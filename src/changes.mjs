// Change log and impact (taught across the Ahrefs and Brian Dean videos: log every change, compare before and after
// over weeks, use unchanged pages as a control). Each SEO change is stored with the day it went live and its pages;
// its effect is read from Search Console page×day data (gsc_page_daily, fetched by gsc.mjs refresh()): N days before
// vs N days after (14, 28 and since the change), next to the same comparison for every other page of the site.
// "vs rest of site" = the change's % change minus the rest of the site's (difference in differences). It shows how the
// pages did against the site's own trend; it never proves the change caused it.
import { db, all, get, run } from "./db.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS seo_changes (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date TEXT NOT NULL, urls TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_seo_changes ON seo_changes(project_id, date);
`);

export const KINDS = ["title", "content", "links", "technical", "schema", "new-page", "redirect", "other"];
export const WINDOWS = [14, 28];
export const MIN_AFTER_DAYS = 7; // days of after-data before anything is compared
const LAG_DAYS = 3;              // Search Console's final data is about 3 days behind
const MIN_CLICKS = 10;           // fewer clicks than this before the change: judge on impressions instead
const MARGIN = 0.1;              // ±10 points vs the rest of the site counts as ahead / behind
const MAX_SUMMARY = 500, MAX_REF = 200, MAX_URLS = 200;

const DAY = 864e5;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "").toLowerCase();
/** Same page whatever the www, trailing slash, index.html or case (as in decay.mjs). */
export const norm = (u) => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/index\.html?$/, "/").replace(/(.)\/$/, "$1")).toLowerCase(); } catch { return String(u); } };
const isDay = (s) => { const t = Date.parse(s + "T00:00:00Z"); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s; };

function project(id) {
  const p = get("SELECT * FROM projects WHERE id=?", Number(id));
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  return p;
}

/** Checks a change before it is stored: a real day (not in the future), a known kind, a short summary and pages of
 *  this site (full URLs, or paths like /pricing resolved against the start URL). Throws a 400 with the reason. */
export function validateChange(p, b = {}) {
  const date = String(b.date ?? "").trim();
  if (!isDay(date)) throw bad("Date must be a real day written yyyy-mm-dd");
  if (date > addDays(new Date().toISOString().slice(0, 10), 1)) throw bad("That date is in the future: log a change on the day it goes live");
  const kind = String(b.kind ?? "").trim().toLowerCase();
  if (!KINDS.includes(kind)) throw bad(`Kind must be one of: ${KINDS.join(", ")}`);
  const summary = String(b.summary ?? "").trim();
  if (!summary) throw bad("Add a short summary of what changed");
  if (summary.length > MAX_SUMMARY) throw bad(`Summary is ${summary.length} characters; keep it to ${MAX_SUMMARY}`);
  const ref = b.ref == null ? "" : String(b.ref).trim();
  if (ref.length > MAX_REF) throw bad(`Reference is too long (${MAX_REF} characters at most)`);
  const host = hostOf(p.start_url);
  const list = (Array.isArray(b.urls) ? b.urls : String(b.urls ?? "").split(/\s+/)).map((s) => String(s).trim()).filter(Boolean);
  const urls = [];
  for (const raw of list) {
    let u;
    try { u = new URL(raw, p.start_url); } catch { throw bad(`Not a web address: ${raw}`); }
    if (!/^https?:$/.test(u.protocol)) throw bad(`Not a web page: ${raw}`);
    if (hostOf(u.href) !== host) throw bad(`${raw} is not on ${host}`);
    u.hash = "";
    if (!urls.includes(u.href)) urls.push(u.href);
  }
  if (!urls.length) throw bad(`Add at least one page of ${host} that the change touched`);
  if (urls.length > MAX_URLS) throw bad(`${urls.length} pages; log at most ${MAX_URLS} per change (use one change per section of the site)`);
  return { date, kind, summary, ref: ref || null, urls };
}

const toChange = (r) => ({ id: r.id, projectId: r.project_id, date: r.date, kind: r.kind, summary: r.summary, ref: r.ref, urls: JSON.parse(r.urls), createdAt: r.created_at });

export function addChange(projectId, body) {
  const p = project(projectId);
  const c = validateChange(p, body);
  const id = Number(run("INSERT INTO seo_changes (project_id, date, urls, kind, summary, ref) VALUES (?,?,?,?,?,?)",
    p.id, c.date, JSON.stringify(c.urls), c.kind, c.summary, c.ref).lastInsertRowid);
  const change = toChange(get("SELECT * FROM seo_changes WHERE id=?", id));
  return { ...change, impact: changeImpact(change, siteData(p.id)) };
}

export function deleteChange(projectId, changeId) {
  project(projectId);
  const r = run("DELETE FROM seo_changes WHERE id=? AND project_id=?", Number(changeId), Number(projectId));
  if (!r.changes) throw Object.assign(new Error("Change not found"), { status: 404 });
  return { deleted: Number(changeId) };
}

// ---- Search Console page×day data ----
/** Daily totals for the whole site and a loader for one page's days, or null when no page data has been fetched. */
export function siteData(projectId) {
  if (!get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='gsc_page_daily'")) return null;
  const span = get("SELECT MIN(date) first, MAX(date) last FROM gsc_page_daily WHERE project_id=?", projectId);
  if (!span?.last) return null;
  const SUMS = "SELECT date, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions) pw FROM gsc_page_daily WHERE project_id=?";
  const byDate = (rows) => new Map(rows.map((r) => [r.date, r]));
  const site = byDate(all(`${SUMS} GROUP BY date`, projectId));
  const variants = new Map(); // normalised page → the URLs Search Console reported for it
  for (const { url } of all("SELECT DISTINCT url FROM gsc_page_daily WHERE project_id=?", projectId)) {
    const k = norm(url); if (!variants.has(k)) variants.set(k, []); variants.get(k).push(url);
  }
  const cache = new Map();
  const page = (url) => {
    const k = norm(url);
    if (!cache.has(k)) {
      const urls = variants.get(k) || [];
      cache.set(k, urls.length ? byDate(all(`${SUMS} AND url IN (${urls.map(() => "?").join(",")}) GROUP BY date`, projectId, ...urls)) : new Map());
    }
    return cache.get(k);
  };
  return { first: span.first, last: span.last, site, page };
}

const ZERO = { clicks: 0, impressions: 0, pw: 0 };
function total(map, from, to) {
  const t = { ...ZERO };
  for (let d = from; d <= to; d = addDays(d, 1)) { const r = map.get(d); if (r) { t.clicks += r.clicks || 0; t.impressions += r.impressions || 0; t.pw += r.pw || 0; } }
  return t;
}
const plus = (a, b) => ({ clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions, pw: a.pw + b.pw });
const minus = (a, b) => ({ clicks: Math.max(0, a.clicks - b.clicks), impressions: Math.max(0, a.impressions - b.impressions), pw: Math.max(0, a.pw - b.pw) });
const metrics = (t) => ({ clicks: t.clicks, impressions: t.impressions, ctr: t.impressions ? t.clicks / t.impressions : null, position: t.impressions ? t.pw / t.impressions : null });
const pct = (after, before) => (before ? after / before - 1 : null);
/** Before vs after for one group of pages: totals, % change in clicks and impressions, change in CTR and position. */
function side(b, a) {
  const before = metrics(b), after = metrics(a);
  return { before, after, change: { clicks: pct(after.clicks, before.clicks), impressions: pct(after.impressions, before.impressions),
    ctr: before.ctr !== null && after.ctr !== null ? after.ctr - before.ctr : null,
    position: before.position !== null && after.position !== null ? after.position - before.position : null } };
}

/** One window: the changed pages (each and together) and the rest of the site, before vs after. */
function compareWindow(data, pages, before, after) {
  const per = pages.map(([url, map]) => [url, total(map, before.from, before.to), total(map, after.from, after.to)]);
  const cb = per.reduce((t, p) => plus(t, p[1]), ZERO), ca = per.reduce((t, p) => plus(t, p[2]), ZERO);
  const changed = side(cb, ca);
  const control = side(minus(total(data.site, before.from, before.to), cb), minus(total(data.site, after.from, after.to), ca));
  const diff = (k) => (changed.change[k] !== null && control.change[k] !== null ? changed.change[k] - control.change[k] : null);
  const basis = changed.before.clicks >= MIN_CLICKS ? "clicks" : "impressions";
  const d = diff(basis);
  return { before, after, changed, control,
    vsControl: { clicks: diff("clicks"), impressions: diff("impressions"), basis, label: d === null ? null : d >= MARGIN ? "ahead" : d <= -MARGIN ? "behind" : "in line" },
    small: changed.before.clicks + changed.after.clicks < 20 && changed.before.impressions + changed.after.impressions < 200,
    pages: per.map(([url, b, a]) => ({ url, ...side(b, a) })) };
}

/** Impact of one change: "no-data" without Search Console page data, "too-early" with under 7 days of data after the
 *  change day, else windows of 14 and 28 days (pending until complete) and "since" the change (equal days before). */
export function changeImpact(change, data) {
  if (!data) return { status: "no-data" };
  const D = change.date, afterDays = Math.max(0, daysBetween(D, data.last)), beforeDays = Math.max(0, daysBetween(data.first, D));
  const base = { afterDays, lastDate: data.last, readyAround: addDays(D, MIN_AFTER_DAYS + LAG_DAYS) };
  if (afterDays < MIN_AFTER_DAYS) return { status: "too-early", ...base };
  const seen = new Set(), pages = [];
  for (const u of change.urls) { const k = norm(u); if (!seen.has(k)) { seen.add(k); pages.push([u, data.page(u)]); } }
  const win = (label, n) => {
    if (afterDays < n) return { window: label, days: n, pending: true, readyAround: addDays(D, n + LAG_DAYS) };
    if (beforeDays < n) return { window: label, days: n, noBefore: true };
    return { window: label, days: n, ...compareWindow(data, pages, { from: addDays(D, -n), to: addDays(D, -1) }, { from: addDays(D, 1), to: addDays(D, n) }) };
  };
  // "since": every day after the change, against as many days before it (fewer if the data starts later).
  const since = Math.min(afterDays, beforeDays);
  const windows = [...WINDOWS.map((n) => win(`${n} days`, n)), since >= MIN_AFTER_DAYS ? win("since", since) : { window: "since", days: since, noBefore: true }];
  return { status: "ok", ...base, windows };
}

/** Every change of a project, newest first, each with its impact. */
export function changeLog(projectId) {
  project(projectId);
  const data = siteData(projectId);
  const meta = get("SELECT value FROM meta WHERE key=?", `gsc-page-daily:${projectId}`);
  const m = meta ? JSON.parse(meta.value) : null;
  const changes = all("SELECT * FROM seo_changes WHERE project_id=? ORDER BY date DESC, id DESC", projectId)
    .map(toChange).map((c) => ({ ...c, impact: changeImpact(c, data) }));
  return { connected: Boolean(data), firstDate: data?.first || null, lastDate: data?.last || null, error: m?.error || null,
    kinds: KINDS, windows: WINDOWS, minAfterDays: MIN_AFTER_DAYS, margin: MARGIN, changes };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/changes$/, ([id]) => changeLog(Number(id))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/changes$/, ([id], q, b) => addChange(Number(id), b)]);
  routes.push(["DELETE", /^\/api\/projects\/(\d+)\/changes\/(\d+)$/, ([id, cid]) => deleteChange(Number(id), Number(cid))]);
}
