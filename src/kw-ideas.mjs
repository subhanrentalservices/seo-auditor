// Keyword ideas (REQ-055 group 6, item 1), free first: Google Autocomplete suggestions for the project's target keywords
// and its top non-brand Search Console searches, each seed asked alone, with question words ("how", "what", ...) and
// with "vs / for / near", optionally with a-z. Read through the polite reader (robots.txt, one request at a time with a
// gap, the tool's own user agent, cached 7 days). Autocomplete shows what people type, not how often: every idea is
// labelled with its source and no volume is shown unless the owner presses the paid DataForSEO button (budget cap).
import { db, all, get, run, projectSettings } from "./db.mjs";
import { brandTest } from "./page2.mjs";
import { parseTargets, intentOf } from "./queries.mjs";
import { createPolite, startJob, jobStatus, pruneCache } from "./polite-fetch.mjs";
import { dfs, budget, spentThisMonth } from "./dataforseo.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS kw_ideas (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idea TEXT NOT NULL, seed TEXT, modifier TEXT, fetched_at TEXT, volume INTEGER, cpc REAL, competition REAL, difficulty INTEGER,
  volume_at TEXT, PRIMARY KEY (project_id, idea))`);

export const SOURCE = "Google Autocomplete";
export const QUESTION_WORDS = ["how", "what", "why", "when", "where", "which", "who", "can", "is", "does", "are"];
export const SUFFIXES = ["vs", "for", "near"];
export const CAPS = { seeds: 10, requests: 120, volumes: 700 };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// DataForSEO country location codes are 2000 + the ISO 3166 numeric code; Autocomplete wants the 2-letter code.
const ISO = { 36: "au", 840: "us", 826: "gb", 124: "ca", 554: "nz", 372: "ie", 356: "in", 710: "za", 702: "sg", 276: "de", 250: "fr",
  724: "es", 380: "it", 528: "nl", 56: "be", 756: "ch", 40: "at", 752: "se", 578: "no", 208: "dk", 246: "fi", 616: "pl", 620: "pt",
  484: "mx", 76: "br", 32: "ar", 392: "jp", 410: "kr", 458: "my", 608: "ph", 360: "id", 784: "ae", 682: "sa", 586: "pk" };
export const countryOf = (locationCode) => ISO[Number(locationCode) - 2000] || "";

export function suggestUrl(q, { hl = "en", gl = "" } = {}) {
  const p = new URLSearchParams({ client: "firefox", ie: "utf-8", oe: "utf-8", hl: String(hl || "en").slice(0, 10), q });
  if (gl) p.set("gl", gl);
  return `https://suggestqueries.google.com/complete/search?${p}`;
}

/** Autocomplete's answer `["query", ["suggestion", ...]]` as clean lower-case strings ([] for anything else). */
export function parseSuggest(body) {
  let j; try { j = JSON.parse(body); } catch { return []; }
  if (!Array.isArray(j) || !Array.isArray(j[1])) return [];
  return [...new Set(j[1].filter((s) => typeof s === "string").map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()).filter((s) => s && s.length <= 120))];
}

/** The requests for the seeds, most useful first (every seed alone, then question words, then vs/for/near, then a-z),
 *  capped. Returns [{ seed, modifier, q }]. */
export function plan(seeds, { az = false, max = CAPS.requests } = {}) {
  const rounds = [[""], QUESTION_WORDS, SUFFIXES, az ? [..."abcdefghijklmnopqrstuvwxyz"] : []];
  const out = [];
  for (const mods of rounds) for (const m of mods) for (const seed of seeds) {
    const q = !m ? seed : QUESTION_WORDS.includes(m) ? `${m} ${seed}` : `${seed} ${m}`;
    out.push({ seed, modifier: m || "(seed)", q });
  }
  return out.slice(0, max);
}

// Searches of the last 28 days of Search Console data: query -> impressions (property level, else the query x page rows).
function gscImpressions(projectId) {
  const has = (t) => get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
  const out = new Map();
  if (has("gsc_query_daily")) {
    const last = get("SELECT MAX(date) d FROM gsc_query_daily WHERE project_id=?", projectId)?.d;
    if (last) {
      const from = new Date(Date.parse(last + "T00:00:00Z") - 27 * 864e5).toISOString().slice(0, 10);
      for (const r of all("SELECT query, SUM(impressions) i FROM gsc_query_daily WHERE project_id=? AND date>=? GROUP BY query", projectId, from)) out.set(r.query, r.i);
      return out;
    }
  }
  if (has("gsc_queries")) for (const r of all("SELECT query, SUM(impressions) i FROM gsc_queries WHERE project_id=? GROUP BY query", projectId)) out.set(r.query, r.i);
  return out;
}

/** Seeds: the target keywords (Settings), then the top non-brand searches by impressions; at most CAPS.seeds. */
export function seedsFor(project) {
  const targets = parseTargets(projectSettings(project).targetKeywords);
  const isBrand = brandTest(project.name, project.start_url);
  const top = [...gscImpressions(project.id)].filter(([q]) => !isBrand(q) && q.length <= 80).sort((a, b) => b[1] - a[1]).map(([q]) => q);
  return [...new Set([...targets, ...top])].slice(0, CAPS.seeds);
}

/** Asks Autocomplete for every planned request and stores the ideas. opts: fetchFn/sleep/now (tests), az, seeds,
 *  progress(done, total, note). Returns counts. */
export async function runIdeas(project, { az = false, seeds = seedsFor(project), progress = () => {}, ...pol } = {}) {
  if (!seeds.length) fail(400, "No seeds: add target keywords in Settings or connect Search Console");
  const s = projectSettings(project);
  const polite = createPolite({ gapMs: 2000, ...pol });
  const reqs = plan(seeds, { az });
  const hl = s.dfsLanguage || "en", gl = countryOf(s.dfsLocation);
  const at = new Date().toISOString();
  let ideas = 0, blocked = 0, errors = 0;
  const save = db.prepare(`INSERT INTO kw_ideas (project_id, idea, seed, modifier, fetched_at) VALUES (?,?,?,?,?)
    ON CONFLICT(project_id, idea) DO UPDATE SET fetched_at=excluded.fetched_at`);
  for (const [i, r] of reqs.entries()) {
    progress(i, reqs.length, r.q);
    const res = await polite.page(suggestUrl(r.q, { hl, gl }), { accept: "application/json,text/javascript,*/*;q=0.5" });
    if (res.blocked) { blocked++; break; } // robots.txt said no: ask nothing more
    if (res.status !== 200) { errors++; if (res.status === 429 || res.status === 503) break; continue; }
    for (const idea of parseSuggest(res.body)) { save.run(project.id, idea, r.seed, r.modifier, at); ideas++; }
  }
  progress(reqs.length, reqs.length, "done");
  pruneCache(30, (pol.now || Date.now)());
  return { seeds: seeds.length, requests: reqs.length, network: polite.stats.requests, cached: polite.stats.cached, ideas, blocked, errors };
}

export function ideasReport(project, { limit = 1000 } = {}) {
  const targets = new Set(parseTargets(projectSettings(project).targetKeywords));
  const gsc = gscImpressions(project.id);
  const isBrand = brandTest(project.name, project.start_url);
  const rows = all("SELECT * FROM kw_ideas WHERE project_id=?", project.id).map((r) => ({
    idea: r.idea, source: SOURCE, seed: r.seed, modifier: r.modifier, fetchedAt: r.fetched_at, intent: intentOf(r.idea, isBrand),
    isTarget: targets.has(r.idea), gscImpressions: gsc.get(r.idea) ?? null,
    volume: r.volume, cpc: r.cpc, competition: r.competition, difficulty: r.difficulty, volumeAt: r.volume_at,
  }));
  rows.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || (b.gscImpressions ?? -1) - (a.gscImpressions ?? -1) || a.idea.localeCompare(b.idea));
  return { total: rows.length, ideas: rows.slice(0, limit), seeds: seedsFor(project), job: jobStatus("ideas", project.id), caps: CAPS,
    withVolume: rows.filter((r) => r.volume !== null).length };
}

export const volumeCost = (n) => 0.01 + 0.0001 * n; // DataForSEO Labs keyword_overview: per task + per keyword (USD)

/** Paid, on the owner's button only: search volume, CPC, competition and difficulty for ideas without them (or the
 *  given ones), in one keyword_overview call. Refuses before calling when the estimate would pass the monthly budget. */
export async function fetchVolumes(project, keywords, { send = dfs, spent = spentThisMonth, cap = budget } = {}) {
  const have = new Set(all("SELECT idea FROM kw_ideas WHERE project_id=?", project.id).map((r) => r.idea));
  const list = (keywords?.length ? keywords.filter((k) => have.has(k)) : all("SELECT idea FROM kw_ideas WHERE project_id=? AND volume IS NULL ORDER BY idea", project.id).map((r) => r.idea)).slice(0, CAPS.volumes);
  if (!list.length) fail(400, "No ideas without a volume: get ideas first");
  const est = volumeCost(list.length);
  if (spent() + est > cap()) fail(402, `This would cost about $${est.toFixed(3)} and pass the monthly DataForSEO budget of $${cap().toFixed(2)} ($${spent().toFixed(2)} spent). Raise it in Settings if you want more.`);
  const s = projectSettings(project);
  const r = await send("dataforseo_labs/google/keyword_overview/live", { keywords: list, location_code: Number(s.dfsLocation) || 2036, language_code: s.dfsLanguage || "en" }, project.id);
  const at = new Date().toISOString();
  const upd = db.prepare("UPDATE kw_ideas SET volume=?, cpc=?, competition=?, difficulty=?, volume_at=? WHERE project_id=? AND idea=?");
  let updated = 0;
  for (const it of r.items || []) {
    const k = String(it.keyword || "").toLowerCase(), info = it.keyword_info || {};
    if (!have.has(k)) continue;
    upd.run(info.search_volume ?? 0, info.cpc ?? null, info.competition ?? null, it.keyword_properties?.keyword_difficulty ?? null, at, project.id, k);
    updated++;
  }
  // Keywords DataForSEO has no data for: volume 0 ("no measurable volume"), so they aren't paid for again.
  for (const k of list) run("UPDATE kw_ideas SET volume=0, volume_at=? WHERE project_id=? AND idea=? AND volume IS NULL", at, project.id, k);
  return { asked: list.length, updated, estimate: est };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/keyword-ideas$/, ([id]) => ideasReport(project(id))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/keyword-ideas$/, ([id], _q, body) => {
    const p = project(id);
    const seeds = seedsFor(p);
    if (!seeds.length) fail(400, "No seeds: add target keywords in Settings or connect Search Console");
    startJob("ideas", p.id, (progress) => runIdeas(p, { az: body?.az === true, seeds, progress }));
    return { started: true, job: jobStatus("ideas", p.id) };
  }]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/keyword-ideas\/volumes$/, ([id], _q, body) => {
    const kw = body?.keywords;
    if (kw !== undefined && (!Array.isArray(kw) || kw.length > CAPS.volumes || kw.some((k) => typeof k !== "string" || k.length > 120))) fail(400, `keywords: a list of up to ${CAPS.volumes} searches`);
    return fetchVolumes(project(id), kw);
  }]);
}
