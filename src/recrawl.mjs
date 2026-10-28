// Incremental re-crawls and resuming audits (REQ-055 group 2, Oct 2026).
//
// Incremental (setting `incremental`, off by default): every page fetched directly keeps its ETag / Last-Modified
// (data.etag, data.lastModified). The next audit sends them back (If-None-Match / If-Modified-Since); a 304 means the
// page is unchanged, so its stored row, links and text are copied from that audit instead of being downloaded again,
// marked data.reused304. The copy goes through the crawl like a fetched page (its links are queued, its images and
// files checked), so it takes part in every post-crawl check. Only pages that are safe to copy are asked: answered
// 200 to a direct request, without a redirect, not rendered (a 304 for the HTML says nothing about what JavaScript
// loads), not the start page (its raw HTML feeds site-level checks); and only from the newest finished audit made
// with the same tool code and the same crawl settings (otherwise the stored data could be stale for this version).
//
// Resume: an audit stopped by the user, or ended by a crash or an app restart, continues where it was: pages already
// stored aren't fetched again; the queue is rebuilt from their links, the sitemap and the start page; the issues of
// the first run are cleared and every post-crawl check runs again over all pages.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, all, get } from "./db.mjs";

/** Fingerprint of the tool's code (src/*.mjs): stored data is reused only by the code that wrote it. */
export const CODE_HASH = (() => {
  const dir = path.dirname(fileURLToPath(import.meta.url)), h = createHash("sha256");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".mjs")).sort()) h.update(f).update(readFileSync(path.join(dir, f)));
  return h.digest("hex").slice(0, 16);
})();
// Settings that change what a page's stored data says; another value means nothing is reused.
export const REUSE_SETTINGS = ["userAgent", "renderJs", "renderUserAgent", "includeSubdomains", "respectRobots"];
// Fields about how this audit fetched the page, recomputed for every audit.
const PER_AUDIT = ["dupOf", "fetchedVia", "retries", "redirect", "error", "botWall", "fallbackTried", "directStatus", "fallbackMs", "rateLimited", "reused304", "cookieRedirect"];
const headerNames = (s) => (s?.requestHeaders || []).map((x) => String(x.name || "").toLowerCase()).sort().join(",");

/** The audit whose pages this one may copy, or why none: { auditId } | { reason }. */
export function reuseSource(projectId, auditId, settings) {
  const prev = get("SELECT id, settings, site_info FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", projectId, auditId);
  if (!prev) return { reason: "no earlier finished audit" };
  let info = {}, ps = {};
  try { info = JSON.parse(prev.site_info || "{}"); ps = JSON.parse(prev.settings || "{}"); } catch { /* unreadable: treated as different */ }
  if (info.codeHash !== CODE_HASH) return { reason: `the tool changed since audit #${prev.id}` };
  const changed = REUSE_SETTINGS.filter((k) => JSON.stringify(ps[k] ?? null) !== JSON.stringify(settings[k] ?? null));
  if (headerNames(ps) !== headerNames(settings)) changed.push("requestHeaders");
  return changed.length ? { reason: `settings changed since audit #${prev.id}: ${changed.join(", ")}` } : { auditId: prev.id };
}

/** The previous audit's validators for pages that are safe to copy: Map(url → { etag, lastModified }). */
export function validatorsOf(auditId, start) {
  const rows = all(`SELECT url, json_extract(data, '$.etag') etag, json_extract(data, '$.lastModified') lm FROM pages
    WHERE audit_id=? AND status=200 AND (final_url IS NULL OR final_url=url) AND json_extract(data, '$.rendered') IS NULL
      AND json_extract(data, '$.fetchedVia') IN ('fetch', 'retry') AND (json_extract(data, '$.etag') IS NOT NULL OR json_extract(data, '$.lastModified') IS NOT NULL)`, auditId);
  return new Map(rows.filter((r) => r.url !== start).map((r) => [r.url, { etag: r.etag, lastModified: r.lm }]));
}

/** If-None-Match / If-Modified-Since for one page's validators. */
export const conditionalHeaders = (v) => (v ? { ...(v.etag ? { "If-None-Match": v.etag } : {}), ...(v.lastModified ? { "If-Modified-Since": v.lastModified } : {}) } : null);

/** One page of an earlier audit rebuilt as parseHtml returns it ({ title, description, h1, canonical, links, imgs,
 *  res, words, text, textHash, data }) plus its row, or null. Its links are the first copy stored for it (a page
 *  reached through a redirect too has its links stored once per URL; a crawl stores a page's a, img and res rows in
 *  one go, in that order). */
export function storedPage(auditId, url) {
  const row = get("SELECT * FROM pages WHERE audit_id=? AND url=?", auditId, url);
  if (!row) return null;
  const from = row.final_url || row.url, links = [], imgs = [], res = [];
  const rank = { a: 0, img: 1, res: 2 };
  let last = -1;
  for (const l of db.prepare("SELECT to_url, anchor, nofollow, kind, placement, rel FROM links WHERE audit_id=? AND from_url=? ORDER BY rowid").iterate(auditId, from)) {
    const k = rank[l.kind];
    if (k === undefined) continue;
    if (k < last || (k === 0 && links.length >= (row.outlinks || 0))) break; // the next stored copy begins
    last = k;
    if (k === 0) links.push({ to: l.to_url, anchor: l.anchor, nofollow: Boolean(l.nofollow), ...(l.rel ? { rel: l.rel } : {}), placement: l.placement });
    else (k === 1 ? imgs : res).push(l.to_url);
  }
  const data = JSON.parse(row.data || "{}");
  for (const k of PER_AUDIT) delete data[k];
  const text = get("SELECT text FROM page_text WHERE audit_id=? AND url=?", auditId, from)?.text || "";
  return { row, p: { title: row.title || "", description: row.description || "", h1: row.h1 || "", canonical: row.canonical, links, imgs, res,
    words: row.words || 0, text, textHash: data.contentHash || null, data } };
}

/** The incremental re-crawl for one audit: { on, auditId, reason, conditional(url), page(url), summary() }. */
export function createReuse({ projectId, auditId, settings, start }) {
  const stats = { asked: 0, reused: 0 };
  if (settings.incremental !== true) return { on: false, conditional: () => null, page: () => null, summary: () => null };
  const src = reuseSource(projectId, auditId, settings);
  const validators = src.auditId ? validatorsOf(src.auditId, start) : new Map();
  return {
    on: Boolean(src.auditId),
    auditId: src.auditId || null,
    conditional(url) { const h = conditionalHeaders(validators.get(url)); if (h) stats.asked++; return h; },
    page(url) { const x = validators.has(url) ? storedPage(src.auditId, url) : null; if (x) stats.reused++; return x; },
    summary: () => ({ from: src.auditId || null, ...(src.reason ? { reason: src.reason } : {}), asked: stats.asked, reused: stats.reused }),
  };
}

/** Prepares a stopped or interrupted audit to continue: clears its issues and any half-stored page's links and text,
 *  then returns what the crawl needs: { pages: [{ url, depth }], frontier: [[url, depth]], hashes: [[contentHash, url]],
 *  files: [{ url, kind, internal }], renderDecision }. followable(url) filters link targets as the crawl does. */
export function resumeState(auditId, followable = () => true) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM issues WHERE audit_id=?").run(auditId);
    // A crash between storing a page's links and its row leaves links of a page that isn't stored: it is fetched again.
    db.prepare(`DELETE FROM links WHERE audit_id=? AND from_url NOT IN (SELECT url FROM pages WHERE audit_id=? UNION SELECT final_url FROM pages WHERE audit_id=? AND final_url IS NOT NULL)`).run(auditId, auditId, auditId);
    db.prepare(`DELETE FROM page_text WHERE audit_id=? AND url NOT IN (SELECT url FROM pages WHERE audit_id=? UNION SELECT final_url FROM pages WHERE audit_id=? AND final_url IS NOT NULL)`).run(auditId, auditId, auditId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  const pages = all("SELECT url, final_url, depth, indexable, json_extract(data, '$.contentHash') h, json_extract(data, '$.jsRedirect.to') js, json_extract(data, '$.variantOf') variant FROM pages WHERE audit_id=? ORDER BY id", auditId);
  const depthOf = new Map(pages.flatMap((p) => [[p.url, p.depth], [p.final_url || p.url, p.depth]]));
  const frontier = [];
  for (const l of db.prepare("SELECT DISTINCT from_url, to_url FROM links WHERE audit_id=? AND kind='a' AND internal=1").iterate(auditId))
    if (followable(l.to_url)) frontier.push([l.to_url, (depthOf.get(l.from_url) ?? 0) + 1]);
  for (const p of pages) for (const u of [p.js, p.variant]) if (u) frontier.push([u, (p.depth ?? 0) + (u === p.js ? 1 : 0)]);
  const hashes = new Map(); // the first indexable page with each text, as the crawl's duplicate check keeps it
  for (const p of pages) if (p.indexable && p.h && !hashes.has(p.h)) hashes.set(p.h, p.url);
  const files = all("SELECT DISTINCT to_url url, kind, internal FROM links WHERE audit_id=? AND (kind IN ('img', 'res') OR (kind='a' AND internal=0))", auditId);
  let renderDecision = null;
  try { const r = JSON.parse(get("SELECT site_info FROM audits WHERE id=?", auditId)?.site_info || "{}").render; if (r?.decision && r.decision !== "unavailable") renderDecision = r; } catch { /* none */ }
  return { pages: pages.map((p) => ({ url: p.url, depth: p.depth })), frontier, hashes: [...hashes], files, renderDecision };
}
