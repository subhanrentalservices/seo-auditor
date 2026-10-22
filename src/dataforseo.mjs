// DataForSEO (paid): ranked keywords and backlink profile. Login is read at run time from the existing
// .mcp.json (or data/config.json) and never copied. Every call's real cost is logged and a monthly budget is
// enforced before any request. Nothing here runs automatically; the owner presses the button.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { db, all, get, run, ROOT, projectSettings, DATA } from "./db.mjs";
import { config } from "./gsc.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS dfs_costs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), project_id INTEGER, endpoint TEXT, cost REAL);
CREATE TABLE IF NOT EXISTS kw_snapshots (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')), location INTEGER, total INTEGER, metrics TEXT);
CREATE TABLE IF NOT EXISTS kw_items (snapshot_id INTEGER NOT NULL REFERENCES kw_snapshots(id) ON DELETE CASCADE,
  keyword TEXT, position INTEGER, volume INTEGER, url TEXT, etv REAL, cpc REAL, difficulty INTEGER, intent TEXT, change INTEGER);
CREATE TABLE IF NOT EXISTS bl_snapshots (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')), backlinks INTEGER, ref_domains INTEGER, rank INTEGER, dofollow INTEGER,
  spam_score INTEGER, data TEXT);
`);

// Optional: an MCP config file (.mcp.json) holding the DataForSEO login, set in App settings or DATAFORSEO_MCP_CONFIG.
const MCP_JSON = process.env.DATAFORSEO_MCP_CONFIG || "";
const CONFIG_FILE = path.join(DATA, "config.json");
export function saveConfig(patch) {
  const next = { ...config(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function login() {
  const c = config();
  if (c.dfsLogin && c.dfsPassword) return [c.dfsLogin, c.dfsPassword];
  const file = c.dfsConfigPath || MCP_JSON;
  if (!existsSync(file)) return null;
  try {
    const env = JSON.parse(readFileSync(file, "utf8")).mcpServers?.dataforseo?.env || {};
    const u = env.DATAFORSEO_USERNAME || env.DATAFORSEO_LOGIN, p = env.DATAFORSEO_PASSWORD;
    return u && p ? [u, p] : null;
  } catch { return null; }
}
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const budget = () => Number(config().dfsMonthlyBudget ?? 2);
export const spentThisMonth = () => get("SELECT COALESCE(SUM(cost),0) s FROM dfs_costs WHERE ts >= strftime('%Y-%m-01','now')").s;

export async function dfs(endpoint, body, projectId, method = "POST") {
  const creds = login();
  if (!creds) fail(400, "DataForSEO login not found. Add it in Settings → DataForSEO.");
  if (method === "POST" && spentThisMonth() >= budget()) fail(402, `Monthly DataForSEO budget of $${budget().toFixed(2)} reached. Raise it in Settings if you want more.`);
  const res = await fetch("https://api.dataforseo.com/v3/" + endpoint, {
    method, headers: { Authorization: "Basic " + Buffer.from(creds.join(":")).toString("base64"), "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify([body]) : undefined, signal: AbortSignal.timeout(120000),
  });
  const j = await res.json().catch(() => ({}));
  if (j.cost) run("INSERT INTO dfs_costs (project_id, endpoint, cost) VALUES (?,?,?)", projectId ?? null, endpoint, j.cost);
  const t = j.tasks?.[0];
  if (j.status_code !== 20000 || !t || t.status_code !== 20000) fail(502, `DataForSEO: ${t?.status_message || j.status_message || res.status}`);
  return t.result?.[0] || {};
}

const domainOf = (p) => new URL(p.start_url).hostname.replace(/^www\./, "");

export async function fetchKeywords(project) {
  const s = projectSettings(project);
  const r = await dfs("dataforseo_labs/google/ranked_keywords/live", { target: domainOf(project), location_code: s.dfsLocation, language_code: s.dfsLanguage,
    limit: 1000, order_by: ["ranked_serp_element.serp_item.etv,desc"] }, project.id);
  const prev = get("SELECT id FROM kw_snapshots WHERE project_id=? ORDER BY id DESC LIMIT 1", project.id);
  const prevPos = prev ? new Map(all("SELECT keyword, position FROM kw_items WHERE snapshot_id=?", prev.id).map((x) => [x.keyword, x.position])) : null;
  db.exec("BEGIN");
  try {
    const sid = Number(run("INSERT INTO kw_snapshots (project_id, location, total, metrics) VALUES (?,?,?,?)", project.id, s.dfsLocation, r.total_count ?? 0, JSON.stringify(r.metrics?.organic || {})).lastInsertRowid);
    const ins = db.prepare("INSERT INTO kw_items (snapshot_id, keyword, position, volume, url, etv, cpc, difficulty, intent, change) VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const i of r.items || []) {
      const kd = i.keyword_data || {}, se = i.ranked_serp_element?.serp_item || {};
      const pos = se.rank_absolute ?? null, before = prevPos?.get(kd.keyword);
      ins.run(sid, kd.keyword, pos, kd.keyword_info?.search_volume ?? null, se.url ?? null, se.etv ?? null, kd.keyword_info?.cpc ?? null,
        kd.keyword_properties?.keyword_difficulty ?? null, kd.search_intent_info?.main_intent ?? null, before && pos ? before - pos : null);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return keywordsData(project.id);
}

export async function fetchBacklinks(project) {
  const target = domainOf(project);
  const sum = await dfs("backlinks/summary/live", { target, include_subdomains: true, backlinks_status_type: "live" }, project.id);
  const refs = await dfs("backlinks/referring_domains/live", { target, include_subdomains: true, limit: 100, order_by: ["rank,desc"], backlinks_status_type: "live" }, project.id);
  const anchors = await dfs("backlinks/anchors/live", { target, include_subdomains: true, limit: 30, order_by: ["backlinks,desc"], backlinks_status_type: "live" }, project.id);
  const data = {
    referringDomains: (refs.items || []).map((x) => ({ domain: x.domain, rank: x.rank, backlinks: x.backlinks, dofollow: x.dofollow ?? null, spam: x.backlinks_spam_score, firstSeen: x.first_seen })),
    anchors: (anchors.items || []).map((x) => ({ anchor: x.anchor, backlinks: x.backlinks, domains: x.referring_domains })),
    tlds: sum.referring_links_tld || {}, countries: sum.referring_links_countries || {}, types: sum.referring_links_types || {},
    nofollow: sum.referring_links_attributes?.nofollow ?? null, brokenBacklinks: sum.broken_backlinks ?? null, referringIps: sum.referring_ips ?? null,
  };
  run("INSERT INTO bl_snapshots (project_id, backlinks, ref_domains, rank, dofollow, spam_score, data) VALUES (?,?,?,?,?,?,?)", project.id,
    sum.backlinks ?? 0, sum.referring_domains ?? 0, sum.rank ?? null, sum.backlinks - (sum.referring_links_attributes?.nofollow ?? 0), sum.backlinks_spam_score ?? null, JSON.stringify(data));
  return backlinksData(project.id);
}

export function keywordsData(projectId) {
  const snaps = all("SELECT id, fetched_at, total, metrics FROM kw_snapshots WHERE project_id=? ORDER BY id", projectId).map((s) => ({ ...s, metrics: JSON.parse(s.metrics || "{}") }));
  const last = snaps.at(-1);
  if (!last) return { snapshots: [] };
  const items = all("SELECT keyword, position, volume, url, etv, cpc, difficulty, intent, change FROM kw_items WHERE snapshot_id=? ORDER BY etv DESC, volume DESC", last.id);
  return { snapshots: snaps.map(({ metrics, ...s }) => ({ ...s, top3: (metrics.pos_1 || 0) + (metrics.pos_2_3 || 0), top10: (metrics.pos_1 || 0) + (metrics.pos_2_3 || 0) + (metrics.pos_4_10 || 0), etv: metrics.etv })),
    last, items };
}
// Anchors that only link sellers and spam networks use. A domain is flagged when its own spam score is high,
// or it has no authority (rank 0) and links with spam anchors — never on one weak signal alone.
const SPAM_ANCHOR = /\b(buy|cheap|pbn|backlinks?|dofollow|da\s*\d+|pa\s*\d+|casino|slot|porn|xxx|viagra|cialis|loan|betting|crypto|seo service|rank first page|link building|citation flow)\b/i;
export function spamReview(data) {
  const spamAnchors = data.anchors.filter((a) => SPAM_ANCHOR.test(a.anchor || ""));
  const anchorShare = data.anchors.length ? spamAnchors.reduce((t, a) => t + a.backlinks, 0) / data.anchors.reduce((t, a) => t + a.backlinks, 0) : 0;
  const flagged = data.referringDomains.filter((d) => (d.spam ?? 0) >= 60 || ((d.rank ?? 0) === 0 && anchorShare >= 0.5)).map((d) => d.domain);
  return { spamAnchors: spamAnchors.map((a) => a.anchor), anchorShare, flagged };
}

export function backlinksData(projectId) {
  const snaps = all("SELECT id, fetched_at, backlinks, ref_domains, rank, dofollow, spam_score FROM bl_snapshots WHERE project_id=? ORDER BY id", projectId);
  const last = snaps.at(-1);
  if (!last) return { snapshots: [] };
  const data = JSON.parse(get("SELECT data FROM bl_snapshots WHERE id=?", last.id).data);
  return { snapshots: snaps, last: { ...last, data }, spam: spamReview(data) };
}

/** Google disavow file (domain: lines) for the flagged domains. Review before uploading. */
export function disavowFile(projectId) {
  const d = backlinksData(projectId);
  if (!d.last) fail(404, "Fetch backlinks first");
  const p = get("SELECT name, start_url FROM projects WHERE id=?", projectId);
  return [`# Disavow file for ${p.start_url} — generated ${new Date().toISOString().slice(0, 10)} by SEO Auditor`,
    "# Review every line. Upload at https://search.google.com/search-console/disavow-links (URL-prefix property).",
    "# Google ignores most spam links on its own; disavow only if you see a manual action or a clear spam attack.",
    ...d.spam.flagged.map((x) => `domain:${x}`)].join("\r\n") + "\r\n";
}

let balanceCache = null; // the balance lookup is free but slow; refresh every 10 min or after spending
export async function status() {
  const out = { configured: Boolean(login()), budget: budget(), spent: spentThisMonth(), source: config().dfsLogin ? "app settings" : config().dfsConfigPath || MCP_JSON };
  if (out.configured) {
    try {
      if (!balanceCache || Date.now() - balanceCache.at > 600000 || balanceCache.spent !== out.spent) {
        const u = await dfs("appendix/user_data", null, null, "GET");
        balanceCache = { at: Date.now(), spent: out.spent, balance: u.money?.balance ?? null };
      }
      out.balance = balanceCache.balance;
    } catch (e) { out.error = e.message; }
  }
  out.recent = all("SELECT ts, endpoint, cost, (SELECT name FROM projects p WHERE p.id=project_id) project FROM dfs_costs ORDER BY id DESC LIMIT 20");
  return out;
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/dfs\/status$/, () => status()]);
  routes.push(["PUT", /^\/api\/config$/, (p, q, b) => {
    const patch = {};
    if (b.dfsMonthlyBudget !== undefined) { const n = Number(b.dfsMonthlyBudget); if (!(n >= 0 && n <= 1000)) fail(400, "Budget must be 0–1000"); patch.dfsMonthlyBudget = n; }
    if (b.dfsLogin !== undefined) patch.dfsLogin = String(b.dfsLogin).slice(0, 200);
    if (b.dfsPassword !== undefined && b.dfsPassword !== "") patch.dfsPassword = String(b.dfsPassword).slice(0, 200);
    if (b.gscKeyFile !== undefined) patch.gscKeyFile = String(b.gscKeyFile).slice(0, 500);
    if (b.dfsConfigPath !== undefined) patch.dfsConfigPath = String(b.dfsConfigPath).slice(0, 500);
    const c = saveConfig(patch);
    return { dfsMonthlyBudget: c.dfsMonthlyBudget ?? 2, dfsLogin: c.dfsLogin || "", gscKeyFile: c.gscKeyFile || "", dfsConfigPath: c.dfsConfigPath || "" };
  }]);
  routes.push(["GET", /^\/api\/config$/, () => { const c = config(); return { dfsMonthlyBudget: c.dfsMonthlyBudget ?? 2, dfsLogin: c.dfsLogin || "", hasPassword: Boolean(c.dfsPassword), gscKeyFile: c.gscKeyFile || "", dfsConfigPath: c.dfsConfigPath || "" }; }]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/keywords$/, ([id]) => keywordsData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/keywords$/, ([id]) => fetchKeywords(project(id))]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/backlinks$/, ([id]) => backlinksData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/backlinks$/, ([id]) => fetchBacklinks(project(id))]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/disavow\.txt$/, ([id]) => ({ __raw: true, body: disavowFile(project(id).id), type: "text/plain; charset=utf-8",
    headers: { "Content-Disposition": `attachment; filename="disavow-${id}.txt"` } })]);
}
