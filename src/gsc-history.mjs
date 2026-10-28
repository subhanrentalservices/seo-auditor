// Search Console history (REQ-055 group 4, item 1). gsc_queries (gsc.mjs) is a 28-day snapshot that every refresh
// replaces; this module keeps the day-by-day rows instead, for 16 months (what Search Console itself keeps), and fetches
// only the days after the last stored one:
//   gsc_query_daily     every search × day (property-level: clicks, impressions, position as Search Console reports them),
//   gsc_kw_daily        target keywords (Settings → Target keywords) × device × day, for mobile vs desktop and position,
//   gsc_kw_page_daily   target keywords × page × day, for the best page and pages competing for a keyword.
// A keyword added to the targets gets its full 16 months on the next refresh; removed ones keep their rows until they age
// out. Search Console only reports searches that had impressions, and leaves out rare (anonymised) searches.
// Runs at the end of every Search Console refresh (gsc.mjs afterRefresh); the rank tracker (rank.mjs) reads it.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { query, afterRefresh } from "./gsc.mjs";
import { parseTargets } from "./queries.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS gsc_query_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL, date TEXT NOT NULL, clicks INTEGER, impressions INTEGER, position REAL, PRIMARY KEY (project_id, query, date));
CREATE INDEX IF NOT EXISTS idx_gscqd_date ON gsc_query_daily(project_id, date);
CREATE TABLE IF NOT EXISTS gsc_kw_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL, date TEXT NOT NULL, device TEXT NOT NULL, clicks INTEGER, impressions INTEGER, position REAL,
  PRIMARY KEY (project_id, query, date, device));
CREATE TABLE IF NOT EXISTS gsc_kw_page_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL, date TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER, impressions INTEGER, position REAL,
  PRIMARY KEY (project_id, query, date, page));
`);

export const HISTORY_DAYS = 486;          // about 16 months, Search Console's own limit
const CHUNK_DAYS = 30;                    // days per request window for all searches
export const MAX_ROWS_PER_CHUNK = 250000; // rows kept per window; beyond it the smallest searches of those days are cut
const KW_CHUNK_DAYS = 120;                // days per request window for target keywords (at most 200 keywords)
const MAX_REGEX = 3500;                   // Search Console allows 4,096 characters of filters per request

export const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
export const firstKept = (endDate, days = HISTORY_DAYS) => addDays(endDate, -(days - 1));

/** Days still to fetch: the day after `through` (or the start of the kept window) to `end`; null when up to date. */
export function missingRange(through, end, days = HISTORY_DAYS) {
  const first = firstKept(end, days);
  const start = through && through >= first ? addDays(through, 1) : first;
  return start > end ? null : { startDate: start, endDate: end };
}

/** A date range cut into windows of at most `size` days, oldest first. */
export function chunks({ startDate, endDate }, size) {
  const out = [];
  for (let s = startDate; s <= endDate; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push({ startDate: s, endDate: e < endDate ? e : endDate });
  }
  return out;
}

/** Exact-match filters for the keywords, as few as fit the length limit: ^(?:blue widgets|red widgets)$ (RE2 syntax). */
export function keywordRegexes(keywords, max = MAX_REGEX) {
  const esc = (k) => k.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
  const out = []; let cur = [];
  const make = (list) => `^(?:${list.join("|")})$`;
  for (const k of keywords.map(esc)) {
    if (cur.length && make([...cur, k]).length > max) { out.push(make(cur)); cur = []; }
    cur.push(k);
  }
  if (cur.length) out.push(make(cur));
  return out;
}

const tx = (fn) => { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };
const KEY = (id) => `gsc-history:${id}`;
export function historyState(projectId) {
  const m = get("SELECT value FROM meta WHERE key=?", KEY(projectId));
  return m ? JSON.parse(m.value) : {};
}
const save = (projectId, state) => run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEY(projectId), JSON.stringify(state));
const TABLES = ["gsc_query_daily", "gsc_kw_daily", "gsc_kw_page_daily"];

/** Incremental fetch for one project. call: the Search Console request function (tests pass a mock). */
export async function refreshHistory(project, { call, property, endDate }) {
  let state = historyState(project.id);
  // Another property is another site's data: start again rather than mix the two.
  if (state.property && state.property !== property) { for (const t of TABLES) run(`DELETE FROM ${t} WHERE project_id=?`, project.id); state = {}; }
  state.property = property;
  const q = (body, max) => query(property, body, max, call);
  const out = { queryRows: 0, keywordRows: 0, queryError: null, keywordError: null };

  // 1. Every search × day, one window at a time; each stored window moves "through" on, so a failure keeps progress.
  const range = missingRange(state.queriesThrough, endDate);
  const iq = db.prepare("INSERT OR REPLACE INTO gsc_query_daily (project_id,query,date,clicks,impressions,position) VALUES (?,?,?,?,?,?)");
  try {
    if (range) for (const c of chunks(range, CHUNK_DAYS)) {
      const rows = await q({ ...c, dimensions: ["date", "query"] }, MAX_ROWS_PER_CHUNK);
      tx(() => { for (const r of rows) iq.run(project.id, r.keys[1], r.keys[0], r.clicks, r.impressions, r.position); });
      if (rows.length >= MAX_ROWS_PER_CHUNK) state.partial = [...(state.partial || []), c].slice(-24);
      state.queriesThrough = c.endDate; out.queryRows += rows.length;
      save(project.id, state);
    }
    state.queryError = null;
  } catch (e) { state.queryError = out.queryError = e.message; }

  // 2. Target keywords × device × day and × page × day: new keywords get the full window, known ones the missing days.
  const targets = parseTargets(projectSettings(project).targetKeywords);
  const known = new Set(state.keywords || []);
  const jobs = [];
  const kwRange = missingRange(state.keywordsThrough, endDate);
  const old = targets.filter((k) => known.has(k)), fresh = targets.filter((k) => !known.has(k));
  if (old.length && kwRange) jobs.push([old, kwRange]);
  if (fresh.length) jobs.push([fresh, missingRange(null, endDate)]);
  const idv = db.prepare("INSERT OR REPLACE INTO gsc_kw_daily (project_id,query,date,device,clicks,impressions,position) VALUES (?,?,?,?,?,?,?)");
  const ipg = db.prepare("INSERT OR REPLACE INTO gsc_kw_page_daily (project_id,query,date,page,clicks,impressions,position) VALUES (?,?,?,?,?,?,?)");
  try {
    for (const [kws, r] of jobs) for (const expression of keywordRegexes(kws)) for (const c of chunks(r, KW_CHUNK_DAYS)) {
      const dimensionFilterGroups = [{ filters: [{ dimension: "query", operator: "includingRegex", expression }] }];
      const [byDevice, byPage] = await Promise.all([q({ ...c, dimensions: ["date", "query", "device"], dimensionFilterGroups }, 500000),
        q({ ...c, dimensions: ["date", "query", "page"], dimensionFilterGroups }, 500000)]);
      tx(() => {
        for (const x of byDevice) idv.run(project.id, x.keys[1], x.keys[0], String(x.keys[2]).toLowerCase(), x.clicks, x.impressions, x.position);
        for (const x of byPage) ipg.run(project.id, x.keys[1], x.keys[0], x.keys[2], x.clicks, x.impressions, x.position);
      });
      out.keywordRows += byDevice.length + byPage.length;
    }
    state.keywords = targets; state.keywordsThrough = endDate; state.keywordError = null;
  } catch (e) { state.keywordError = out.keywordError = e.message; }

  // 3. Retention: nothing older than Search Console keeps.
  const cut = firstKept(endDate);
  for (const t of TABLES) run(`DELETE FROM ${t} WHERE project_id=? AND date < ?`, project.id, cut);
  state.fetchedAt = new Date().toISOString();
  save(project.id, state);
  return { ...out, queriesThrough: state.queriesThrough || null, keywordsThrough: state.keywordsThrough || null };
}

/** First and last stored day of the all-searches history, or null. */
export function historySpan(projectId) {
  const r = get("SELECT MIN(date) first, MAX(date) last, COUNT(DISTINCT query) queries FROM gsc_query_daily WHERE project_id=?", projectId);
  return r?.first ? r : null;
}

export const queryDays = (projectId, from, to) =>
  all("SELECT query, date, clicks, impressions, position FROM gsc_query_daily WHERE project_id=? AND date BETWEEN ? AND ?", projectId, from, to);

afterRefresh.push(["history", refreshHistory]);
