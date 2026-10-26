// Core Web Vitals field data from Google's free Chrome UX Report (CrUX) API: real Chrome users, 28-day p75, the data
// Google uses for page experience. Needs a free API key in App settings (data/config.json). The key is sent in a
// header (not the URL), never returned by /api/config and never logged. Sites with too few Chrome users get a 404:
// stored and shown as "not enough data", not as an error. Registered from cwv.mjs, so it runs after Lighthouse.
import { db, all, get, run } from "./db.mjs";
import { config } from "./gsc.mjs";
import { afterAudit, phase } from "./runner.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS crux (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL, url TEXT NOT NULL, form_factor TEXT NOT NULL, metric TEXT, p75 REAL, good REAL, ni REAL, poor REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')), error TEXT);
CREATE INDEX IF NOT EXISTS idx_crux ON crux(project_id);
`);

export const ENDPOINT = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const METRICS = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift", "first_contentful_paint", "experimental_time_to_first_byte"];
// Google's good / poor limits (good ≤ first, poor > second). LCP, INP, CLS are the Core Web Vitals.
export const FIELD_THRESHOLDS = { largest_contentful_paint: [2500, 4000], interaction_to_next_paint: [200, 500], cumulative_layout_shift: [0.1, 0.25],
  first_contentful_paint: [1800, 3000], experimental_time_to_first_byte: [800, 1800] };
export const NO_DATA = "Not enough Chrome users for field data";
export const NO_KEY = "Field data needs a free Chrome UX Report API key: add it in App settings.";
const MAX_URLS = 50; // the free quota is 150 requests a minute

export const cruxKey = () => { const k = config().cruxApiKey; return typeof k === "string" ? k.trim() : ""; };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** CrUX record → { metric: { p75, good, ni, poor } } (histogram densities 0–1; CLS p75 arrives as a string). */
export function parseRecord(json) {
  const m = json?.record?.metrics || {}, out = {};
  for (const k of METRICS) {
    const x = m[k]; if (!x) continue;
    const p = Number(x.percentiles?.p75);
    const d = (i) => { const v = x.histogram?.[i]?.density; return v === undefined || v === null ? null : Number(v); };
    out[k] = { p75: Number.isFinite(p) ? p : null, good: d(0), ni: d(1), poor: d(2) };
  }
  return out;
}

/** One queryRecord call. target = { origin } or { url }. Returns { metrics } | { noData: true } | { error }. */
export async function queryRecord(target, formFactor, key = cruxKey()) {
  if (!key) fail(400, NO_KEY);
  let res;
  try {
    res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({ ...target, formFactor, metrics: METRICS }), signal: AbortSignal.timeout(30000) });
  } catch (e) { return { error: `Chrome UX Report API not reachable (${e.name === "TimeoutError" ? "timed out" : "network error"})` }; }
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) return { noData: true };
  if (!res.ok) return { error: `Chrome UX Report API ${res.status}: ${String(j.error?.message || res.statusText || "").split(key).join("[key]").slice(0, 200)}` };
  const metrics = parseRecord(j);
  return Object.keys(metrics).length ? { metrics } : { noData: true };
}

/** Pages Lighthouse measured in an audit (the URL-level CrUX lookups). */
export const measuredUrls = (auditId) => all("SELECT url FROM cwv WHERE audit_id=? ORDER BY rowid", auditId).map((r) => r.url);

/** Origin (phone + desktop) and per-URL (phone, like Lighthouse's mobile run) records; replaces the project's last set. */
export async function refreshCrux(project, urls = [], onStep) {
  const key = cruxKey();
  if (!key) fail(400, NO_KEY);
  const pages = [...new Set(urls)].slice(0, MAX_URLS);
  const origin = new URL(pages[0] || project.start_url).origin;
  const jobs = [["origin", origin, "PHONE"], ["origin", origin, "DESKTOP"], ...pages.map((u) => ["url", u, "PHONE"])];
  const results = [];
  for (const [i, [scope, url, ff]] of jobs.entries()) {
    onStep?.(i + 1, jobs.length);
    results.push([scope, url, ff, await queryRecord(scope === "origin" ? { origin: url } : { url }, ff, key)]);
  }
  db.exec("BEGIN");
  try {
    run("DELETE FROM crux WHERE project_id=?", project.id);
    const ins = db.prepare("INSERT INTO crux (project_id, scope, url, form_factor, metric, p75, good, ni, poor, error) VALUES (?,?,?,?,?,?,?,?,?,?)");
    for (const [scope, url, ff, r] of results) {
      if (r.metrics) for (const [m, v] of Object.entries(r.metrics)) ins.run(project.id, scope, url, ff, m, v.p75, v.good, v.ni, v.poor, null);
      else ins.run(project.id, scope, url, ff, null, null, null, null, null, r.noData ? NO_DATA : r.error);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return cruxData(project.id);
}

/** Stored field data: origin.PHONE / origin.DESKTOP and urls[], each { metrics, noData, error }. */
export function cruxData(projectId) {
  const enabled = Boolean(cruxKey());
  const rows = all("SELECT scope, url, form_factor, metric, p75, good, ni, poor, fetched_at, error FROM crux WHERE project_id=? ORDER BY rowid", projectId);
  const recs = new Map();
  for (const r of rows) {
    const k = `${r.scope} ${r.form_factor} ${r.url}`;
    if (!recs.has(k)) recs.set(k, { scope: r.scope, url: r.url, formFactor: r.form_factor, metrics: {}, noData: false, error: null });
    const rec = recs.get(k);
    if (r.metric) rec.metrics[r.metric] = { p75: r.p75, good: r.good, ni: r.ni, poor: r.poor };
    else if (r.error === NO_DATA) rec.noData = true;
    else rec.error = r.error;
  }
  const list = [...recs.values()];
  const origin = (ff) => list.find((r) => r.scope === "origin" && r.formFactor === ff) || null;
  return { enabled, message: enabled ? null : NO_KEY, noDataMessage: NO_DATA, thresholds: FIELD_THRESHOLDS, fetchedAt: rows[0]?.fetched_at || null,
    origin: { PHONE: origin("PHONE"), DESKTOP: origin("DESKTOP") }, urls: list.filter((r) => r.scope === "url") };
}

let registered = false, busy = false;
export function register({ routes }) {
  if (registered) return; // cwv.mjs registers this module; a second entry in server.mjs is harmless
  registered = true;
  afterAudit.push(async (auditId, project) => {
    if (!cruxKey()) return;
    phase(project.id, auditId, "Chrome UX Report (field data)");
    await refreshCrux(project, measuredUrls(auditId)).catch((e) => console.error("crux:", e.message));
  });
  routes.push(["GET", /^\/api\/projects\/(\d+)\/crux$/, ([id]) => ({ ...cruxData(Number(id)), running: busy })]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/crux$/, async ([id], q, body) => {
    const project = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    if (!cruxKey()) fail(400, NO_KEY);
    if (busy) fail(409, "Field data is already being fetched");
    const a = Number(body?.auditId) ? get("SELECT id FROM audits WHERE id=? AND project_id=?", Number(body.auditId), project.id)
      : get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
    busy = true;
    try { return await refreshCrux(project, a ? measuredUrls(a.id) : []); } finally { busy = false; }
  }]);
}
