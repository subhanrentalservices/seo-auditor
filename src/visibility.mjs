// AI Visibility: for each saved prompt, ask ChatGPT (web search), Google (AI Overview + organic + local pack in one
// SERP), Google AI Mode, Perplexity and Gemini through DataForSEO, then record whether the brand is mentioned, cited and where it
// ranks, plus which other domains get cited. Paid per prompt; runs only when the owner starts it.
import { db, all, get, run, projectSettings } from "./db.mjs";
import { dfs, dfsConfigured } from "./dataforseo.mjs";
import { emit } from "./runner.mjs";
import { serpSnapshot } from "./serpfeatures.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS ai_prompts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id, prompt));
CREATE TABLE IF NOT EXISTS ai_runs (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT, status TEXT, platforms TEXT, prompts INTEGER, cost REAL DEFAULT 0, message TEXT);
CREATE TABLE IF NOT EXISTS ai_results (run_id INTEGER NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE, prompt TEXT, platform TEXT,
  present INTEGER, mentioned INTEGER, cited INTEGER, rank INTEGER, organic_pos INTEGER, local_pos INTEGER,
  sources TEXT, brands TEXT, excerpt TEXT, check_url TEXT, error TEXT);
`);
// SERP features snapshot (JSON) from the Google search already paid for; runs before 2026-10-26 have none.
if (!db.prepare("PRAGMA table_info(ai_results)").all().some((c) => c.name === "serp")) db.exec("ALTER TABLE ai_results ADD COLUMN serp TEXT");

export const PLATFORMS = {
  chatgpt: { label: "ChatGPT (web search)", cost: 0.004 },
  google: { label: "Google: AI Overview + rankings", cost: 0.006 },
  ai_mode: { label: "Google AI Mode", cost: 0.004 },
  perplexity: { label: "Perplexity (Sonar, web search)", cost: 0.006 },
  gemini: { label: "Gemini", cost: 0.004 },
};

// DataForSEO country location codes are 2000 + the ISO 3166 numeric code; Perplexity wants the two-letter code.
const COUNTRY_ISO = { 2036: "AU", 2840: "US", 2826: "GB", 2124: "CA", 2554: "NZ", 2372: "IE", 2356: "IN", 2586: "PK", 2702: "SG",
  2784: "AE", 2710: "ZA", 2276: "DE", 2250: "FR", 2724: "ES", 2380: "IT", 2528: "NL" };

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || "").replace(/^www\./, ""); } };
const compact = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Brand matcher from the domain, project name and extra brand terms. */
export function brandMatcher(project) {
  const s = projectSettings(project);
  const domain = host(project.start_url);
  const terms = [domain, domain.split(".")[0], project.name, ...String(s.brandTerms || "").split(",")].map((t) => t.trim()).filter((t) => compact(t).length >= 4);
  const keys = [...new Set(terms.map(compact))];
  const isOwn = (d) => { const x = host(d); return x === domain || x.endsWith("." + domain); };
  return { domain, isOwn, mentions: (text) => { const c = compact(text); return keys.some((k) => c.includes(k)); } };
}

// DataForSEO's live SERP often answers "Internal SE Server Error" (about 1 call in 4 for Google); later tries usually work.
export const RETRY_WAITS = [3000, 10000, 30000];
export async function call(endpoint, body, projectId, send = dfs) {
  for (let i = 0; ; i++) {
    try { return await send(endpoint, body, projectId); }
    catch (e) {
      if (i >= RETRY_WAITS.length || !/40101|50000|Internal|timeout/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_WAITS[i]));
    }
  }
}

async function checkChatGpt(prompt, loc, b, pid) {
  return parseChatGpt(await call("ai_optimization/chat_gpt/llm_scraper/live/advanced", { keyword: prompt, location_code: loc, language_code: "en", force_web_search: true }, pid), b);
}

/** ChatGPT llm_scraper result: markdown, sources, local business cards and brand entities. */
export function parseChatGpt(r, b) {
  const sources = (r.sources || []).map((x) => ({ domain: host(x.domain || x.url), url: x.url, title: x.title }));
  const names = [];
  for (const it of r.items || []) {
    if (it.type === "chat_gpt_local_businesses") for (const x of it.items || []) names.push({ name: x.title, domain: host(x.domain || x.url || "") });
    for (const e of it.brand_entities || []) names.push({ name: e.title, domain: host(e.urls?.[0]?.domain || "") });
  }
  for (const e of r.brand_entities || []) names.push({ name: e.title, domain: host(e.urls?.[0]?.domain || "") });
  const uniq = []; for (const n of names) if (n.name && !uniq.some((u) => compact(u.name) === compact(n.name))) uniq.push(n);
  // Rank = place in the answer's own list ("**1. Name**"); the business cards are a fallback (they can leave the brand out).
  const listed = listRank(r.markdown, b);
  const idx = listed ? listed - 1 : uniq.findIndex((n) => b.mentions(n.name) || (n.domain && b.isOwn(n.domain)));
  return { present: 1, mentioned: b.mentions(r.markdown) || idx >= 0 ? 1 : 0, cited: sources.some((s) => b.isOwn(s.domain)) ? 1 : 0, rank: idx >= 0 ? idx + 1 : null,
    sources, brands: uniq.slice(0, 15).map((n) => n.name), excerpt: (r.markdown || "").slice(0, 1500), check_url: r.check_url || null };
}

async function checkGoogle(prompt, loc, b, pid) {
  const r = await call("serp/google/organic/live/advanced", { keyword: prompt, location_code: loc, language_code: "en", device: "mobile", os: "android", depth: 20, load_async_ai_overview: true }, pid);
  const items = r.items || [];
  const aio = items.find((i) => i.type === "ai_overview");
  const refs = (aio?.references || []).map((x) => ({ domain: host(x.domain || x.url), url: x.url, title: x.title }));
  const organic = items.filter((i) => i.type === "organic");
  const own = organic.find((i) => b.isOwn(i.domain));
  const pack = items.find((i) => i.type === "local_pack") ? items.filter((i) => i.type === "local_pack") : [];
  const packIdx = pack.findIndex((p) => b.mentions(p.title) || (p.domain && b.isOwn(p.domain)));
  return { present: aio ? 1 : 0, mentioned: aio && b.mentions(aio.markdown) ? 1 : 0, cited: refs.some((s) => b.isOwn(s.domain)) ? 1 : 0, rank: null,
    organic_pos: own ? own.rank_group : null, local_pos: packIdx >= 0 ? packIdx + 1 : null,
    sources: refs.length ? refs : organic.slice(0, 10).map((i) => ({ domain: host(i.domain), url: i.url, title: i.title, organic: true })),
    brands: pack.map((p) => p.title).slice(0, 10), excerpt: (aio?.markdown || "").slice(0, 1500), check_url: r.check_url || null,
    serp: serpSnapshot(items, (d) => b.isOwn(d)) };
}

async function checkAiMode(prompt, loc, b, pid) {
  const r = await call("serp/google/ai_mode/live/advanced", { keyword: prompt, location_code: loc, language_code: "en", device: "mobile" }, pid);
  const aio = (r.items || []).find((i) => i.type === "ai_overview");
  const refs = (aio?.references || []).map((x) => ({ domain: host(x.domain || x.url), url: x.url, title: x.title }));
  return { present: aio ? 1 : 0, mentioned: aio && b.mentions(aio.markdown) ? 1 : 0, cited: refs.some((s) => b.isOwn(s.domain)) ? 1 : 0, rank: null,
    sources: refs, brands: [], excerpt: (aio?.markdown || "").slice(0, 1500), check_url: r.check_url || null };
}
/** Business names an answer lists: bold text that opens a bullet or a paragraph (numbered steps are skipped). */
const LABEL = /^(phone|address|website|hours|email|note|tip|why|best for|services|location|contact|focus|details)$/i;
// Candidate names in answer order: bold text opening a bullet or paragraph ("**1\. Name**", "- **Name:**") and numbered
// headings ("### 1. Name"). Numbered bullets ("1. **Gather information**") are steps, not picks.
function candidates(markdown) {
  const out = [];
  for (const m of String(markdown || "").matchAll(/^[ \t]*(?:(#{1,4})[ \t]+(\d+\\?\.[ \t]+[^\n]{2,80})|(?:[-*•][ \t]+)?\*\*([^*\n]{2,80}?)\*\*)/gm)) {
    const raw = (m[2] || m[3]).replace(/\*\*/g, "");
    const numbered = Boolean(m[2]) || /^\d+\\?\.\s/.test(raw);
    const name = raw.replace(/^\d+\\?\.\s*/, "").replace(/[\\:\s]+$/, "").trim(); // "1\. Name:" → "Name"
    if (name && !LABEL.test(name) && !out.some((n) => compact(n.name) === compact(name))) out.push({ name, numbered, heading: Boolean(m[2]) });
  }
  return out;
}
/** Business names an answer lists; when it numbers its picks, only the numbered ones (other bold lines are labels or notes). */
export function listedNames(markdown) {
  const c = candidates(markdown);
  return (c.some((n) => n.numbered) ? c.filter((n) => n.numbered) : c).map((n) => n.name);
}
/** The brand's place in the answer: among numbered picks first, else among bold names (headings there are categories). */
export function listRank(markdown, b) {
  const c = candidates(markdown);
  const i = c.filter((n) => n.numbered).findIndex((n) => b.mentions(n.name));
  if (i >= 0) return i + 1;
  const j = c.filter((n) => !n.heading).findIndex((n) => b.mentions(n.name));
  return j >= 0 ? j + 1 : null;
}

function textAnswer(text, sourceList, b) {
  const seen = new Set(), sources = [];
  for (const x of sourceList) { const url = String(x.url || "").replace(/#:~:text=.*$/, ""); if (url && !seen.has(url)) { seen.add(url); sources.push({ domain: host(x.domain || url), url, title: x.title || x.source_name || "" }); } }
  const names = listedNames(text);
  return { present: text ? 1 : 0, mentioned: b.mentions(text) ? 1 : 0, cited: sources.some((s) => b.isOwn(s.domain)) ? 1 : 0, rank: listRank(text, b),
    sources, brands: names.slice(0, 15), excerpt: String(text || "").slice(0, 1500), check_url: null };
}

/** Perplexity llm_responses result: items[].sections[] with text and annotations (title, url). */
export function parsePerplexity(r, b) {
  const sections = (r.items || []).flatMap((i) => i.sections || []).filter((s) => s.type === "text" || s.text);
  return textAnswer(sections.map((s) => s.text).join("\n\n"), sections.flatMap((s) => s.annotations || []), b);
}

/** Gemini llm_scraper result: markdown plus sources (domain, url, title, source_name). */
export function parseGemini(r, b) {
  const sources = [...(r.sources || []), ...(r.items || []).flatMap((i) => i.sources || [])];
  return textAnswer(r.markdown || (r.items || []).map((i) => i.markdown).filter(Boolean).join("\n\n"), sources, b);
}

async function checkPerplexity(prompt, loc, b, pid) {
  const iso = COUNTRY_ISO[loc];
  const r = await call("ai_optimization/perplexity/llm_responses/live", { user_prompt: prompt, model_name: "sonar", max_output_tokens: 1500, ...(iso ? { web_search_country_iso_code: iso } : {}) }, pid);
  return parsePerplexity(r, b);
}

async function checkGemini(prompt, loc, b, pid) {
  return parseGemini(await call("ai_optimization/gemini/llm_scraper/live/advanced", { keyword: prompt, location_code: loc, language_code: "en" }, pid), b);
}

const CHECK = { chatgpt: checkChatGpt, google: checkGoogle, ai_mode: checkAiMode, perplexity: checkPerplexity, gemini: checkGemini };
const COUNTRY_LEVEL = new Set(["chatgpt", "perplexity", "gemini"]); // these take a country, not a city

const runningRuns = new Set();
const ready = (project) => {
  if (runningRuns.has(project.id)) throw Object.assign(new Error("A visibility run is already in progress"), { status: 409 });
  if (!dfsConfigured()) throw Object.assign(new Error("DataForSEO login not found. Add it in Settings → DataForSEO."), { status: 400 });
};

export async function startRun(project, platforms) {
  const prompts = all("SELECT prompt FROM ai_prompts WHERE project_id=? ORDER BY id", project.id).map((r) => r.prompt);
  platforms = platforms.filter((p) => CHECK[p]);
  if (!prompts.length) throw Object.assign(new Error("Add some prompts first"), { status: 400 });
  if (!platforms.length) throw Object.assign(new Error("Pick at least one platform"), { status: 400 });
  ready(project);
  const runId = Number(run("INSERT INTO ai_runs (project_id, status, platforms, prompts) VALUES (?, 'running', ?, ?)", project.id, platforms.join(","), prompts.length).lastInsertRowid);
  return execute(project, runId, prompts.flatMap((p) => platforms.map((pl) => [p, pl])), 0);
}

/** Finish a run the budget (or a crash) stopped: only the prompt × platform checks it has no answer for are run, into
 *  the same run, so nothing already paid for is bought twice and the run stays one comparable snapshot. Failed checks
 *  are retried; prompts deleted since are skipped. */
export async function resumeRun(project, runId) {
  const r = get("SELECT * FROM ai_runs WHERE id=? AND project_id=?", Number(runId), project.id);
  if (!r) throw Object.assign(new Error("Run not found"), { status: 404 });
  if (!["stopped", "failed"].includes(r.status)) throw Object.assign(new Error("Only a stopped or failed run can be finished"), { status: 400 });
  ready(project);
  const have = new Set(all("SELECT prompt, platform FROM ai_results WHERE run_id=? AND error IS NULL", r.id).map((x) => `${x.platform}\n${x.prompt}`));
  const prompts = all("SELECT prompt FROM ai_prompts WHERE project_id=? ORDER BY id", project.id).map((x) => x.prompt);
  const jobs = prompts.flatMap((p) => r.platforms.split(",").filter((pl) => CHECK[pl] && !have.has(`${pl}\n${p}`)).map((pl) => [p, pl]));
  if (!jobs.length) throw Object.assign(new Error("This run has an answer for every check already"), { status: 400 });
  run("DELETE FROM ai_results WHERE run_id=? AND error IS NOT NULL", r.id);
  run("UPDATE ai_runs SET status='running', message=NULL, finished_at=NULL WHERE id=?", r.id);
  return execute(project, r.id, jobs, r.cost || 0);
}

function execute(project, runId, jobs, costBefore) {
  const s = projectSettings(project);
  const country = Number(s.dfsLocation) || 2036;
  const local = Number(s.aiLocation) || country; // city-level location for Google; ChatGPT only takes countries
  const b = brandMatcher(project);
  const spentBefore = get("SELECT COALESCE(SUM(cost),0) s FROM dfs_costs").s;
  const total = jobs.length;
  runningRuns.add(project.id);
  (async () => {
    let done = 0, stopped = null;
    const ins = db.prepare(`INSERT INTO ai_results (run_id, prompt, platform, present, mentioned, cited, rank, organic_pos, local_pos, sources, brands, excerpt, check_url, error, serp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const worker = async () => {
      while (jobs.length && !stopped) {
        const [prompt, pl] = jobs.shift();
        try {
          const x = await CHECK[pl](prompt, COUNTRY_LEVEL.has(pl) ? country : local, b, project.id);
          ins.run(runId, prompt, pl, x.present, x.mentioned, x.cited, x.rank, x.organic_pos ?? null, x.local_pos ?? null, JSON.stringify(x.sources), JSON.stringify(x.brands), x.excerpt, x.check_url, null, x.serp ? JSON.stringify(x.serp) : null);
        } catch (e) {
          if (e.status === 402) stopped = e.message; // budget reached: stop the whole run
          ins.run(runId, prompt, pl, null, null, null, null, null, null, "[]", "[]", "", null, e.message.slice(0, 300), null);
        }
        done++;
        emit({ type: "phase", projectId: project.id, auditId: null, phase: `AI visibility ${done}/${total}` });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const cost = costBefore + get("SELECT COALESCE(SUM(cost),0) s FROM dfs_costs").s - spentBefore;
    run("UPDATE ai_runs SET status=?, finished_at=datetime('now'), cost=?, message=? WHERE id=?", stopped ? "stopped" : "done", cost, stopped, runId);
    runningRuns.delete(project.id);
    emit({ type: "phase", projectId: project.id, auditId: null, phase: null });
    emit({ type: "visibility", projectId: project.id, runId });
  })().catch((e) => { runningRuns.delete(project.id); run("UPDATE ai_runs SET status='failed', message=? WHERE id=?", e.message, runId); });
  return { runId, calls: total };
}

export function visibilityData(projectId) {
  const prompts = all("SELECT id, prompt FROM ai_prompts WHERE project_id=? ORDER BY id", projectId);
  const runs = all("SELECT * FROM ai_runs WHERE project_id=? ORDER BY id", projectId);
  const rates = (runId) => all(`SELECT platform, COUNT(*) n, SUM(error IS NOT NULL) errors, SUM(present) present, SUM(mentioned) mentioned, SUM(cited) cited,
      AVG(rank) avg_rank, SUM(organic_pos IS NOT NULL AND organic_pos <= 10) top10, SUM(local_pos IS NOT NULL) in_pack
    FROM ai_results WHERE run_id=? GROUP BY platform`, runId);
  const last = runs.filter((r) => r.status !== "running").at(-1);
  const results = last ? all("SELECT * FROM ai_results WHERE run_id=? ORDER BY prompt, platform", last.id).map((r) => ({ ...r, sources: JSON.parse(r.sources || "[]"), brands: JSON.parse(r.brands || "[]") })) : [];
  // Share of voice: which domains AI answers cite most across the last run (own domain marked).
  const p = get("SELECT * FROM projects WHERE id=?", projectId);
  const b = p ? brandMatcher(p) : null;
  const sov = new Map();
  for (const r of results) for (const d of new Set(r.sources.filter((s) => !s.organic).map((s) => s.domain))) sov.set(d, (sov.get(d) || 0) + 1);
  const answers = results.filter((r) => r.sources.some((s) => !s.organic)).length;
  return { platforms: PLATFORMS, prompts, running: runningRuns.has(projectId),
    runs: runs.map((r) => ({ ...r, rates: rates(r.id) })), last: last ? { ...last, rates: rates(last.id) } : null, results,
    shareOfVoice: [...sov].sort((a, b2) => b2[1] - a[1]).slice(0, 20).map(([domain, n]) => ({ domain, answers: n, share: answers ? n / answers : 0, own: b?.isOwn(domain) || false })) };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || (() => { throw Object.assign(new Error("Project not found"), { status: 404 }); })();
  routes.push(["GET", /^\/api\/projects\/(\d+)\/visibility$/, ([id]) => visibilityData(project(id).id)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/visibility\/prompts$/, ([id], q, body) => {
    const p = project(id);
    const list = String(body.prompts || "").split(/\r?\n/).map((x) => x.trim().slice(0, 300)).filter(Boolean).slice(0, 200);
    const ins = db.prepare("INSERT OR IGNORE INTO ai_prompts (project_id, prompt) VALUES (?, ?)");
    let added = 0; for (const x of list) added += ins.run(p.id, x).changes;
    return { added };
  }]);
  routes.push(["DELETE", /^\/api\/projects\/(\d+)\/visibility\/prompts\/(\d+)$/, ([id, pid]) => { run("DELETE FROM ai_prompts WHERE project_id=? AND id=?", project(id).id, Number(pid)); return { ok: true }; }]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/visibility\/run$/, ([id], q, body) => startRun(project(id), Array.isArray(body.platforms) ? body.platforms.map(String) : Object.keys(PLATFORMS))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/visibility\/runs\/(\d+)\/resume$/, ([id, rid]) => resumeRun(project(id), Number(rid))]);
}
