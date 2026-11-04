// Open Graph tags incomplete (2026-11-04): a page with og:title + og:image but missing the rest of a share preview.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { CHECKS, pageIssues } = await import("../src/checks.mjs");

const head = (tags) => `<html><head><title>T</title>${tags}</head><body><main><h1>H</h1><p>Text</p></main></body></html>`;
const FULL = `<meta property="og:title" content="T"><meta property="og:description" content="D"><meta property="og:type" content="website">
  <meta property="og:url" content="https://x.com/a"><meta property="og:site_name" content="X Co"><meta property="og:image" content="https://x.com/i.jpg">
  <meta name="twitter:card" content="summary_large_image">`;
const page = (data) => ({ url: "https://x.com/a", final_url: "https://x.com/a", status: 200, content_type: "text/html", indexable: 1,
  title: "A good page title for tests", description: "d".repeat(100), h1: "H", words: 900, text_ratio: 20, canonical: "https://x.com/a",
  data: { h1Count: 1, viewport: true, lang: "en", canonicals: 1, jsonld: 1, ...data } });
const issue = (html) => pageIssues(page(parseHtml(head(html), "https://x.com/a").data), {}).find(([id]) => /^(og_incomplete|missing_og)$/.test(id));

test("a full set of preview tags raises nothing; twitter:title/description/image and twitter:site aren't required", () => {
  assert.equal(issue(FULL), undefined);
});

test("missing tags are listed in order; empty content counts as missing; name= instead of property= is accepted", () => {
  const partial = `<meta property="og:title" content="T"><meta property="og:image" content="https://x.com/i.jpg"><meta property="og:type" content="website">
    <meta name="og:url" content="https://x.com/a"><meta property="og:site_name" content=" ">`;
  assert.deepEqual(issue(partial), ["og_incomplete", "og:description, og:site_name, twitter:card"]);
  assert.equal(issue(FULL.replace(/<meta property="og:site_name"[^>]*>/, "")).join(" "), "og_incomplete og:site_name");
});

test("no og:title or og:image stays the stronger missing_og notice, not both", () => {
  assert.equal(issue("")[0], "missing_og");
  assert.equal(issue(FULL.replace(/<meta property="og:image"[^>]*>/, ""))[0], "missing_og");
  assert.equal(CHECKS.og_incomplete[0], "notice");
  assert.match(CHECKS.og_incomplete[1], /not a Google ranking factor/);
});
