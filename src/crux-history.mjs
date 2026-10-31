// Core Web Vitals field-data trends from the free Chrome UX Report History API: 25 weekly collection periods (each a
// 28-day window) of p75 values and good / needs-improvement / poor shares, for the origin and the pages Lighthouse
// measured, phone and desktop. Same free key as crux.mjs (header, never in the URL or an error). Registered from
// cwv.mjs after crux.mjs, so it runs after Lighthouse and the current field data.
import { db, all, get, run } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";
import { cruxKey, measuredUrls, FIELD_THRESHOLDS, NO_DATA, NO_KEY } from "./crux.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS crux_history (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, url TEXT NOT NULL, form_factor TEXT NOT NULL, metric TEXT, period_end TEXT, p75 REAL, good REAL, ni REAL, poor REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')), error TEXT);
CREATE INDEX IF NOT EXISTS idx_crux_history ON crux_history(project_id);
`);

export const HISTORY_ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";
export const HISTORY_METRICS = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"];
export const MAX_HISTORY_URLS = 10; // 2 + 10 × 2 = 22 requests, well under the free 150 a minute
const FORM_FACTORS = ["PHONE", "DESKTOP"];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const num = (v) => { if (v === null || v === undefined || v === "NaN") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const ymd = (d) => (d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null);

/** History record → { periods: [lastDate…], metrics: { metric: [{ end, p75, good, ni, poor }…] } } (missing weeks are null). */
export function parseHistory(json) {
  const rec = json?.record || {};
  const periods = (rec.collectionPeriods || []).map((p) => ymd(p.lastDate));
  const metrics = {};
  for (const k of HISTORY_METRICS) {
    const x = rec.metrics?.[k]; if (!x) continue;
    const p75s = x.percentilesTimeseries?.p75s || [], dens = (i) => x.histogramTimeseries?.[i]?.densities || [];
    metrics[k] = periods.map((end, i) => ({ end, p75: num(p75s[i]), good: num(dens(0)[i]), ni: num(dens(1)[i]), poor: num(dens(2)[i]) }));
  }
  return { periods, metrics };
}

/** One queryHistoryRecord call. target = { origin } or { url }. Returns { periods, metrics } | { noData } | { error }. */
export async function queryHistory(target, formFactor, key = cruxKey(), fetchImpl = globalThis.fetch) {
  if (!key) fail(400, NO_KEY);
  let res;
  try {
    res = await fetchImpl(HISTORY_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({ ...target, formFactor, metrics: HISTORY_METRICS }), signal: AbortSignal.timeout(30000) });
  } catch (e) { return { error: `Chrome UX Report History API not reachable (${e.name === "TimeoutError" ? "timed out" : "network error"})` }; }
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) return { noData: true };
  if (!res.ok) return { error: `Chrome UX Report History API ${res.status}: ${String(j.error?.message || res.statusText || "").split(key).join("[key]").slice(0, 200)}` };
  const h = parseHistory(j);
  return Object.keys(h.metrics).length ? h : { noData: true };
}

/** Origin and up to MAX_HISTORY_URLS pages, phone and desktop; replaces the project's stored history. */
export async function refreshCruxHistory(project, urls = [], { fetch: fetchImpl = globalThis.fetch, onStep } = {}) {
  const key = cruxKey();
  if (!key) fail(400, NO_KEY);
  const pages = [...new Set(urls)].slice(0, MAX_HISTORY_URLS);
  const origin = new URL(pages[0] || project.start_url).origin;
  const jobs = [...FORM_FACTORS.map((ff) => ["origin", origin, ff]), ...pages.flatMap((u) => FORM_FACTORS.map((ff) => ["url", u, ff]))];
  const results = [];
  for (const [i, [scope, url, ff]] of jobs.entries()) {
    onStep?.(i + 1, jobs.length);
    results.push([scope, url, ff, await queryHistory(scope === "origin" ? { origin: url } : { url }, ff, key, fetchImpl)]);
  }
  db.exec("BEGIN");
  try {
    run("DELETE FROM crux_history WHERE project_id=?", project.id);
    const ins = db.prepare("INSERT INTO crux_history (project_id, scope, url, form_factor, metric, period_end, p75, good, ni, poor, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const [scope, url, ff, r] of results) {
      if (r.metrics) for (const [m, pts] of Object.entries(r.metrics)) for (const p of pts) ins.run(project.id, scope, url, ff, m, p.end, p.p75, p.good, p.ni, p.poor, null);
      else ins.run(project.id, scope, url, ff, null, null, null, null, null, null, r.noData ? NO_DATA : r.error);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return cruxHistoryData(project.id);
}

/** Stored trends: records[] = { scope, url, formFactor, noData, error, metrics: { metric: [{ end, p75, good, ni, poor }] } }. */
export function cruxHistoryData(projectId) {
  const enabled = Boolean(cruxKey());
  const rows = all("SELECT scope, url, form_factor, metric, period_end, p75, good, ni, poor, fetched_at, error FROM crux_history WHERE project_id=? ORDER BY rowid", projectId);
  const recs = new Map();
  for (const r of rows) {
    const k = `${r.scope} ${r.form_factor} ${r.url}`;
    if (!recs.has(k)) recs.set(k, { scope: r.scope, url: r.url, formFactor: r.form_factor, metrics: {}, noData: false, error: null });
    const rec = recs.get(k);
    if (r.metric) (rec.metrics[r.metric] ||= []).push({ end: r.period_end, p75: r.p75, good: r.good, ni: r.ni, poor: r.poor });
    else if (r.error === NO_DATA) rec.noData = true;
    else rec.error = r.error;
  }
  return { enabled, message: enabled ? null : NO_KEY, noDataMessage: NO_DATA, thresholds: FIELD_THRESHOLDS, fetchedAt: rows[0]?.fetched_at || null, records: [...recs.values()] };
}

let busy = false, registered = false;
export function register({ routes }) {
  if (registered) return;
  registered = true;
  afterAudit.push(async (auditId, project) => {
    if (!cruxKey()) return;
    phase(project.id, auditId, "Chrome UX Report history (25-week trend)");
    await refreshCruxHistory(project, measuredUrls(auditId)).catch((e) => console.error("crux history:", e.message));
  });
  routes.push(["GET", /^\/api\/projects\/(\d+)\/crux-history$/, ([id]) => ({ ...cruxHistoryData(Number(id)), running: busy })]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/crux-history$/, async ([id], q, body) => {
    const project = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    if (!cruxKey()) fail(400, NO_KEY);
    if (busy) fail(409, "Field data history is already being fetched");
    const a = Number(body?.auditId) ? get("SELECT id FROM audits WHERE id=? AND project_id=?", Number(body.auditId), project.id)
      : get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
    busy = true;
    try { return await refreshCruxHistory(project, a ? measuredUrls(a.id) : []); } finally { busy = false; }
  }]);
}
