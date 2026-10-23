// Rules that raised false positives in real audits (REQ-010, 2026-10-23). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues } = await import("../src/checks.mjs");
const { aiPageIssues } = await import("../src/ai-checks.mjs");

const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
const page = (over = {}) => ({ url: "https://x.com/a", final_url: "https://x.com/a", status: 200, content_type: "text/html", indexable: 1, title: "A good page title for tests", description: "d".repeat(100), h1: "Heading", words: 900, text_ratio: 20, canonical: "https://x.com/a", data: { h1Count: 1, viewport: true, lang: "en", canonicals: 1, jsonld: 1, og: true, answerEarly: true, citableBlocks: 1, headings: 4, questionHeadings: 1, externalLinks: 2 }, ...over });
const ids = (list) => list.map(([id]) => id);

test("a ?query variant canonical to its clean URL raises no content issues", () => {
  const p = page({ url: "https://x.com/book?service=a", final_url: "https://x.com/book?service=a", canonical: "https://x.com/book", indexable: 0,
    data: { ...page().data, variantOf: "https://x.com/book", noindex: true, crumbHidden: true } });
  assert.deepEqual(ids(pageIssues(p, {})), []);
});

test("a canonical to a different page is still reported", () => {
  const p = page({ canonical: "https://x.com/other", indexable: 0 });
  assert.ok(ids(pageIssues(p, {})).includes("canonical_elsewhere"));
});

test("low text ratio: form pages are exempt, other pages are not", () => {
  assert.ok(ids(pageIssues(page({ text_ratio: 5 }), {})).includes("low_text_ratio"));
  assert.ok(!ids(pageIssues(page({ text_ratio: 5, data: { ...page().data, formShare: 0.5 } }), {})).includes("low_text_ratio"));
});

test("text ratio counts header and footer text too", () => {
  const html = `<html><body><header><nav>${words(300, "nav")}</nav></header><main><p>${words(30)}</p></main><footer>${words(300, "foot")}</footer></body></html>`;
  const { data } = parseHtml(html, "https://x.com/a");
  assert.ok(data.visibleBytes > 6 * 30 * 4, "body text, not only <main>");
});

test("a 150-word opening paragraph counts as a direct answer and a citable passage", () => {
  const { data } = parseHtml(`<html><body><main><h1>T</h1><p>${words(150)}</p><p>${words(300)}</p></main></body></html>`, "https://x.com/a");
  assert.equal(data.answerEarly, true);
  assert.equal(data.citableBlocks, 1);
  const long = parseHtml(`<html><body><main><p>${words(200)}</p><p>${words(300)}</p></main></body></html>`, "https://x.com/a").data;
  assert.equal(long.answerEarly, false);
});

test("listing and legal pages skip the passage and question-heading checks", () => {
  const base = { ...page().data, citableBlocks: 0, questionHeadings: 0 };
  assert.ok(ids(aiPageIssues(page({ data: base }))).includes("ai_no_citable_block"));
  assert.deepEqual(ids(aiPageIssues(page({ url: "https://x.com/blog/", final_url: "https://x.com/blog/", data: { ...base, childLinks: 12 } }))), []);
  assert.deepEqual(ids(aiPageIssues(page({ url: "https://x.com/privacy.html", final_url: "https://x.com/privacy.html", data: base }))), []);
});

test("childLinks counts distinct pages below a folder page", () => {
  const links = Array.from({ length: 8 }, (_, i) => `<a href="/blog/p${i}.html">p</a>`).join("") + '<a href="/about.html">a</a><a href="/blog/p1.html">dup</a>';
  assert.equal(parseHtml(`<html><body>${links}</body></html>`, "https://x.com/blog/").data.childLinks, 8);
  assert.equal(parseHtml(`<html><body>${links}</body></html>`, "https://x.com/").data.childLinks, undefined);
});

test("a shared sitemap lastmod is accepted when those pages really changed after the previous audit", async () => {
  const { run } = await import("../src/db.mjs");
  const { lastmodChanged } = await import("../src/quality.mjs");
  run("INSERT INTO projects (id, name, start_url) VALUES (900, 't', 'https://x.com/')");
  run("INSERT INTO audits (id, project_id, status, finished_at) VALUES (901, 900, 'done', '2026-10-20 10:00:00'), (902, 900, 'done', '2026-10-23 10:00:00')");
  const urls = ["https://x.com/a", "https://x.com/b", "https://x.com/c", "https://x.com/d"];
  for (const u of urls) run("INSERT INTO page_text (audit_id, url, text) VALUES (901, ?, 'old'), (902, ?, ?)", u, u, u.endsWith("d") ? "old" : "new");
  const lastmodOf = new Map(urls.map((u) => [u, "2026-10-22"]));
  assert.deepEqual(lastmodChanged(900, 902, "2026-10-22", lastmodOf), { baseAudit: 901, n: 4, changed: 3, share: 0.75 });
  assert.equal(lastmodChanged(900, 902, "2026-10-19", new Map(urls.map((u) => [u, "2026-10-19"]))), null); // no audit before that date
});
