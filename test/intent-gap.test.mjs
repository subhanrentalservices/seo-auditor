// Search intent gap (REQ-150, 2026-11-19): low-CTR searches per page, page-2 vs deeper triage, unanswered searches and
// pages to link from that Google already shows. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { intentGaps, band, STEPS, lookup } = await import("../src/intent-gap.mjs");

const q = (query, impressions, clicks, position) => ({ query, impressions, clicks, position });
const page = {
  url: "https://x.com/blog/how-long-claim", title: "How Long Does a Car Insurance Claim Take?", h1: "How long does a claim take",
  h2s: ["The deadlines your insurer has signed up to", "How long insurance takes to fix your car"],
  queries: [q("how long does a car insurance claim take", 300, 1, 12), q("car insurance claim time limit", 120, 0, 30), q("how long does insurance take to fix a car", 40, 0, 7), q("tiny search", 3, 0, 5)],
};
const shown = (over) => ({ url: "https://x.com/other", title: "", h1: "", impressions: 0, clicks: 0, bodyLinksTo: new Set(), ...over });

test("a page with good impressions and a low CTR is listed with its hidden searches, most impressions first", () => {
  const [r] = intentGaps([page], [], { minPageImpressions: 100 });
  assert.equal(r.url, page.url);
  assert.equal(r.mainQuery, "how long does a car insurance claim take");
  assert.deepEqual(r.hidden.map((h) => h.query), ["how long does a car insurance claim take", "car insurance claim time limit", "how long does insurance take to fix a car"]);
  assert.ok(r.titleLast);
  assert.match(r.steps.at(-1), /title/i, "the title comes last");
  assert.equal(STEPS.length, 4);
});

test("searches no H2/H3 answers are the gaps to check; answered ones are not", () => {
  const [r] = intentGaps([page], []);
  assert.ok(r.unanswered.includes("car insurance claim time limit"));
  assert.ok(!r.unanswered.includes("how long does insurance take to fix a car"));
});

test("a page that already earns clicks, or has too few impressions, is not listed", () => {
  const good = { ...page, queries: [q("how long does a car insurance claim take", 300, 30, 4)] };
  assert.equal(intentGaps([good], []).length, 0);
  assert.equal(intentGaps([{ ...page, queries: [q("x y z", 50, 0, 9)] }], []).length, 0);
});

test("page 2 can be moved by an update; page 5 cannot on its own", () => {
  assert.equal(band(6).band, "page 1");
  assert.equal(band(14).band, "page 2");
  assert.equal(band(33).band, "page 3-4");
  assert.equal(band(55).band, "page 5+");
  assert.match(band(14).note, /page 1/);
});

test("link sources are pages Google already shows on the same topic, not linking yet, most clicks first", () => {
  const key = "x.com/blog/how-long-claim";
  const list = [
    shown({ url: "https://x.com/aami-claim", title: "AAMI car insurance claim guide", clicks: 3, impressions: 400 }),
    shown({ url: "https://x.com/budget-claim", title: "Budget Direct insurance claim", clicks: 6, impressions: 900 }),
    shown({ url: "https://x.com/linked", title: "Insurance claim help", clicks: 9, impressions: 900, bodyLinksTo: new Set([key]) }),
    shown({ url: "https://x.com/tyres", title: "Tyres and wheels", clicks: 20, impressions: 2000 }),
    shown({ url: "https://x.com/unseen", title: "Insurance claim checklist", clicks: 0, impressions: 0 }),
    shown({ url: page.url, title: page.title, clicks: 1, impressions: 460 }),
  ];
  const [r] = intentGaps([page], list);
  assert.deepEqual(r.linkFrom.map((s) => s.url), ["https://x.com/budget-claim", "https://x.com/aami-claim"]);
});

test("pages deeper than the cut-off are left out", () => {
  const deep = { ...page, queries: [q("car insurance claim time limit", 300, 0, 60)] };
  assert.equal(intentGaps([deep], []).length, 0);
});

test("web addresses and phone numbers are lookups for another site or line, not content gaps", () => {
  for (const x of ["youi.insurance", "acme.com.au claims", "1300 139 591", "1800104731"]) assert.ok(lookup(x), x);
  for (const x of ["how long does a claim take", "13 youi", "car service 3175"]) assert.ok(!lookup(x), x);
});
