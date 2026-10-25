// CTR report (REQ-022, 2026-10-25): impressions and clicks by position band, brand vs non-brand, and page-1 queries
// clicked far less than a benchmark expects. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { ctrReport, EXPECTED_CTR } = await import("../src/gsc.mjs");

const isBrand = (q) => /acme/i.test(q);
const row = (query, impressions, clicks, position, page = "https://acmemotors.com.au/") => ({ query, impressions, clicks, position, page });

test("impressions are split by position band and brand; the deep share is positions 21+", () => {
  const r = ctrReport([row("acme motors", 100, 10, 1.4), row("brake repairs springfield", 50, 0, 34), row("rwc springfield", 30, 1, 6), row("acme car", 20, 0, 60)], isBrand);
  const band = (b) => r.bands.find((x) => x.band === b);
  assert.deepEqual(band("1–3").brand, { impressions: 100, clicks: 10 });
  assert.deepEqual(band("4–10").other, { impressions: 30, clicks: 1 });
  assert.equal(band("21–50").other.impressions, 50);
  assert.equal(band("51+").brand.impressions, 20);
  assert.equal(r.deepShare, 70 / 200);
});

test("a page-1 query with under half the expected clicks is a gap; brand queries and deep positions are not", () => {
  const r = ctrReport([
    row("rwc springfield", 60, 0, 3),                 // expects 6.1 clicks, got 0 → gap
    row("mechanic springfield", 40, 3, 4),            // expects 2.9, got 3 → fine
    row("acme motors", 300, 0, 8),                    // brand → ignored
    row("panel beater springfield", 500, 0, 25),      // position 25 → a ranking problem, not listed
    row("tyres springfield", 10, 0, 9),               // expects 0.19 click → too few impressions to judge
  ], isBrand);
  assert.deepEqual(r.gaps.map((g) => g.query), ["rwc springfield"]);
  assert.ok(Math.abs(r.gaps[0].expectedClicks - 60 * EXPECTED_CTR[2]) < 1e-9);
});

test("a query spread over several pages is judged on its combined, impression-weighted position", () => {
  const r = ctrReport([row("brakes springfield", 30, 0, 2, "https://acmemotors.com.au/brakes.html"), row("brakes springfield", 10, 0, 14, "https://acmemotors.com.au/")], isBrand);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].position, 5);
  assert.equal(r.gaps[0].page, "https://acmemotors.com.au/brakes.html");
});
