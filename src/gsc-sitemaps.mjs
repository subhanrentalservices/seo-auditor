// Search Console Sitemaps API (REQ-055 group 4, item 4): the sitemaps submitted for the property, when Google last read
// each, its errors and warnings, and the URLs submitted per content type (children of a sitemap index included, at most
// 50 index files). Google no longer provides an indexed count per sitemap (contents[].indexed is "Deprecated; do not
// use", developers.google.com/webmaster-tools/v1/sitemaps), so it is never shown; instead the sitemap pages of the latest
// audit are matched with this tool's own URL Inspection results (indexing.mjs). Fetched on every Search Console refresh.
import { db, all, get, run } from "./db.mjs";
import { afterRefresh } from "./gsc.mjs";
import { classify } from "./indexing.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS gsc_sitemaps (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL, parent TEXT, type TEXT, is_index INTEGER, is_pending INTEGER, last_submitted TEXT, last_downloaded TEXT,
  warnings INTEGER, errors INTEGER, contents TEXT, PRIMARY KEY (project_id, path));`);

const MAX_INDEXES = 50;
const KEY = (id) => `gsc-sitemaps:${id}`;

/** One Sitemaps API entry → the stored fields (counts arrive as strings; "indexed" is deliberately dropped). */
export function parseSitemap(x, parent = null) {
  const n = (v) => (v === undefined || v === null || v === "" ? 0 : Number(v) || 0);
  return { path: String(x.path || ""), parent, type: x.type || null, isIndex: x.isSitemapsIndex ? 1 : 0, isPending: x.isPending ? 1 : 0,
    lastSubmitted: x.lastSubmitted || null, lastDownloaded: x.lastDownloaded || null, warnings: n(x.warnings), errors: n(x.errors),
    contents: (x.contents || []).map((c) => ({ type: c.type || "web", submitted: n(c.submitted) })) };
}

export async function refreshSitemaps(project, { call, property }) {
  const base = `sites/${encodeURIComponent(property)}/sitemaps`;
  try {
    const top = ((await call(base)).sitemap || []).map((x) => parseSitemap(x));
    const kids = [];
    for (const s of top.filter((x) => x.isIndex).slice(0, MAX_INDEXES))
      for (const x of (await call(`${base}?sitemapIndex=${encodeURIComponent(s.path)}`)).sitemap || []) if (x.path !== s.path) kids.push(parseSitemap(x, s.path));
    const list = [...top, ...kids.filter((k) => !top.some((t) => t.path === k.path))];
    const ins = db.prepare(`INSERT OR REPLACE INTO gsc_sitemaps (project_id,path,parent,type,is_index,is_pending,last_submitted,last_downloaded,warnings,errors,contents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec("BEGIN");
    try {
      run("DELETE FROM gsc_sitemaps WHERE project_id=?", project.id);
      for (const s of list) ins.run(project.id, s.path, s.parent, s.type, s.isIndex, s.isPending, s.lastSubmitted, s.lastDownloaded, s.warnings, s.errors, JSON.stringify(s.contents));
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEY(project.id), JSON.stringify({ fetchedAt: new Date().toISOString(), error: null }));
    return { sitemaps: list.length };
  } catch (e) {
    // Keep the previous list; say the refresh failed.
    const prev = get("SELECT value FROM meta WHERE key=?", KEY(project.id));
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEY(project.id), JSON.stringify({ ...(prev ? JSON.parse(prev.value) : {}), error: e.message }));
    return { error: e.message };
  }
}

/** Problems worth a look, per sitemap: errors, warnings, never read, or not read for 30+ days while not pending. */
export function sitemapProblems(s, now = Date.now()) {
  const out = [];
  if (s.errors) out.push(`${s.errors} error${s.errors === 1 ? "" : "s"}`);
  if (s.warnings) out.push(`${s.warnings} warning${s.warnings === 1 ? "" : "s"}`);
  if (s.isPending) out.push("not processed yet");
  else if (!s.lastDownloaded) out.push("never read by Google");
  else if (now - Date.parse(s.lastDownloaded) > 30 * 864e5) out.push("not read for 30+ days");
  return out;
}

export function sitemapReport(projectId, now = Date.now()) {
  const m = get("SELECT value FROM meta WHERE key=?", KEY(projectId));
  const meta = m ? JSON.parse(m.value) : {};
  const sitemaps = all("SELECT * FROM gsc_sitemaps WHERE project_id=? ORDER BY parent IS NOT NULL, parent, path", projectId).map((r) => {
    const s = { path: r.path, parent: r.parent, type: r.type, isIndex: r.is_index, isPending: r.is_pending, lastSubmitted: r.last_submitted,
      lastDownloaded: r.last_downloaded, warnings: r.warnings, errors: r.errors, contents: JSON.parse(r.contents || "[]") };
    return { ...s, problems: sitemapProblems(s, now) };
  });
  const leaf = sitemaps.filter((s) => !s.isIndex);
  const submitted = leaf.reduce((n, s) => n + s.contents.filter((c) => c.type === "web").reduce((a, c) => a + c.submitted, 0), 0);
  // Sitemap pages of the latest audit, matched with this tool's URL Inspection results.
  let inspection = null;
  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  if (a) {
    const rows = all(`SELECT p.url, i.coverage, i.verdict, i.error, i.inspected_at FROM pages p LEFT JOIN index_status i ON i.project_id=? AND i.url=p.url
      WHERE p.audit_id=? AND p.in_sitemap=1`, projectId, a.id);
    const checked = rows.filter((r) => r.inspected_at && !r.error);
    inspection = { auditId: a.id, sitemapPages: rows.length, inspected: checked.length, indexed: checked.filter((r) => classify(r.coverage, r.verdict).kind === "indexed").length };
  }
  return { fetched: Boolean(meta.fetchedAt), fetchedAt: meta.fetchedAt || null, error: meta.error || null, sitemaps,
    totals: { sitemaps: sitemaps.length, submitted, errors: sitemaps.reduce((n, s) => n + s.errors, 0), warnings: sitemaps.reduce((n, s) => n + s.warnings, 0) }, inspection };
}

afterRefresh.push(["sitemaps", refreshSitemaps]);

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/gsc\/sitemaps$/, ([id]) => sitemapReport(Number(id))]);
}
