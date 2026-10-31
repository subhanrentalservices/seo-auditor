// AI visibility, more from what is already stored (REQ-055 group 9):
//   1. prompt suggestions: question searches from Search Console (free) that aren't prompts yet,
//   2. opt-in scheduled runs (paid): off until the owner turns them on per project; before each run the estimate is
//      checked against the monthly DataForSEO budget (and an optional per-run cap), and a run that doesn't fit is
//      skipped with the reason. Each paid call still goes through dfs(), which enforces the budget again,
//   3. a trend per prompt across runs, and competitor share of voice over time (domains cited per run),
//   4. cited sources mapped to the site's own pages: which own pages AI cites, and for prompts where others are cited
//      instead, the own page that best matches the prompt (Search Console first, then title/H1 words: a heuristic).
// Scheduled runs happen only while the app runs (checked every 30 minutes).
import { db, all, get, run } from "./db.mjs";
import { isQuestion, urlKey } from "./queries.mjs";
import { words } from "./page2.mjs";
import { budget as monthBudget, spentThisMonth, dfsConfigured } from "./dataforseo.mjs";
import { PLATFORMS, brandMatcher, startRun } from "./visibility.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS ai_schedule (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0, every_days INTEGER NOT NULL DEFAULT 30, platforms TEXT, max_cost REAL,
  last_check_at TEXT, last_run_id INTEGER, last_result TEXT);
`);

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hasTable = (t) => Boolean(get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name=?", t));
export const INTERVALS = [7, 14, 30];

/** Question searches from Search Console (last 90 days of kept history, else the last 28 days) that aren't prompts yet. */
export function promptSuggestions(projectId, { minImpressions = 5, limit = 50 } = {}) {
  const p = get("SELECT * FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const have = new Set(all("SELECT prompt FROM ai_prompts WHERE project_id=?", p.id).map((r) => r.prompt.toLowerCase().trim()));
  const daily = hasTable("gsc_query_daily") ? all(`SELECT query, SUM(impressions) impressions, SUM(clicks) clicks, SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
    FROM gsc_query_daily WHERE project_id=? AND date >= date((SELECT MAX(date) FROM gsc_query_daily WHERE project_id=?), '-89 days') GROUP BY query`, p.id, p.id) : [];
  const recent = all("SELECT query, SUM(impressions) impressions, SUM(clicks) clicks, SUM(position * impressions) / NULLIF(SUM(impressions), 0) position FROM gsc_queries WHERE project_id=? GROUP BY query", p.id);
  const rows = daily.length ? daily : recent;
  const pageOf = new Map();
  for (const r of all("SELECT query, page, impressions FROM gsc_queries WHERE project_id=? ORDER BY impressions ASC", p.id)) pageOf.set(r.query, r.page);
  const b = brandMatcher(p);
  return { source: daily.length ? "Search Console, last 90 days" : "Search Console, last 28 days", suggestions: rows
    .filter((r) => r.impressions >= minImpressions && isQuestion(r.query) && !have.has(r.query.toLowerCase().trim()))
    .sort((x, y) => y.impressions - x.impressions).slice(0, limit)
    .map((r) => ({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: r.position === null ? null : Math.round(r.position * 10) / 10, page: pageOf.get(r.query) || null, brand: b.mentions(r.query) })) };
}

// ---------- schedule ----------
export function getSchedule(projectId) {
  const s = get("SELECT * FROM ai_schedule WHERE project_id=?", projectId);
  const prompts = get("SELECT COUNT(*) n FROM ai_prompts WHERE project_id=?", projectId).n;
  const platforms = s?.platforms ? s.platforms.split(",").filter((k) => PLATFORMS[k]) : Object.keys(PLATFORMS);
  const perRun = estimate(prompts, platforms);
  return { enabled: Boolean(s?.enabled), everyDays: s?.every_days || 30, platforms, maxCost: s?.max_cost ?? null, prompts, estimate: perRun,
    lastCheckAt: s?.last_check_at || null, lastRunId: s?.last_run_id || null, lastResult: s?.last_result || null, intervals: INTERVALS,
    labels: Object.fromEntries(Object.entries(PLATFORMS).map(([k, x]) => [k, x.label])) };
}

export const estimate = (prompts, platforms) => Math.round(prompts * platforms.reduce((t, k) => t + (PLATFORMS[k]?.cost || 0), 0) * 1000) / 1000;

export function saveSchedule(projectId, body = {}) {
  get("SELECT id FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const cur = getSchedule(projectId);
  const everyDays = body.everyDays === undefined ? cur.everyDays : Number(body.everyDays);
  if (!INTERVALS.includes(everyDays)) fail(400, `Run every ${INTERVALS.join(", ")} days`);
  const platforms = body.platforms === undefined ? cur.platforms : [...new Set((Array.isArray(body.platforms) ? body.platforms : []).map(String))].filter((k) => PLATFORMS[k]);
  if (!platforms.length) fail(400, "Pick at least one platform");
  const maxCost = body.maxCost === undefined ? cur.maxCost : body.maxCost === null || body.maxCost === "" ? null : Number(body.maxCost);
  if (maxCost !== null && !(Number.isFinite(maxCost) && maxCost > 0)) fail(400, "The cost cap per run must be a positive number of dollars");
  const enabled = body.enabled === undefined ? cur.enabled : body.enabled === true; // only an explicit true turns paid runs on
  run(`INSERT INTO ai_schedule (project_id, enabled, every_days, platforms, max_cost) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET enabled=excluded.enabled, every_days=excluded.every_days, platforms=excluded.platforms, max_cost=excluded.max_cost`,
  projectId, enabled ? 1 : 0, everyDays, platforms.join(","), maxCost);
  return getSchedule(projectId);
}

/** Projects whose opt-in schedule is due: no run (scheduled or by hand) in the last everyDays days. */
export function dueSchedules(now = Date.now()) {
  return all("SELECT s.*, p.name FROM ai_schedule s JOIN projects p ON p.id=s.project_id WHERE s.enabled=1").filter((s) => {
    const last = get("SELECT started_at FROM ai_runs WHERE project_id=? ORDER BY id DESC LIMIT 1", s.project_id);
    return !last || now - Date.parse(last.started_at.replace(" ", "T") + "Z") >= s.every_days * 864e5 - 30 * 60e3;
  });
}

/** One pass of the scheduler. deps (tests): start(project, platforms), spent(), budget(), configured(), now. Every
 *  due project is checked against the budget before its run starts; a run that doesn't fit is skipped with the reason. */
export async function runDueSchedules({ start = startRun, spent = spentThisMonth, budget = monthBudget, configured = dfsConfigured, now = Date.now(), log = console.log } = {}) {
  const out = [];
  for (const s of dueSchedules(now)) {
    const project = get("SELECT * FROM projects WHERE id=?", s.project_id);
    const sch = getSchedule(s.project_id);
    let result, runId = null;
    const left = budget() - spent();
    if (!sch.prompts) result = "skipped: no prompts";
    else if (!configured()) result = "skipped: DataForSEO login not set";
    else if (sch.maxCost !== null && sch.estimate > sch.maxCost) result = `skipped: estimate $${sch.estimate.toFixed(3)} is over the cap of $${sch.maxCost.toFixed(2)} per run`;
    else if (sch.estimate > left) result = `skipped: estimate $${sch.estimate.toFixed(3)} is more than the $${Math.max(left, 0).toFixed(3)} left of this month's budget`;
    else {
      try { runId = (await start(project, sch.platforms)).runId; result = `started run ${runId} (≈ $${sch.estimate.toFixed(3)})`; }
      catch (e) { result = `failed: ${String(e.message).slice(0, 200)}`; }
    }
    run("UPDATE ai_schedule SET last_check_at=?, last_result=?, last_run_id=COALESCE(?, last_run_id) WHERE project_id=?", new Date(now).toISOString(), result, runId, s.project_id);
    log(`AI visibility schedule, ${s.name}: ${result}`);
    out.push({ projectId: s.project_id, result, runId });
  }
  return out;
}

// ---------- trends ----------
/** Per prompt, per run: platforms answered, mentioned, cited and the best rank; plus share of voice per run. */
export function visibilityTrends(projectId, { topDomains = 6 } = {}) {
  const runs = all("SELECT id, started_at FROM ai_runs WHERE project_id=? AND status IN ('done','stopped') ORDER BY id", projectId);
  const rows = runs.length ? all(`SELECT run_id, prompt, platform, mentioned, cited, rank, sources FROM ai_results WHERE error IS NULL AND run_id IN (${runs.map(() => "?").join(",")})`, ...runs.map((r) => r.id)) : [];
  const p = get("SELECT * FROM projects WHERE id=?", projectId);
  const b = p ? brandMatcher(p) : null;
  const prompts = new Map();
  const sov = runs.map(() => ({ answers: 0, domains: new Map() }));
  const idx = new Map(runs.map((r, i) => [r.id, i]));
  for (const r of rows) {
    const i = idx.get(r.run_id);
    if (!prompts.has(r.prompt)) prompts.set(r.prompt, runs.map(() => ({ answered: 0, mentioned: 0, cited: 0, bestRank: null })));
    const cell = prompts.get(r.prompt)[i];
    cell.answered++; cell.mentioned += r.mentioned ? 1 : 0; cell.cited += r.cited ? 1 : 0;
    if (r.rank && (cell.bestRank === null || r.rank < cell.bestRank)) cell.bestRank = r.rank;
    const cited = new Set(JSON.parse(r.sources || "[]").filter((s) => !s.organic).map((s) => s.domain).filter(Boolean));
    if (cited.size) { sov[i].answers++; for (const d of cited) sov[i].domains.set(d, (sov[i].domains.get(d) || 0) + 1); }
  }
  const total = new Map();
  for (const x of sov) for (const [d, n] of x.domains) total.set(d, (total.get(d) || 0) + n);
  const own = [...total.keys()].filter((d) => b?.isOwn(d));
  const top = [...new Set([...[...total].sort((x, y) => y[1] - x[1]).slice(0, topDomains).map(([d]) => d), ...own])];
  return {
    runs: runs.map((r, i) => ({ id: r.id, at: r.started_at, answersWithSources: sov[i].answers })),
    prompts: [...prompts].map(([prompt, series]) => ({ prompt, series })),
    shareOfVoice: top.map((d) => ({ domain: d, own: Boolean(b?.isOwn(d)), shares: sov.map((x) => (x.answers ? Math.round((1000 * (x.domains.get(d) || 0)) / x.answers) / 1000 : null)) })),
  };
}

// ---------- cited sources → own pages ----------
const overlap = (a, bw) => { const x = new Set(a); return x.size ? [...new Set(bw)].filter((w) => x.has(w)).length / x.size : 0; };

/** For the latest finished run: own pages AI cites (with the crawled page), and per prompt where only others are
 *  cited, the own page that best matches it. */
export function sourceMapping(projectId) {
  const p = get("SELECT * FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const last = get("SELECT id, started_at FROM ai_runs WHERE project_id=? AND status IN ('done','stopped') ORDER BY id DESC LIMIT 1", p.id);
  if (!last) return { run: null, ownCited: [], prompts: [] };
  const b = brandMatcher(p);
  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", p.id);
  const pages = audit ? all("SELECT url, final_url, status, title, h1, indexable FROM pages WHERE audit_id=?", audit.id) : [];
  const byKey = new Map();
  for (const x of pages) for (const u of [x.url, x.final_url]) if (u && (!byKey.has(urlKey(u)) || x.status === 200)) byKey.set(urlKey(u), x);
  const gscRows = all("SELECT query, page, impressions FROM gsc_queries WHERE project_id=?", p.id).map((r) => ({ ...r, w: words(r.query) }));
  const results = all("SELECT prompt, platform, cited, sources FROM ai_results WHERE run_id=? AND error IS NULL", last.id).map((r) => ({ ...r, sources: JSON.parse(r.sources || "[]").filter((s) => !s.organic) }));
  const ownCited = new Map(), prompts = new Map();
  for (const r of results) {
    const e = prompts.get(r.prompt) || { prompt: r.prompt, ownUrls: new Set(), others: new Map() };
    for (const s of r.sources) {
      if (!s.url && !s.domain) continue;
      if (b.isOwn(s.domain)) {
        const k = urlKey(s.url || "https://" + s.domain + "/");
        const c = ownCited.get(k) || { url: s.url, page: byKey.get(k) || null, prompts: new Set(), platforms: new Set() };
        c.prompts.add(r.prompt); c.platforms.add(r.platform); ownCited.set(k, c); e.ownUrls.add(s.url);
      } else e.others.set(s.domain, (e.others.get(s.domain) || 0) + 1);
    }
    prompts.set(r.prompt, e);
  }
  const bestPage = (prompt) => {
    const pw = words(prompt);
    let g = null;
    for (const r of gscRows) { const sc = overlap(pw, r.w); if (sc >= 0.5 && (!g || sc > g.sc || (sc === g.sc && r.impressions > g.impressions))) g = { sc, impressions: r.impressions, url: r.page }; }
    if (g) return { url: g.url, title: byKey.get(urlKey(g.url))?.title || null, via: "Search Console search on the same topic", score: Math.round(g.sc * 100) / 100 };
    let t = null;
    for (const x of pages) if (x.status === 200 && x.indexable) { const sc = overlap(pw, [...words(x.title), ...words(x.h1)]); if (sc >= 0.4 && (!t || sc > t.sc)) t = { sc, x }; }
    return t ? { url: t.x.url, title: t.x.title, via: "title/H1 words (heuristic)", score: Math.round(t.sc * 100) / 100 } : null;
  };
  return {
    run: last, auditId: audit?.id || null,
    ownCited: [...ownCited.values()].map((c) => ({ url: c.url, title: c.page?.title || null, status: c.page?.status ?? null, inAudit: Boolean(c.page), prompts: [...c.prompts], platforms: [...c.platforms] }))
      .sort((x, y) => y.prompts.length - x.prompts.length),
    prompts: [...prompts.values()].filter((e) => !e.ownUrls.size && e.others.size).map((e) => ({ prompt: e.prompt,
      cited: [...e.others].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([domain, n]) => ({ domain, answers: n })), ownPage: bestPage(e.prompt) })),
  };
}

export function register({ routes, cli }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/visibility\/suggestions$/, ([id]) => promptSuggestions(project(id).id)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/visibility\/trends$/, ([id]) => visibilityTrends(project(id).id)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/visibility\/sources$/, ([id]) => sourceMapping(project(id).id)]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/visibility\/schedule$/, ([id]) => getSchedule(project(id).id)]);
  routes.push(["PUT", /^\/api\/projects\/(\d+)\/visibility\/schedule$/, ([id], q, body) => saveSchedule(project(id).id, body)]);
  if (cli) return; // the scheduled task outside the app doesn't start paid runs
  const tick = () => runDueSchedules().catch((e) => console.error("AI visibility schedule:", e.message));
  setTimeout(tick, 3 * 60e3).unref?.();
  setInterval(tick, 30 * 60e3).unref?.();
}
