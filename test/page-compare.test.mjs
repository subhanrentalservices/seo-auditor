// Page vs page for one search (REQ-062, 2026-10-31): signals read from both pages and the gaps listed. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { comparePages, uses, gaps } = await import("../src/page-compare.mjs");

const mine = `<!doctype html><html lang="en"><head><title>Email Tools | Acme</title><meta name="description" content="Our picks."></head><body><main>
<h1>Email tools</h1><p>${"We like simple tools. ".repeat(30)}</p><img src="/a.png"><h2>Pricing</h2><p>Plans vary.</p></main></body></html>`;
const theirs = `<!doctype html><html lang="en"><head><title>15 Best Email Marketing Tools in 2026 (Tested)</title>
<meta name="description" content="We tested 15 email marketing tools for price and deliverability.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the best email marketing tool?","acceptedAnswer":{"@type":"Answer","text":"It depends on your list size."}}]}</script>
</head><body><main><h1>The 15 best email marketing tools</h1><p>Email marketing tools send newsletters and automations. ${"We tested each tool for a month. ".repeat(80)}</p>
<p>Updated 12 September 2026</p><h2>Best email marketing tools for small business</h2><h2>What is the best email marketing tool?</h2><p>It depends.</p>
<h2>How much do email marketing tools cost?</h2><p>From free.</p><h2>Is email marketing worth it?</h2><p>Yes, <a href="https://www.example.org/report">per this study</a>.</p></main></body></html>`;

const fake = (pages) => async (u) => ({ status: 200, type: "text/html; charset=utf-8", body: pages[u], finalUrl: u });

test("uses(): exact phrase, words close together, or nothing", () => {
  assert.equal(uses("15 Best Email Marketing Tools in 2026", "email marketing tools"), "exact");
  assert.equal(uses("Tools for marketing by email", "email marketing tools"), "words");
  assert.equal(uses("Our picks", "email marketing tools"), null);
});

test("compares two pages for a search and lists what the other page does that mine doesn't", async () => {
  const r = await comparePages({ mine: "https://acme.example/email", theirs: "https://rival.example/best", keyword: "email marketing tools" },
    { fetchPage: fake({ "https://acme.example/email": mine, "https://rival.example/best": theirs }) });
  assert.equal(r.mine.titleUses, null);
  assert.equal(r.theirs.titleUses, "exact");
  assert.equal(r.theirs.headingsUsing, 3, "\"tool\" and \"tools\" both count");
  assert.ok(r.theirs.schemaTypes.includes("FAQPage"));
  const ids = r.gaps.map((g) => g[0]);
  for (const id of ["title", "h1", "first100", "headings", "questions", "length", "description", "schema", "dated", "sources"]) assert.ok(ids.includes(id), id);
  assert.ok(ids.includes("alt"), "my image has no alt text");
  assert.equal(ids[0], "title", "title first");
});

test("no gaps when my page already does everything; errors are reported, not thrown", async () => {
  const same = await comparePages({ mine: "https://a.example/x", theirs: "https://b.example/y", keyword: "email marketing tools" },
    { fetchPage: fake({ "https://a.example/x": theirs, "https://b.example/y": theirs }) });
  assert.deepEqual(same.gaps, []);
  const bad = await comparePages({ mine: "https://a.example/x", theirs: "https://b.example/gone", keyword: "x" },
    { fetchPage: async (u) => (u.endsWith("gone") ? { status: 404, type: "text/html", body: "" } : { status: 200, type: "text/html", body: mine, finalUrl: u }) });
  assert.equal(bad.theirs.error, "HTTP 404");
  assert.deepEqual(bad.gaps, []);
  await assert.rejects(comparePages({ mine: "acme", theirs: "https://b.example", keyword: "x" }), /full page addresses/);
  await assert.rejects(comparePages({ mine: "https://a.example", theirs: "https://b.example", keyword: " " }), /search/);
});

test("gaps() ignores markup types that say nothing about the content", () => {
  const base = { titleUses: "exact", h1Uses: "exact", first100Uses: "exact", headingsUsing: 1, questionHeadings: 0, words: 500, descriptionUses: "exact", schemaTypes: ["Article"], dated: true, author: true, contentLinksExternal: 1, imagesNoAlt: 0 };
  assert.deepEqual(gaps(base, { ...base, schemaTypes: ["Article", "WebSite", "BreadcrumbList", "Organization"] }).map((g) => g[0]), ["schema"]);
  assert.deepEqual(gaps(base, { ...base, schemaTypes: ["Article", "WebSite", "Organization"] }), []);
});
