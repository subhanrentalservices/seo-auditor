// Google Search Console via the existing service account (read-only scope). The key file is read at run time
// from its own location and never copied. Stores page totals, query×page rows and a daily trend per project.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoogleAuth } from "google-auth-library";
import { db, all, get, run, ROOT, projectSettings, DATA } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS gsc_queries (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL);
CREATE INDEX IF NOT EXISTS idx_gscq ON gsc_queries(project_id, query);
CREATE TABLE IF NOT EXISTS gsc_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date TEXT NOT NULL, clicks INTEGER, impressions INTEGER, ctr REAL, position REAL, PRIMARY KEY (project_id, date));
`);

// Service-account key: App settings, else GSC_KEY_FILE, else ~/.config/claude-seo/gsc-service-account.json.
const DEFAULT_KEY = process.env.GSC_KEY_FILE || path.join(os.homedir(), ".config", "claude-seo", "gsc-service-account.json");
export function config() {
  const f = path.join(DATA, "config.json");
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}; } catch { return {}; }
}
const keyFile = () => config().gscKeyFile || DEFAULT_KEY;

let client;
async function gsc(urlPath, body) {
  if (!existsSync(keyFile())) throw Object.assign(new Error(`Search Console key file not found: ${keyFile()}`), { status: 400 });
  client ||= await new GoogleAuth({ keyFile: keyFile(), scopes: ["https://www.googleapis.com/auth/webmasters.readonly"] }).getClient();
  const res = await client.request({ url: "https://searchconsole.googleapis.com/webmasters/v3/" + urlPath, method: body ? "POST" : "GET", data: body });
  return res.data;
}

export async function listSites() { return ((await gsc("sites")).siteEntry || []).map((s) => s.siteUrl).sort(); }

/** Matches a project URL to a property the account can read: exact URL-prefix property first, then domain property. */
export async function detectProperty(startUrl) {
  const u = new URL(startUrl); const host = u.hostname.replace(/^www\./, "");
  const sites = await listSites();
  return sites.find((s) => s === `${u.origin}/`) || sites.find((s) => s === `sc-domain:${host}`) ||
    sites.find((s) => !s.startsWith("sc-domain:") && new URL(s).hostname.replace(/^www\./, "") === host) || null;
}

const iso = (d) => d.toISOString().slice(0, 10);
async function query(property, body, max = 100000) {
  const rows = [];
  for (let startRow = 0; startRow < max; startRow += 25000) {
    const r = await gsc(`sites/${encodeURIComponent(property)}/searchAnalytics/query`, { ...body, rowLimit: 25000, startRow, dataState: "final" });
    rows.push(...(r.rows || []));
    if (!r.rows || r.rows.length < 25000) break;
  }
  return rows;
}

export async function refresh(project) {
  const s = projectSettings(project);
  const property = s.gscProperty || (await detectProperty(project.start_url));
  if (!property) throw Object.assign(new Error("No Search Console property for this site is shared with the service account"), { status: 400 });
  const end = new Date(Date.now() - 3 * 864e5), start = new Date(end - 27 * 864e5), start90 = new Date(end - 89 * 864e5);
  const range = { startDate: iso(start), endDate: iso(end) };
  const [pages, queries, daily] = await Promise.all([
    query(property, { ...range, dimensions: ["page"] }),
    query(property, { ...range, dimensions: ["query", "page"] }, 50000),
    query(property, { startDate: iso(start90), endDate: iso(end), dimensions: ["date"] }),
  ]);
  db.exec("BEGIN");
  try {
    run("DELETE FROM gsc WHERE project_id=?", project.id);
    run("DELETE FROM gsc_queries WHERE project_id=?", project.id);
    const ip = db.prepare("INSERT OR REPLACE INTO gsc (project_id,url,clicks,impressions,ctr,position,start_date,end_date) VALUES (?,?,?,?,?,?,?,?)");
    for (const r of pages) ip.run(project.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position, range.startDate, range.endDate);
    const iq = db.prepare("INSERT INTO gsc_queries (project_id,query,page,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?,?)");
    for (const r of queries) iq.run(project.id, r.keys[0], r.keys[1], r.clicks, r.impressions, r.ctr, r.position);
    const id = db.prepare("INSERT OR REPLACE INTO gsc_daily (project_id,date,clicks,impressions,ctr,position) VALUES (?,?,?,?,?,?)");
    for (const r of daily) id.run(project.id, r.keys[0], r.clicks, r.impressions, r.ctr, r.position);
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", `gsc:${project.id}`, JSON.stringify({ property, fetchedAt: new Date().toISOString(), ...range }));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { property, pages: pages.length, queries: queries.length, days: daily.length };
}

export function summary(projectId) {
  const meta = get("SELECT value FROM meta WHERE key=?", `gsc:${projectId}`);
  if (!meta) return { connected: false };
  const m = JSON.parse(meta.value);
  const totals = get("SELECT SUM(clicks) clicks, SUM(impressions) impressions FROM gsc_daily WHERE project_id=? AND date BETWEEN ? AND ?", projectId, m.startDate, m.endDate);
  const pos = get("SELECT SUM(position*impressions)/NULLIF(SUM(impressions),0) p FROM gsc_daily WHERE project_id=? AND date BETWEEN ? AND ?", projectId, m.startDate, m.endDate).p;
  const daily = all("SELECT date, clicks, impressions, position FROM gsc_daily WHERE project_id=? ORDER BY date", projectId);
  const topQueries = all(`SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions)/SUM(impressions) position, COUNT(*) pages
    FROM gsc_queries WHERE project_id=? GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT 100`, projectId);
  const topPages = all("SELECT url, clicks, impressions, ctr, position FROM gsc WHERE project_id=? ORDER BY clicks DESC, impressions DESC LIMIT 100", projectId);
  // Quick wins: queries on page 1's lower half or page 2 that already get seen — small improvements move them up.
  const quickWins = all(`SELECT * FROM (SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions)/SUM(impressions) position,
      (SELECT page FROM gsc_queries b WHERE b.project_id=q.project_id AND b.query=q.query ORDER BY impressions DESC LIMIT 1) page
    FROM gsc_queries q WHERE project_id=? GROUP BY query) WHERE position BETWEEN 4 AND 20 AND impressions >= 10 ORDER BY impressions DESC LIMIT 50`, projectId);
  // Cannibalisation: two or more of your pages each take a real share of one query's impressions.
  const cannibal = all(`SELECT query, COUNT(*) pages, SUM(impressions) impressions, GROUP_CONCAT(page || ' (' || ROUND(position,1) || ')', '  |  ') detail
    FROM gsc_queries q WHERE project_id=? AND impressions >= 5
      AND impressions >= 0.15 * (SELECT SUM(impressions) FROM gsc_queries x WHERE x.project_id=q.project_id AND x.query=q.query)
    GROUP BY query HAVING COUNT(*) > 1 ORDER BY impressions DESC LIMIT 50`, projectId);
  const p = get("SELECT name, start_url FROM projects WHERE id=?", projectId);
  const brandKeys = [new URL(p.start_url).hostname.replace(/^www./, "").split(".")[0], p.name.toLowerCase().replace(/[^a-z0-9]/g, "")].filter((k) => k.length >= 4);
  const isBrand = (q) => brandKeys.some((k) => q.toLowerCase().replace(/[^a-z0-9]/g, "").includes(k));
  for (const r of [...topQueries, ...quickWins, ...cannibal]) r.brand = isBrand(r.query);
  return { connected: true, ...m, totals: { ...totals, ctr: totals.impressions ? totals.clicks / totals.impressions : 0, position: pos },
    keywords: get("SELECT COUNT(DISTINCT query) n FROM gsc_queries WHERE project_id=?", projectId).n,
    top3: get("SELECT COUNT(*) n FROM (SELECT query, SUM(position*impressions)/SUM(impressions) p FROM gsc_queries WHERE project_id=? GROUP BY query) WHERE p <= 3", projectId).n,
    top10: get("SELECT COUNT(*) n FROM (SELECT query, SUM(position*impressions)/SUM(impressions) p FROM gsc_queries WHERE project_id=? GROUP BY query) WHERE p <= 10", projectId).n,
    daily, topQueries, topPages, quickWins, cannibal };
}

export function register({ routes }) {
  afterAudit.push(async (auditId, project) => {
    const last = get("SELECT value FROM meta WHERE key=?", `gsc:${project.id}`);
    if (last && Date.now() - Date.parse(JSON.parse(last.value).fetchedAt) < 12 * 3600e3) return;
    phase(project.id, auditId, "Search Console");
    await refresh(get("SELECT * FROM projects WHERE id=?", project.id)).catch((e) => console.error("gsc:", e.message));
  });
  routes.push(["GET", /^\/api\/gsc\/sites$/, () => listSites()]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/gsc$/, ([id]) => summary(Number(id))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/gsc$/, async ([id]) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id));
    if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
    return refresh(p);
  }]);
}
