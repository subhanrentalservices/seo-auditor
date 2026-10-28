// Discover and Google News performance (REQ-055 group 4, item 5), shown apart from Search because they are different
// surfaces: Search Analytics with type=discover (the Discover feed) and type=googleNews (news.google.com and the Google
// News app; the News tab of Search is type=news and is not this). Neither reports searches or an average position, only
// clicks, impressions and CTR (Search Console Help, "Discover performance report"), and Search Console shows them only
// once the property passes a minimum number of impressions. So: one call per type for the daily totals over 16 months;
// only when that has rows are the pages of the last 28 days fetched. Runs on every Search Console refresh.
import { db, all, get, run } from "./db.mjs";
import { query, afterRefresh } from "./gsc.mjs";
import { firstKept, addDays } from "./gsc-history.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS gsc_type_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, date TEXT NOT NULL, clicks INTEGER, impressions INTEGER, PRIMARY KEY (project_id, type, date));
CREATE TABLE IF NOT EXISTS gsc_type_pages (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, page TEXT NOT NULL, clicks INTEGER, impressions INTEGER, start_date TEXT, end_date TEXT, PRIMARY KEY (project_id, type, page));
`);

export const TYPES = { discover: "Discover", googleNews: "Google News" };
const KEY = (id) => `gsc-types:${id}`;

export async function refreshTypes(project, { call, property, endDate }) {
  const q = (body, max) => query(property, body, max, call);
  const prev = get("SELECT value FROM meta WHERE key=?", KEY(project.id));
  const state = prev ? JSON.parse(prev.value) : {};
  const out = {};
  for (const type of Object.keys(TYPES)) {
    try {
      const days = await q({ type, startDate: firstKept(endDate), endDate, dimensions: ["date"] }, 1000);
      const range = { startDate: addDays(endDate, -27), endDate };
      const pages = days.length ? await q({ type, ...range, dimensions: ["page"] }, 1000) : [];
      db.exec("BEGIN");
      try {
        const id = db.prepare("INSERT OR REPLACE INTO gsc_type_daily (project_id,type,date,clicks,impressions) VALUES (?,?,?,?,?)");
        for (const r of days) id.run(project.id, type, r.keys[0], r.clicks, r.impressions);
        run("DELETE FROM gsc_type_daily WHERE project_id=? AND type=? AND date < ?", project.id, type, firstKept(endDate));
        run("DELETE FROM gsc_type_pages WHERE project_id=? AND type=?", project.id, type);
        const ip = db.prepare("INSERT OR REPLACE INTO gsc_type_pages (project_id,type,page,clicks,impressions,start_date,end_date) VALUES (?,?,?,?,?,?,?)");
        for (const r of pages) ip.run(project.id, type, r.keys[0], r.clicks, r.impressions, range.startDate, range.endDate);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      state[type] = { hasData: days.length > 0, fetchedAt: new Date().toISOString(), endDate, error: null };
      out[type] = { days: days.length, pages: pages.length };
    } catch (e) {
      state[type] = { ...(state[type] || {}), error: e.message };
      out[type] = { error: e.message };
    }
  }
  run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEY(project.id), JSON.stringify(state));
  return out;
}

const totals = (rows) => {
  const clicks = rows.reduce((n, r) => n + r.clicks, 0), impressions = rows.reduce((n, r) => n + r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? clicks / impressions : null };
};

/** Per type: whether the property has data, 28-day totals against the 28 days before, daily rows and top pages. */
export function typesReport(projectId) {
  const m = get("SELECT value FROM meta WHERE key=?", KEY(projectId));
  const state = m ? JSON.parse(m.value) : {};
  const types = Object.entries(TYPES).map(([type, label]) => {
    const st = state[type] || {};
    const days = all("SELECT date, clicks, impressions FROM gsc_type_daily WHERE project_id=? AND type=? ORDER BY date", projectId, type);
    const end = st.endDate || days.at(-1)?.date || null;
    const inRange = (a, b) => days.filter((d) => d.date >= a && d.date <= b);
    return { type, label, fetched: Boolean(st.fetchedAt), hasData: days.length > 0, error: st.error || null, endDate: end, days,
      last28: end ? totals(inRange(addDays(end, -27), end)) : null, prev28: end ? totals(inRange(addDays(end, -55), addDays(end, -28))) : null,
      pages: all("SELECT page, clicks, impressions, start_date, end_date FROM gsc_type_pages WHERE project_id=? AND type=? ORDER BY clicks DESC, impressions DESC LIMIT 100", projectId, type) };
  });
  return { types };
}

afterRefresh.push(["discover", refreshTypes]);

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/gsc\/types$/, ([id]) => typesReport(Number(id))]);
}
