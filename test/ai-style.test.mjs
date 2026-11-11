// AI-style and depth signals (ai_style, thin_thinking; 2026-11-10). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { aiStyle, depthOf } = await import("../src/ai-style.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS } = await import("../src/checks.mjs");

const S = "https://acme.example";
const audit = (html, url = S + "/blog/how-to-share-a-photo") => {
  const p = parseHtml(html, url);
  const page = { url, final_url: url, status: 200, content_type: "text/html", indexable: 1, title: p.title, description: p.description, h1: p.h1,
    words: p.words, text_ratio: 20, canonical: url, data: p.data };
  return { data: p.data, ids: pageIssues(page, { auditDate: "2026-11-10" }).map(([id]) => id) };
};
const doc = (body) => `<html lang="en"><head><title>How to share a photo as a link</title>
<script type="application/ld+json">{"@type":"BlogPosting","headline":"How to share a photo as a link"}</script></head><body><main><h1>How to share a photo as a link</h1>${body}</main></body></html>`;

// A typical unedited draft: every sentence about the same length, most starting "The", label bullets, stock phrases.
const robotic = doc(Array.from({ length: 8 }, (_, i) => `<h2>The option number ${i + 1} explained</h2>
<p>The image host gives you a direct link that works in various places online. The direct link points to the image file and it typically loads quickly. The share page shows the picture with a simple layout for your viewers. The process is straightforward and it allows you to share images with ease.</p>`).join("") + `
<ul>${["Speed", "Privacy", "Cost", "Formats", "Limits", "Support"].map((l) => `<li><strong>${l}:</strong> The service handles this part well for most people in most situations.</li>`).join("")}</ul>`);

// An editor's version: mixed rhythm, a verdict, reasons, numbers with units, and limits.
const edited = doc(`<p>Upload the photo and copy the direct link.</p>
<p>That's it.</p>
<p>Your phone's photo has no address of its own, because nobody else can reach your phone, so it has to live on a server first.</p>
<h2>Which link to send</h2>
<p>If the link goes into a forum post, use the direct link, because forums turn it into a picture. Paste a share page there and it fails: the forum gets a web page where it expected a file. Send the share page to a person instead, since it opens cleanly in any chat app.</p>
<p>Size matters less than people think. Our 3024 × 2016 test photo was 1.6 MB before upload and 365 KB after, a 77% cut, and it still looked the same on a 6.1 inch phone screen. That's why I'd skip the manual compressor for everyday sharing.</p>
<h2>Where this stops working</h2>
<p>It isn't permanent storage. An image with no views for 12 months is removed, so keep your own copy. Private photos don't belong on any public host either, unless you're fine with anyone who has the link seeing them. Big files are another limit: 25 MB per file is the cap, and a 40 MB scan won't upload.</p>
<p>Email is the awkward case. Some apps hold back linked images until the reader allows them, which is why a share page link is safer there than an embedded picture. Discord is easier, since a direct link shows inline in seconds.</p>
<h2>When a photo won't upload</h2>
<p>Most failures come down to the file, not the connection. An iPhone HEIC photo fails on many sites because few browsers can show it, so convert it to JPG first. Panoramas fail for a simpler reason. Ours was 30 MB: it's over the limit. Shrink it to about 1920 px wide and it drops to a few hundred KB.</p>
<p>Screenshots are the exception to the size rule. Ours, a 1366 × 900 PNG, weighed 2.3 MB, which is why I'd convert it to WebP before sharing; ours came out at 105 KB. Text stays sharp, but colors in photos inside the screenshot may shift slightly.</p>
<p>So the rule is short. Direct link for software, share page for people, your own copy for anything that matters, because no free host promises to keep a file forever.</p>`);

test("the new checks are in the catalog with all four fields", () => {
  for (const id of ["ai_style", "thin_thinking"]) assert.ok(CHECKS[id] && CHECKS[id].length === 4, id);
});

test("too little prose gives no score", () => {
  assert.equal(aiStyle({ paragraphs: ["Short text only."] }), null);
});

test("an unedited draft is flagged for style and for thin thinking", () => {
  const { data, ids } = audit(robotic);
  assert.ok(data.aiStyle.score < 85, `style ${data.aiStyle.score}`);
  assert.ok(data.aiStyle.problems.some((p) => /Label: text/.test(p)));
  assert.ok(ids.includes("ai_style"));
  assert.ok(data.aiStyle.depth < 75, `depth ${data.aiStyle.depth}`);
  assert.ok(ids.includes("thin_thinking"));
});

test("an edited page passes both", () => {
  const { data, ids } = audit(edited);
  assert.ok(data.aiStyle.score >= 85, `style ${data.aiStyle.score}: ${data.aiStyle.problems.join("; ")}`);
  assert.ok(data.aiStyle.depth >= 75, `depth ${data.aiStyle.depth}: ${data.aiStyle.depthProblems.join("; ")}`);
  assert.ok(!ids.includes("ai_style") && !ids.includes("thin_thinking"));
});

test("navigation lists don't count as label bullets", () => {
  const nav = `<nav><ul>${"<li><strong>Menu:</strong> item</li>".repeat(8)}</ul></nav>`;
  const { data } = audit(edited.replace("<main>", `<main>${nav}`));
  assert.ok(!data.aiStyle.problems.some((p) => /Label: text/.test(p)));
});

test("depth reads reasons, numbers and limits per 1,000 words", () => {
  const d = depthOf("It works because the file is public. It is 25 MB, but it won't keep files forever. If you need it later, keep a copy.", 26);
  assert.ok(d.signals.reasonsPer1k > 0 && d.signals.numbersPer1k > 0 && d.signals.limitsPer1k > 0 && d.signals.verdictsPer1k > 0);
});

test("related-post cards after the article don't count as its writing", () => {
  const cards = `<section><h3>Related articles</h3>${Array.from({ length: 6 }, (_, i) => `<article><h4><a href="/blog/p${i}">Post ${i}</a></h4><p>Speed, privacy and cost, compared for forums, chats and email in one short guide.</p></article>`).join("")}</section>`;
  const page = edited.replace("<main>", "<main><article>").replace("</main>", `</article>${cards}</main>`);
  const { data } = audit(page);
  assert.ok(data.aiStyle.score >= 85, `style ${data.aiStyle.score}: ${data.aiStyle.problems.join("; ")}`);
});

test("listing pages are not flagged", () => {
  const listing = robotic.replace("BlogPosting", "CollectionPage");
  const { ids } = audit(listing, S + "/blog");
  assert.ok(!ids.includes("ai_style") && !ids.includes("thin_thinking"));
});

test("typographic apostrophes count as limits and advice", () => {
  const p = "It can’t keep the file and it won’t show it, so don’t send it. ".repeat(30);
  const r = aiStyle({ paragraphs: [p] });
  assert.ok(r.depth.signals.limitsPer1k > 0, `limits ${r.depth.signals.limitsPer1k}`);
});
