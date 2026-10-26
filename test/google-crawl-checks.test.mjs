// Google crawl checks (REQ-046, 2026-10-26): head closed early, 2 MB HTML cut-off, robots.txt changes between audits,
// home page favicon, possible back-button hijacking, raw HTML vs rendered DOM. Network calls are faked.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { headClosedEarly, robotsDiff, imageSize, faviconIssues, historyTraps, scriptTrapIssues } = await import("../src/crawlability.mjs");
const { parseHtml, rawRenderedDiff, robotsChangeIssues, saveRobots } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const { run } = await import("../src/db.mjs");

const S = "https://example.com";
const CANON = `<link rel="canonical" href="${S}/page.html">`;
const HREFLANG = `<link rel="alternate" hreflang="en-au" href="${S}/page.html"><link rel="alternate" hreflang="x-default" href="${S}/page.html">`;
const ROBOTS = '<meta name="robots" content="index,follow">';
const page = (data, over = {}) => ({ url: S + "/page.html", final_url: S + "/page.html", status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 300, text_ratio: 20, depth: 0, outlinks: 1, canonical: S + "/page.html", data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });
const ids = (issues) => issues.map((i) => i[0]);

test("every new check is in the catalogue; the crawl ones show under Crawlability", () => {
  for (const id of ["head_closed_early", "robots_txt_changed", "robots_disallow_added", "favicon_issue", "back_button_hijack", "raw_vs_rendered", "large_html"])
    assert.ok(CHECKS[id] && CHECKS[id].length === 4, id);
  for (const id of ["head_closed_early", "robots_txt_changed", "robots_disallow_added", "raw_vs_rendered"]) assert.ok(CRAWL.has(id), id);
  assert.equal(CHECKS.head_closed_early[0], "warning");
  assert.equal(CHECKS.robots_txt_changed[0], "notice");
  assert.equal(CHECKS.robots_disallow_added[0], "warning");
  assert.equal(CHECKS.favicon_issue[0], "notice");
  assert.equal(CHECKS.back_button_hijack[0], "warning");
});

// ---- 1. head_closed_early ----
test("a <div> before the canonical and hreflang in the raw source closes the head", () => {
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"><title>T</title>\n<div id="promo">Sale</div>\n${CANON}\n${HREFLANG}\n${ROBOTS}\n</head><body><p>x</p></body></html>`;
  const h = headClosedEarly(html);
  assert.equal(h.element, "<div>");
  assert.equal(h.line, 5);
  assert.deepEqual(h.tags, ["canonical", "2 hreflang link(s)"]);
  assert.equal(h.robots, true);
  const det = pageIssues(page({ headClosedEarly: h }), {}).find(([id]) => id === "head_closed_early")[1];
  assert.match(det, /<div> on line 5 closes the head; after it: canonical, 2 hreflang link\(s\), robots meta \(Google still honours that one\)/);
});

test("img, iframe, span, a, section and stray text break the head; allowed elements, comments and script contents don't", () => {
  for (const bad of ['<img src="/p.gif">', '<iframe src="/x"></iframe>', "<span>x</span>", '<a href="/">x</a>', "<section></section>", "hello"])
    assert.ok(headClosedEarly(`<html><head><title>T</title>${bad}${CANON}</head><body></body></html>`), bad);
  const clean = `<html><head><meta charset="utf-8"><!-- <div>not real</div> --><title>A <div> in a title</title>
    <script>document.write("<div>in a script</div>"); if (a < b) {}</script><style>div > p { color: red }</style>
    <noscript><img src="/pixel.gif"></noscript><template><div>t</div></template><base href="/"><link rel="stylesheet" href="/s.css">${CANON}${HREFLANG}${ROBOTS}</head><body><div>x</div></body></html>`;
  assert.equal(headClosedEarly(clean), null);
});

test("a break after the canonical, or before only a robots meta, is not reported (Google honours robots meta in the body)", () => {
  assert.equal(headClosedEarly(`<html><head>${CANON}${HREFLANG}<div>x</div></head><body></body></html>`), null);
  assert.equal(headClosedEarly(`<html><head><div>x</div>${ROBOTS}</head><body></body></html>`), null);
  assert.equal(headClosedEarly(`<html><head><title>T</title></head><body><div>x</div>${CANON}</body></html>`), null, "a canonical in a real body is another problem");
});

test("no <head> tag: the implied head still breaks; parseHtml's repaired DOM would hide it, so the raw string is scanned", () => {
  const html = `<!doctype html><html><meta charset="utf-8"><svg></svg>${CANON}<p>x</p></html>`;
  assert.equal(headClosedEarly(html).element, "<svg>");
  assert.ok(parseHtml(html, S + "/page.html").canonical, "cheerio still finds the canonical, which is why the source is scanned separately");
});

// ---- 2. large_html: Google's 2 MB cut-off ----
test("HTML over 2 MB is flagged with Google's cut-off; 2 MB exactly is not", () => {
  const over = pageIssues(page({}, { bytes: 2 * 1024 * 1024 + 1 }), {}).find(([id]) => id === "large_html");
  assert.match(over[1], /2049 KB uncompressed; Googlebot reads only the first 2,048 KB/);
  assert.ok(!ids(pageIssues(page({}, { bytes: 2 * 1024 * 1024 }), {})).includes("large_html"));
  assert.match(CHECKS.large_html[2], /first 2 MB of an HTML file \(64 MB for a PDF\)/);
  assert.ok(!CHECKS.html_over_2mb, "no duplicate check for the same limit");
});

// ---- 3. robots.txt changes ----
const OLD = "User-agent: *\nDisallow: /admin/\n# old comment\nSitemap: https://example.com/sitemap.xml\n";
test("comment and whitespace edits are not a change; a new Disallow that blocks indexable pages is a warning", () => {
  assert.deepEqual(robotsDiff(OLD, "user-agent: *\r\n  Disallow: /admin/   # new comment\n\nSitemap: https://example.com/sitemap.xml", [], S, 1), []);
  const now = OLD + "Disallow: /blog/\n";
  const r = robotsDiff(OLD, now, [S + "/blog/post.html", S + "/about.html"], S, 7);
  assert.deepEqual(ids(r), ["robots_txt_changed", "robots_disallow_added"]);
  assert.match(r[0][2], /1 line\(s\) added, 0 removed since audit #7: \+ Disallow: \/blog\//);
  assert.match(r[1][2], /1 page\(s\) indexable in audit #7 now blocked for Googlebot, e.g. https:\/\/example.com\/blog\/post.html; new rule\(s\): Disallow: \/blog\//);
  assert.equal(r[1][1], S + "/robots.txt");
});

test("a Disallow that blocks nothing indexed is only a notice; a blanket Disallow: / for Googlebot or * is a warning", () => {
  assert.deepEqual(ids(robotsDiff(OLD, OLD + "Disallow: /tmp/\n", [S + "/about.html"], S, 1)), ["robots_txt_changed"]);
  const g = robotsDiff(OLD, OLD + "\nUser-agent: Googlebot\nDisallow: /\n", [], S, 1);
  assert.match(g.find(([id]) => id === "robots_disallow_added")[2], /Disallow: \/ now blocks Googlebot from the whole site/);
  const all = robotsDiff("", "User-agent: *\nDisallow: /\n", [S + "/"], S, 1);
  assert.match(all.find(([id]) => id === "robots_disallow_added")[2], /blocks Googlebot and \* from the whole site; 1 page/);
  assert.deepEqual(ids(robotsDiff("User-agent: *\nDisallow: /\n", "User-agent: *\nAllow: /\n", [], S, 1)), ["robots_txt_changed"], "unblocking is a change, not a new block");
});

test("two synthetic audits: the second audit's robots.txt is compared with the first finished one", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (900, 'Example', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status) VALUES (901, 900, 'done'), (902, 900, 'running')");
  run(`INSERT INTO pages (audit_id, url, final_url, status, indexable) VALUES (901, ?, ?, 200, 1), (901, ?, ?, 200, 1), (901, ?, ?, 200, 0)`,
    S + "/", S + "/", S + "/shop/item.html", S + "/shop/item.html", S + "/shop/hidden.html", S + "/shop/hidden.html");
  saveRobots(901, 200, OLD);
  saveRobots(902, 200, OLD + "Disallow: /shop/\n");
  const r = robotsChangeIssues(900, 902, 200, OLD + "Disallow: /shop/\n", S);
  assert.deepEqual(ids(r), ["robots_txt_changed", "robots_disallow_added"]);
  assert.match(r[1][2], /^1 page\(s\) indexable in audit #901 now blocked for Googlebot, e\.g\. https:\/\/example\.com\/shop\/item\.html;/, "the noindex page isn't counted");
  assert.deepEqual(robotsChangeIssues(900, 902, 200, OLD, S), [], "unchanged file: nothing");
  assert.deepEqual(robotsChangeIssues(900, 902, 503, "", S), [], "a robots.txt error this time is robots_txt_error's job");
  assert.deepEqual(robotsChangeIssues(900, 901, 200, OLD, S), [], "the first audit has nothing to compare with");
  run("UPDATE audits SET status='failed' WHERE id=901");
  assert.deepEqual(robotsChangeIssues(900, 902, 200, OLD + "Disallow: /shop/\n", S), [], "only finished audits are a baseline");
});

// ---- 4. favicon ----
const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const ico = (...sizes) => { const b = Buffer.alloc(6 + 16 * sizes.length); b.writeUInt16LE(0, 0); b.writeUInt16LE(1, 2); b.writeUInt16LE(sizes.length, 4); sizes.forEach((s, k) => { b[6 + 16 * k] = s % 256; b[7 + 16 * k] = s % 256; }); return b; };
const files = (map) => async (u) => (map[u] ? { status: 200, bytes: map[u] } : { status: 404, bytes: Buffer.alloc(0) });

test("image sizes are read from PNG, ICO, GIF, JPEG and SVG headers", () => {
  assert.deepEqual(imageSize(png(96, 96)), { format: "PNG", width: 96, height: 96 });
  assert.deepEqual(imageSize(ico(16, 32, 48)), { format: "ICO", width: 48, height: 48 });
  assert.deepEqual(imageSize(ico(0)), { format: "ICO", width: 256, height: 256 }, "0 means 256 in an ICO entry");
  const gif = Buffer.from("GIF89a\x20\x00\x10\x00\x00\x00", "latin1");
  assert.deepEqual(imageSize(gif), { format: "GIF", width: 32, height: 16 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x60, 0x03]);
  assert.deepEqual(imageSize(jpg), { format: "JPEG", width: 96, height: 64 });
  assert.deepEqual(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>')), { format: "SVG", width: 64, height: 64, vector: true });
  assert.equal(imageSize(Buffer.from("<html>not an image</html>")), null);
});

test("favicon: missing link, 404, blocked for Googlebot-Image, not square and too small are reported; a good one is clean", async () => {
  const home = (head) => `<html><head>${head}</head><body></body></html>`;
  const icon = '<link rel="icon" href="/favicon.png">';
  assert.match((await faviconIssues({ start: S + "/", html: home(""), getBytes: files({}) }))[0][2], /no <link rel="icon">/);
  assert.match((await faviconIssues({ start: S + "/", html: home(icon), getBytes: files({}) }))[0][2], /favicon\.png: HTTP 404/);
  const ok = files({ [S + "/favicon.png"]: png(96, 96) });
  assert.deepEqual(await faviconIssues({ start: S + "/", html: home(icon), getBytes: ok }), []);
  assert.deepEqual(await faviconIssues({ start: S + "/", html: home('<link rel="shortcut icon" href="/favicon.png">'), getBytes: ok }), []);
  assert.deepEqual(await faviconIssues({ start: S + "/", html: home('<link rel="apple-touch-icon" href="/favicon.png">'), getBytes: ok }), [], "apple-touch-icon is a fallback Google accepts");
  const blocked = await faviconIssues({ start: S + "/", html: home(icon), robotsTxt: "User-agent: Googlebot-Image\nDisallow: /\n", getBytes: ok });
  assert.match(blocked[0][2], /blocked for Googlebot-Image by robots\.txt/);
  const viaGooglebot = await faviconIssues({ start: S + "/", html: home(icon), robotsTxt: "User-agent: Googlebot\nDisallow: /favicon\n", getBytes: ok });
  assert.match(viaGooglebot[0][2], /blocked for Googlebot-Image/, "Googlebot-Image follows Googlebot's rules when it has no group of its own");
  assert.match((await faviconIssues({ start: S + "/", html: home(icon), getBytes: files({ [S + "/favicon.png"]: png(120, 60) }) }))[0][2], /not square \(120x60\)/);
  assert.match((await faviconIssues({ start: S + "/", html: home(icon), getBytes: files({ [S + "/favicon.png"]: png(32, 32) }) }))[0][2], /32x32, smaller than 48x48/);
  const svgOnly = await faviconIssues({ start: S + "/", html: home('<link rel="icon" href="/i.svg">'), getBytes: files({ [S + "/i.svg"]: Buffer.from('<svg viewBox="0 0 10 10"></svg>') }) });
  assert.match(svgOnly[0][2], /SVG isn't one of Google's listed favicon formats/);
  const svgPlusIco = home('<link rel="icon" href="/i.svg"><link rel="icon" href="/favicon.ico">');
  assert.deepEqual(await faviconIssues({ start: S + "/", html: svgPlusIco, getBytes: files({ [S + "/i.svg"]: Buffer.from("<svg></svg>"), [S + "/favicon.ico"]: ico(16, 48) }) }), [],
    "any declared icon that passes is enough");
});

// ---- 5. back_button_hijack ----
test("history traps: pushState in a popstate handler, forward/redirect on back, pushState loops", () => {
  assert.equal(historyTraps(`window.addEventListener("popstate", function (e) { history.pushState(null, "", location.href); });`).length, 1);
  assert.match(historyTraps(`window.onpopstate = () => { history.go(1); };`)[0], /forward again/);
  assert.match(historyTraps(`history.pushState({}, "", "#x"); addEventListener('popstate', (e) => { location.href = "https://ads.example.com/"; });`)[0], /redirects when the visitor presses back/);
  assert.match(historyTraps(`for (let i = 0; i < 20; i++) { history.pushState({ i }, "", "?p=" + i); }`)[0], /inside a loop/);
  assert.match(historyTraps(`while (n--) history.pushState(null, "")`)[0], /inside a loop/);
});

test("ordinary router code is not flagged", () => {
  const router = `function go(u) { history.pushState({}, "", u); render(u); }
    window.addEventListener("popstate", () => { render(location.pathname); });
    window.addEventListener("popstate", onPop);
    window.addEventListener("popstate", (e) => { history.replaceState({ y: scrollY }, ""); });
    for (const a of links) a.addEventListener("click", go);`;
  assert.deepEqual(historyTraps(router), []);
  assert.deepEqual(historyTraps("console.log('nothing here')"), []);
});

test("inline scripts are checked per page (not JSON-LD); same-site script files on the home page are checked once", async () => {
  const trap = `<script>addEventListener("popstate", function () { history.pushState(null, "", location.href); });</script>`;
  const p = parseHtml(`<html><head><script type="application/ld+json">{"a":"history.pushState popstate"}</script></head><body><script>var a=1;</script>${trap}</body></html>`, S + "/page.html");
  assert.match(p.data.backButton, /^inline script #3: popstate handler calls history\.pushState/);
  assert.match(pageIssues(page({ backButton: p.data.backButton }), {}).find(([id]) => id === "back_button_hijack")[1], /^possible, in inline script #3/);
  assert.equal(parseHtml(`<html><body><script>history.pushState({}, "", "/a")</script></body></html>`, S + "/").data.backButton, undefined);
  const html = `<script src="/js/app.js"></script><script src="https://cdn.example.net/lib.js"></script><!-- <script src="/js/old.js"></script> -->`;
  const fetched = [];
  const get = async (u) => { fetched.push(u); return { status: 200, bytes: Buffer.from(u.endsWith("app.js") ? "for(var i=0;i<9;i++){history.pushState(null,'')}" : "") }; };
  const r = await scriptTrapIssues({ start: S + "/", html, get, getBytes: get });
  assert.deepEqual(fetched, [S + "/js/app.js"], "only same-site files, not commented-out ones");
  assert.deepEqual(r, [["back_button_hijack", S + "/", `possible, in script ${S}/js/app.js: history.pushState inside a loop (fills the history with entries)`]]);
});

// ---- 6. raw_vs_rendered ----
const doc = (head, body = "<main><h1>T</h1><p>short</p></main>") => `<html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const both = (rawHtml, renHtml) => rawRenderedDiff(parseHtml(rawHtml, S + "/page.html"), parseHtml(renHtml, S + "/page.html"));
test("raw vs rendered: noindex removed or added by JS, canonical changed or removed, text only after rendering", () => {
  assert.match(both(doc('<meta name="robots" content="noindex">' + CANON), doc(CANON)), /^noindex in the raw HTML is removed by JavaScript/);
  assert.match(both(doc(CANON), doc('<meta name="robots" content="noindex">' + CANON)), /JavaScript adds noindex/);
  assert.match(both(doc('<meta name="robots" content="index,follow">'), doc('<meta name="robots" content="index,nofollow">')), /robots meta "index,follow" in raw HTML, "index,nofollow" after rendering/);
  assert.match(both(doc(CANON), doc(`<link rel="canonical" href="${S}/other.html">`)), /canonical https:\/\/example\.com\/page\.html in raw HTML, https:\/\/example\.com\/other\.html after rendering/);
  assert.match(both(doc(CANON), doc("")), /canonical https:\/\/example\.com\/page\.html removed by JavaScript/);
  const words = Array(300).fill("word").join(" ");
  assert.match(both(doc(CANON, '<div id="app"></div>'), doc(CANON, `<main><p>${words}</p></main>`)), /main text only after rendering: 0 words in raw HTML, 300 rendered/);
});

test("raw vs rendered: identical pages and a canonical set only by JavaScript are fine", () => {
  assert.equal(both(doc(CANON + ROBOTS), doc(CANON + ROBOTS)), "");
  assert.equal(both(doc(""), doc(CANON)), "", "Google allows a canonical injected by JavaScript when the HTML has none");
  assert.match(pageIssues(page({ rawVsRendered: "JavaScript adds noindex that isn't in the raw HTML" }), {}).find(([id]) => id === "raw_vs_rendered")[1], /adds noindex/);
  assert.ok(!ids(pageIssues(page({}), {})).includes("raw_vs_rendered"), "nothing without rendering data");
});
