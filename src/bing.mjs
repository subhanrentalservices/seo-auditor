// Bing Webmaster Tools API (free; an API key from Bing Webmaster Tools → Settings → API access): daily clicks and
// impressions, top queries and pages, crawl stats, crawl issues and a sample of inbound links. The key is write-only
// (data/config.json, never returned, never logged, removed from every stored error: Bing takes it as ?apikey=, which the
// shared redact() does not catch on its own). Each part is fetched on its own; a failed part is recorded in meta
// bing:<pid> and keeps its previous rows. fetch is injectable so tests never call Bing.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";
import { config } from "./gsc.mjs";
import { saveConfig } from "./dataforseo.mjs";
import { redact } from "./alert-channels.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS bing_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, date TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER, crawled_pages INTEGER, crawl_errors INTEGER, in_index INTEGER, in_links INTEGER, code_4xx INTEGER, code_5xx INTEGER,
  PRIMARY KEY (project_id, date));
CREATE TABLE IF NOT EXISTS bing_rows (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, kind TEXT NOT NULL, key TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER, position REAL, PRIMARY KEY (project_id, kind, key));
CREATE TABLE IF NOT EXISTS bing_crawl_issues (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL,
  issues INTEGER, http_code INTEGER, in_links INTEGER, PRIMARY KEY (project_id, url));
CREATE TABLE IF NOT EXISTS bing_links (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, url TEXT NOT NULL, count INTEGER,
  PRIMARY KEY (project_id, url));
CREATE TABLE IF NOT EXISTS bing_link_sources (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, target TEXT NOT NULL,
  source TEXT NOT NULL, anchor TEXT);
`);

export const API = "https://ssl.bing.com/webmaster/api.svc/json/";
export const NO_KEY = "Bing Webmaster Tools needs an API key: Bing Webmaster Tools → Settings → API access → API key, then paste it in App settings.";
const KEY_RE = /^[A-Za-z0-9]{16,64}$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const bingKey = () => { const k = config().bingApiKey; return typeof k === "string" ? k.trim() : ""; };

// Crawl issue bit flags (Bing's CrawlIssues enum).
export const ISSUE_FLAGS = [[1, "301 redirect"], [2, "302 redirect"], [4, "4xx error"], [8, "5xx error"], [16, "Blocked by robots.txt"],
  [32, "Malware"], [64, "Important URL blocked by robots.txt"], [128, "DNS error"], [256, "Timeout"]];
export const issueLabels = (flags) => ISSUE_FLAGS.filter(([bit]) => (Number(flags) & bit) !== 0).map(([, label]) => label);

/** "/Date(1316156400000-0700)/" → "2011-09-16" (the day in the offset Bing gives). */
export function parseDate(v) {
  const m = String(v || "").match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (!m) return null;
  let ms = Number(m[1]);
  if (m[2]) { const sign = m[2][0] === "-" ? -1 : 1; ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3))) * 60e3; }
  return new Date(ms).toISOString().slice(0, 10);
}

/** One API call: GET <API><method>?…&apikey=… → the "d" payload. Errors carry Bing's message, never the key. */
export async function bingCall(method, params = {}, { key = bingKey(), fetchFn = fetch } = {}) {
  if (!key) fail(400, NO_KEY);
  const url = `${API}${method}?${new URLSearchParams({ ...params, apikey: key })}`;
  const clean = (s) => redact(String(s), [key, encodeURIComponent(key)]).replace(/(apikey=)[^&\s"'<>]+/gi, "$1[hidden]").slice(0, 300);
  let res, j;
  try { res = await fetchFn(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) }); j = await res.json().catch(() => ({})); }
  catch (e) { throw Object.assign(new Error(clean(`Bing ${method}: not reachable (${e.name === "TimeoutError" ? "timed out" : e.message})`)), { status: 502 }); }
  if (!res.ok || j?.ErrorCode) {
    const msg = j?.Message || res.statusText || "";
    const hint = /InvalidApiKey|NotAuthorized/i.test(msg) || res.status === 401 ? " (check the API key in App settings)" : "";
    throw Object.assign(new Error(clean(`Bing ${method}: ${res.status} ${msg}${hint}`)), { status: 502 });
  }
  return j?.d ?? null;
}

const norm = (u) => { try { const x = new URL(u); return { origin: x.origin, host: x.hostname.replace(/^www\./, "") }; } catch { return null; } };
/** The Bing site matching the project: the same origin, else the same host (with or without www). */
export async function detectSite(startUrl, call) {
  const sites = ((await call("GetUserSites")) || []).map((s) => s.Url).filter(Boolean);
  const p = norm(startUrl);
  return sites.find((s) => norm(s)?.origin === p.origin) || sites.find((s) => norm(s)?.host === p.host) || null;
}

/** Weekly query/page rows → one row per key: summed clicks/impressions, impression-weighted average position. */
export function aggregate(rows, keyField) {
  const m = new Map();
  for (const r of rows || []) {
    const k = r[keyField]; if (!k) continue;
    const a = m.get(k) || { key: k, clicks: 0, impressions: 0, w: 0, wi: 0 };
    a.clicks += Number(r.Clicks) || 0; a.impressions += Number(r.Impressions) || 0;
    const pos = Number(r.AvgImpressionPosition);
    if (pos > 0 && r.Impressions > 0) { a.w += pos * r.Impressions; a.wi += Number(r.Impressions); }
    m.set(k, a);
  }
  return [...m.values()].map((a) => ({ key: a.key, clicks: a.clicks, impressions: a.impressions, position: a.wi ? a.w / a.wi : null }));
}

/** Fetches every part and saves it. Returns the stored data plus per-part errors. */
export async function refreshBing(project, { fetchFn = fetch, now = Date.now() } = {}) {
  const key = bingKey();
  if (!key) fail(400, NO_KEY);
  const call = (method, params) => bingCall(method, params, { key, fetchFn });
  const s = projectSettings(project);
  const siteUrl = s.bingSiteUrl?.trim() || (await detectSite(project.start_url, call));
  if (!siteUrl) fail(400, "This site isn't in your Bing Webmaster Tools account. Add and verify it there (or import it from Search Console), or enter the site URL exactly as Bing lists it on the Bing screen.");
  const part = (fn) => fn().catch((e) => ({ error: e.message }));
  const [traffic, queries, pages, crawl, issues, links] = await Promise.all([
    part(() => call("GetRankAndTrafficStats", { siteUrl })),
    part(() => call("GetQueryStats", { siteUrl })),
    part(() => call("GetPageStats", { siteUrl })),
    part(() => call("GetCrawlStats", { siteUrl })),
    part(() => call("GetCrawlIssues", { siteUrl })),
    part(async () => {
      const counts = (await call("GetLinkCounts", { siteUrl, page: 0 }))?.Links || [];
      const top = [...counts].sort((a, b) => b.Count - a.Count)[0];
      const sample = top ? (await call("GetUrlLinks", { siteUrl, link: top.Url, page: 0 }))?.Details || [] : [];
      return { counts, top: top?.Url || null, sample };
    }),
  ]);
  const errors = {}, isErr = (x) => x && !Array.isArray(x) && x.error;
  const dates = [...(Array.isArray(queries) ? queries : []), ...(Array.isArray(pages) ? pages : [])].map((r) => parseDate(r.Date)).filter(Boolean).sort();
  db.exec("BEGIN");
  try {
    if (isErr(traffic)) errors.traffic = traffic.error; else {
      const up = db.prepare(`INSERT INTO bing_daily (project_id, date, clicks, impressions) VALUES (?,?,?,?)
        ON CONFLICT(project_id, date) DO UPDATE SET clicks=excluded.clicks, impressions=excluded.impressions`);
      for (const r of traffic || []) { const d = parseDate(r.Date); if (d) up.run(project.id, d, Number(r.Clicks) || 0, Number(r.Impressions) || 0); }
    }
    if (isErr(crawl)) errors.crawl = crawl.error; else {
      const up = db.prepare(`INSERT INTO bing_daily (project_id, date, crawled_pages, crawl_errors, in_index, in_links, code_4xx, code_5xx) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, date) DO UPDATE SET crawled_pages=excluded.crawled_pages, crawl_errors=excluded.crawl_errors, in_index=excluded.in_index,
        in_links=excluded.in_links, code_4xx=excluded.code_4xx, code_5xx=excluded.code_5xx`);
      for (const r of crawl || []) { const d = parseDate(r.Date); if (d) up.run(project.id, d, r.CrawledPages ?? null, r.CrawlErrors ?? null, r.InIndex ?? null, r.InLinks ?? null, r.Code4xx ?? null, r.Code5xx ?? null); }
    }
    for (const [kind, rows, field] of [["query", queries, "Query"], ["page", pages, "Query"]]) {
      if (isErr(rows)) { errors[kind === "query" ? "queries" : "pages"] = rows.error; continue; }
      run("DELETE FROM bing_rows WHERE project_id=? AND kind=?", project.id, kind);
      const ins = db.prepare("INSERT OR REPLACE INTO bing_rows (project_id, kind, key, clicks, impressions, position) VALUES (?,?,?,?,?,?)");
      for (const a of aggregate(rows, field)) ins.run(project.id, kind, a.key, a.clicks, a.impressions, a.position);
    }
    if (isErr(issues)) errors.issues = issues.error; else {
      run("DELETE FROM bing_crawl_issues WHERE project_id=?", project.id);
      const ins = db.prepare("INSERT OR REPLACE INTO bing_crawl_issues (project_id, url, issues, http_code, in_links) VALUES (?,?,?,?,?)");
      for (const r of issues || []) if (r.Url) ins.run(project.id, r.Url, Number(r.Issues) || 0, r.HttpCode ?? null, r.InLinks ?? null);
    }
    if (isErr(links)) errors.links = links.error; else {
      run("DELETE FROM bing_links WHERE project_id=?", project.id);
      run("DELETE FROM bing_link_sources WHERE project_id=?", project.id);
      const il = db.prepare("INSERT OR REPLACE INTO bing_links (project_id, url, count) VALUES (?,?,?)");
      for (const r of links.counts) if (r.Url) il.run(project.id, r.Url, Number(r.Count) || 0);
      const is = db.prepare("INSERT INTO bing_link_sources (project_id, target, source, anchor) VALUES (?,?,?,?)");
      for (const r of links.sample) if (r.Url) is.run(project.id, links.top, r.Url, r.AnchorText || "");
    }
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", `bing:${project.id}`,
      JSON.stringify({ siteUrl, fetchedAt: new Date(now).toISOString(), rowsFrom: dates[0] || null, rowsTo: dates.at(-1) || null, errors }));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return bingData(project.id);
}

/** Stored Bing data for the Bing screen. */
export function bingData(projectId) {
  const m = JSON.parse(get("SELECT value FROM meta WHERE key=?", `bing:${projectId}`)?.value || "null");
  const out = { hasKey: Boolean(bingKey()), message: bingKey() ? null : NO_KEY, siteUrl: m?.siteUrl || null, fetchedAt: m?.fetchedAt || null,
    rowsFrom: m?.rowsFrom || null, rowsTo: m?.rowsTo || null, errors: m?.errors || {} };
  const last = get("SELECT MAX(date) d FROM bing_daily WHERE project_id=? AND clicks IS NOT NULL", projectId)?.d;
  const from = last ? new Date(Date.parse(last) - 27 * 864e5).toISOString().slice(0, 10) : null;
  const totals = last ? get("SELECT SUM(clicks) clicks, SUM(impressions) impressions FROM bing_daily WHERE project_id=? AND date BETWEEN ? AND ?", projectId, from, last) : null;
  const rows = (kind) => all("SELECT key, clicks, impressions, position FROM bing_rows WHERE project_id=? AND kind=? ORDER BY clicks DESC, impressions DESC LIMIT 200", projectId, kind);
  return { ...out, totals: totals ? { ...totals, from, to: last } : null,
    daily: all("SELECT date, clicks, impressions, crawled_pages crawledPages, crawl_errors crawlErrors, in_index inIndex, in_links inLinks, code_4xx code4xx, code_5xx code5xx FROM bing_daily WHERE project_id=? ORDER BY date", projectId),
    queries: rows("query"), pages: rows("page"),
    crawlIssues: all("SELECT url, issues, http_code httpCode, in_links inLinks FROM bing_crawl_issues WHERE project_id=? ORDER BY in_links DESC, url LIMIT 500", projectId)
      .map((r) => ({ ...r, labels: issueLabels(r.issues) })),
    links: { targets: all("SELECT url, count FROM bing_links WHERE project_id=? ORDER BY count DESC LIMIT 50", projectId),
      sample: all("SELECT target, source, anchor FROM bing_link_sources WHERE project_id=? ORDER BY rowid LIMIT 200", projectId) } };
}

/** PUT /api/bing/config body: { apiKey (empty = keep), clear }. Returns only whether a key is saved. */
export function updateBingConfig(b = {}) {
  if (b.apiKey !== undefined && b.apiKey !== "") {
    const k = String(b.apiKey).trim();
    if (!KEY_RE.test(k)) fail(400, "That doesn't look like a Bing Webmaster API key (16–64 letters and digits).");
    saveConfig({ bingApiKey: k });
  }
  if (b.clear === true) saveConfig({ bingApiKey: "" });
  return { hasKey: Boolean(bingKey()) };
}

const busy = new Set();
export function register({ routes }) {
  afterAudit.push(async (auditId, project) => {
    if (!bingKey()) return;
    const last = get("SELECT value FROM meta WHERE key=?", `bing:${project.id}`);
    if (last && Date.now() - Date.parse(JSON.parse(last.value).fetchedAt) < 12 * 3600e3) return;
    phase(project.id, auditId, "Bing Webmaster Tools");
    await refreshBing(get("SELECT * FROM projects WHERE id=?", project.id)).catch((e) => console.error("bing:", redact(e.message, [bingKey()])));
  });
  routes.push(["GET", /^\/api\/bing\/config$/, () => ({ hasKey: Boolean(bingKey()) })]);
  routes.push(["PUT", /^\/api\/bing\/config$/, (p, q, b) => updateBingConfig(b)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/bing$/, ([id]) => ({ ...bingData(Number(id)), running: busy.has(Number(id)) })]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/bing$/, async ([id]) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    if (busy.has(p.id)) fail(409, "Bing data is already being fetched");
    busy.add(p.id);
    try { return await refreshBing(p); } finally { busy.delete(p.id); }
  }]);
}
