// Search trend diagnosis (REQ-040 #10, 2026-10-27): weekly series, month-by-month change on last year, and drops
// labelled seasonal / after a Google update / unexplained with the segment that drove them. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates gsc_trend
const { analyse, brandTerms, brandRegex, loadUpdates, trendReport } = await import("../src/trends.mjs");

const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/** Daily rows from `from` for `n` days; value(i, date) gives clicks, impressions are 10x. */
const series = (from, n, value) => Array.from({ length: n }, (_, i) => { const date = add(from, i), c = value(i, date); return { date, clicks: c, impressions: c * 10, position: 5 }; });
const js = (re) => new RegExp(re.replace(/^\(\?i\)/, ""), "i"); // Search Console's RE2 "(?i)" flag as a JS flag

test("a 30% drop two days after a dated update is flagged, attributed and split by segment", () => {
  const from = "2026-01-01", drop = "2026-03-15", n = 120;
  const after = (d) => d >= drop;
  const s = {
    all: series(from, n, (i, d) => (after(d) ? 70 : 100)),
    brand: series(from, n, () => 20),
    nonbrand: series(from, n, (i, d) => (after(d) ? 50 : 80)),
    mobile: series(from, n, (i, d) => (after(d) ? 30 : 60)),
    desktop: series(from, n, () => 40),
  };
  const r = analyse(s, [{ name: "Test core update", type: "core", start: "2026-03-13" }]);
  assert.equal(r.drops.length, 1);
  const x = r.drops[0];
  assert.equal(x.start, drop);
  assert.equal(x.label, "after a Google update");
  assert.equal(x.update.name, "Test core update");
  assert.equal(Math.round(x.pct * 100), 30);
  assert.equal(x.yearAgoNote, "no year-ago data");
  assert.equal(x.driver.query.segment, "nonbrand");
  assert.equal(x.driver.device.segment, "mobile");
  assert.equal(r.updates.length, 1, "updates inside the data range are listed");
});

test("a drop that last year also had in the same weeks is seasonal; YoY by month is computed", () => {
  const from = "2025-05-01", n = 540;
  // Last year: 100 a day with a 3-week dip to 70 from 2025-07-10. This year: 95 a day, the same dip 364 days later.
  const ly = ["2025-07-10", add("2025-07-10", 21)], ty = [add(ly[0], 364), add(ly[1], 364)];
  const s = { all: series(from, n, (i, d) => {
    if (d < "2026-01-01") return d >= ly[0] && d < ly[1] ? 70 : 100;
    return d >= ty[0] && d < ty[1] ? 66 : 95;
  }) };
  const r = analyse(s, []);
  const now = r.drops.find((x) => x.start === ty[0]);
  assert.ok(now, "this year's dip is flagged");
  assert.equal(now.label, "seasonal");
  assert.equal(now.yearAgoNote, null);
  assert.ok(r.drops.some((x) => x.start === ly[0] && x.yearAgoNote === "no year-ago data"), "last year's dip has nothing to compare with");
  assert.ok(r.hasYoy);
  const jul = r.yoy.find((m) => m.month === "2026-07");
  assert.ok(jul && jul.clicksPct < 0 && !jul.partial);
  assert.ok(!r.yoy.some((m) => m.month < "2026-05"), "no YoY for months whose last-year month is missing");
});

test("a rise or a dip that stays above last year is not a drop", () => {
  const from = "2025-01-01";
  const s = { all: series(from, 500, (i, d) => (d < "2026-01-01" ? 50 : d >= "2026-03-01" && d < "2026-03-20" ? 75 : 100)) };
  assert.equal(analyse(s, []).drops.filter((x) => x.start >= "2026-01-01").length, 0, "75 is still above last year's 50");
});

test("brand regex: name words in order, optional plural, any spacing, regex characters escaped", () => {
  const terms = brandTerms({ name: "Acme Motors", start_url: "https://www.acme-motors.example/" }, { brandTerms: "C++ Garage, A.B Panels" });
  assert.deepEqual(terms, ["Acme Motors", "C++ Garage", "A.B Panels"], "the domain label acme-motors repeats the name and is dropped");
  const re = brandRegex(terms);
  assert.ok(re.startsWith("(?i)"));
  const m = js(re);
  for (const q of ["acme motor springfield", "Acme Motors", "acmemotors reviews", "c++ garage springfield", "a.b panels"]) assert.ok(m.test(q), q);
  for (const q of ["springfield car repairs", "motors near me", "axb panels", "cgarage"]) assert.ok(!m.test(q), q);
  assert.ok(re.includes("c\\+\\+") && re.includes("a\\.b"), "special characters are escaped");
  assert.equal(brandRegex(brandTerms({ name: "AB", start_url: "https://ab.io/" })), null, "no usable terms: no brand split");
});

test("a site with 3 months of data: weekly series, no YoY, no crash; empty data is fine too", () => {
  const r = analyse({ all: series("2026-07-01", 90, (i) => 20 + (i % 7)) }, loadUpdates());
  assert.equal(r.hasYoy, false);
  assert.deepEqual(r.yoy, []);
  assert.equal(r.weekly.all.length, 12);
  assert.equal(r.weekly.all.at(-1).end, add("2026-07-01", 89), "the last week ends on the latest day");
  assert.deepEqual(r.drops, []);
  assert.equal(analyse({}).days, 0);
});

test("the update list is dated and the report reads stored rows", () => {
  const u = loadUpdates();
  assert.ok(u.length >= 5 && u.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.start) && x.name && x.type));
  run("INSERT INTO projects (id, name, start_url) VALUES (985, 'Acme', 'https://acme.example/')");
  for (const r of series("2026-06-01", 60, () => 10)) run("INSERT INTO gsc_trend (project_id,date,segment,clicks,impressions,position) VALUES (985,?,?,?,?,?)", r.date, "all", r.clicks, r.impressions, r.position);
  const t = trendReport(985);
  assert.equal(t.fetched, true);
  assert.equal(t.days, 60);
  assert.equal(trendReport(986).fetched, false);
});
