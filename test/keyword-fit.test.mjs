// Keyword fit (owner videos 2026-11-11): keyword placement on a page and the "untapped keyword" SERP test.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { placement, untappedTest, resultsFromJson } = await import("../src/keyword-fit.mjs");
const { parseHtml } = await import("../src/crawler.mjs");

test("the crawler keeps the opening paragraph and image alt texts", () => {
  const p = parseHtml(`<html lang="en"><head><title>Smash repairs Noble Park</title></head><body><main><h1>Smash repairs</h1>
    <p>Short intro.</p><p>We handle smash repairs for Noble Park drivers, from the claim to the final paint job, at our workshop.</p>
    <img src="/a.jpg" alt="Rear bumper repair in Noble Park"><img src="/b.jpg" alt=""></main></body></html>`, "https://x.example/noble-park");
  assert.match(p.data.firstPara, /^We handle smash repairs for Noble Park/);
  assert.deepEqual(p.data.imgAlts, ["Rear bumper repair in Noble Park"]);
});

test("placement: every core word in a slot counts, in any order and stemmed; missing slots are listed", () => {
  const page = { title: "Noble Park Smash Repairs | Acme", description: "Accident repairs for Noble Park drivers.", h1: "Smash repair in Noble Park", inlinks: 7,
    data: { h2s: ["What our smash repairs cover"], firstPara: "Smash repairs for Noble Park drivers, from claim to paint.", imgAlts: ["Workshop"], schemaTypes: ["AutoRepair"], externalLinks: 1 } };
  const r = placement("smash repairs noble park", page);
  assert.equal(r.slots.title, true);
  assert.equal(r.slots.h1, true, "stemmed: repair matches repairs");
  assert.equal(r.slots.metaDescription, false);
  assert.equal(r.slots.h2, false);
  assert.equal(r.slots.firstParagraph, true);
  assert.equal(r.slots.imageAlt, false);
  assert.deepEqual(r.missing, ["metaDescription", "h2", "imageAlt"]);
  assert.equal(r.score, 50);
  assert.equal(r.extras.schema, true);
  const old = placement("smash repairs noble park", { title: "x", data: {} });
  assert.equal(old.slots.firstParagraph, null, "an audit from before this version says unknown, not missing");
});

test("untapped: a forum and an off-topic page in the top 5 with a low allintitle count is untapped", () => {
  const results = [
    { url: "https://www.reddit.com/r/melbourne/comments/x", title: "Anyone know a good panel beater?" },
    { url: "https://acme-repairs.com.au/noble-park", title: "Smash Repairs Noble Park | Acme" },
    { url: "https://garden.example/sheds", title: "How to build a garden shed" },
    { url: "https://www.yelp.com.au/x", title: "Top 10 smash repairs near Noble Park" },
    { url: "https://b.example/", title: "Noble Park smash repair specialists" },
  ];
  const t = untappedTest("smash repairs noble park", results, { allintitle: 12 });
  assert.equal(t.verdict, "untapped");
  assert.equal(t.signals.allintitle, "pass");
  assert.equal(t.weak.length, 2);
  assert.ok(t.irrelevant.some((r) => r.rank === 1) && t.irrelevant.some((r) => r.rank === 3));
  assert.equal(t.signals.youngSite, "unknown", "never guessed without first-seen data");
});

test("untapped: strong, on-topic results or a high allintitle count is contested; the 300 limit is selectable", () => {
  const strong = [1, 2, 3, 4, 5].map((i) => ({ url: `https://s${i}.example/`, title: `Smash repairs Noble Park ${i}` }));
  assert.equal(untappedTest("smash repairs noble park", strong, { allintitle: 10 }).verdict, "contested");
  const thin = [{ url: "https://www.facebook.com/x", title: "x" }, ...strong];
  assert.equal(untappedTest("smash repairs noble park", thin, { allintitle: 120 }).verdict, "contested");
  assert.equal(untappedTest("smash repairs noble park", thin, { allintitle: 120, limit: 300 }).verdict, "untapped");
  const lowAuth = untappedTest("smash repairs noble park", strong, { authority: { s2: 12 } });
  assert.equal(lowAuth.weak[0].why, "low authority");
});

test("Australian directories count as weak, and a title sharing only half the words is off-topic", () => {
  const r = [{ url: "https://www.autoguru.com.au/x", title: "Midas Narre Warren" }, { url: "https://startech.example/", title: "Roadworthy Certificate Narre Warren | RWC" }];
  const t = untappedTest("logbook service narre warren", r);
  assert.equal(t.weak[0].why, "directory");
  assert.ok(t.irrelevant.some((x) => x.rank === 2), "only the suburb matches");
});

test("SERP files: plain lists, DataForSEO tasks and organic-only filtering", () => {
  assert.equal(resultsFromJson([{ url: "https://a.example/", title: "A" }]).length, 1);
  const dfs = { tasks: [{ result: [{ items: [{ type: "local_pack", url: "https://m.example/" }, { type: "organic", url: "https://b.example/", title: "B" }] }] }] };
  assert.deepEqual(resultsFromJson(dfs), [{ url: "https://b.example/", title: "B" }]);
});
