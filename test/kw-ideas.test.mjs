// Keyword ideas (REQ-055 group 6, item 1): Google Autocomplete through the polite reader, seeded from target keywords
// and top Search Console searches; volumes only from the paid button (mocked here). No network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run, get } = await import("../src/db.mjs");
await import("../src/gsc.mjs");
await import("../src/gsc-history.mjs");
const K = await import("../src/kw-ideas.mjs");
const { fakeWeb } = await import("./fake-web.mjs");

run("INSERT INTO projects (id, name, start_url, settings) VALUES (1, 'Northwind Supplies', 'https://northwind.example/', ?)",
  JSON.stringify({ targetKeywords: "espresso machine repair\ncoffee grinder", dfsLocation: 2036, dfsLanguage: "en" }));
for (const [q, i] of [["northwind supplies", 900], ["descale espresso machine", 300], ["burr grinder cleaning", 120]])
  run("INSERT INTO gsc_query_daily (project_id, query, date, clicks, impressions, position) VALUES (1,?,?,0,?,8)", q, "2026-10-20", i);
const project = get("SELECT * FROM projects WHERE id=1");

test("parseSuggest and suggestUrl", () => {
  assert.deepEqual(K.parseSuggest('["coffee",["Coffee Grinder","coffee  near me","coffee grinder"]]'), ["coffee grinder", "coffee near me"]);
  assert.deepEqual(K.parseSuggest("<html>"), []);
  assert.deepEqual(K.parseSuggest('{"a":1}'), []);
  const u = new URL(K.suggestUrl("how coffee", { hl: "en", gl: K.countryOf(2036) }));
  assert.equal(u.host, "suggestqueries.google.com");
  assert.equal(u.searchParams.get("q"), "how coffee");
  assert.equal(u.searchParams.get("gl"), "au");
  assert.equal(K.countryOf(2840), "us");
  assert.equal(K.countryOf(9199156), "", "a city code has no country here");
});

test("plan: seeds alone first, then question words, vs/for/near, a-z only when asked; capped", () => {
  const p = K.plan(["a b", "c d"]);
  assert.deepEqual(p.slice(0, 2).map((x) => x.q), ["a b", "c d"]);
  assert.equal(p[2].q, "how a b");
  assert.ok(p.some((x) => x.q === "c d vs"));
  assert.ok(!p.some((x) => x.modifier === "a"));
  assert.equal(p.length, 2 * (1 + K.QUESTION_WORDS.length + K.SUFFIXES.length));
  assert.ok(K.plan(["x"], { az: true }).some((x) => x.q === "x z"));
  const big = K.plan(Array.from({ length: 10 }, (_, i) => `seed ${i}`), { az: true });
  assert.equal(big.length, K.CAPS.requests);
});

test("seeds: target keywords first, then non-brand searches by impressions", () => {
  assert.deepEqual(K.seedsFor(project), ["espresso machine repair", "coffee grinder", "descale espresso machine", "burr grinder cleaning"]);
});

test("runIdeas: robots.txt checked, ideas saved with seed and modifier, a repeat run is served from the cache", async () => {
  const site = { "https://suggestqueries.google.com/robots.txt": [404] };
  for (const r of K.plan(["coffee grinder"])) site[K.suggestUrl(r.q, { hl: "en", gl: "au" })] = [200, JSON.stringify([r.q, [`${r.q} idea`, "coffee grinder burr"]]), "application/json"];
  const w = fakeWeb(site);
  const out = await K.runIdeas(project, { seeds: ["coffee grinder"], ...w });
  assert.equal(out.requests, 1 + K.QUESTION_WORDS.length + K.SUFFIXES.length);
  assert.equal(out.network, out.requests + 1, "plus robots.txt");
  assert.equal(out.blocked, 0);
  assert.ok(!w.calls.some((c) => /dataforseo/.test(c.url)), "nothing paid");
  const rep = K.ideasReport(project);
  const burr = rep.ideas.find((x) => x.idea === "coffee grinder burr");
  assert.equal(burr.source, "Google Autocomplete");
  assert.equal(burr.seed, "coffee grinder");
  assert.equal(burr.modifier, "(seed)");
  assert.equal(burr.volume, null, "no volume without the paid button");
  assert.equal(rep.ideas.find((x) => x.idea === "how coffee grinder idea").intent, "question");
  assert.equal(rep.withVolume, 0);
  const again = await K.runIdeas(project, { seeds: ["coffee grinder"], ...fakeWeb({}) });
  assert.equal(again.network, 0, "all from the cache");
  assert.equal(again.cached, out.requests + 1);
});

test("runIdeas: a robots.txt that disallows the tool stops the run before any suggestion request", async () => {
  const w = fakeWeb({ "https://suggestqueries.google.com/robots.txt": [200, "User-agent: SEOAuditor\nDisallow: /complete/\n", "text/plain"] });
  run("DELETE FROM research_cache");
  const out = await K.runIdeas(project, { seeds: ["something new"], ...w });
  assert.equal(out.blocked, 1);
  assert.deepEqual(w.calls.map((c) => new URL(c.url).pathname), ["/robots.txt"]);
  run("DELETE FROM research_cache");
});

test("fetchVolumes: refuses over the budget before calling; fills volumes from one keyword_overview call", async () => {
  let calls = 0;
  const send = async (endpoint, body) => {
    calls++;
    assert.equal(endpoint, "dataforseo_labs/google/keyword_overview/live");
    assert.equal(body.location_code, 2036);
    return { items: [{ keyword: "coffee grinder burr", keyword_info: { search_volume: 590, cpc: 1.2, competition: 0.4 }, keyword_properties: { keyword_difficulty: 22 } }] };
  };
  await assert.rejects(K.fetchVolumes(project, undefined, { send, spent: () => 1.995, cap: () => 2 }), (e) => e.status === 402 && /budget/.test(e.message));
  assert.equal(calls, 0);
  const r = await K.fetchVolumes(project, undefined, { send, spent: () => 0, cap: () => 2 });
  assert.equal(calls, 1);
  assert.equal(r.updated, 1);
  const rep = K.ideasReport(project);
  assert.equal(rep.ideas[0].idea, "coffee grinder burr", "ideas with volume first");
  assert.equal(rep.ideas[0].volume, 590);
  assert.equal(rep.ideas[0].difficulty, 22);
  assert.equal(rep.ideas.find((x) => x.idea === "how coffee grinder idea").volume, 0, "no data = 0, not asked again");
  await assert.rejects(K.fetchVolumes(project, undefined, { send, spent: () => 0, cap: () => 2 }), (e) => e.status === 400);
});

test("routes: validation at the boundary", async () => {
  const routes = [];
  K.register({ routes });
  const vol = routes.find(([m, re]) => m === "POST" && re.test("/api/projects/1/keyword-ideas/volumes"))[2];
  await assert.rejects(async () => vol(["1"], {}, { keywords: "x" }), (e) => e.status === 400);
  await assert.rejects(async () => vol(["1"], {}, { keywords: ["a".repeat(200)] }), (e) => e.status === 400);
  const getR = routes.find(([m, re]) => m === "GET" && re.test("/api/projects/1/keyword-ideas"))[2];
  assert.throws(() => getR(["99"]), (e) => e.status === 404);
});
