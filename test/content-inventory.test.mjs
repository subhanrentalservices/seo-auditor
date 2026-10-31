// Content inventory (REQ-055 group 6, item 4): words, last modified, Search Console trend, inlinks, decay and one
// suggested action per page (keep / refresh / merge into X / prune) with its reason. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs");
await import("../src/site-rules.mjs");
const { inventory, inventoryCsv, suggest } = await import("../src/content-inventory.mjs");

const S = "https://northwind.example";
const TODAY = "2026-10-31";
run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Northwind Supplies', ?)", S + "/");
run("INSERT INTO audits (id, project_id, status, started_at) VALUES (1, 1, 'done', '2026-06-01 10:00:00'), (2, 1, 'done', '2026-10-30 10:00:00')");
const page = (audit, p, words, inlinks, data = {}, title = p) => run("INSERT INTO pages (audit_id, url, status, indexable, content_type, title, words, inlinks, data) VALUES (?,?,200,1,'text/html; charset=utf-8',?,?,?,?)",
  audit, S + p, title, words, inlinks, JSON.stringify(data));
page(1, "/thin", 120, 1);
for (const [p, w, l, d] of [["/", 900, 0], ["/near-one", 800, 10], ["/old-guide", 1500, 6, { dateModified: "2024-01-15" }], ["/decaying", 700, 4], ["/thin", 120, 1],
  ["/contact", 80, 30], ["/dup-a", 600, 2], ["/dup-b", 650, 8], ["/fine", 1000, 12], ["/new-thin", 150, 1]]) page(2, p, w, l, d);
run("INSERT INTO audit_lastmod (audit_id, url, lastmod) VALUES (2, ?, '2026-09-01')", S + "/near-one");
// Search Console: daily page rows (last day 2026-10-30), page totals and the previous window for decay, query x page rows.
const daily = (p, date, clicks, impressions, position) => run("INSERT INTO gsc_page_daily (project_id, url, date, clicks, impressions, position) VALUES (1,?,?,?,?,?)", S + p, date, clicks, impressions, position);
daily("/", "2026-10-30", 30, 300, 2);
daily("/near-one", "2026-10-20", 1, 200, 12);
daily("/near-one", "2026-09-20", 3, 150, 11); // the 28 days before
daily("/old-guide", "2026-10-25", 6, 90, 4);
daily("/decaying", "2026-10-28", 2, 100, 5);
daily("/decaying", "2026-09-25", 20, 110, 5);
daily("/fine", "2026-10-29", 40, 400, 3);
daily("/dup-a", "2026-10-29", 1, 60, 9);
daily("/dup-b", "2026-10-29", 9, 80, 6);
run("INSERT INTO gsc (project_id, url, clicks, impressions, position) VALUES (1, ?, 2, 100, 5)", S + "/decaying");
run("INSERT INTO gsc_pages_past (project_id, period, url, clicks, impressions, position, start_date, end_date) VALUES (1, 'prev', ?, 20, 110, 5, '2026-09-05', '2026-10-02')", S + "/decaying");
for (const qq of ["espresso grinder settings", "grinder settings chart", "how fine espresso grind"]) {
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (1,?,?,0,20,0,9)", qq, S + "/dup-a");
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (1,?,?,3,25,0,6)", qq, S + "/dup-b");
}

test("inventory: one action per page, with its reason", () => {
  const r = inventory(1, { today: TODAY });
  assert.equal(r.audited, true);
  assert.equal(r.connected, true);
  assert.deepEqual(r.window, { from: "2026-10-03", to: "2026-10-30" });
  const by = (p) => r.pages.find((x) => x.url === S + p);
  const near = by("/near-one");
  assert.equal(near.action, "refresh");
  assert.match(near.reason, /position 12/);
  assert.equal(near.lastModified, "2026-09-01");
  assert.equal(near.lastModifiedFrom, "sitemap");
  assert.equal(near.prevImpressions, 150);
  assert.equal(near.weekly.length, 12);
  assert.equal(near.weekly.reduce((a, b) => a + b, 0), 4, "clicks per week over 12 weeks");
  assert.equal(by("/old-guide").action, "refresh");
  assert.match(by("/old-guide").reason, /Last modified 2024-01-15/);
  assert.equal(by("/decaying").action, "refresh");
  assert.match(by("/decaying").reason, /Clicks fell 90%/);
  assert.equal(by("/dup-a").action, "merge");
  assert.equal(by("/dup-a").into, S + "/dup-b");
  assert.equal(by("/dup-b").action, "keep");
  assert.equal(by("/thin").action, "prune");
  assert.match(by("/thin").reason, /120 words.*1 internal links/);
  assert.equal(by("/new-thin").action, "keep", "first seen yesterday: too new to judge");
  assert.equal(by("/contact").action, "keep", "utility page");
  assert.equal(by("/").action, "keep", "home page never pruned");
  assert.equal(by("/fine").action, "keep");
  assert.equal(r.pages[0].action, "merge", "merge, refresh and prune first");
  assert.deepEqual(r.counts, { merge: 1, refresh: 3, prune: 1, keep: 5 });
});

test("suggest: no Search Console data = never prune for having no impressions", () => {
  const p = { url: S + "/x", words: 50, inlinks: 0, lastModified: null, ageDays: 400, clicks: 0, impressions: 0, position: null, impressions90: 0, decay: null, mergeInto: null };
  assert.equal(suggest(p, { today: TODAY, home: S + "/" }).action, "prune");
  assert.equal(suggest(p, { today: TODAY, home: S + "/", gsc: false }).action, "keep");
  assert.equal(suggest({ ...p, decay: { pct: 0.5, cause: "demand", advice: "", seasonal: true } }, { today: TODAY, gsc: false }).reason.includes("seasonal"), true);
});

test("CSV export and edge cases", () => {
  const csv = inventoryCsv(1);
  assert.match(csv.split("\r\n")[0], /^url,title,action,into,reason/);
  assert.ok(csv.includes(`${S}/dup-a,/dup-a,merge,${S}/dup-b,`));
  assert.throws(() => inventory(99), (e) => e.status === 404);
  run("INSERT INTO projects (id, name, start_url) VALUES (2, 'Empty', 'https://empty.example/')");
  assert.deepEqual(inventory(2), { audited: false, pages: [] });
});
