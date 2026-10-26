// Content age, long-content structure and video markup (REQ-040 gaps #7, #12, #13, 2026-10-26). Any site type.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml, isoDate } = await import("../src/crawler.mjs");
const { pageIssues, pastYear, CHECKS } = await import("../src/checks.mjs");

const S = "https://acme.example";
const ctx = { auditDate: "2026-10-26" };
const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
/** Parse HTML the way the crawler does and run the page rules on it. */
const audit = (html, url = S + "/guides/how-to-choose", over = {}) => {
  const p = parseHtml(html, url);
  const page = { url, final_url: url, status: 200, content_type: "text/html", indexable: 1, title: p.title, description: p.description, h1: p.h1,
    words: p.words, text_ratio: 20, canonical: url, data: p.data, ...over };
  return { data: p.data, ids: pageIssues(page, ctx).map(([id]) => id), issues: pageIssues(page, ctx) };
};
const doc = (head, body) => `<html lang="en"><head><title>A page title for the tests here</title>${head}</head><body>${body}</body></html>`;
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test("every new check is in the catalogue", () => {
  for (const id of ["content_stale", "title_past_year", "heading_skip", "heading_before_h1", "long_no_toc", "long_paragraphs", "video_no_schema", "video_schema_incomplete"])
    assert.ok(CHECKS[id] && CHECKS[id].length === 4, id);
});

test("dates are read as yyyy-mm-dd from ISO and written forms; ambiguous numeric dates are ignored", () => {
  assert.equal(isoDate("2024-01-05T09:00:00+11:00"), "2024-01-05");
  assert.equal(isoDate("5 January 2024"), "2024-01-05");
  assert.equal(isoDate("January 5th, 2024"), "2024-01-05");
  assert.equal(isoDate("05/01/2024"), null);
  assert.equal(isoDate("Monday"), null);
});

test("the newest stated date is stored; declared dates win over dates of related posts", () => {
  const { data } = audit(doc(ld({ "@type": "BlogPosting", datePublished: "2023-03-01", dateModified: "2024-01-05" }),
    '<main><h1>Guide</h1><p>Text</p><aside><time datetime="2026-09-01">Related post</time></aside></main>'));
  assert.equal(data.dateModified, "2024-01-05");
  assert.equal(data.datePublished, "2023-03-01");
  assert.equal(data.dated, true, "the old boolean still works");
  const meta = audit(doc('<meta property="article:modified_time" content="2025-06-30T10:00:00Z">', "<main><h1>Guide</h1></main>")).data;
  assert.equal(meta.dateModified, "2025-06-30");
  const visible = audit(doc("", "<main><h1>Guide</h1><p>Last updated: 12 March 2026</p><p>Published 2 February 2022</p></main>")).data;
  assert.equal(visible.dateModified, "2026-03-12");
  assert.equal(visible.datePublished, "2022-02-02");
});

test("an article last dated 2024-01-05 is stale at an audit on 2026-10-26; a recent one and a service page are not", () => {
  const old = audit(doc(ld({ "@type": "Article", dateModified: "2024-01-05" }), "<main><h1>Guide</h1></main>"));
  assert.ok(old.ids.includes("content_stale"));
  assert.match(old.issues.find(([id]) => id === "content_stale")[1], /2024-01-05 \(33 months/);
  assert.ok(!audit(doc(ld({ "@type": "Article", dateModified: "2026-01-05" }), "<main><h1>Guide</h1></main>")).ids.includes("content_stale"));
  assert.ok(!audit(doc(ld({ "@type": "WebPage", dateModified: "2024-01-05" }), "<main><h1>Repairs</h1></main>"), S + "/services/repairs").ids.includes("content_stale"),
    "only articles are expected to stay current");
  assert.ok(!audit(doc("", "<main><h1>Guide</h1></main>")).ids.includes("content_stale"), "no date: nothing to compare (ai_no_date covers it)");
});

test("a past year in the title or H1 is flagged; history, 'since', ranges into this year and prices are not", () => {
  assert.equal(pastYear("Best brakes 2024", 2026), 2024);
  assert.equal(pastYear("Best brakes 2026", 2026), null);
  assert.equal(pastYear("Operating since 2021", 2026), null);
  assert.equal(pastYear("Our history: founded in 2009", 2026), null);
  assert.equal(pastYear("Tax rates 2025/26", 2026), null);
  assert.equal(pastYear("Results 2019–2023", 2026), 2019);
  assert.equal(pastYear("Laptops under $2000", 2026), null);
  assert.equal(pastYear("A 2000 km road trip", 2026), null);
  assert.equal(pastYear("The XR-2020 explained", 2026), null);
  const t = audit(doc("", "<main><h1>Choosing brakes</h1></main>").replace("A page title for the tests here", "Best brakes 2024"));
  assert.ok(t.ids.includes("title_past_year"));
  const body = audit(doc("", "<main><h1>About us</h1><p>Operating since 2021 and still growing.</p></main>"), S + "/about");
  assert.ok(!body.ids.includes("title_past_year"), "a year in the body text is not a headline");
  const h1 = audit(doc("", "<main><h1>Top tools for 2023</h1></main>"));
  assert.ok(h1.ids.includes("title_past_year"));
  assert.ok(!audit(doc(ld({ "@type": "NewsArticle" }), "<main><h1>Council approves budget 2024</h1></main>")).ids.includes("title_past_year"));
});

test("h1, h2, h4 is one heading skip; a heading before the H1 is reported; footer headings don't count", () => {
  const r = audit(doc("", "<main><h1>T</h1><h2>A</h2><h4>Deep</h4><h2>B</h2><h3>C</h3></main><footer><h5>Links</h5></footer>"));
  assert.equal(r.data.headingSkips, 1);
  assert.match(r.data.headingSkipExample, /H2 → H4 "Deep"/);
  assert.ok(r.ids.includes("heading_skip"));
  assert.ok(!r.ids.includes("heading_before_h1"));
  const before = audit(doc("", "<main><h2>Intro</h2><h1>T</h1><h2>A</h2></main>"));
  assert.equal(before.data.headingsBeforeH1, 1);
  assert.ok(before.ids.includes("heading_before_h1"));
  const noMain = audit(doc("", "<header><nav><h4>Menu</h4></nav></header><article><header><h1>T</h1></header><h2>A</h2><h3>B</h3></article><footer><h4>Contact</h4></footer>"));
  assert.ok(!noMain.ids.includes("heading_skip") && !noMain.ids.includes("heading_before_h1"), "menus and the site footer are not the outline");
});

const longPage = (toc) => doc("", `<main><h1>Guide</h1>${toc}${[1, 2, 3, 4, 5].map((i) => `<h2 id="s${i}">Section ${i}</h2><p>${words(400)}</p>`).join("")}</main>`);

test("a 2,000-word page with 5 H2s and no jump links gets the table-of-contents notice; one with a contents list doesn't", () => {
  const r = audit(longPage(""));
  assert.ok(r.data.h2Count === 5 && r.ids.includes("long_no_toc"));
  const toc = audit(longPage('<nav><a href="#s1">One</a><a href="#s2">Two</a><a href="#s3">Three</a></nav><a href="#main">Skip</a>'));
  assert.equal(toc.data.jumpLinks, 3);
  assert.ok(!toc.ids.includes("long_no_toc"));
  const short = audit(doc("", `<main><h1>G</h1>${[1, 2, 3, 4].map((i) => `<h2>S${i}</h2><p>${words(100)}</p>`).join("")}</main>`));
  assert.ok(!short.ids.includes("long_no_toc"), "short pages don't need one");
});

test("paragraphs over 180 words are reported; a 160-word citable passage is not (no contradiction with the AI checks)", () => {
  const r = audit(doc("", `<main><h1>G</h1><p>${words(160)}</p><p>${words(250)}</p></main>`));
  assert.equal(r.data.longParas, 1);
  assert.equal(r.data.longParaMax, 250);
  assert.ok(r.ids.includes("long_paragraphs"));
  assert.ok(!audit(doc("", `<main><h1>G</h1><p>${words(160)}</p></main>`)).ids.includes("long_paragraphs"));
});

const yt = '<iframe src="https://www.youtube.com/embed/abc123" title="Demo"></iframe>';
test("a YouTube iframe without JSON-LD is flagged; decorative background video is not", () => {
  const r = audit(doc("", `<main><h1>G</h1>${yt}</main>`));
  assert.equal(r.data.videos, 1, "found before iframes are stripped from the text");
  assert.ok(r.ids.includes("video_no_schema"));
  assert.ok(!audit(doc("", '<main><h1>G</h1><video autoplay muted loop src="/bg.mp4"></video></main>')).ids.includes("video_no_schema"));
  assert.ok(!audit(doc("", '<main><h1>G</h1><video muted loop playsinline data-hero></video></main>')).ids.includes("video_no_schema"), "started by script");
  assert.ok(audit(doc("", '<main><h1>G</h1><video controls src="/how-to.mp4"></video></main>')).ids.includes("video_no_schema"));
  assert.ok(audit(doc("", '<main><h1>G</h1><iframe data-src="https://player.vimeo.com/video/1"></iframe></main>')).ids.includes("video_no_schema"));
});

test("a VideoObject without uploadDate is flagged; a complete one is clean", () => {
  const video = { "@context": "https://schema.org", "@type": "VideoObject", name: "Demo", thumbnailUrl: "https://acme.example/t.jpg" };
  const bad = audit(doc(ld(video), `<main><h1>G</h1>${yt}</main>`));
  assert.ok(bad.ids.includes("video_schema_incomplete") && !bad.ids.includes("video_no_schema"));
  assert.match(bad.issues.find(([id]) => id === "video_schema_incomplete")[1], /uploadDate/);
  const good = audit(doc(ld({ ...video, uploadDate: "2026-05-01" }), `<main><h1>G</h1>${yt}</main>`));
  assert.ok(!good.ids.includes("video_schema_incomplete") && !good.ids.includes("video_no_schema"));
  const ref = audit(doc(ld({ "@type": "Article", video: { "@type": "VideoObject", "@id": "#v" } }) + ld({ ...video, "@id": "#v", uploadDate: "2026-05-01" }), `<main><h1>G</h1>${yt}</main>`));
  assert.ok(!ref.ids.includes("video_schema_incomplete"), "an @id reference is not an incomplete VideoObject");
});

test("noindex pages get none of these notices", () => {
  const r = audit(doc(ld({ "@type": "Article", dateModified: "2020-01-01" }), `<main><h2>x</h2><h1>Best of 2020</h1><h4>y</h4>${yt}</main>`), undefined, { indexable: 0 });
  assert.deepEqual(r.ids.filter((id) => /content_stale|title_past_year|heading_|video_/.test(id)), []);
});
