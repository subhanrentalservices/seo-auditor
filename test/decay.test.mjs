// Content decay (REQ-040, 2026-10-27): pages losing clicks against the 28 days before and the same weeks last year,
// with the likely cause and seasonal drops told apart; indexable pages Google shows for nothing. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates the Search Console tables
const { compare, decayReport } = await import("../src/decay.mjs");

const S = "https://acme.example";
run("INSERT INTO projects (id, name, start_url) VALUES (995, 'Acme', ?)", S + "/");
run("INSERT INTO audits (id, project_id, status, started_at) VALUES (996, 995, 'done', datetime('now','-90 days'))");
run("INSERT INTO audits (id, project_id, status, started_at) VALUES (997, 995, 'done', datetime('now'))");
const page = (audit, p) => run("INSERT INTO pages (audit_id, url, status, indexable, content_type, title, words, inlinks) VALUES (?,?,200,1,'text/html','T',500,3)", audit, S + p);
for (const p of ["/", "/pricing", "/blog/old-guide", "/blog/orphan", "/privacy"]) { page(996, p); page(997, p); }
page(997, "/blog/brand-new");
const cur = (u, c, i, p) => run("INSERT INTO gsc (project_id,url,clicks,impressions,ctr,position) VALUES (995,?,?,?,0,?)", S + u, c, i, p);
const past = (period, u, c, i, p) => run("INSERT INTO gsc_pages_past (project_id,period,url,clicks,impressions,position,start_date,end_date) VALUES (995,?,?,?,?,?,'2026-01-01','2026-01-28')", period, S + u, c, i, p);

test("a page is decaying only when it loses 30% and at least 5 clicks; the cause follows impressions and position", () => {
  assert.equal(compare({ clicks: 90, impressions: 1000, position: 3 }, { clicks: 100, impressions: 1000, position: 3 }), null, "10% is noise");
  assert.equal(compare({ clicks: 1, impressions: 50, position: 9 }, { clicks: 4, impressions: 60, position: 9 }), null, "too few clicks to judge");
  assert.equal(compare({ clicks: 40, impressions: 900, position: 9.5 }, { clicks: 100, impressions: 1000, position: 3 }).cause, "rank");
  assert.equal(compare({ clicks: 40, impressions: 400, position: 3.2 }, { clicks: 100, impressions: 1000, position: 3 }).cause, "demand");
  assert.equal(compare({ clicks: 40, impressions: 1000, position: 3 }, { clicks: 100, impressions: 1000, position: 3 }).cause, "ctr");
  assert.equal(compare(undefined, { clicks: 20, impressions: 300, position: 5 }).cause, "gone");
});

test("the report ranks real decay first, marks seasonal dips, and lists indexable pages with no impressions", () => {
  cur("/", 200, 5000, 2); past("prev", "/", 210, 5100, 2); past("yoy", "/", 190, 4800, 2.1);           // steady
  cur("/pricing", 30, 2000, 8); past("prev", "/pricing", 120, 2100, 3); past("yoy", "/pricing", 110, 1900, 3); // ranking loss
  cur("/blog/old-guide/", 20, 900, 6); past("prev", "/blog/old-guide", 60, 2000, 6); past("yoy", "/blog/old-guide", 21, 950, 6); // seasonal (trailing slash still matches)
  past("prev", "/blog/dropped", 15, 400, 7);                                                            // vanished
  const d = decayReport(995);
  assert.deepEqual(d.decaying.map((r) => [r.url.replace(S, ""), r.cause]), [["/pricing", "rank"], ["/blog/dropped", "gone"], ["/blog/old-guide/", "seasonal"]]);
  assert.equal(d.decaying[0].vsYear.lost, 80);
  assert.equal(d.decaying.at(-1).seasonal, true);
  assert.deepEqual(d.invisible.map((r) => [r.url.replace(S, ""), r.isNew]).sort(), [["/blog/brand-new", true], ["/blog/orphan", false]]);
  assert.deepEqual(d.expected.map((r) => r.url.replace(S, "")), ["/privacy"], "legal pages are expected to get no impressions");
  assert.equal(d.prevWindow, "2026-01-01 → 2026-01-28");
});
