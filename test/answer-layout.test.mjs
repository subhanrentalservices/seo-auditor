// Answer layout (2026-11-04): question headings answered straight away; long pages with no list or table. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { parseHtml } = await import("../src/crawler.mjs");
const { aiPageIssues } = await import("../src/ai-checks.mjs");

const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
const html = (body) => `<html><body><header><nav><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul></nav><h2>Menu?</h2></header><main>${body}</main></body></html>`;

test("a question heading followed by a short answer counts as answered; a lead-in or no text is late", () => {
  const d = parseHtml(html(`<h1>Guide</h1>
    <h2>How long does indexing take?</h2><p>A few days to a few weeks. ${words(60)}.</p>
    <h2>Do I need a sitemap?</h2><p>Yes.</p><p>${words(30)}.</p>
    <h3>Why is my page crawled but not indexed?</h3><p>${words(55)} before it gets to the point.</p>
    <h2>What about images?</h2><img src="/x.png" alt="x"><h2>Plain heading</h2><p>${words(20)}.</p>`), "https://x.com/a").data;
  assert.equal(d.qAnswered, 2);
  assert.equal(d.qLate, 2);
  assert.match(d.qLateExample, /^"Why is my page crawled but not indexed\?" \(first sentence is 6\d words\)$/);
});

test("FAQ accordions with the question heading inside <summary> are read in order; menus are ignored", () => {
  const d = parseHtml(html(`<details><summary><h3>Is the quote free?</h3></summary><p>Yes, quotes are free.</p></details>`), "https://x.com/a").data;
  assert.deepEqual([d.qAnswered, d.qLate], [1, 0], "the header's 'Menu?' heading is page chrome");
});

test("a table or list straight under the question, or after a short lead-in ending in a colon, is the answer", () => {
  const table = `<table><tr><td>Freeways and arterial roads</td><td>The state road authority</td></tr><tr><td>Local streets</td><td>Your local council</td></tr></table>`;
  const d = parseHtml(html(`<h2>Who is responsible for the road?</h2>${table}
    <h2>Which road is it?</h2><p>Who you claim against depends on the type of road:</p>${table}
    <h2>How do I report a mistake?</h2><p>If you think something in a guide is wrong or out of date, tell us and we'll check it against the source and fix it:</p><ul><li>Email us</li><li>Phone us</li></ul>
    <h2>What happens when you bring your car in?</h2><h3>We look before we work</h3><p>Every job starts with an inspection.</p>`), "https://x.com/a").data;
  assert.deepEqual([d.qAnswered, d.qLate], [3, 1]);
  assert.match(d.qLateExample, /bring your car in\?" \(no answer text before the next heading\)/, "sub-headings with no summary first are still late");
});

test("numbered step headings and numbered cards count as formats", () => {
  const steps = parseHtml(html(`<h3>1. At the scene</h3><p>a</p><h3>2. Lodge your claim</h3><p>b</p><h3>3. Send us the claim number</h3><p>c</p>`), "https://x.com/a").data;
  assert.equal(steps.formats, 1);
  const cards = parseHtml(html(`<p>01</p><h3>Panel beating</h3><p>02</p><h3>Paint</h3><p>03</p><h3>Bumpers</h3>`), "https://x.com/a").data;
  assert.equal(cards.formats, 1);
  assert.equal(parseHtml(html(`<h3>2026 prices</h3><p>a</p><h3>10 tips</h3>`), "https://x.com/a").data.formats, 0, "a heading that only starts with a number isn't a step");
});

test("lists and tables with content count as formats; link-only lists and menus don't", () => {
  const none = parseHtml(html(`<p>${words(50)}</p><ul><li><a href="/x">Link one</a></li><li><a href="/y">Link two</a></li></ul>`), "https://x.com/a").data;
  assert.equal(none.formats, 0);
  const some = parseHtml(html(`<ol><li>Take photos of both cars and the scene</li><li>Swap details with the other driver</li></ol><table><tr><td>Panel repair</td><td>2-5 days</td></tr><tr><td>Full respray</td><td>1-2 weeks</td></tr></table>`), "https://x.com/a").data;
  assert.equal(some.formats, 2);
});

const page = (data, over = {}) => ({ url: "https://x.com/a", final_url: "https://x.com/a", status: 200, content_type: "text/html", indexable: 1, words: 900,
  data: { answerEarly: true, citableBlocks: 1, headings: 4, questionHeadings: 2, externalLinks: 1, ...data }, ...over });
const ids = (list) => list.map(([id]) => id);

test("notices: late answers with a count and example; no list/table only on long pages and only when measured", () => {
  const late = aiPageIssues(page({ qLate: 1, qAnswered: 3, qLateExample: '"Q?" (first sentence is 52 words)', formats: 2 }));
  assert.deepEqual(late.find(([id]) => id === "ai_question_answer_late"), ["ai_question_answer_late", '1 of 4: "Q?" (first sentence is 52 words)']);
  assert.deepEqual(aiPageIssues(page({ formats: 0 })).find(([id]) => id === "ai_no_lists_tables"), ["ai_no_lists_tables", "900 words, 4 headings"]);
  assert.ok(!ids(aiPageIssues(page({ formats: 0, headings: 14 }))).includes("ai_no_lists_tables"), "many short labelled sections read like a list");
  assert.ok(!ids(aiPageIssues(page({ formats: 0 }, { words: 500 }))).includes("ai_no_lists_tables"), "short pages don't need a list");
  assert.ok(!ids(aiPageIssues(page({}))).includes("ai_no_lists_tables"), "older audits without the measurement aren't flagged");
  assert.ok(!ids(aiPageIssues(page({ qLate: 2, formats: 0 }, { url: "https://x.com/privacy.html", final_url: "https://x.com/privacy.html" }))).some((id) => /late|lists/.test(id)), "legal pages skip both");
});
