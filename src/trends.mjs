// Search trend diagnosis (REQ-040 #10): 16 months of daily Search Console totals, split brand vs non-brand and by
// device (fetched by gsc.mjs refresh() into gsc_trend). Gives weekly series, month-by-month change on last year, and
// the drops worth explaining: 7 days at least 20% below the 7 before (and below the same week last year when there is
// one), each labelled seasonal, after a dated Google update, during a Google incident, or unexplained, with the segment
// that lost the most (brand/non-brand, device, country, site section). REQ-044 rows 48-49: countries come from a
// date x country query, sections from the page x day data (first folder of the URL); a country or section is judged
// only with 100+ impressions in the week before. Each drop also lists what the audits saw change in its window (a new
// robots.txt block, pages that turned noindex, new 5xx), and the Search Status Dashboard feed (status-feed.mjs) adds
// ranking updates and crawling/indexing/serving incidents to the hand-curated list.
import { readFileSync } from "node:fs";
import { all, get } from "./db.mjs";
import { cachedFeed, mergeUpdates } from "./status-feed.mjs";

export const SEGMENTS = ["all", "brand", "nonbrand", "mobile", "desktop", "tablet"];
const DAY = 864e5;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

/** The confirmed-update list shipped with the tool (src/google-updates.json, hand-curated, never written by the tool). */
export function loadShipped() {
  try { return JSON.parse(readFileSync(new URL("./google-updates.json", import.meta.url), "utf8")).updates || []; } catch { return []; }
}
/** Shipped updates plus ranking updates from the cached Search Status Dashboard feed that the list doesn't have yet. */
export function loadUpdates() {
  const feed = cachedFeed();
  return mergeUpdates(loadShipped(), feed?.updates || [], feed?.fetchedAt?.slice(0, 10) || null);
}
/** Crawling, indexing and serving incidents from the cached feed (empty before the first fetch). */
export const loadIncidents = () => cachedFeed()?.incidents || [];

// ---- Brand terms → one Search Console regex (RE2) ----
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Brand names for a project: its name, its domain label and the comma-separated brandTerms setting. */
export function brandTerms(project, settings = {}) {
  let label = "";
  try { label = new URL(project.start_url).hostname.replace(/^www\./, "").split(".")[0]; } catch { /* no URL */ }
  const derived = [project.name, label.replace(/-/g, " ")].filter((t) => compact(t).length >= 4);
  const extra = String(settings.brandTerms || "").split(",").map((t) => t.trim()).filter((t) => compact(t).length >= 3);
  const seen = new Set();
  return [...derived, ...extra].filter((t) => { const k = t.toLowerCase(); return seen.has(k) ? false : seen.add(k); });
}

/** One term as a pattern: its words in order with any spacing or punctuation between them ("acme widgets" also
 *  matches "acmewidgets"), a trailing plural "s" optional ("Acme Motors" matches "acme motor"), regex characters escaped. */
function termPattern(term) {
  const words = String(term).toLowerCase().split(/[\s\-_/,]+/).map((w) => w.replace(/^[()[\]{}"'.,;:!?]+|[()[\]{}"'.,;:!?]+$/g, "")).filter(Boolean);
  if (!words.length) return null;
  const parts = words.map((w) => (w.length > 3 && w.endsWith("s") && /^[a-z0-9]+$/.test(w) ? esc(w.slice(0, -1)) + "s?" : esc(w)));
  return (/^[a-z0-9]/.test(words[0]) ? "\\b" : "") + parts.join("[^a-z0-9]*");
}

/** Case-insensitive RE2 regex for Search Console's includingRegex / excludingRegex, or null without terms. */
export function brandRegex(terms) {
  const pats = [...new Set(terms.map(termPattern).filter(Boolean))];
  return pats.length ? `(?i)(${pats.join("|")})` : null;
}

// ---- Series helpers ----
/** Rows [{date, clicks, impressions, position}] → arrays over every day in `dates` (missing days are 0). */
function dense(rows, dates) {
  const by = new Map((rows || []).map((r) => [r.date, r]));
  return dates.map((d) => { const r = by.get(d); return { date: d, clicks: r?.clicks || 0, impressions: r?.impressions || 0, position: r?.position ?? null }; });
}
/** Every date from the first row to the last (Search Console leaves out days with no impressions). */
function allDates(rows) {
  const out = [];
  if (rows.length) for (let d = rows[0].date; d <= rows.at(-1).date; d = addDays(d, 1)) out.push(d);
  return out;
}
const sum = (arr, a, b, k) => { let t = 0; for (let i = a; i <= b; i++) t += arr[i][k]; return t; };

/** Weekly totals in 7-day blocks ending on the latest day, so the last point is the latest full week. */
export function weekly(days) {
  const out = [];
  for (let e = days.length - 1; e - 6 >= 0; e -= 7) {
    let clicks = 0, impressions = 0, w = 0;
    for (let i = e - 6; i <= e; i++) { clicks += days[i].clicks; impressions += days[i].impressions; if (days[i].position != null) w += days[i].position * days[i].impressions; }
    out.unshift({ start: days[e - 6].date, end: days[e].date, clicks, impressions, position: impressions ? w / impressions : null });
  }
  return out;
}

/** Month-by-month change on the same days last year, only for months whose last-year days are inside the data. */
export function yoyMonths(days) {
  if (!days.length) return [];
  const first = days[0].date, idx = new Map(days.map((d, i) => [d.date, i]));
  const months = new Map();
  for (const d of days) { const m = d.date.slice(0, 7); const x = months.get(m) || { month: m, from: d.date, to: d.date }; x.to = d.date; months.set(m, x); }
  const out = [];
  for (const m of months.values()) {
    const lyFrom = `${Number(m.from.slice(0, 4)) - 1}${m.from.slice(4)}`, lyTo = `${Number(m.to.slice(0, 4)) - 1}${m.to.slice(4)}`;
    if (lyFrom < first || !idx.has(lyFrom) || !idx.has(lyTo)) continue;
    const a = idx.get(m.from), b = idx.get(m.to), la = idx.get(lyFrom), lb = idx.get(lyTo);
    const cur = { clicks: sum(days, a, b, "clicks"), impressions: sum(days, a, b, "impressions") };
    const ly = { clicks: sum(days, la, lb, "clicks"), impressions: sum(days, la, lb, "impressions") };
    const pct = (k) => (ly[k] ? cur[k] / ly[k] - 1 : null);
    const lastDay = new Date(Date.UTC(+m.month.slice(0, 4), +m.month.slice(5, 7), 0)).getUTCDate();
    out.push({ month: m.month, ...cur, lastYear: ly, clicksPct: pct("clicks"), impressionsPct: pct("impressions"),
      partial: m.from.slice(8) !== "01" || Number(m.to.slice(8)) !== lastDay, from: m.from, to: m.to });
  }
  return out;
}

const DROP = 0.2;           // 7 days at least 20% below the 7 before
const MIN_CLICKS = 10;      // fewer clicks than this in the earlier week: judge on impressions instead
const MIN_IMPRESSIONS = 50; // and below this, too little to judge at all
const YEAR = 364;           // same weekdays last year
const MIN_SEGMENT = 100;    // a country or section needs 100+ impressions in the week before to be judged (heuristic)
const EXTRA = /^(country|section):/; // dynamic segments: "country:aus", "section:/blog/"

/** Detects drops in the site-wide series and explains each one. series: {all, brand?, nonbrand?, mobile?, ...,
 *  "country:aus"?, "section:/blog/"?} as daily rows; updates: [{name, type, start}]; incidents: [{name, service, start, end}]. */
export function findDrops(series, updates = loadUpdates(), incidents = loadIncidents()) {
  const base = series.all || [];
  if (base.length < 14) return [];
  const dates = allDates(base), days = dense(base, dates);
  const names = Object.keys(series).filter((s) => s !== "all" && series[s]?.length && (SEGMENTS.includes(s) || EXTRA.test(s)));
  const seg = Object.fromEntries(names.map((s) => [s, dense(series[s], dates)]));
  const metricAt = (a) => (sum(days, a, a + 6, "clicks") >= MIN_CLICKS ? "clicks" : "impressions");
  // Week starting at c against the week before it (null when out of range or too small to judge).
  const ratio = (arr, c, k) => {
    if (c - 7 < 0 || c + 6 >= arr.length) return null;
    const before = sum(arr, c - 7, c - 1, k);
    if (!before || (k === "impressions" && before < MIN_IMPRESSIONS)) return null;
    return sum(arr, c, c + 6, k) / before;
  };
  // 1. Each day t closing a week that is 20%+ below the week before and below the same week last year.
  const flagged = [];
  for (let t = 13; t < days.length; t++) {
    const k = metricAt(t - 13), r = ratio(days, t - 6, k);
    if (r === null || r > 1 - DROP) continue;
    const cur = sum(days, t - 6, t, k), y = t - YEAR;
    if (y - 6 >= 0 && cur >= sum(days, y - 6, y, k)) continue; // still at or above last year: not a loss
    flagged.push(t);
  }
  // 2. Runs of flagged days (gaps up to a week) are one drop; it starts on the day with the sharpest week-on-week fall.
  const runs = [];
  for (const t of flagged) { const r = runs.at(-1); if (r && t - r.last <= 7) r.last = t; else runs.push({ first: t, last: t }); }
  const drops = [];
  for (const r of runs) {
    let c = null, best = Infinity;
    const k = metricAt(Math.max(0, r.first - 13));
    for (let x = Math.max(7, r.first - 12); x <= r.first && x + 6 < days.length; x++) {
      const q = ratio(days, x, k);
      if (q !== null && q < best) { best = q; c = x; }
    }
    if (c === null || best > 1 - DROP) continue;
    const before = sum(days, c - 7, c - 1, k), after = sum(days, c, c + 6, k), pct = 1 - after / before, start = dates[c];
    // Last year: the same weeks (±7 days, seasons don't land on the same day) showing a comparable fall.
    let lastYear = null;
    if (c - YEAR - 7 >= 0) {
      let ly = Infinity;
      for (let s = -7; s <= 7; s++) { const q = ratio(days, c - YEAR + s, k); if (q !== null) ly = Math.min(ly, q); }
      lastYear = { change: ly === Infinity ? null : ly - 1, before: sum(days, c - YEAR - 7, c - YEAR - 1, k), after: sum(days, c - YEAR, c - YEAR + 6, k) };
    }
    const seasonal = Boolean(lastYear?.change != null && -lastYear.change >= Math.max(0.1, pct / 2));
    const update = updates.filter((u) => { const g = daysBetween(u.start, start); return g >= 0 && g <= 5; }).sort((a, b) => b.start.localeCompare(a.start))[0] || null;
    // An open crawling, indexing or serving incident from 2 days before the drop to the end of its first week.
    const incident = incidents.filter((i) => i.start <= dates[c + 6] && (i.end || i.start) >= addDays(start, -2)).sort((a, b) => b.start.localeCompare(a.start))[0] || null;
    const label = seasonal ? "seasonal" : update ? "after a Google update" : incident ? "during a Google incident" : "unexplained";
    // Which segment lost the most over the same two weeks.
    const split = {};
    for (const [s, arr] of Object.entries(seg)) {
      const b = sum(arr, c - 7, c - 1, k), a = sum(arr, c, c + 6, k);
      split[s] = { before: b, after: a, lost: b - a, pct: b ? 1 - a / b : null, impressionsBefore: sum(arr, c - 7, c - 1, "impressions") };
    }
    const lead = (list, min = 0) => {
      const xs = list.filter((n) => split[n] && split[n].impressionsBefore >= min), lost = xs.reduce((t, n) => t + Math.max(0, split[n].lost), 0);
      if (!lost) return null;
      const top = xs.sort((a, b) => split[b].lost - split[a].lost)[0];
      return { segment: top, share: split[top].lost / lost };
    };
    const of = (kind) => names.filter((n) => n.startsWith(kind + ":"));
    drops.push({ start, end: dates[Math.min(r.last, days.length - 1)], metric: k, before, after, pct, label, update, incident, seasonal,
      yearAgo: lastYear ? lastYear : null, yearAgoNote: lastYear ? null : "no year-ago data",
      split, driver: { query: lead(["brand", "nonbrand"]), device: lead(["mobile", "desktop", "tablet"]),
        country: lead(of("country"), MIN_SEGMENT), section: lead(of("section"), MIN_SEGMENT) } });
  }
  return drops.reverse(); // newest first
}

/** Countries and sections: the last 4 weeks against the 4 before, for those averaging 100+ impressions a week. */
export function segmentTable(series, dates) {
  const out = [];
  const t = (xs, k) => xs.reduce((n, x) => n + x[k], 0);
  for (const [s, rows] of Object.entries(series)) {
    if (!EXTRA.test(s) || !rows?.length) continue;
    const w = weekly(dense(rows, dates)), last = w.slice(-4), prev = w.slice(-8, -4);
    if (prev.length < 4) continue;
    const cur = { clicks: t(last, "clicks"), impressions: t(last, "impressions") }, before = { clicks: t(prev, "clicks"), impressions: t(prev, "impressions") };
    if ((cur.impressions + before.impressions) / 8 < MIN_SEGMENT) continue;
    const i = s.indexOf(":");
    out.push({ segment: s, kind: s.slice(0, i), name: s.slice(i + 1), ...cur, before, clicksPct: before.clicks ? cur.clicks / before.clicks - 1 : null,
      impressionsPct: before.impressions ? cur.impressions / before.impressions - 1 : null, from: last[0].start, to: last.at(-1).end });
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

/** Everything the card shows, from daily rows per segment. */
export function analyse(series, updates = loadUpdates(), incidents = loadIncidents()) {
  const base = series.all || [];
  if (!base.length) return { days: 0, weekly: {}, yoy: [], drops: [], updates: [], incidents: [], segments: [], hasYoy: false };
  const dates = allDates(base);
  const full = Object.fromEntries(Object.keys(series).filter((s) => series[s]?.length && (SEGMENTS.includes(s) || EXTRA.test(s))).map((s) => [s, dense(series[s], dates)]));
  const yoy = yoyMonths(full.all);
  return {
    days: dates.length, startDate: dates[0], endDate: dates.at(-1),
    weekly: Object.fromEntries(Object.entries(full).filter(([s]) => SEGMENTS.includes(s)).map(([s, d]) => [s, weekly(d)])),
    yoy, hasYoy: yoy.length > 0,
    drops: findDrops(full, updates, incidents),
    segments: segmentTable(series, dates),
    updates: updates.filter((u) => u.start >= dates[0] && u.start <= dates.at(-1)).sort((a, b) => a.start.localeCompare(b.start)),
    incidents: incidents.filter((u) => u.start <= dates.at(-1) && (u.end || u.start) >= dates[0]).sort((a, b) => a.start.localeCompare(b.start)),
  };
}

// ---- Site sections from the page x day data ----
/** "/blog/" for https://x/blog/post, "/" for a top-level page (no folder). */
export function sectionOf(url) {
  let p = "/";
  try { p = new URL(url).pathname; } catch { /* not a URL */ }
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts[0].toLowerCase()}/` : "/";
}
/** Daily rows per site section (top 10 by impressions), only when the site has 2 or more sections. */
export function sectionSeries(rows, max = 10) {
  const by = new Map();
  for (const r of rows) {
    const s = sectionOf(r.url);
    if (!by.has(s)) by.set(s, { total: 0, days: new Map() });
    const x = by.get(s), d = x.days.get(r.date) || { date: r.date, clicks: 0, impressions: 0, pw: 0 };
    d.clicks += r.clicks || 0; d.impressions += r.impressions || 0; d.pw += (r.position || 0) * (r.impressions || 0);
    x.days.set(r.date, d); x.total += r.impressions || 0;
  }
  if (by.size < 2) return {};
  const rowsOf = (x) => [...x.days.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions, position: d.impressions ? d.pw / d.impressions : null }));
  return Object.fromEntries([...by].sort((a, b) => b[1].total - a[1].total).slice(0, max).map(([s, x]) => ["section:" + s, rowsOf(x)]));
}

// ---- What the audits saw change around a drop ----
/** Audits finished from `from` to `to` (yyyy-mm-dd), each against the audit before it: robots.txt rules that now
 *  block Googlebot, pages that were indexable and now answer 200 but aren't indexable (noindex or canonical elsewhere),
 *  and URLs with a 5xx that the previous audit didn't have. */
export function siteChangesBetween(projectId, from, to) {
  const audits = all("SELECT id, finished_at FROM audits WHERE project_id=? AND status='done' AND substr(finished_at,1,10) BETWEEN ? AND ? ORDER BY id", projectId, from, to);
  const changes = [];
  for (const a of audits) {
    const prev = get("SELECT id FROM audits WHERE project_id=? AND status='done' AND id<? ORDER BY id DESC LIMIT 1", projectId, a.id);
    if (!prev) continue;
    const add = (kind, urls) => { if (urls.length) changes.push({ auditId: a.id, date: a.finished_at.slice(0, 10), kind, count: urls.length, urls: urls.slice(0, 5) }); };
    add("robots", all(`SELECT DISTINCT url FROM issues WHERE audit_id=? AND (check_id='robots_disallow_added' OR (check_id='robots_disallow_all'
      AND NOT EXISTS (SELECT 1 FROM issues WHERE audit_id=? AND check_id='robots_disallow_all')))`, a.id, prev.id).map((r) => r.url));
    add("noindex", all(`SELECT p.url FROM pages p JOIN pages q ON q.audit_id=? AND q.url=p.url
      WHERE p.audit_id=? AND p.status=200 AND p.indexable=0 AND q.indexable=1 AND q.status=200 ORDER BY p.inlinks DESC`, prev.id, a.id).map((r) => r.url));
    add("5xx", all(`SELECT DISTINCT url FROM issues WHERE audit_id=? AND check_id='http_5xx'
      AND url NOT IN (SELECT url FROM issues WHERE audit_id=? AND check_id='http_5xx')`, a.id, prev.id).map((r) => r.url));
  }
  return { audits: audits.length, changes };
}

export function trendReport(projectId) {
  const meta = get("SELECT value FROM meta WHERE key=?", `gsc-trend:${projectId}`);
  const m = meta ? JSON.parse(meta.value) : null;
  const rows = all("SELECT date, segment, clicks, impressions, position FROM gsc_trend WHERE project_id=? ORDER BY date", projectId);
  const series = {};
  for (const r of rows) (series[r.segment] ||= []).push(r);
  if (rows.length && get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='gsc_page_daily'"))
    Object.assign(series, sectionSeries(all("SELECT url, date, clicks, impressions, position FROM gsc_page_daily WHERE project_id=?", projectId)));
  const out = analyse(series);
  // Each drop: what the audits saw change from 14 days before it started to its end.
  for (const d of out.drops) d.siteChanges = siteChangesBetween(projectId, addDays(d.start, -14), d.end);
  const feed = cachedFeed();
  return { fetched: rows.length > 0, terms: m?.terms || [], error: m?.error || null, source: "https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history",
    feed: feed ? { fetchedAt: feed.fetchedAt, checkedAt: feed.checkedAt, error: feed.error, url: feed.source } : null, ...out };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/trends$/, ([id]) => {
    if (!get("SELECT id FROM projects WHERE id=?", Number(id))) throw Object.assign(new Error("Project not found"), { status: 404 });
    return trendReport(Number(id));
  }]);
}
