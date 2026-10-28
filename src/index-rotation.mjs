// Scheduled URL Inspection (REQ-055 group 4, item 6). Google's URL Inspection API allows 2,000 inspections a day per
// property (Search Console API usage limits); a manual check (indexing.mjs) covers at most 500 pages. With "URLs per
// day" set (project setting inspectPerDay, 0 = off, capped at 1,800 to keep a safety margin for manual checks), the app
// inspects the indexable pages of the latest audit a batch at a time, never-inspected first and then the
// longest-unchecked, so a site of any size is covered in turn. The count of the last 24 hours (manual runs included)
// stays under the daily figure, so no calendar day — Google counts by Pacific time — goes over it.
// Every change of Google's verdict, coverage state or chosen canonical is kept in index_history (an SQLite trigger on
// index_status, so manual runs are recorded too), which shows when a page dropped out of the index or came back.
// Runs only while the app runs (checked every 30 minutes). Read-only: never requests indexing.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { gsc, detectProperty } from "./gsc.mjs";
import { targets, parseInspection, classify, indexRunning } from "./indexing.mjs";
import { emit } from "./runner.mjs";

export const DAILY_QUOTA = 2000;
export const MAX_PER_DAY = 1800;
const CHECK_EVERY = 30 * 60e3;

db.exec(`
CREATE TABLE IF NOT EXISTS index_history (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL, inspected_at TEXT NOT NULL, verdict TEXT, coverage TEXT, indexing_state TEXT, google_canonical TEXT, last_crawl TEXT);
CREATE INDEX IF NOT EXISTS idx_index_history ON index_history(project_id, url, id);
CREATE TRIGGER IF NOT EXISTS index_status_history AFTER INSERT ON index_status WHEN NEW.error IS NULL BEGIN
  INSERT INTO index_history (project_id, url, inspected_at, verdict, coverage, indexing_state, google_canonical, last_crawl)
  SELECT NEW.project_id, NEW.url, NEW.inspected_at, NEW.verdict, NEW.coverage, NEW.indexing_state, NEW.google_canonical, NEW.last_crawl
  WHERE NOT EXISTS (SELECT 1 FROM (SELECT verdict, coverage, google_canonical FROM index_history WHERE project_id=NEW.project_id AND url=NEW.url ORDER BY id DESC LIMIT 1) h
    WHERE h.verdict IS NEW.verdict AND h.coverage IS NEW.coverage AND h.google_canonical IS NEW.google_canonical);
END;
`);

const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19); // SQLite datetime('now') format, UTC
export const perDayOf = (project) => Math.min(Math.max(0, Math.floor(Number(projectSettings(project).inspectPerDay) || 0)), MAX_PER_DAY);

/** Inspections stored in the last 24 hours (manual and scheduled). */
export const usedLast24h = (projectId, now = Date.now()) =>
  get("SELECT COUNT(*) n FROM index_status WHERE project_id=? AND inspected_at >= ?", projectId, sqlTime(now - 864e5)).n;

/** The next `n` indexable pages of the latest audit: never inspected first (in crawl order), then oldest inspection. */
export function pickUrls(projectId, n) {
  const last = new Map(all("SELECT url, inspected_at FROM index_status WHERE project_id=?", projectId).map((r) => [r.url, r.inspected_at]));
  return targets(projectId).filter((t) => t.wanted).map((t, i) => ({ ...t, i, at: last.get(t.url) ?? null }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at === null ? -1 : b.at === null ? 1 : a.at < b.at ? -1 : 1))
    .slice(0, Math.max(0, n)).map(({ url, wanted }) => ({ url, wanted }));
}

/** One scheduled batch for a project. inspect: (url) => URL Inspection response (tests pass a mock). */
export async function rotate(project, { inspect, perDay, now = Date.now() } = {}) {
  const budget = Math.min(perDay ?? perDayOf(project), MAX_PER_DAY);
  if (!budget) return { skipped: "off" };
  if (indexRunning.has(project.id)) return { skipped: "running" };
  const used = usedLast24h(project.id, now), left = budget - used;
  if (left <= 0) return { skipped: "quota", used };
  const urls = pickUrls(project.id, left);
  if (!urls.length) return { skipped: "no-pages" };
  let call = inspect;
  if (!call) {
    const property = projectSettings(project).gscProperty || (await detectProperty(project.start_url));
    if (!property) return { skipped: "no-property" };
    call = (url) => gsc("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: url, siteUrl: property });
  }
  indexRunning.add(project.id);
  const runId = Number(run("INSERT INTO index_runs (project_id, urls, status, message) VALUES (?, ?, 'running', 'Scheduled')", project.id, urls.length).lastInsertRowid);
  let done = 0, quota = null;
  try {
    const up = db.prepare(`INSERT OR REPLACE INTO index_status (project_id, url, verdict, coverage, indexing_state, robots, fetch_state, google_canonical, user_canonical, last_crawl, sitemap, wanted, inspected_at, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)`);
    const queue = [...urls];
    const worker = async () => {
      while (queue.length && !quota) {
        const { url, wanted } = queue.shift();
        try {
          const x = parseInspection(await call(url));
          up.run(project.id, url, x.verdict, x.coverage, x.indexing_state, x.robots, x.fetch_state, x.google_canonical, x.user_canonical, x.last_crawl, x.sitemap, wanted, null);
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          if (e.response?.status === 429 || /quota/i.test(msg)) { quota = msg; break; }
          up.run(project.id, url, null, null, null, null, null, null, null, null, null, wanted, String(msg).slice(0, 300));
        }
        done++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const counts = all("SELECT coverage, verdict FROM index_status WHERE project_id=? AND wanted=1 AND error IS NULL", project.id)
      .reduce((m, r) => { const k = classify(r.coverage, r.verdict).kind; m[k] = (m[k] || 0) + 1; return m; }, {});
    run("UPDATE index_runs SET status=?, finished_at=datetime('now'), message=?, counts=? WHERE id=?", quota ? "stopped" : "done",
      quota ? `Scheduled: stopped at the daily limit (${quota})` : `Scheduled: ${done} pages`, JSON.stringify(counts), runId);
  } catch (e) {
    run("UPDATE index_runs SET status='failed', finished_at=datetime('now'), message=? WHERE id=?", e.message, runId);
    throw e;
  } finally { indexRunning.delete(project.id); }
  return { runId, inspected: done, stopped: quota };
}

const kindOf = (r) => classify(r.coverage, r.verdict).kind;

/** Every recorded state of one URL, oldest first. */
export function urlHistory(projectId, url) {
  return all("SELECT inspected_at, verdict, coverage, indexing_state, google_canonical, last_crawl FROM index_history WHERE project_id=? AND url=? ORDER BY id", projectId, String(url || ""))
    .map((r) => ({ ...r, kind: kindOf(r) }));
}

/** URLs whose state changed in the last `days` days: the state before and the new one (first sightings are not changes). */
export function indexChanges(projectId, { days = 30, now = Date.now() } = {}) {
  const since = sqlTime(now - days * 864e5), out = [];
  const rows = all(`SELECT h.* FROM index_history h WHERE h.project_id=? AND h.url IN (SELECT url FROM index_history WHERE project_id=? AND inspected_at >= ?) ORDER BY h.url, h.id`, projectId, projectId, since);
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.url !== b.url || b.inspected_at < since) continue;
    out.push({ url: b.url, at: b.inspected_at, from: { kind: kindOf(a), coverage: a.coverage, since: a.inspected_at }, to: { kind: kindOf(b), coverage: b.coverage },
      lost: kindOf(a) === "indexed" && kindOf(b) !== "indexed", gained: kindOf(a) !== "indexed" && kindOf(b) === "indexed", googleCanonical: b.google_canonical });
  }
  return out.sort((x, y) => (x.at < y.at ? 1 : -1));
}

export function rotationStatus(projectId, now = Date.now()) {
  const p = get("SELECT * FROM projects WHERE id=?", Number(projectId));
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  const wanted = targets(p.id).filter((t) => t.wanted), at = new Map(all("SELECT url, inspected_at FROM index_status WHERE project_id=? AND error IS NULL", p.id).map((r) => [r.url, r.inspected_at]));
  const seen = wanted.map((t) => at.get(t.url)).filter(Boolean).sort();
  const perDay = perDayOf(p);
  return { perDay, maxPerDay: MAX_PER_DAY, dailyQuota: DAILY_QUOTA, used24h: usedLast24h(p.id, now), pages: wanted.length,
    neverInspected: wanted.length - seen.length, inspected30d: seen.filter((s) => s >= sqlTime(now - 30 * 864e5)).length,
    oldest: seen[0] || null, cycleDays: perDay ? Math.ceil(wanted.length / perDay) : null, running: indexRunning.has(p.id),
    changes: indexChanges(p.id, { now }).slice(0, 200) };
}

export function setPerDay(projectId, body = {}) {
  const p = get("SELECT * FROM projects WHERE id=?", Number(projectId));
  if (!p) throw Object.assign(new Error("Project not found"), { status: 404 });
  const n = Math.min(Math.max(0, Math.floor(Number(body.perDay) || 0)), MAX_PER_DAY);
  run("UPDATE projects SET settings=? WHERE id=?", JSON.stringify({ ...JSON.parse(p.settings || "{}"), inspectPerDay: n }), p.id);
  return rotationStatus(p.id);
}

async function tick() {
  for (const p of all("SELECT * FROM projects")) {
    if (!perDayOf(p) || !get("SELECT 1 x FROM audits WHERE project_id=? AND status='done'", p.id)) continue;
    const r = await rotate(p).catch((e) => ({ error: e.message }));
    if (r.inspected || r.error) console.log(`index rotation ${p.name}:`, r.error || `${r.inspected} pages`);
    if (r.inspected) emit({ type: "phase", projectId: p.id, auditId: null, phase: null });
  }
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/index-rotation$/, ([id]) => rotationStatus(id)]);
  routes.push(["PUT", /^\/api\/projects\/(\d+)\/index-rotation$/, ([id], q, b) => setPerDay(id, b)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/index-history$/, ([id], q) => urlHistory(Number(id), q.url)]);
  setTimeout(() => tick().catch(() => {}), 2 * 60e3).unref?.();
  setInterval(() => tick().catch(() => {}), CHECK_EVERY).unref?.();
}
