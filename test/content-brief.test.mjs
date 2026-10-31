// Content brief (REQ-055 group 6, item 5): one paid SERP call (mocked; budget checked first), the top-10 pages' H2/H3
// through the polite reader (robots.txt obeyed), merged headings and the site's own searches. No network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run, get } = await import("../src/db.mjs");
await import("../src/gsc.mjs");
const B = await import("../src/content-brief.mjs");
const { fakeWeb } = await import("./fake-web.mjs");

run("INSERT INTO projects (id, name, start_url, settings) VALUES (1, 'Me', 'https://me.example/', ?)", JSON.stringify({ dfsLocation: 2036 }));
for (const [q, i] of [["how to descale an espresso machine", 40], ["espresso machine descaling service", 90], ["descale kettle", 70]])
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (1,?,'https://me.example/x',0,?,0,9)", q, i);
const project = get("SELECT * FROM projects WHERE id=1");

const page = (hs) => `<html><body><nav><h2>Menu</h2></nav><h1>T</h1>${hs.map(([l, t]) => `<${l}>${t}</${l}>`).join("<p>text</p>")}<footer><h2>Contact us</h2></footer></body></html>`;
const SERP = { items: [
  { type: "organic", rank_group: 1, url: "https://a.example/descale", title: "How to descale" },
  { type: "people_also_ask", items: [{ title: "How often should I descale?" }, { title: "Can I use vinegar?" }] },
  { type: "organic", rank_group: 2, url: "https://b.example/guide", title: "Descaling guide" },
  { type: "organic", rank_group: 3, url: "https://c.example/private/x", title: "Blocked" },
  { type: "related_searches", items: ["descaling solution", "espresso machine cleaning"] },
] };
const site = {
  "https://a.example/robots.txt": [404], "https://b.example/robots.txt": [404],
  "https://c.example/robots.txt": [200, "User-agent: *\nDisallow: /private/\n", "text/plain"],
  "https://a.example/descale": [200, page([["h2", "What you need"], ["h2", "How often to descale"], ["h3", "Using vinegar"]])],
  "https://b.example/guide": [200, page([["h2", "What You'll Need"], ["h2", "How often should you descale?"], ["h2", "Step by step"]])],
};

test("parseSerp, headingsOf, mergeHeadings", () => {
  const s = B.parseSerp(SERP.items);
  assert.equal(s.organic.length, 3);
  assert.deepEqual(s.paa, ["How often should I descale?", "Can I use vinegar?"]);
  assert.deepEqual(s.related, ["descaling solution", "espresso machine cleaning"]);
  const hs = B.headingsOf(site["https://a.example/descale"][1]);
  assert.deepEqual(hs.map((x) => x.text), ["What you need", "How often to descale", "Using vinegar"], "nav and footer headings left out");
  const m = B.mergeHeadings([hs, B.headingsOf(site["https://b.example/guide"][1])]);
  const often = m.find((x) => /often/i.test(x.text));
  assert.equal(often.pages, 2);
  assert.equal(m[0].pages, 2, "headings more pages use first");
  assert.ok(m.some((x) => x.text === "Step by step" && x.pages === 1));
});

test("siteSearches: every topic word, questions first", () => {
  assert.deepEqual(B.siteSearches(1, "descale espresso machine").map((x) => x.query), ["how to descale an espresso machine", "espresso machine descaling service"], "descaling = descale, stemmed");
  assert.deepEqual(B.siteSearches(1, "descale").map((x) => x.query), ["how to descale an espresso machine", "espresso machine descaling service", "descale kettle"]);
});

test("createBrief: budget checked before the paid call; headings read politely; robots.txt obeyed", async () => {
  let calls = 0;
  const send = async (endpoint, body) => { calls++; assert.equal(endpoint, "serp/google/organic/live/advanced"); assert.equal(body.keyword, "descale espresso machine"); assert.equal(body.location_code, 2036); return SERP; };
  await assert.rejects(B.createBrief(project, "Descale espresso machine", { send, spent: () => 2, cap: () => 2 }), (e) => e.status === 402);
  assert.equal(calls, 0, "nothing paid over the budget");
  await assert.rejects(B.createBrief(project, "x", { send, spent: () => 0, cap: () => 2 }), (e) => e.status === 400);
  const w = fakeWeb(site);
  const r = await B.createBrief(project, "  Descale espresso   machine ", { send, spent: () => 0, cap: () => 2, background: false, ...w });
  assert.equal(calls, 1);
  assert.equal(r.status, "done");
  assert.ok(!w.calls.some((c) => c.url.includes("/private/")), "a disallowed result page is not read");
  const routes = [];
  B.register({ routes });
  const one = routes.find(([m, re]) => m === "GET" && re.test("/api/projects/1/briefs/1"))[2](["1", String(r.id)]);
  assert.equal(one.topic, "descale espresso machine");
  assert.equal(one.pagesRead.find((x) => x.url.includes("c.example")).status, "disallowed by robots.txt");
  assert.equal(one.headings.find((x) => /often/i.test(x.text)).pages, 2);
  assert.equal(one.siteSearches[0].query, "how to descale an espresso machine", "questions first");
  const list = routes.find(([m, re]) => m === "GET" && re.test("/api/projects/1/briefs"))[2](["1"]);
  assert.equal(list.briefs.length, 1);
  const del = routes.find(([m]) => m === "DELETE")[2];
  assert.deepEqual(del(["1", String(r.id)]), { ok: true });
  assert.throws(() => del(["1", String(r.id)]), (e) => e.status === 404);
});
