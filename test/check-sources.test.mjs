// The "All checks" catalog and the README numbers (REQ-055 group 9): every check has a severity, why, fix and a
// source; Google pages only on developers.google.com/search; the README's generated block matches the code. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { checkCatalog, checkCounts, sourceOf } = await import("../src/check-sources.mjs");
const { CHECKS } = await import("../src/checks.mjs");
const { catalog } = await import("../src/api.mjs");
const { numbersBlock, withNumbers, README } = await import("../scripts/readme-numbers.mjs");

test("every check is in the catalog with severity, title, why, fix, group and a source", () => {
  const list = checkCatalog();
  assert.equal(list.length, Object.keys(CHECKS).length);
  for (const c of list) {
    assert.ok(["error", "warning", "notice"].includes(c.severity), c.id);
    assert.ok(c.title && c.why && c.fix, `${c.id} has title, why and fix`);
    assert.ok(c.source.label, c.id);
    if (c.source.url) assert.match(c.source.url, /^https:\/\/developers\.google\.com\/(search|crawling)\/docs\/[a-z0-9/_-]+$/, c.id); // Google moved some crawling pages to /crawling/docs/
  }
  assert.ok(list.some((c) => c.group === "ai") && list.some((c) => c.group === "crawl"));
});

test("sources: Google pages for documented topics, honest labels for the rest", () => {
  assert.match(sourceOf("missing_title").url, /appearance\/title-link$/);
  assert.match(sourceOf("canonical_broken").url, /consolidate-duplicate-urls$/);
  assert.match(sourceOf("hreflang_no_return").url, /localized-versions$/);
  assert.match(sourceOf("cwv_lcp_poor").url, /core-web-vitals$/);
  assert.equal(sourceOf("sec_no_hsts").url, null);
  assert.match(sourceOf("sec_no_hsts").label, /not a Google ranking factor/);
  assert.match(sourceOf("a11y_form_label").label, /WCAG/);
  assert.match(sourceOf("ai_no_author").label, /heuristic/);
  assert.match(sourceOf("low_word_count").label, /heuristic/, "Google sets no word count: no Google page is borrowed");
});

test("counts add up, and GET /api/checks returns the list, with totals on ?counts=1", () => {
  const c = checkCounts();
  assert.equal(c.severity.error + c.severity.warning + c.severity.notice, c.total);
  assert.equal(Object.values(c.groups).reduce((t, n) => t + n, 0), c.total);
  assert.equal(catalog().length, c.total);
  assert.deepEqual(catalog({ counts: "1" }).counts, c);
});

test("README.md numbers match the code (run node scripts/readme-numbers.mjs after adding checks)", async () => {
  const text = readFileSync(README, "utf8").replace(/\r\n/g, "\n");
  const block = await numbersBlock();
  assert.equal(withNumbers(text, block), text);
  assert.match(block, new RegExp(`\\*\\*${checkCounts().total} checks\\*\\*`));
  assert.throws(() => withNumbers("no markers", block), /markers/);
});
