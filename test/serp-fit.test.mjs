import { test } from "node:test";
import assert from "node:assert/strict";
import { pageType, serpFit } from "../src/serp-fit.mjs";

test("page types from url and title", () => {
  assert.equal(pageType({ url: "https://www.localsearch.com.au/find/mechanics/x" }), "directory");
  assert.equal(pageType({ url: "https://example.com.au/", title: "Example Mechanics" }), "home");
  assert.equal(pageType({ url: "https://www.reddit.com/r/x" }), "forum");
  assert.equal(pageType({ url: "https://www.vicroads.vic.gov.au/x" }), "gov");
  assert.equal(pageType({ url: "https://x.com.au/blog/how-to-claim" }), "article");
  assert.equal(pageType({ url: "https://x.com.au/services/brakes", title: "Brake Repairs" }), "page");
  assert.equal(pageType({ url: "https://x.com.au/p", title: "10 Best Panel Beaters in Dandenong" }), "directory");
});

const local = [
  { url: "https://a-mech.com.au/", dr: 8 }, { url: "https://b-mech.com.au/", dr: 0 }, { url: "https://big.repco.net/", dr: 57 },
  { url: "https://www.autoguru.com.au/mechanics/vic/x" }, { url: "https://c.com.au/" }, { url: "https://d.com.au/services" },
];

test("weak local results with service pages: go, and a service page matches the format", () => {
  const r = serpFit({ keyword: "mechanic x", rows: local, ourDr: 5, ourType: "service" });
  assert.equal(r.verdict, "go");
  assert.equal(r.formatMatch, true);
});

test("the same results for an article: format mismatch", () => {
  const r = serpFit({ keyword: "mechanic x", rows: local, ourDr: 5, ourType: "article" });
  assert.equal(r.formatMatch, false);
  assert.ok(r.notes.some((n) => /won't rank/.test(n)));
});

test("one brand filling the top 10 is navigational and skipped", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ url: `https://www.aami.com.au/claims/${i}`, dr: 67 })).concat([{ url: "https://reddit.com/r/x", dr: 95 }]);
  assert.equal(serpFit({ keyword: "aami claim", rows, ourDr: 5 }).verdict, "skip");
});

test("only big sites rated: skip; our own result is left out and its rank reported", () => {
  const rows = [{ url: "https://gov.example.gov.au/a", dr: 92 }, { url: "https://ssautomotive.com.au/blog/x", dr: 5 }, { url: "https://ins.com.au/a", dr: 75 }, { url: "https://ins2.com.au/b", dr: 74 }];
  const r = serpFit({ keyword: "what to do", rows, ourDomain: "ssautomotive.com.au", ourDr: 5, ourType: "article" });
  assert.equal(r.verdict, "skip");
  assert.equal(r.ourRank, 2);
});
