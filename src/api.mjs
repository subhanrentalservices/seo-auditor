// REST handlers. Each returns a JSON-able value or throws an Error with .status.
import { all, get, run, projectSettings, DEFAULT_SETTINGS } from "./db.mjs";
import { CHECKS, CRAWL } from "./checks.mjs";
import "./ai-checks.mjs";
import { startAudit, stop, activeAudit } from "./runner.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const SEV_ORDER = { error: 0, warning: 1, notice: 2 };

function cleanUrl(u) {
  let x;
  try { x = new URL(String(u || "").trim().match(/^https?:\/\//i) ? String(u).trim() : "https://" + String(u || "").trim()); } catch { fail(400, "Enter a valid website address"); }
  if (!/^https?:$/.test(x.protocol) || !x.hostname.includes(".")) fail(400, "Enter a valid website address");
  x.hash = "";
  return x.href;
}

/** Keeps only known settings with the right types. */
function cleanSettings(input = {}) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof def === "number") { const n = Number(v); if (Number.isFinite(n) && n >= 0) out[k] = Math.floor(n); }
    else if (typeof def === "boolean") out[k] = Boolean(v);
    else out[k] = String(v ?? "").slice(0, k === "targetKeywords" ? 4000 : 500);
  }
  if (out.concurrency !== undefined) out.concurrency = Math.min(Math.max(out.concurrency, 1), 20);
  if (out.schedule !== undefined && !["off", "daily", "weekly"].includes(out.schedule)) out.schedule = "off";
  return out;
}

const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
const audit = (id) => get("SELECT * FROM audits WHERE id=?", Number(id)) || fail(404, "Audit not found");
const previousAudit = (a) => get("SELECT * FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", a.project_id, a.id);
const shapeAudit = (a) => a && { ...a, settings: JSON.parse(a.settings || "{}"), site_info: a.site_info ? JSON.parse(a.site_info) : null };

export function listProjects() {
  return all("SELECT * FROM projects ORDER BY name").map((p) => {
    const last = get("SELECT * FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", p.id);
    const prev = last && previousAudit(last);
    return { ...p, settings: projectSettings(p), last: shapeAudit(last), healthDelta: last && prev ? last.health - prev.health : null, running: activeAudit(p.id) };
  });
}

export function createProject(body) {
  const start = cleanUrl(body.start_url);
  const name = String(body.name || new URL(start).hostname.replace(/^www\./, "")).slice(0, 100);
  const id = Number(run("INSERT INTO projects (name, start_url, settings) VALUES (?, ?, ?)", name, start, JSON.stringify(cleanSettings(body.settings))).lastInsertRowid);
  return getProject(id);
}

export function getProject(id) {
  const p = project(id);
  const history = all("SELECT id, status, started_at, finished_at, pages_crawled, health, ai_readiness, errors, warnings, notices, message FROM audits WHERE project_id=? ORDER BY id DESC LIMIT 60", p.id);
  return { ...p, settings: projectSettings(p), history, running: activeAudit(p.id) };
}

export function updateProject(id, body) {
  const p = project(id);
  const name = body.name !== undefined ? String(body.name).slice(0, 100) : p.name;
  const start = body.start_url !== undefined ? cleanUrl(body.start_url) : p.start_url;
  const settings = { ...JSON.parse(p.settings || "{}"), ...cleanSettings(body.settings) };
  run("UPDATE projects SET name=?, start_url=?, settings=? WHERE id=?", name, start, JSON.stringify(settings), p.id);
  return getProject(p.id);
}

export function deleteProject(id) {
  const p = project(id);
  const a = activeAudit(p.id); if (a) stop(a);
  run("DELETE FROM projects WHERE id=?", p.id);
  return { ok: true };
}

export function startProjectAudit(id) { return { auditId: startAudit(project(id).id) }; }
export function stopAudit(id) { stop(audit(id).id); return { ok: true }; }

export function getAudit(id) {
  const a = audit(id);
  const prev = previousAudit(a);
  const groups = issueGroups(a, prev);
  // Every crawlability check with its title, so the screen can show the ones that passed too.
  const crawlChecks = [...CRAWL].map((cid) => ({ id: cid, title: CHECKS[cid][1], severity: CHECKS[cid][0] }));
  return { audit: shapeAudit(a), previous: shapeAudit(prev), project: project(a.project_id), groups, crawlChecks,
    depth: all("SELECT depth, COUNT(*) n FROM pages WHERE audit_id=? GROUP BY depth ORDER BY depth", a.id),
    statuses: all("SELECT status, COUNT(*) n FROM pages WHERE audit_id=? GROUP BY status ORDER BY status", a.id) };
}

/** Issues grouped by check, with counts of URLs that are new or fixed since the previous audit. */
function issueGroups(a, prev) {
  const cur = all("SELECT check_id, COUNT(*) n, COUNT(DISTINCT url) pages FROM issues WHERE audit_id=? GROUP BY check_id", a.id);
  const key = (r) => r.check_id + "\u0000" + r.url;
  const prevKeys = prev ? new Set(all("SELECT DISTINCT check_id, url FROM issues WHERE audit_id=?", prev.id).map(key)) : null;
  const curKeys = new Set(all("SELECT DISTINCT check_id, url FROM issues WHERE audit_id=?", a.id).map(key));
  const out = cur.map((r) => {
    const [severity, title, why, fix] = CHECKS[r.check_id] || ["notice", r.check_id, "", ""];
    let added = null, fixed = null;
    if (prevKeys) {
      added = [...curKeys].filter((k) => k.startsWith(r.check_id + "\u0000") && !prevKeys.has(k)).length;
      fixed = [...prevKeys].filter((k) => k.startsWith(r.check_id + "\u0000") && !curKeys.has(k)).length;
    }
    return { id: r.check_id, severity, title, why, fix, count: r.n, pages: r.pages, added, fixed, ai: r.check_id.startsWith("ai_"), crawl: CRAWL.has(r.check_id) };
  });
  if (prevKeys) { // checks that disappeared completely
    const gone = new Map();
    for (const k of prevKeys) { const id = k.split("\u0000")[0]; if (!cur.some((c) => c.check_id === id)) gone.set(id, (gone.get(id) || 0) + 1); }
    for (const [id, n] of gone) { const [severity, title, why, fix] = CHECKS[id] || ["notice", id, "", ""]; out.push({ id, severity, title, why, fix, count: 0, pages: 0, added: 0, fixed: n, ai: id.startsWith("ai_"), crawl: CRAWL.has(id) }); }
  }
  return out.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || y.count - x.count);
}

export function getIssue(auditId, checkId, q = {}) {
  const a = audit(auditId);
  const [severity, title, why, fix] = CHECKS[checkId] || fail(404, "Unknown check");
  const prev = previousAudit(a);
  const prevUrls = prev ? new Set(all("SELECT url FROM issues WHERE audit_id=? AND check_id=?", prev.id, checkId).map((r) => r.url)) : null;
  const rows = all("SELECT url, detail FROM issues WHERE audit_id=? AND check_id=? ORDER BY url LIMIT ? OFFSET ?", a.id, checkId, Math.min(Number(q.limit) || 500, 5000), Number(q.offset) || 0)
    .map((r) => ({ ...r, isNew: prevUrls ? !prevUrls.has(r.url) : false }));
  const fixedUrls = prevUrls ? [...prevUrls].filter((u) => !get("SELECT 1 x FROM issues WHERE audit_id=? AND check_id=? AND url=?", a.id, checkId, u)) : [];
  return { id: checkId, severity, title, why, fix, total: get("SELECT COUNT(*) n FROM issues WHERE audit_id=? AND check_id=?", a.id, checkId).n, rows, fixedUrls };
}

const PAGE_SORT = { url: "p.url", status: "p.status", depth: "p.depth", inlinks: "p.inlinks", outlinks: "p.outlinks", words: "p.words", response_ms: "p.response_ms", bytes: "p.bytes", title: "p.title", issues: "issues", clicks: "g.clicks", impressions: "g.impressions", position: "g.position" };
export function listPages(auditId, q = {}) {
  const a = audit(auditId);
  const where = ["p.audit_id=?"]; const args = [a.id];
  if (q.q) { where.push("(p.url LIKE ? OR p.title LIKE ?)"); args.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.status === "ok") where.push("p.status=200"); else if (q.status === "redirect") where.push("(p.status BETWEEN 300 AND 399 OR json_extract(p.data,'$.redirect') IS NOT NULL)");
  else if (q.status === "error") where.push("(p.status>=400 OR p.status=0)");
  if (q.indexable === "1") where.push("p.indexable=1"); else if (q.indexable === "0") where.push("p.indexable=0");
  if (q.issue) { where.push("EXISTS (SELECT 1 FROM issues i WHERE i.audit_id=p.audit_id AND i.url=p.url AND i.check_id=?)"); args.push(String(q.issue)); }
  const sort = PAGE_SORT[q.sort] || "p.url"; const dir = q.dir === "desc" ? "DESC" : "ASC";
  const sql = `SELECT p.url, p.final_url, p.status, p.depth, p.response_ms, p.bytes, p.title, p.h1, p.indexable, p.in_sitemap, p.inlinks, p.outlinks, p.words,
      COALESCE(ic.errors, 0) errors, COALESCE(ic.warnings, 0) warnings, COALESCE(ic.issues, 0) issues,
      g.clicks, g.impressions, g.position
    FROM pages p LEFT JOIN gsc g ON g.project_id=? AND g.url IN (p.url, p.final_url)
    LEFT JOIN (SELECT url, SUM(severity='error') errors, SUM(severity='warning') warnings, COUNT(*) issues FROM issues WHERE audit_id=? GROUP BY url) ic ON ic.url=p.url
    WHERE ${where.join(" AND ")} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`;
  const limit = Math.min(Number(q.limit) || 100, 5000), offset = Number(q.offset) || 0;
  const total = get(`SELECT COUNT(*) n FROM pages p WHERE ${where.join(" AND ")}`, ...args).n;
  return { total, rows: all(sql, a.project_id, a.id, ...args, limit, offset) };
}

export function getPage(auditId, url) {
  const a = audit(auditId);
  const p = get("SELECT * FROM pages WHERE audit_id=? AND url=?", a.id, String(url)) || fail(404, "Page not in this audit");
  const issues = all("SELECT check_id, severity, detail FROM issues WHERE audit_id=? AND url=?", a.id, p.url)
    .map((i) => ({ ...i, title: CHECKS[i.check_id]?.[1], fix: CHECKS[i.check_id]?.[3] }))
    .sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]);
  const inlinks = all("SELECT DISTINCT from_url, anchor FROM links WHERE audit_id=? AND kind='a' AND internal=1 AND to_url IN (?, ?) AND from_url<>? LIMIT 500", a.id, p.url, p.final_url, p.url);
  const outlinks = all("SELECT to_url, anchor, internal, nofollow FROM links WHERE audit_id=? AND from_url IN (?, ?) AND kind='a' LIMIT 1000", a.id, p.url, p.final_url);
  const gsc = get("SELECT clicks, impressions, ctr, position, start_date, end_date FROM gsc WHERE project_id=? AND url IN (?, ?)", a.project_id, p.url, p.final_url);
  const cwvRow = get("SELECT lcp_ms, cls, tbt_ms, fcp_ms, si_ms, transfer_kb, perf, a11y, bp, seo, details FROM cwv WHERE audit_id=? AND url IN (?, ?) AND error IS NULL", a.id, p.url, p.final_url);
  const cwv = cwvRow && { ...cwvRow, details: cwvRow.details ? JSON.parse(cwvRow.details) : null };
  return { page: { ...p, data: JSON.parse(p.data) }, issues, inlinks, outlinks, gsc, cwv };
}

export function compareAudits(aId, bId) {
  const a = audit(aId), b = audit(bId);
  if (a.project_id !== b.project_id) fail(400, "Audits belong to different projects");
  const [older, newer] = a.id < b.id ? [a, b] : [b, a];
  const set = (id) => new Set(all("SELECT DISTINCT check_id || char(0) || url k FROM issues WHERE audit_id=?", id).map((r) => r.k));
  const o = set(older.id), n = set(newer.id);
  const split = (k) => { const [check, url] = k.split("\u0000"); return { check, url, severity: CHECKS[check]?.[0], title: CHECKS[check]?.[1] }; };
  const pagesO = new Set(all("SELECT url FROM pages WHERE audit_id=?", older.id).map((r) => r.url));
  const pagesN = new Set(all("SELECT url FROM pages WHERE audit_id=?", newer.id).map((r) => r.url));
  return { older: shapeAudit(older), newer: shapeAudit(newer),
    added: [...n].filter((k) => !o.has(k)).map(split), fixed: [...o].filter((k) => !n.has(k)).map(split),
    newPages: [...pagesN].filter((u) => !pagesO.has(u)), lostPages: [...pagesO].filter((u) => !pagesN.has(u)) };
}

const csvCell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\r\n");

export function exportCsv(auditId, kind) {
  const a = audit(auditId);
  if (kind === "issues") {
    const rows = all("SELECT check_id, severity, url, detail FROM issues WHERE audit_id=? ORDER BY severity, check_id, url", a.id).map((r) => ({ ...r, title: CHECKS[r.check_id]?.[1] }));
    return toCsv(rows, ["severity", "check_id", "title", "url", "detail"]);
  }
  if (kind === "pages") return toCsv(listPages(a.id, { limit: 5000000 }).rows, ["url", "status", "depth", "indexable", "in_sitemap", "inlinks", "outlinks", "words", "response_ms", "bytes", "title", "h1", "errors", "warnings", "clicks", "impressions", "position"]);
  if (kind === "links") return toCsv(all("SELECT from_url, to_url, anchor, internal, nofollow, kind FROM links WHERE audit_id=?", a.id), ["from_url", "to_url", "anchor", "internal", "nofollow", "kind"]);
  fail(404, "Unknown export");
}

export const catalog = () => Object.entries(CHECKS).map(([id, [severity, title, why, fix]]) => ({ id, severity, title, why, fix }));
