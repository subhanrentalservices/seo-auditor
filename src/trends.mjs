// Search trend diagnosis (REQ-040 #10): 16 months of daily Search Console totals, split brand vs non-brand and by
// device (fetched by gsc.mjs refresh() into gsc_trend). Gives weekly series, month-by-month change on last year, and
// the drops worth explaining: 7 days at least 20% below the 7 before (and below the same week last year when there is
// one), each labelled seasonal, after a dated Google update, or unexplained, with the segment that lost the most.
import { readFileSync } from "node:fs";
import { all, get } from "./db.mjs";

export const SEGMENTS = ["all", "brand", "nonbrand", "mobile", "desktop", "tablet"];
const DAY = 864e5;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);

/** The confirmed-update list shipped with the tool (src/google-updates.json, editable). */
export function loadUpdates() {
  try { return JSON.parse(readFileSync(new URL("./google-updates.json", import.meta.url), "utf8")).updates || []; } catch { return []; }
}

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

/** Detects drops in the site-wide series and explains each one. series: {all, brand?, nonbrand?, mobile?, ...} as
 *  daily rows; updates: [{name, type, start}]. */
export function findDrops(series, updates = loadUpdates()) {
  const base = series.all || [];
  if (base.length < 14) return [];
  const dates = allDates(base), days = dense(base, dates);
  const seg = Object.fromEntries(SEGMENTS.filter((s) => s !== "all" && series[s]?.length).map((s) => [s, dense(series[s], dates)]));
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
    const label = seasonal ? "seasonal" : update ? "after a Google update" : "unexplained";
    // Which segment lost the most over the same two weeks.
    const split = {};
    for (const [s, arr] of Object.entries(seg)) {
      const b = sum(arr, c - 7, c - 1, k), a = sum(arr, c, c + 6, k);
      split[s] = { before: b, after: a, lost: b - a, pct: b ? 1 - a / b : null };
    }
    const lead = (names) => {
      const xs = names.filter((n) => split[n]), lost = xs.reduce((t, n) => t + Math.max(0, split[n].lost), 0);
      if (!lost) return null;
      const top = xs.sort((a, b) => split[b].lost - split[a].lost)[0];
      return { segment: top, share: split[top].lost / lost };
    };
    drops.push({ start, end: dates[Math.min(r.last, days.length - 1)], metric: k, before, after, pct, label, update, seasonal,
      yearAgo: lastYear ? lastYear : null, yearAgoNote: lastYear ? null : "no year-ago data",
      split, driver: { query: lead(["brand", "nonbrand"]), device: lead(["mobile", "desktop", "tablet"]) } });
  }
  return drops.reverse(); // newest first
}

/** Everything the card shows, from daily rows per segment. */
export function analyse(series, updates = loadUpdates()) {
  const base = series.all || [];
  if (!base.length) return { days: 0, weekly: {}, yoy: [], drops: [], updates: [], hasYoy: false };
  const dates = allDates(base);
  const full = Object.fromEntries(SEGMENTS.filter((s) => series[s]?.length).map((s) => [s, dense(series[s], dates)]));
  const yoy = yoyMonths(full.all);
  return {
    days: dates.length, startDate: dates[0], endDate: dates.at(-1),
    weekly: Object.fromEntries(Object.entries(full).map(([s, d]) => [s, weekly(d)])),
    yoy, hasYoy: yoy.length > 0,
    drops: findDrops(full, updates),
    updates: updates.filter((u) => u.start >= dates[0] && u.start <= dates.at(-1)).sort((a, b) => a.start.localeCompare(b.start)),
  };
}

export function trendReport(projectId) {
  const meta = get("SELECT value FROM meta WHERE key=?", `gsc-trend:${projectId}`);
  const m = meta ? JSON.parse(meta.value) : null;
  const rows = all("SELECT date, segment, clicks, impressions, position FROM gsc_trend WHERE project_id=? ORDER BY date", projectId);
  const series = {};
  for (const r of rows) (series[r.segment] ||= []).push(r);
  return { fetched: rows.length > 0, terms: m?.terms || [], error: m?.error || null, source: "https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history", ...analyse(series) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/trends$/, ([id]) => {
    if (!get("SELECT id FROM projects WHERE id=?", Number(id))) throw Object.assign(new Error("Project not found"), { status: 404 });
    return trendReport(Number(id));
  }]);
}
