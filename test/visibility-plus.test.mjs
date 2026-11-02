// AI visibility from stored data (REQ-055 group 9): prompt suggestions from Search Console question searches, the
// opt-in scheduled runs (off by default, budget checked before each run), trends per prompt, share of voice over
// time and cited sources mapped to own pages. The paid run is always a fake here, and fetch throws if anything tries
// the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
globalThis.fetch = async (u) => { throw new Error(`no network in tests: ${u}`); };
const V = await import("../src/visibility-plus.mjs");
const { createProject } = await import("../src/api.mjs");
const { db, run, get } = await import("../src/db.mjs");

const newProject = (name) => createProject({ start_url: `https://${name}.example.com/`, name });
const addPrompts = (pid, list) => { for (const x of list) run("INSERT INTO ai_prompts (project_id, prompt) VALUES (?, ?)", pid, x); };
const addRun = (pid, startedAt, status = "done") => Number(run("INSERT INTO ai_runs (project_id, started_at, status, platforms, prompts) VALUES (?, ?, ?, 'chatgpt', 1)", pid, startedAt, status).lastInsertRowid);
const addResult = (runId, prompt, platform, { mentioned = 0, cited = 0, rank = null, sources = [], error = null } = {}) =>
  run("INSERT INTO ai_results (run_id, prompt, platform, present, mentioned, cited, rank, sources, brands, excerpt, error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    runId, prompt, platform, 1, mentioned, cited, rank, JSON.stringify(sources), "[]", "", error);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

test("suggestions: question searches with enough impressions that aren't prompts yet, biggest first", () => {
  const p = newProject("acmepanels");
  const ins = db.prepare("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?)");
  ins.run(p.id, "how long does a smash repair take", "https://acmepanels.example.com/a", 2, 40, 0.05, 8);
  ins.run(p.id, "how long does a smash repair take", "https://acmepanels.example.com/b", 0, 5, 0, 20);
  ins.run(p.id, "what is paintless dent removal?", "https://acmepanels.example.com/pdr", 1, 90, 0.01, 6);
  ins.run(p.id, "is acmepanels any good", "https://acmepanels.example.com/", 3, 12, 0.25, 1);
  ins.run(p.id, "smash repairs near me", "https://acmepanels.example.com/", 9, 500, 0.02, 4); // not a question
  ins.run(p.id, "why is my car pulling left", "https://acmepanels.example.com/c", 0, 2, 0, 30); // too few impressions
  ins.run(p.id, "can you fix a dented bumper", "https://acmepanels.example.com/d", 0, 30, 0, 12);
  addPrompts(p.id, ["Can you fix a dented bumper"]); // already a prompt (case ignored)
  const r = V.promptSuggestions(p.id);
  assert.match(r.source, /Search Console/);
  assert.deepEqual(r.suggestions.map((s) => s.query), ["what is paintless dent removal?", "how long does a smash repair take", "is acmepanels any good"]);
  const first = r.suggestions[1];
  assert.deepEqual([first.impressions, first.clicks, first.page], [45, 2, "https://acmepanels.example.com/a"]);
  assert.equal(first.position, 9.3); // impression-weighted: (40 × 8 + 5 × 20) ÷ 45
  assert.equal(r.suggestions[2].brand, true);
});

test("schedule: off by default; only an explicit true turns paid runs on; inputs validated", () => {
  const p = newProject("schedone");
  addPrompts(p.id, ["a", "b"]);
  const s = V.getSchedule(p.id);
  assert.equal(s.enabled, false);
  assert.equal(s.estimate, 0.048); // 2 prompts × all five platforms ($0.024)
  assert.equal(V.saveSchedule(p.id, { enabled: "true" }).enabled, false);
  assert.equal(V.saveSchedule(p.id, { enabled: 1 }).enabled, false);
  const on = V.saveSchedule(p.id, { enabled: true, everyDays: 7, platforms: ["chatgpt", "nope", "gemini"], maxCost: 0.5 });
  assert.deepEqual([on.enabled, on.everyDays, on.platforms, on.maxCost, on.estimate], [true, 7, ["chatgpt", "gemini"], 0.5, 0.016]);
  assert.equal(V.saveSchedule(p.id, { everyDays: 14 }).enabled, true, "other changes keep it on");
  assert.throws(() => V.saveSchedule(p.id, { everyDays: 3 }), /7, 14, 30/);
  assert.throws(() => V.saveSchedule(p.id, { platforms: [] }), /at least one platform/);
  assert.throws(() => V.saveSchedule(p.id, { maxCost: -1 }), /positive/);
  assert.equal(V.saveSchedule(p.id, { maxCost: "" }).maxCost, null);
  V.saveSchedule(p.id, { enabled: false });
});

test("scheduled runs: due ones start after the budget check; others are skipped with the reason", async () => {
  run("UPDATE ai_schedule SET enabled=0"); // earlier tests' projects
  const now = Date.parse("2026-11-01T00:00:00Z");
  const fresh = newProject("fresh"), due = newProject("due"), poor = newProject("poor"), capped = newProject("capped"), empty = newProject("empty"), off = newProject("off");
  for (const p of [fresh, due, poor, capped, off]) addPrompts(p.id, ["how much is a respray"]);
  addRun(fresh.id, sqlTime(now - 3 * 864e5)); // ran 3 days ago: not due on a 7-day schedule
  addRun(due.id, sqlTime(now - 8 * 864e5));
  addPrompts(poor.id, Array.from({ length: 99 }, (_, i) => `question ${i}`)); // 100 prompts ≈ $2.40
  for (const p of [fresh, due, poor, capped, empty]) V.saveSchedule(p.id, { enabled: true, everyDays: 7 });
  V.saveSchedule(capped.id, { maxCost: 0.01 });
  const started = [];
  const start = async (project, platforms) => { started.push([project.name, platforms.length]); return { runId: addRun(project.id, sqlTime(now), "running"), calls: platforms.length }; };
  const out = await V.runDueSchedules({ start, spent: () => 0.5, budget: () => 2, configured: () => true, now, log: () => {} });
  const by = Object.fromEntries(out.map((x) => [get("SELECT name FROM projects WHERE id=?", x.projectId).name, x.result]));
  assert.deepEqual(Object.keys(by).sort(), ["capped", "due", "empty", "poor"]);
  assert.deepEqual(started, [["due", 5]]);
  assert.match(by.due, /^started run \d+ \(≈ \$0\.024\)$/);
  assert.match(by.poor, /skipped: estimate \$2\.400 is more than the \$1\.500 left of this month's budget/);
  assert.match(by.capped, /over the cap of \$0\.01 per run/);
  assert.equal(by.empty, "skipped: no prompts");
  assert.match(V.getSchedule(due.id).lastResult, /started run/);
  // The run just started makes it not due; nothing is configured → skipped, never started.
  const again = await V.runDueSchedules({ start, spent: () => 0, budget: () => 2, configured: () => false, now, log: () => {} });
  assert.ok(!again.some((x) => x.projectId === due.id));
  assert.equal(again.find((x) => x.projectId === poor.id).result, "skipped: DataForSEO login not set");
  assert.equal(started.length, 1);
  // A failing start is recorded, not thrown.
  const failed = await V.runDueSchedules({ start: async () => { throw new Error("A visibility run is already in progress"); }, spent: () => 0, budget: () => 100, configured: () => true, now, log: () => {} });
  assert.match(failed.find((x) => x.projectId === poor.id).result, /^failed: A visibility run is already in progress/);
});

test("trends per prompt and share of voice over time, own domain always included", () => {
  const p = newProject("trendco");
  const own = "trendco.example.com";
  const r1 = addRun(p.id, "2026-09-01 00:00:00"), r2 = addRun(p.id, "2026-10-01 00:00:00");
  addRun(p.id, "2026-10-15 00:00:00", "running"); // not finished: left out
  const src = (...domains) => domains.map((d) => ({ domain: d, url: `https://${d}/x` }));
  addResult(r1, "best panel shop", "chatgpt", { sources: src("rival.example", "dir.example") });
  addResult(r1, "best panel shop", "gemini", { sources: src("rival.example") });
  addResult(r1, "best panel shop", "perplexity", { error: "timeout" });
  addResult(r2, "best panel shop", "chatgpt", { mentioned: 1, cited: 1, rank: 2, sources: src(own, "rival.example") });
  addResult(r2, "best panel shop", "gemini", { mentioned: 1, rank: 4, sources: [] });
  const t = V.visibilityTrends(p.id);
  assert.deepEqual(t.runs.map((r) => [r.id, r.answersWithSources]), [[r1, 2], [r2, 1]]);
  assert.deepEqual(t.prompts, [{ prompt: "best panel shop", series: [{ answered: 2, mentioned: 0, cited: 0, bestRank: null }, { answered: 2, mentioned: 2, cited: 1, bestRank: 2 }] }]);
  const share = Object.fromEntries(t.shareOfVoice.map((d) => [d.domain, d.shares]));
  assert.deepEqual(share["rival.example"], [1, 1]);
  assert.deepEqual(share["dir.example"], [0.5, 0]);
  assert.deepEqual(share[own], [0, 1]);
  assert.equal(t.shareOfVoice.find((d) => d.domain === own).own, true);
});

test("cited sources → own pages: pages AI cites, and the best own page for prompts others win", () => {
  const p = newProject("mapco");
  const site = "https://mapco.example.com";
  const a = Number(run("INSERT INTO audits (project_id, status) VALUES (?, 'done')", p.id).lastInsertRowid);
  const page = db.prepare("INSERT INTO pages (audit_id, url, final_url, status, title, h1, indexable, data) VALUES (?,?,?,?,?,?,?,'{}')");
  page.run(a, site + "/", site + "/", 200, "Mapco home", "Mapco", 1);
  page.run(a, site + "/windscreen-replacement", site + "/windscreen-replacement", 200, "Windscreen replacement in Springfield", "Windscreen replacement", 1);
  page.run(a, site + "/hail-damage", site + "/hail-damage", 200, "Hail damage repairs", "Hail damage repair", 1);
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?)", p.id, "hail damage repair cost", site + "/hail-damage", 1, 50, 0.02, 7);
  const r = addRun(p.id, "2026-10-20 00:00:00");
  addResult(r, "who does windscreen replacement", "chatgpt", { cited: 1, sources: [{ domain: "mapco.example.com", url: site + "/windscreen-replacement/" }, { domain: "rival.example", url: "https://rival.example/" }] });
  addResult(r, "who does windscreen replacement", "perplexity", { cited: 1, sources: [{ domain: "www.mapco.example.com", url: "https://www.mapco.example.com/windscreen-replacement" }] });
  addResult(r, "how much does hail damage repair cost", "chatgpt", { sources: [{ domain: "rival.example", url: "https://rival.example/hail" }, { domain: "dir.example", url: "https://dir.example/" }] });
  addResult(r, "how much does hail damage repair cost", "gemini", { sources: [{ domain: "rival.example", url: "https://rival.example/hail" }] });
  addResult(r, "best detailing kits", "chatgpt", { sources: [{ domain: "shop.example", url: "https://shop.example/" }] });
  addResult(r, "google only", "google", { sources: [{ domain: "x.example", url: "https://x.example/", organic: true }] }); // organic results aren't citations
  const m = V.sourceMapping(p.id);
  assert.equal(m.run.id, r);
  assert.deepEqual(m.ownCited.map((c) => [c.title, c.inAudit, c.prompts.length, c.platforms.sort()]), [["Windscreen replacement in Springfield", true, 1, ["chatgpt", "perplexity"]]]);
  const hail = m.prompts.find((x) => x.prompt.startsWith("how much"));
  assert.deepEqual(hail.cited, [{ domain: "rival.example", answers: 2 }, { domain: "dir.example", answers: 1 }]);
  assert.equal(hail.ownPage.url, site + "/hail-damage");
  assert.match(hail.ownPage.via, /Search Console/);
  assert.equal(m.prompts.find((x) => x.prompt === "best detailing kits").ownPage, null, "no page on the topic: a content gap");
  assert.ok(!m.prompts.some((x) => x.prompt === "google only" || x.prompt.startsWith("who does")));
  assert.deepEqual(V.sourceMapping(newProject("norun").id), { run: null, ownCited: [], prompts: [] });
});

test("listing targets: other sites' pages for prompts that don't name the brand, list pages flagged, own site and Google viewers left out", () => {
  const p = newProject("listpanels");
  addPrompts(p.id, ["best panel beater springfield", "listpanels reviews"]);
  const rid = addRun(p.id, "2026-11-02 05:00:00");
  const extra = JSON.stringify({ fanOut: ["panel beater springfield top rated"], retrieved: [{ domain: "allstars.example", url: "https://allstars.example/best/panel-beaters/springfield", title: "Panel beaters in Springfield, most reviewed" }] });
  run("INSERT INTO ai_results (run_id, prompt, platform, present, mentioned, cited, sources, brands, excerpt, extra) VALUES (?,?,?,?,?,?,?,?,?,?)", rid, "best panel beater springfield", "chatgpt", 1, 0, 0,
    JSON.stringify([{ domain: "crashco.example", url: "https://crashco.example/?utm_source=chatgpt.com", title: "Crash Co" }, { domain: "listpanels.example.com", url: "https://listpanels.example.com/" }]), "[]", "", extra);
  addResult(rid, "best panel beater springfield", "google", { sources: [{ domain: "google.com", url: "https://www.google.com/searchviewer/10?svid=x", title: "Some shop" }, { domain: "crashco.example", url: "https://crashco.example/" }, { domain: "x.example", url: "https://x.example/", organic: true }] });
  addResult(rid, "listpanels reviews", "chatgpt", { mentioned: 1, sources: [{ domain: "rival.example", url: "https://rival.example/" }] }); // names the brand: skipped
  const r = V.listingTargets(p.id);
  assert.deepEqual(r.pages.map((e) => [e.url, e.prompts.length, e.platforms.sort().join("+"), e.cited, e.retrieved, e.listPage]), [
    ["https://allstars.example/best/panel-beaters/springfield", 1, "chatgpt", 0, 1, true], // same prompt count: list pages first
    ["https://crashco.example/", 1, "chatgpt+google", 2, 0, false]]);
  assert.deepEqual(r.searches, [{ prompt: "best panel beater springfield", platform: "chatgpt", mentioned: false, queries: ["panel beater springfield top rated"] }]);
  assert.deepEqual(V.listingTargets(newProject("emptylist").id), { run: null, pages: [], searches: [] });
});
