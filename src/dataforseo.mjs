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
export const dfsConfigured = () => Boolean(login());
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
  // "Task completed with partial results": the first pages came back (later ones did not, and are not charged). Keep them.
  const partial = t?.result?.[0] && /partial results/i.test(t.status_message || "");
  if (j.status_code !== 20000 || !t || (t.status_code !== 20000 && !partial)) fail(502, `DataForSEO: ${t?.status_message || j.status_message || res.status}`);
  return t.result?.[0] || {};
}

const domainOf = (p) => new URL(p.start_url).hostname.replace(/^www\./, "");
// How many referring domains and anchors each backlinks snapshot stores (the diff and the anchor mix only see these).
export const RD_LIST_CAP = 100, ANCHOR_LIST_CAP = 30;

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
  const refs = await dfs("backlinks/referring_domains/live", { target, include_subdomains: true, limit: RD_LIST_CAP, order_by: ["rank,desc"], backlinks_status_type: "live" }, project.id);
  const anchors = await dfs("backlinks/anchors/live", { target, include_subdomains: true, limit: ANCHOR_LIST_CAP, order_by: ["backlinks,desc"], backlinks_status_type: "live" }, project.id);
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

// ---------- Snapshot diff and anchor mix: stored snapshots only, no paid call ----------
/** Referring domains gained and lost between two snapshots ({...bl_snapshots row, data}), totals delta, new spam domains. */
export function snapshotDiff(prev, last) {
  const pd = prev.data.referringDomains || [], ld = last.data.referringDomains || [];
  const before = new Set(pd.map((d) => d.domain)), now = new Set(ld.map((d) => d.domain));
  const gained = ld.filter((d) => !before.has(d.domain)), lost = pd.filter((d) => !now.has(d.domain));
  const capped = pd.length >= RD_LIST_CAP || ld.length >= RD_LIST_CAP;
  const has = (v) => v !== null && v !== undefined;
  const totals = Object.fromEntries(["backlinks", "ref_domains", "dofollow", "rank", "spam_score"].map((k) => [k, has(last[k]) && has(prev[k]) ? last[k] - prev[k] : null]));
  return { since: prev.fetched_at, until: last.fetched_at, gained, lost, totals, newSpam: gained.filter((d) => (d.spam ?? 0) >= 60).map((d) => d.domain),
    capped, cap: capped ? RD_LIST_CAP : null,
    note: capped ? `Compared from the top ${RD_LIST_CAP} referring domains (by rank) stored with each snapshot: a domain that moved into or out of the top ${RD_LIST_CAP} also shows here.` : null };
}

const GENERIC_ANCHORS = new Set(["click here", "here", "click", "this", "website", "web site", "the website", "this website", "our website", "their website",
  "official website", "site", "this site", "web", "homepage", "home page", "home", "read more", "more", "learn more", "find out more", "more info",
  "more information", "see more", "view more", "details", "visit", "visit website", "visit site", "visit us", "link", "this link", "source",
  "url", "go", "check it out", "view", "view website", "website link", "www", "continue reading"]);
const normText = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const NAKED_URL = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i;
export const ANCHOR_TYPES = { brand: "Brand", naked: "Naked URL", generic: "Generic", exact: "Exact-match commercial", other: "Other" };
export const EXACT_WARN_SHARE = 0.2;

/** Anchor share by type, weighted by backlinks. brandTerms: names/domains that count as brand; queries: Search Console
 *  queries, most clicked first (brand ones are dropped, the first topN non-brand ones are used for exact match). */
export function anchorMix(anchors, { brandTerms = [], queries = [], topN = 50 } = {}) {
  const brands = [...new Set(brandTerms.map((t) => normText(t).replace(/ /g, "")).filter((t) => t.length >= 4))];
  const isBrand = (n) => brands.some((b) => n.replace(/ /g, "").includes(b));
  const qs = [...new Set(queries.map(normText).filter((q) => q.length >= 3 && !isBrand(q)))].slice(0, topN);
  const typeOf = (anchor) => {
    const raw = String(anchor || "").trim();
    if (!raw) return "other"; // empty: image links
    if (NAKED_URL.test(raw)) return "naked";
    const n = normText(raw);
    if (isBrand(n)) return "brand";
    if (GENERIC_ANCHORS.has(n)) return "generic";
    if (qs.some((q) => n === q || ` ${n} `.includes(` ${q} `))) return "exact";
    return "other";
  };
  const by = Object.fromEntries(Object.keys(ANCHOR_TYPES).map((k) => [k, { type: k, label: ANCHOR_TYPES[k], backlinks: 0, anchors: [] }]));
  for (const a of anchors) { const t = by[typeOf(a.anchor)]; t.backlinks += a.backlinks || 0; t.anchors.push(a.anchor || "(empty / image)"); }
  const total = Object.values(by).reduce((s, t) => s + t.backlinks, 0);
  const types = Object.values(by).map((t) => ({ ...t, share: total ? t.backlinks / total : 0, anchors: t.anchors.slice(0, 5) }));
  const exactShare = total ? by.exact.backlinks / total : 0;
  return { types, total, exactShare, queriesUsed: qs.length, cap: ANCHOR_LIST_CAP, anchorsChecked: anchors.length,
    warning: exactShare > EXACT_WARN_SHARE ? `${Math.round(exactShare * 100)}% of links use exact-match commercial anchors (above ${EXACT_WARN_SHARE * 100}%). Natural profiles are mostly brand and URL anchors; a high share of keyword anchors looks bought and can draw Google's link spam systems.` : null };
}

/** Brand names for a project: its name, domain, domain label and the brand terms in project settings. */
function brandTermsOf(project) {
  const domain = domainOf(project);
  return [project.name, domain, domain.split(".")[0], ...String(projectSettings(project).brandTerms || "").split(",")].map((t) => String(t || "").trim()).filter(Boolean);
}
function topQueries(projectId) {
  try { return all("SELECT query FROM gsc_queries WHERE project_id=? GROUP BY query ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 300", projectId).map((r) => r.query); }
  catch { return []; } // no Search Console table
}

export function backlinksData(projectId) {
  const snaps = all("SELECT id, fetched_at, backlinks, ref_domains, rank, dofollow, spam_score FROM bl_snapshots WHERE project_id=? ORDER BY id", projectId);
  const last = snaps.at(-1);
  if (!last) return { snapshots: [] };
  const dataOf = (id) => JSON.parse(get("SELECT data FROM bl_snapshots WHERE id=?", id).data || "{}");
  const data = dataOf(last.id), prev = snaps.at(-2);
  const project = get("SELECT * FROM projects WHERE id=?", projectId);
  return { snapshots: snaps, last: { ...last, data }, spam: spamReview(data),
    diff: prev ? snapshotDiff({ ...prev, data: dataOf(prev.id) }, { ...last, data }) : null,
    diffNote: prev ? null : "Referring domains gained and lost appear after the next fetch: the comparison needs two snapshots.",
    anchorMix: anchorMix(data.anchors || [], { brandTerms: project ? brandTermsOf(project) : [], queries: topQueries(projectId) }) };
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
    // Chrome UX Report API key: write-only (empty = keep the saved one). Never returned, never logged.
    if (b.cruxApiKey !== undefined && b.cruxApiKey !== "") {
      const k = String(b.cruxApiKey).trim();
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(k)) fail(400, "That doesn't look like a Google API key (letters, digits, - and _, usually starting AIza).");
      patch.cruxApiKey = k;
    }
    if (b.clearCruxKey === true) patch.cruxApiKey = "";
    if (b.dfsConfigPath !== undefined) {
      patch.dfsConfigPath = String(b.dfsConfigPath).trim().slice(0, 500);
      if (patch.dfsConfigPath && !existsSync(patch.dfsConfigPath)) fail(400, `File not found: ${patch.dfsConfigPath}`);
    }
    const c = saveConfig(patch);
    return { dfsMonthlyBudget: c.dfsMonthlyBudget ?? 2, dfsLogin: c.dfsLogin || "", gscKeyFile: c.gscKeyFile || "", dfsConfigPath: c.dfsConfigPath || "", hasCruxKey: Boolean(c.cruxApiKey) };
  }]);
  routes.push(["GET", /^\/api\/config$/, () => { const c = config(); return { dfsMonthlyBudget: c.dfsMonthlyBudget ?? 2, dfsLogin: c.dfsLogin || "", hasPassword: Boolean(c.dfsPassword), gscKeyFile: c.gscKeyFile || "", dfsConfigPath: c.dfsConfigPath || "", hasCruxKey: Boolean(c.cruxApiKey) }; }]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/keywords$/, ([id]) => keywordsData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/keywords$/, ([id]) => fetchKeywords(project(id))]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/backlinks$/, ([id]) => backlinksData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/backlinks$/, ([id]) => fetchBacklinks(project(id))]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/disavow\.txt$/, ([id]) => ({ __raw: true, body: disavowFile(project(id).id), type: "text/plain; charset=utf-8",
    headers: { "Content-Disposition": `attachment; filename="disavow-${id}.txt"` } })]);
}
