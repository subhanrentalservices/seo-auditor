// Query-page alignment and merge candidates (REQ-040, 2026-10-26): the top search's words missing from title/H1,
// question searches no heading answers, the intent mix, and page pairs competing across many searches. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates the Search Console tables
const { intentOf, isQuestion, titleGap, answeredBy, overlapPairs, queryAlignment } = await import("../src/queries.mjs");
const { brandTest } = await import("../src/page2.mjs");

test("intent buckets: brand is navigational, then question, comparison, transactional, the rest informational", () => {
  const isBrand = brandTest("Northwind Supplies", "https://northwind.example/");
  assert.equal(intentOf("northwind supplies opening hours", isBrand), "navigational");
  assert.equal(intentOf("how do i clean a coffee grinder", isBrand), "question");
  assert.equal(intentOf("coffee grinder or blender?", isBrand), "question");
  assert.equal(intentOf("best espresso machine for beginners", isBrand), "comparison");
  assert.equal(intentOf("grinder vs blender", isBrand), "comparison");
  assert.equal(intentOf("coffee grinder burr replacement cost", isBrand), "transactional");
  assert.equal(intentOf("espresso machine near me", isBrand), "transactional");
  assert.equal(intentOf("espresso history", isBrand), "informational");
  assert.ok(isQuestion("should i descale weekly") && !isQuestion("showroom espresso"));
});

test("title/H1 gap: the top search's words the title and H1 never use, stemmed, site-wide words ignored", () => {
  assert.deepEqual(titleGap("coffee grinder burr replacement cost", "Coffee Grinders", ""), ["burr", "replacement", "cost"]);
  assert.deepEqual(titleGap("coffee grinders springfield", "Coffee Grinder", "", new Set(["springfield"])), []);
  assert.deepEqual(titleGap("burr grinder cleaning", "Shop", "Cleaning burr grinders"), [], "the H1 counts too");
  assert.deepEqual(titleGap("logbook template", "Log Book Templates", ""), [], "a split compound is the same word");
});

test("a question is answered by a heading that asks it or says it in other word forms", () => {
  assert.equal(answeredBy("how long do burr grinders last", ["Our range", "How long do burr grinders last?"]), "How long do burr grinders last?");
  assert.equal(answeredBy("how to fix a leaking tap", ["Fixing a leaking tap"]), "Fixing a leaking tap");
  assert.equal(answeredBy("how do i clean a coffee grinder", ["How long do burr grinders last?"]), null);
});

test("pairs: 4 of 5 searches shared is a merge candidate (keeper = more clicks); 2 shared or a small share is not", () => {
  const q = (query, impressions, clicks = 0, position = 5) => ({ query, impressions, clicks, position });
  const a = { url: "https://x.example/a", queries: [q("w1", 50, 5), q("w2", 40, 4), q("w3", 30, 3), q("w4", 20, 2), q("w5", 10, 1)] };
  const b = { url: "https://x.example/b", queries: [q("w1", 30), q("w2", 20), q("w3", 20), q("w4", 10), q("own", 10)] };
  const [p, ...rest] = overlapPairs([a, b]);
  assert.equal(rest.length, 0);
  assert.equal(p.keeper.url, a.url); assert.equal(p.reason, "clicks"); assert.equal(p.shared, 4);
  assert.equal(Math.round(p.share * 100), 89, "80 of the smaller page's 90 impressions are on shared searches");
  assert.deepEqual(overlapPairs([a, { url: "https://x.example/c", queries: [q("w1", 30), q("w2", 20), q("own", 5)] }]), [], "only 2 shared searches");
  assert.deepEqual(overlapPairs([a, { url: "https://x.example/d", queries: [q("w1", 5), q("w2", 5), q("w3", 5), q("own", 100)] }]), [], "shared searches are a small part of the page");
  const tie = overlapPairs([{ ...a, queries: a.queries.map((r) => ({ ...r, clicks: 0, position: 9 })) }, { ...b, queries: b.queries.map((r) => ({ ...r, position: 4 })) }]);
  assert.equal(tie[0].keeper.url, b.url); assert.equal(tie[0].reason, "position", "no clicks either side: better position wins");
});

test("report: title gaps, unanswered questions, intent mix and competing pages from Search Console and the audit", () => {
  const S = "https://northwind.example";
  run("INSERT INTO projects (id, name, start_url) VALUES (980, 'Northwind Supplies', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status, started_at) VALUES (981, 980, 'done', datetime('now'))");
  const page = (p, title, h1, h2s, inlinks = 3) => run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1, inlinks, data) VALUES (981,?,?,200,1,'text/html',?,?,?,?)",
    S + p, S + p, title, h1, inlinks, JSON.stringify(h2s ? { h2s } : {}));
  page("/", "Northwind Supplies", "Northwind Supplies", ["Our shops"], 0);
  page("/coffee-grinders", "Coffee Grinders | Northwind Supplies", "Coffee Grinders", ["Our range", "How long do burr grinders last?"]);
  page("/espresso-machines", "Espresso Machines | Northwind Supplies", "Espresso Machines", ["Choosing a machine"], 9);
  page("/espresso-guide", "Espresso Guide | Northwind Supplies", "The Espresso Guide", [], 2);
  page("/about", "About | Northwind Supplies", "About Northwind", ["Our story"]);
  page("/old-page", "Descaling | Northwind Supplies", "Descaling", null); // audited before headings were stored
  run("INSERT INTO gsc (project_id, url, start_date, end_date) VALUES (980, ?, '2026-09-26', '2026-10-23')", S + "/");
  run("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (981, 'near_duplicate', 'notice', ?, ?)", S + "/espresso-guide", `87% shared with ${S}/espresso-machines`);
  const q = (query, p, impressions, clicks = 0, position = 6) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (980,?,?,?,?,0,?)", query, S + p, clicks, impressions, position);
  q("coffee grinder burr replacement cost", "/coffee-grinders", 120, 4); q("how long do burr grinders last", "/coffee-grinders", 40, 2);
  q("how do i clean a coffee grinder?", "/coffee-grinders", 25); q("what is a burr", "/coffee-grinders", 5);
  q("how often to descale", "/old-page", 30);
  // Brand searches on two pages: never a pair, never a title gap.
  for (const [b, i] of [["northwind supplies", 300], ["northwind", 200], ["northwind supplies hours", 50]]) { q(b, "/", i, 60, 1); q(b, "/about", i / 2, 5, 3); }
  for (const [w, im, cl, gi] of [["espresso machine", 50, 5, 30], ["espresso machine grinder", 40, 4, 20], ["home espresso setup", 30, 3, 20], ["espresso machine buying guide", 20, 2, 10]]) {
    q(w, "/espresso-machines", im, cl, 4); q(w, "/espresso-guide/", gi, 0, 9); // trailing slash is the same page
  }
  q("best espresso machine", "/espresso-machines", 10, 1, 4); q("espresso history", "/espresso-guide", 10, 0, 7);

  const r = queryAlignment(980);
  assert.equal(r.connected, true);
  const gap = Object.fromEntries(r.titleGaps.map((g) => [g.url.replace(S, ""), g]));
  assert.deepEqual(gap["/coffee-grinders"].missing, ["burr", "replacement", "cost"]);
  assert.equal(gap["/coffee-grinders"].intent, "transactional");
  assert.ok(!gap["/"] && !gap["/about"], "pages whose searches are all brand searches are skipped");
  assert.ok(r.titleGaps.every((g) => !/northwind/.test(g.query)));
  assert.deepEqual(r.questions.map((x) => [x.url.replace(S, ""), x.query]), [["/coffee-grinders", "how do i clean a coffee grinder?"]],
    "the H2 answers how long they last; 5 impressions is too few; the old page has no heading data");
  assert.equal(r.noHeadingData, 1);
  const intents = Object.fromEntries(r.intents.map((b) => [b.intent, b]));
  assert.equal(intents.navigational.impressions, 825); assert.equal(intents.navigational.queries, 3);
  assert.equal(intents.question.impressions, 100); assert.equal(intents.comparison.impressions, 10);
  assert.deepEqual(r.pairs.map((p) => [p.keeper.url.replace(S, ""), p.other.url.replace(S, ""), p.shared, p.nearDuplicate]), [["/espresso-machines", "/espresso-guide", 4, true]],
    "the home and about pages share only brand searches");
});

test("real-data cases: 'log book' isn't 'book now', an address is never the top query, home/contact pages and position 30+ searches don't make merge pairs", () => {
  assert.equal(intentOf("log book service springfield"), "informational");
  assert.equal(intentOf("book a service springfield"), "transactional");
  const S = "https://acme.example";
  run("INSERT INTO projects (id, name, start_url) VALUES (970, 'Acme Workshop', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status, started_at) VALUES (971, 970, 'done', datetime('now'))");
  for (const p of ["/", "/contact.html", "/brakes", "/services", "/tyres", "/wheels"])
    run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1, inlinks, data) VALUES (971,?,?,200,1,'text/html',?,?,3,'{\"h2s\":[]}')", S + p, S + p, "Brake Repairs", "Brake Repairs");
  run("INSERT INTO gsc (project_id, url, start_date, end_date) VALUES (970, ?, '2026-09-26', '2026-10-23')", S + "/");
  const q = (query, p, impressions, position) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (970,?,?,0,?,0,?)", query, S + p, impressions, position);
  q("415 example highway springfield 3999", "/brakes", 90, 60); q("brake pad replacement", "/brakes", 40, 12);
  for (const w of ["disc brakes", "brake pads", "brake fluid", "brake noise"]) { q(w, "/", 30, 8); q(w, "/contact.html", 20, 9); q(w, "/services", 25, 55); q(w, "/brakes", 20, 70); }
  for (const w of ["tyre rotation", "wheel balance", "tyre pressure"]) { q(w, "/tyres", 30, 6); q(w, "/wheels", 25, 9); }
  const r = queryAlignment(970);
  assert.equal(r.titleGaps.find((g) => g.url === S + "/brakes")?.query, "brake pad replacement", "the address search is skipped");
  assert.deepEqual(r.pairs.map((p) => [p.keeper.url.replace(S, ""), p.other.url.replace(S, "")]), [["/tyres", "/wheels"]],
    "home and contact never pair; /services and /brakes only meet at positions 55-70");
});

test("report: without Search Console data there is nothing to show, and no crash", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (990, 'Empty', 'https://empty.example/')");
  const r = queryAlignment(990);
  assert.equal(r.connected, false);
  assert.deepEqual([r.titleGaps, r.questions, r.pairs], [[], [], []]);
  assert.throws(() => queryAlignment(12345), /Project not found/);
});
