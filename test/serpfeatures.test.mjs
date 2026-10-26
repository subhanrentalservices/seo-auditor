// SERP features from the Google searches AI visibility already pays for (REQ-040 #11, 2026-10-26). The fixture follows
// the real serp/google/organic/live/advanced response shape; fetch is mocked, the real API is never called. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { startRun } = await import("../src/visibility.mjs");
const { serpFeatures, serpSnapshot, resultType, siteName } = await import("../src/serpfeatures.mjs");
const { run, get, all } = await import("../src/db.mjs");
const { saveConfig } = await import("../src/dataforseo.mjs");

const OWN = "https://acmemotors.com.au/smash-repairs.html";
const org = (rank, url, title) => ({ type: "organic", rank_group: rank, rank_absolute: rank + 3, domain: new URL(url).hostname, url, title });
const SERP = { keyword: "smash repairs springfield", check_url: "https://www.google.com.au/search?q=smash+repairs+springfield", items: [
  { type: "featured_snippet", rank_group: 1, rank_absolute: 1, domain: "www.crashguide.com.au", url: "https://www.crashguide.com.au/smash-repair-cost", title: "Smash repair costs" },
  { type: "paid", rank_group: 1, domain: "ads.example.com", url: "https://ads.example.com/" },
  { type: "paid", rank_group: 2, domain: "ads2.example.com", url: "https://ads2.example.com/" },
  { type: "local_pack", rank_group: 1, title: "Crash Co", domain: "crashco.com.au" },
  { type: "local_pack", rank_group: 2, title: "Acme Motors", domain: "acmemotors.com.au" },
  { type: "people_also_ask", rank_group: 1, items: [
    { type: "people_also_ask_element", title: "How long do smash repairs take?" },
    { type: "people_also_ask_element", title: "Does insurance cover smash repairs?" },
    { type: "people_also_ask_element", title: "What is the average cost of a smash repair?" },
    { type: "people_also_ask_element", title: "Can I choose my own smash repairer?" }] },
  { type: "video", rank_group: 1, items: [{ type: "video_element", title: "Smash repair walkthrough", url: "https://www.youtube.com/watch?v=x", source: "YouTube" }] },
  org(1, "https://www.yelp.com.au/search?find_desc=smash+repairs", "Top 10 smash repairs near Springfield"),
  org(2, "https://www.yellowpages.com.au/find/smash-repairs/springfield", "Smash Repairs in Springfield"),
  org(3, "https://www.truelocal.com.au/find/smash-repairs/springfield", "Smash repairs Springfield"),
  org(4, OWN, "Smash Repairs Springfield | Acme Motors"),
  org(5, "https://m.facebook.com/crashco", "Crash Co"),
  org(6, "https://hipages.com.au/find/smash_repairs/springfield", "Smash repairers"),
  org(7, "https://www.oneflare.com.au/smash-repairs/springfield", "Smash repairs"),
  org(8, "https://www.productreview.com.au/c/smash-repairs", "Smash repairs reviews"),
  org(9, "https://boltpanels.com.au/", "Bolt Panels: panel beating"),
  org(10, "https://crashco.com.au/services", "Our services"),
  org(11, "https://www.crashguide.com.au/blog/choose-a-repairer", "How to choose a repairer") ] };

const P = { id: 990, name: "Acme Motors", start_url: "https://acmemotors.com.au/", settings: "{}" };
const done = async (id) => { while (get("SELECT status FROM ai_runs WHERE id=?", id).status === "running") await new Promise((r) => setTimeout(r, 10)); };

test("result types: directories by site name, articles by path or title, else business pages", () => {
  assert.equal(siteName("https://m.yelp.com.au/x"), "yelp");
  assert.equal(siteName("booking.acme.com.au"), "acme");
  assert.equal(resultType({ url: "https://en.wikipedia.org/wiki/Car" }), "directory");
  assert.equal(resultType({ url: "https://booking.acme.com.au/" }), "business", "a subdomain named like a directory is not one");
  assert.equal(resultType({ url: "https://a.com/blog/brakes", title: "Brakes" }), "article");
  assert.equal(resultType({ url: "https://a.com/brakes", title: "How to tell your brakes are worn" }), "article");
  assert.equal(resultType({ url: "https://a.com/brakes", title: "Brake repairs Springfield" }), "business");
  assert.equal(resultType({ url: "https://a.com/x", domain: "a.com" }, ["a"]), "directory", "extra directories from settings");
});

test("snapshot keeps types with counts, the snippet, PAA questions, our result and the top 10", () => {
  const s = serpSnapshot(SERP.items, (d) => /acmemotors\.com\.au$/.test(d));
  assert.deepEqual([s.types.paid, s.types.local_pack, s.types.organic, s.types.featured_snippet], [2, 2, 11, 1]);
  assert.equal(s.snippet.domain, "crashguide.com.au");
  assert.equal(s.paa.length, 4);
  assert.deepEqual(s.own, { pos: 4, url: OWN });
  assert.equal(s.top.length, 10);
  assert.equal(s.top.filter((x) => x.type === "directory").length, 7);
});

test("a paid Google run stores SERP features; opportunities from the stored data (no extra call)", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (990, 'Acme Motors', 'https://acmemotors.com.au/')");
  run("INSERT INTO ai_prompts (project_id, prompt) VALUES (990, 'smash repairs springfield')");
  const spent = get("SELECT COALESCE(SUM(cost),0) s FROM dfs_costs WHERE ts >= strftime('%Y-%m-01','now')").s;
  saveConfig({ dfsLogin: "test", dfsPassword: "test", dfsMonthlyBudget: spent + 1 });
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => { asked.push(url);
    return { json: async () => ({ status_code: 20000, cost: 0.006, tasks: [{ status_code: 20000, result: [SERP] }] }) }; };
  try {
    const { runId } = await startRun(P, ["google"]);
    await done(runId);
  } finally {
    globalThis.fetch = real;
    saveConfig({ dfsLogin: "", dfsPassword: "", dfsMonthlyBudget: 2 });
  }
  assert.deepEqual(asked, ["https://api.dataforseo.com/v3/serp/google/organic/live/advanced"], "one Google call, nothing extra");

  // The latest audit: our service page answers one of the four questions and has no video embed.
  const audit = Number(run("INSERT INTO audits (project_id, status) VALUES (990, 'done')").lastInsertRowid);
  run("INSERT INTO pages (audit_id, url, final_url, status, content_type, indexable, title, h1, data) VALUES (?,?,?,200,'text/html',1,?,?,?)", audit, OWN, OWN,
    "Smash Repairs Springfield", "Smash repairs", JSON.stringify({ h2s: ["How long smash repairs take", "Our spray booth"], jumpLinks: 0 }));

  const r = serpFeatures(990);
  assert.equal(r.withData, 1);
  assert.equal(r.auditId, audit);
  const kinds = Object.fromEntries(r.opportunities.map((o) => [o.kind, o]));
  assert.match(kinds.snippet.detail, /crashguide\.com\.au holds the snippet; you rank #4/);
  assert.deepEqual(kinds.paa.questions, ["Does insurance cover smash repairs?", "What is the average cost of a smash repair?", "Can I choose my own smash repairer?"]);
  assert.ok(kinds.video && !kinds.video.unknown, "video shown, page has none");
  assert.match(kinds.type.detail, /7 of the top 10 are directories or marketplaces/);
  assert.equal(kinds.type.url, OWN);
  const f = Object.fromEntries(r.features.map((x) => [x.type, x.prompts]));
  assert.deepEqual([f.featured_snippet, f.people_also_ask, f.video, f.paid, f.local_pack], [1, 1, 1, 1, 1]);
  assert.equal(f.organic, undefined);
  assert.equal(r.prompts[0].paid, 2);

  // With a video on the page and every question answered, those two opportunities go away.
  run("UPDATE pages SET data=? WHERE audit_id=?", JSON.stringify({ videos: 1, h2s: ["How long smash repairs take", "Does insurance cover smash repairs", "Average cost of a smash repair", "Choose your own smash repairer"] }), audit);
  const k2 = serpFeatures(990).opportunities.map((o) => o.kind).sort();
  assert.deepEqual(k2, ["snippet", "type"]);
});

test("a run without stored SERP data, or no run at all: empty, no crash", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (991, 'Old Run', 'https://oldrun.com.au/')");
  assert.deepEqual(serpFeatures(991).opportunities, []);
  assert.equal(serpFeatures(991).run, null);
  const rid = Number(run("INSERT INTO ai_runs (project_id, status, platforms, prompts) VALUES (991, 'done', 'google', 1)").lastInsertRowid);
  run("INSERT INTO ai_results (run_id, prompt, platform, present, organic_pos, sources, brands, excerpt) VALUES (?, 'old prompt', 'google', 0, 3, '[]', '[]', '')", rid);
  const r = serpFeatures(991);
  assert.equal(r.run.id, rid);
  assert.deepEqual([r.googleRows, r.withData, r.opportunities.length, r.features.length, r.prompts.length], [1, 0, 0, 0, 0]);
  assert.throws(() => serpFeatures(99999), /Project not found/);
  assert.equal(all("SELECT serp FROM ai_results WHERE run_id=?", rid)[0].serp, null);
});
