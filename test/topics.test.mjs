// Topic coverage (REQ-021, 2026-10-25): non-brand searches Google shows a page for that its text never covers, and the
// words those searches keep using. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates gsc_queries
const { topicCoverage } = await import("../src/topics.mjs");

const S = "https://acmemotors.com.au";
run("INSERT INTO projects (id, name, start_url) VALUES (990, 'Acme Motors', 'https://acmemotors.com.au/')");
run("INSERT INTO audits (id, project_id, status) VALUES (991, 990, 'done')");
run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title) VALUES (991, ?, ?, 200, 1, 'text/html', 'Roadworthy Certificate Springfield | Acme Motors')", S + "/rwc.html", S + "/rwc.html");
run("INSERT INTO page_text (audit_id, url, text) VALUES (991, ?, ?)", S + "/rwc.html", "We arrange a roadworthy certificate for cars in Springfield. The inspection checks brakes, tyres and lights.");
const q = (query, impressions, position) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (990, ?, ?, 0, ?, 0, ?)", query, S + "/rwc.html", impressions, position);
q("roadworthy certificate springfield", 40, 6);   // covered (exact phrase)
q("rwc inspection brakes", 3, 20);                // "rwc" is never used on the page
q("roadworthy cost springfield", 12, 18);         // "cost" never used
q("how much does a roadworthy cost", 8, 22);      // "much", "cost"
q("acme motors rwc", 30, 2);                      // brand: ignored
q("roadworthy certificate", 1, 9);                // under 2 impressions: ignored
q("roadworthy springfield south", 5, 70);         // beyond position 50: ignored

test("lists searches the page doesn't cover, with the words it never uses", () => {
  const d = topicCoverage(991);
  const p = d.pages.find((x) => x.url === S + "/rwc.html");
  assert.equal(p.queries, 4);
  assert.equal(p.covered, 1);
  assert.deepEqual(p.uncovered.map((u) => u.query), ["roadworthy cost springfield", "how much does a roadworthy cost", "rwc inspection brakes"]);
  assert.equal(p.missingWords[0].word, "cost", "the word worth most impressions comes first");
  assert.ok(p.missingWords.some((w) => w.word === "rwc"));
});

test("works without Search Console", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (992, 'Bolt Panels', 'https://boltpanels.com.au/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (993, 992, 'done')");
  assert.deepEqual(topicCoverage(993).pages, []);
});
