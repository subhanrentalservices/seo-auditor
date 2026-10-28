// Rank tracker (REQ-055 group 4, items 2 and 3), free: built only from Search Console history (gsc-history.mjs).
// Per target keyword (Settings → Target keywords, up to 200): Google's average position, clicks and impressions per day,
// the best page, mobile vs desktop, and the change against 7 and 28 days earlier; tags to group keywords.
// Position is Search Console's "average position" (the topmost result of the site, averaged over impressions), not a
// live ranking check: a keyword with no impressions has no position, and Search Console only reports searches that had
// impressions, so "no impressions" is shown as such rather than as a rank.
// rankAlerts() is the rank alert feed for alerting (group 5): position worse by >= N (default 3) on the 7-day average
// against the 7 days before, with enough impressions in both weeks; new top-3 and lost top-10 events.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { parseTargets } from "./queries.mjs";
import { words } from "./page2.mjs";
import { historyState, addDays } from "./gsc-history.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS rank_tags (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', PRIMARY KEY (project_id, keyword));`);

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const DEVICES = ["mobile", "desktop", "tablet"];
const TOP_QUERIES = 100; // non-target searches also watched by the alert feed (most impressions in 28 days)

/** "Local, Brakes ,local" → ["local", "brakes"]: lower case, at most 10 tags of 30 characters. */
export function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(",");
  return [...new Set(list.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30)).filter(Boolean))].slice(0, 10);
}

/** Rows of any split (device, page) summed into one row per day; position weighted by impressions. Sorted by date. */
export function byDay(rows) {
  const m = new Map();
  for (const r of rows) {
    const d = m.get(r.date) || { date: r.date, clicks: 0, impressions: 0, w: 0 };
    d.clicks += r.clicks || 0; d.impressions += r.impressions || 0; d.w += (r.position || 0) * (r.impressions || 0);
    m.set(r.date, d);
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ date: d.date, clicks: d.clicks, impressions: d.impressions, position: d.impressions ? d.w / d.impressions : null }));
}

/** Totals over the days from..to (inclusive): clicks, impressions, CTR and average position (null without impressions). */
export function windowStats(days, from, to) {
  let clicks = 0, impressions = 0, w = 0;
  for (const d of days) if (d.date >= from && d.date <= to) { clicks += d.clicks; impressions += d.impressions; w += (d.position || 0) * d.impressions; }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null, position: impressions ? w / impressions : null };
}

const delta = (a, b) => (a.position === null || b.position === null ? null : a.position - b.position);

/** Alert events from daily series. list: [{keyword, source, days}]. Weeks: the 7 days ending endDate against the 7
 *  before. drop: both weeks have >= minImpressions and the average position is >= threshold worse. new_top3: this week
 *  in the top 3 (>= minImpressions) and last week not. lost_top10: last week in the top 10 (>= minImpressions), this
 *  week below 10 or no impressions at all. Positive delta = worse (a bigger position number). */
export function detectEvents(list, { endDate, threshold = 3, minImpressions = 10 } = {}) {
  if (!endDate) return [];
  const cur = [addDays(endDate, -6), endDate], prev = [addDays(endDate, -13), addDays(endDate, -7)];
  const out = [];
  for (const k of list) {
    const c = windowStats(k.days, ...cur), p = windowStats(k.days, ...prev);
    const base = { keyword: k.keyword, source: k.source, from: p.position, to: c.position, delta: delta(c, p),
      impressions: { previous: p.impressions, current: c.impressions }, clicks: { previous: p.clicks, current: c.clicks },
      window: { previous: { startDate: prev[0], endDate: prev[1] }, current: { startDate: cur[0], endDate: cur[1] } } };
    const ev = (type, severity) => out.push({ id: `${type}:${k.keyword}:${endDate}`, type, severity, ...base });
    const enough = (x) => x.impressions >= minImpressions;
    if (enough(c) && enough(p) && c.position - p.position >= threshold) ev("drop", "warning");
    if (enough(c) && c.position <= 3 && (p.position === null || p.position > 3)) ev("new_top3", "info");
    if (enough(p) && p.position <= 10 && (c.position === null || c.position > 10)) ev("lost_top10", "warning");
  }
  const order = { drop: 0, lost_top10: 1, new_top3: 2 };
  return out.sort((a, b) => order[a.type] - order[b.type] || (b.delta ?? 99) - (a.delta ?? 99) || b.impressions.previous - a.impressions.previous);
}

function tagsOf(projectId) {
  return new Map(all("SELECT keyword, tags FROM rank_tags WHERE project_id=?", projectId).map((r) => [r.keyword, cleanTags(r.tags)]));
}
const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");

/** Searches containing every word of each keyword (stemmed, any order): impressions and how many such searches. */
export function variants(keywords, rows) {
  const sets = new Map();
  for (const r of rows) if (!sets.has(r.query)) sets.set(r.query, new Set(words(r.query)));
  return new Map(keywords.map((k) => {
    const need = [...new Set(words(k))];
    let impressions = 0; const qs = new Set();
    for (const r of rows) if (r.query !== k && need.length && need.every((w) => sets.get(r.query).has(w))) { impressions += r.impressions; qs.add(r.query); }
    return [k, { impressions, searches: qs.size }];
  }));
}

/** The rank tracker screen: one row per target keyword, newest 28 days of history. */
export function trackerReport(projectId) {
  const p = project(projectId), s = projectSettings(p);
  const targets = parseTargets(s.targetKeywords), state = historyState(p.id), tags = tagsOf(p.id);
  const end = state.keywordsThrough || null;
  const base = { configured: targets.length > 0, connected: Boolean(end), endDate: end, error: state.keywordError || null,
    threshold: s.rankDropThreshold, minImpressions: s.rankMinImpressions };
  if (!end) return { ...base, keywords: targets.map((k) => ({ keyword: k, tags: tags.get(k) || [], status: "not-fetched" })), tags: [...new Set([...tags.values()].flat())].sort() };
  const from28 = addDays(end, -27), known = new Set(state.keywords || []);
  const rows = all(`SELECT query, date, device, clicks, impressions, position FROM gsc_kw_daily WHERE project_id=? AND date >= ?`, p.id, addDays(end, -34));
  const byKw = new Map();
  for (const r of rows) { if (!byKw.has(r.query)) byKw.set(r.query, []); byKw.get(r.query).push(r); }
  const pages = all(`SELECT query, page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_kw_page_daily WHERE project_id=? AND date BETWEEN ? AND ? GROUP BY query, page ORDER BY clicks DESC, impressions DESC`, p.id, from28, end);
  const best = new Map(), pageCount = new Map();
  for (const r of pages) { if (!best.has(r.query)) best.set(r.query, r); pageCount.set(r.query, (pageCount.get(r.query) || 0) + 1); }
  const vars = variants(targets, all("SELECT query, SUM(impressions) impressions FROM gsc_query_daily WHERE project_id=? AND date BETWEEN ? AND ? GROUP BY query", p.id, from28, end));
  const keywords = targets.map((k) => {
    const raw = byKw.get(k) || [], days = byDay(raw);
    const last7 = windowStats(days, addDays(end, -6), end), prev7 = windowStats(days, addDays(end, -13), addDays(end, -7));
    const prior28 = windowStats(days, addDays(end, -34), addDays(end, -28)), d28 = windowStats(days, from28, end);
    const devices = Object.fromEntries(DEVICES.map((dv) => [dv, windowStats(byDay(raw.filter((r) => r.device === dv)), from28, end)]));
    const status = !known.has(k) ? "not-fetched" : d28.impressions ? "ranking" : "no-impressions";
    return { keyword: k, tags: tags.get(k) || [], status, position: last7.position, last7, d28, change7: delta(last7, prev7), change28: delta(last7, prior28),
      devices, bestPage: best.get(k) || null, pages: pageCount.get(k) || 0, variants: vars.get(k) };
  });
  const ranked = keywords.filter((k) => k.d28?.impressions);
  return { ...base, keywords, tags: [...new Set([...tags.values()].flat())].sort(),
    counts: { tracked: targets.length, withImpressions: ranked.length, top3: ranked.filter((k) => k.position !== null && k.position <= 3).length,
      top10: ranked.filter((k) => k.position !== null && k.position <= 10).length, noImpressions: keywords.filter((k) => k.status === "no-impressions").length } };
}

/** One keyword over the whole stored history: per day (all devices), per device per day, and its pages. */
export function keywordDetail(projectId, keyword) {
  const p = project(projectId), k = String(keyword || "").trim().toLowerCase();
  if (!k) fail(400, "Keyword missing");
  const raw = all("SELECT date, device, clicks, impressions, position FROM gsc_kw_daily WHERE project_id=? AND query=? ORDER BY date", p.id, k);
  const end = historyState(p.id).keywordsThrough || null;
  const pages = (from) => all(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position*impressions)/NULLIF(SUM(impressions),0) position
    FROM gsc_kw_page_daily WHERE project_id=? AND query=? AND date >= ? GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT 50`, p.id, k, from);
  return { keyword: k, endDate: end, tags: tagsOf(p.id).get(k) || [], days: byDay(raw),
    devices: Object.fromEntries(DEVICES.map((dv) => [dv, byDay(raw.filter((r) => r.device === dv))])),
    pages28: end ? pages(addDays(end, -27)) : [], pagesAll: pages("0000-00-00") };
}

export function setTags(projectId, body = {}) {
  const p = project(projectId), k = String(body.keyword || "").trim().toLowerCase().slice(0, 100);
  if (!k) fail(400, "Keyword missing");
  const tags = cleanTags(body.tags);
  if (tags.length) run("INSERT OR REPLACE INTO rank_tags (project_id, keyword, tags) VALUES (?, ?, ?)", p.id, k, tags.join(","));
  else run("DELETE FROM rank_tags WHERE project_id=? AND keyword=?", p.id, k);
  return { keyword: k, tags };
}

/** Rank alert feed (consumed by alerting, group 5). Target keywords plus the top non-target searches by impressions.
 *  Thresholds from project settings (rankDropThreshold, rankMinImpressions) unless passed. Never throws for a project
 *  without Search Console history: returns no events. */
export function rankAlerts(projectId, opts = {}) {
  const p = project(projectId), s = projectSettings(p), state = historyState(p.id);
  const threshold = opts.threshold ?? (s.rankDropThreshold || 3), minImpressions = opts.minImpressions ?? (s.rankMinImpressions || 10);
  const targets = parseTargets(s.targetKeywords), events = [];
  const kwEnd = state.keywordsThrough, qEnd = state.queriesThrough;
  if (kwEnd && targets.length) {
    const rows = all("SELECT query, date, clicks, impressions, position FROM gsc_kw_daily WHERE project_id=? AND date >= ?", p.id, addDays(kwEnd, -13));
    const list = targets.map((k) => ({ keyword: k, source: "target", days: byDay(rows.filter((r) => r.query === k)) }));
    events.push(...detectEvents(list, { endDate: kwEnd, threshold, minImpressions }));
  }
  if (qEnd) {
    const skip = new Set(targets);
    const top = all(`SELECT query FROM gsc_query_daily WHERE project_id=? AND date BETWEEN ? AND ? GROUP BY query ORDER BY SUM(impressions) DESC LIMIT ?`,
      p.id, addDays(qEnd, -27), qEnd, TOP_QUERIES + skip.size).map((r) => r.query).filter((q) => !skip.has(q)).slice(0, TOP_QUERIES);
    const rows = top.length ? all(`SELECT query, date, clicks, impressions, position FROM gsc_query_daily WHERE project_id=? AND date >= ? AND query IN (${top.map(() => "?").join(",")})`,
      p.id, addDays(qEnd, -13), ...top) : [];
    const list = top.map((q) => ({ keyword: q, source: "top", days: byDay(rows.filter((r) => r.query === q)) }));
    events.push(...detectEvents(list, { endDate: qEnd, threshold, minImpressions }));
  }
  return { projectId: p.id, endDate: kwEnd || qEnd || null, threshold, minImpressions, events };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/rank$/, ([id]) => trackerReport(id)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/rank\/keyword$/, ([id], q) => keywordDetail(id, q.k)]);
  routes.push(["PUT", /^\/api\/projects\/(\d+)\/rank\/tags$/, ([id], q, b) => setTags(id, b)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/rank\/alerts$/, ([id]) => rankAlerts(id)]);
}
