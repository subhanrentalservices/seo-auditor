// JavaScript rendering checks (REQ-044 build rows 4, 13, 14, 27; 2026-10-27): raw vs rendered title, H1, content
// links, structured data and hreflang; files the render needs that robots.txt blocks or that fail; uncaught script
// errors; JavaScript redirects; same-site scripts, styles and fonts collected for the broken-file check. The browser
// log is faked, so no browser is started. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { rawRenderedDiff, sameTitle, renderFindings, mergeRender, siteOf } = await import("../src/render-checks.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const robotsParser = (await import("robots-parser")).default;

const S = "https://example.com";
const U = S + "/page.html";
const ids = (xs) => xs.map((x) => x[0]);
const page = (data, over = {}) => ({ url: U, final_url: U, status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 300, text_ratio: 20, depth: 0, outlinks: 1, canonical: U, data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });
const doc = (title, body, head = "") => `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const diff = (rawHtml, renHtml) => rawRenderedDiff(parseHtml(rawHtml, U), parseHtml(renHtml, U), U);
const links = (n, from = 0) => Array.from({ length: n }, (_, i) => `<a href="/p${from + i}.html">Page ${from + i}</a>`).join(" ");

test("the rendering checks are catalogued with the right severity and show under Crawlability", () => {
  const sev = { render_resource_blocked: "warning", render_js_error: "notice", render_js_error_content: "warning", broken_internal_resource: "error", js_redirect: "notice" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); assert.ok(CRAWL.has(id), id); }
  assert.match(CHECKS.raw_vs_rendered[1], /title, H1, links, structured data/);
});

// ---- Row 4: raw_vs_rendered, new kinds ----
test("raw vs rendered: a title JavaScript rewrites is reported; a brand part added or removed is not", () => {
  assert.match(diff(doc("Brakes", "<h1>H</h1>"), doc("Cheap brakes today", "<h1>H</h1>")), /title "Brakes" in raw HTML, "Cheap brakes today" after rendering/);
  assert.equal(diff(doc("Brakes", "<h1>H</h1>"), doc("Brakes | Example Co", "<h1>H</h1>")), "");
  assert.equal(diff(doc("Example Co – Brakes", "<h1>H</h1>"), doc("Brakes", "<h1>H</h1>")), "");
  assert.equal(diff(doc("  brakes ", "<h1>H</h1>"), doc("Brakes", "<h1>H</h1>")), "", "whitespace and case don't count");
  assert.match(diff(doc("", "<h1>H</h1>"), doc("Brakes", "<h1>H</h1>")), /title only after rendering/);
  assert.equal(sameTitle("Brakes", "Brakes repair"), false, "a longer title without a separator is a real change");
});

test("raw vs rendered: H1 changed or added by JavaScript", () => {
  assert.match(diff(doc("T", "<h1>Old heading</h1>"), doc("T", "<h1>New heading</h1>")), /H1 "Old heading" in raw HTML, "New heading" after rendering/);
  assert.match(diff(doc("T", '<div id="app"></div>'), doc("T", "<h1>Heading</h1>")), /H1 only after rendering/);
  assert.equal(diff(doc("T", "<h1>Heading</h1>"), doc("T", "<h1> heading </h1>")), "");
});

test("raw vs rendered: 5+ internal content links (and 20%+ of them) only after rendering; menus and other hosts don't count", () => {
  const raw = doc("T", `<h1>H</h1><main>${links(10)}</main>`);
  assert.match(diff(raw, doc("T", `<h1>H</h1><main>${links(10)} ${links(5, 10)}</main>`)), /5 of 15 internal content links only after rendering/);
  assert.equal(diff(raw, doc("T", `<h1>H</h1><main>${links(10)} ${links(4, 10)}</main>`)), "", "4 added links are below the minimum");
  assert.equal(diff(doc("T", `<h1>H</h1><main>${links(40)}</main>`), doc("T", `<h1>H</h1><main>${links(40)} ${links(6, 40)}</main>`)), "", "6 of 46 is under 20%");
  assert.equal(diff(raw, doc("T", `<h1>H</h1><nav>${links(8, 10)}</nav><main>${links(10)}</main>`)), "", "menu links added by JavaScript");
  const ext = Array.from({ length: 8 }, (_, i) => `<a href="https://chat.example.net/x${i}">Chat ${i}</a>`).join(" ");
  assert.equal(diff(raw, doc("T", `<h1>H</h1><main>${links(10)} ${ext}</main>`)), "", "widget links on another host");
});

test("raw vs rendered: structured data types and hreflang added only by JavaScript", () => {
  const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X"}</script>';
  assert.match(diff(doc("T", "<h1>H</h1>"), doc("T", "<h1>H</h1>", ld)), /structured data only after rendering: Product/);
  assert.equal(diff(doc("T", "<h1>H</h1>", ld), doc("T", "<h1>H</h1>", ld)), "");
  const hl = `<link rel="alternate" hreflang="en" href="${U}"><link rel="alternate" hreflang="de" href="${S}/de/page.html">`;
  assert.match(diff(doc("T", "<h1>H</h1>"), doc("T", "<h1>H</h1>", hl)), /2 hreflang link\(s\) only after rendering/);
  assert.equal(diff(doc("T", "<h1>H</h1>", hl), doc("T", "<h1>H</h1>", hl)), "");
});

test("mergeRender: uncrawlable links found only in the raw HTML still count", () => {
  const raw = parseHtml(doc("T", `<h1>H</h1><div onclick="location.href='/a.html'">A</div><div onclick="location.href='/b.html'">B</div>`), U);
  const ren = parseHtml(doc("T", "<h1>H</h1><p>x</p>"), U);
  const d = mergeRender({ ...ren.data }, raw, ren, U, { jsRedirect: { to: S + "/x.html" } });
  assert.equal(d.jsLinks, 2);
  assert.equal(d.jsRedirect.to, S + "/x.html");
});

// ---- Row 13: render_resource_blocked, render_js_error ----
const robotsTxt = "User-agent: *\nDisallow: /api/\nDisallow: /assets/private/\n";
const robots = robotsParser(S + "/robots.txt", robotsTxt);
const robotsFor = async (o) => (o === S ? robots : o === "https://cdn.example.com" ? robotsParser("https://cdn.example.com/robots.txt", "User-agent: *\nDisallow: /js/\n") : null);
const log = (over = {}) => ({ html: "<html></html>", url: U, docs: [U], requests: [], errors: [], ...over });

test("blocked files: same-site scripts, styles and data requests disallowed for Googlebot; third-party, analytics and images are left out", async () => {
  const requests = [
    { url: S + "/api/menu.json", type: "fetch", status: 200 }, { url: S + "/assets/private/app.css", type: "stylesheet", status: 200 },
    { url: "https://cdn.example.com/js/app.js", type: "script", status: 200 }, { url: S + "/assets/site.js", type: "script", status: 200 },
    { url: "https://tags.example.org/api/x.js", type: "script", status: 200 }, { url: S + "/api/g/collect?v=2", type: "xhr", status: 204 },
  ];
  const d = await renderFindings({ fetched: U, render: log({ requests }), robotsFor });
  assert.deepEqual(d.renderBlocked, [S + "/api/menu.json", S + "/assets/private/app.css", "https://cdn.example.com/js/app.js"]);
  const issue = pageIssues(page(d), {}).find(([id]) => id === "render_resource_blocked");
  assert.match(issue[1], /^3 file\(s\) disallowed for Googlebot, e\.g\. https:\/\/example\.com\/api\/menu\.json/);
  assert.deepEqual(await renderFindings({ fetched: U, render: log({ requests: [{ url: S + "/assets/site.js", type: "script", status: 200 }] }), robotsFor }), {});
});

test("registrable domain: subdomains and country second-level domains", () => {
  assert.equal(siteOf("cdn.example.com"), "example.com");
  assert.equal(siteOf("www.example.com.au"), "example.com.au");
  assert.equal(siteOf("static.shop.example.co.uk"), "example.co.uk");
});

test("script errors: a notice; a warning when the site's own script failed and the rendered text is mostly gone", async () => {
  const own = { message: "TypeError: x is undefined", stack: `TypeError: x is undefined\n    at init (${S}/assets/app.js:1:20)` };
  const third = { message: "ReferenceError: fbq is not defined", stack: "ReferenceError\n    at https://tags.example.org/pixel.js:3:1" };
  const plain = await renderFindings({ fetched: U, render: log({ errors: [third] }), words: { raw: 400, rendered: 20 } });
  assert.equal(plain.renderErrors[0].firstParty, false);
  assert.equal(plain.renderErrorContent, undefined, "a third-party error alone is a notice");
  const issues = pageIssues(page(plain), {});
  assert.match(issues.find(([id]) => id === "render_js_error")[1], /fbq is not defined" in a script from tags\.example\.org \(third-party\)/);
  const lost = await renderFindings({ fetched: U, render: log({ errors: [own] }), words: { raw: 400, rendered: 20 } });
  assert.equal(lost.renderErrorContent, "400 words in raw HTML, 20 rendered");
  assert.deepEqual(ids(pageIssues(page(lost), {})).filter((x) => x.startsWith("render_js")), ["render_js_error_content"]);
  const shell = await renderFindings({ fetched: U, render: log({ errors: [{ message: "boom", stack: "" }] }), words: { raw: 3, rendered: 3 } });
  assert.ok(shell.renderErrorContent, "an app shell that never started (inline script error)");
  const fine = await renderFindings({ fetched: U, render: log({ errors: [own] }), words: { raw: 400, rendered: 380 } });
  assert.equal(fine.renderErrorContent, undefined);
});

// ---- Row 14: broken_internal_resource (collection; statuses are checked by the crawler) ----
test("parseHtml collects scripts, stylesheets, preloads, modulepreloads and inline @font-face files", () => {
  const html = `<html><head><script src="/js/app.js"></script><link rel="stylesheet" href="css/site.css"><link rel="preload" href="/fonts/a.woff2" as="font">
    <link rel="modulepreload" href="/js/mod.js"><link rel="icon" href="/favicon.ico"><link rel="canonical" href="${U}">
    <style>@font-face{font-family:X;src:url('/fonts/b.woff2') format('woff2'),url(/fonts/b.ttf)} .x{background:url(/img/bg.png)}</style></head>
    <body><script src="https://cdn.example.net/lib.js"></script></body></html>`;
  assert.deepEqual(parseHtml(html, U).res.sort(), ["https://cdn.example.net/lib.js", S + "/css/site.css", S + "/fonts/a.woff2", S + "/fonts/b.ttf", S + "/fonts/b.woff2", S + "/js/app.js", S + "/js/mod.js"],
    "icons, canonicals and CSS background images are not render files; the crawler keeps only same-site ones");
});

test("same-site scripts, styles and fonts that failed while rendering are passed on to the broken-file check", async () => {
  const requests = [{ url: S + "/js/chunk-1.js", type: "script", status: 404 }, { url: S + "/fonts/x.woff2", type: "font", status: 410 },
    { url: S + "/api/user", type: "fetch", status: 404 }, { url: "https://cdn.example.net/lib.js", type: "script", status: 404 }];
  assert.deepEqual((await renderFindings({ fetched: U, render: log({ requests }), robotsFor })).renderFailed, [S + "/js/chunk-1.js", S + "/fonts/x.woff2"]);
});

// ---- Row 27: js_redirect ----
test("JavaScript redirect: a later document request to another path; query or #hash changes and meta refresh don't count; a loop is named", async () => {
  const to = await renderFindings({ fetched: U, render: log({ docs: [U, S + "/new.html"] }) });
  assert.deepEqual(to.jsRedirect, { to: S + "/new.html" });
  assert.match(pageIssues(page(to), {}).find(([id]) => id === "js_redirect")[1], /^to https:\/\/example\.com\/new\.html$/);
  assert.deepEqual(await renderFindings({ fetched: U, render: log({ docs: [U, U + "?consent=1", U + "#top"] }) }), {});
  assert.deepEqual(await renderFindings({ fetched: U, render: log({ docs: [U, S + "/new.html"] }), metaRefresh: true }), {}, "meta_refresh covers it");
  const loop = await renderFindings({ fetched: U, render: log({ docs: [U, S + "/b.html", U, S + "/b.html"] }) });
  assert.equal(loop.jsRedirect.loop, true);
  assert.match(pageIssues(page(loop), {}).find(([id]) => id === "js_redirect")[1], /JavaScript redirect loop: https:\/\/example\.com\/page\.html → https:\/\/example\.com\/b\.html → https:\/\/example\.com\/page\.html/);
});
