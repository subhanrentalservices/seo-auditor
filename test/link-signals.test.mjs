// Link signals (REQ-044 build rows 5, 9, 28-33; 2026-10-27): links Google can't follow, links and sitemap entries
// pointing at canonicalised URLs, tracking parameters on internal links, URL forms of one page answering 200, generic
// and empty anchors, affiliate and user-generated links without rel qualifiers, and crawl-trap links. Pure functions;
// no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { trackingParams, affiliateOf, crawlTrap, linkSiteIssues, urlVariantIssues, anchorFindings, isGenericAnchor } = await import("../src/link-signals.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const robotsParser = (await import("robots-parser")).default;

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);
const inScope = (u) => u.startsWith(S);
const page = (url, over = {}, data = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 400, text_ratio: 20, depth: 1, outlinks: 1, inlinks: 2, canonical: S + url, data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });
const link = (from, to, over = {}) => ({ from_url: S + from, to_url: to.startsWith("http") ? to : S + to, internal: to.startsWith("http") && !to.startsWith(S) ? 0 : 1, nofollow: 0, rel: null, ...over });
const site = (rows, opts = {}) => linkSiteIssues(rows, { pages: [], inScope, auditDate: "2026-10-27", ...opts });

test("the link checks are catalogued with the right severity; crawl ones show under Crawlability", () => {
  const sev = { links_to_canonicalized: "notice", sitemap_non_canonical: "warning", internal_link_tracking_params: "notice", url_variant_200: "notice", generic_anchor_text: "notice",
    empty_anchor: "notice", affiliate_link_unqualified: "warning", ugc_link_unqualified: "notice", crawl_trap_links: "warning" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); }
  for (const id of ["sitemap_non_canonical", "internal_link_tracking_params", "url_variant_200", "crawl_trap_links"]) assert.ok(CRAWL.has(id), id);
});

// ---- Row 5: uncrawlable_links ----
const body = (html) => parseHtml(`<html><body>${html}</body></html>`, S + "/").data;
test("uncrawlable links: <a> without href, #! and #/ routes, _escaped_fragment_, role=link, routerlink, data-href and <router-link to>", () => {
  const d = body(`<a>Services</a><a href="#!/about">About</a><a href="#/team">Team</a><a href="/x?_escaped_fragment_=a">X</a>
    <span role="link">Prices</span><div routerlink="/blog">Blog</div><li data-href="/tyres.html">Tyres</li><router-link to="/contact">Contact</router-link>
    <a href="#" onclick="window.location.href='/quote.html'">Quote</a><button onclick="router.push('/book')">Book</button>`);
  assert.equal(d.jsLinks, 10);
  assert.equal(d.jsLinkExample, '<a> without href: "Services"');
  const issue = pageIssues(page("/", {}, d), { siteIsHttps: true }).find(([id]) => id === "uncrawlable_links");
  assert.match(issue[1], /^10 link\(s\)/);
});

test("uncrawlable links: named anchors, #section jump links and toggles are fine", () => {
  const d = body(`<a name="top"></a><a id="faq"></a><a href="#main">Skip to content</a><a href="#section-2">Section 2</a>
    <a aria-expanded="false" aria-controls="menu">Menu</a><a role="button">Open</a><a href="#" aria-controls="x">Toggle</a>
    <span role="link" aria-expanded="false">More</span><a href="/real.html">Real</a><div data-x="1" to="/nowhere">Not a router link</div>`);
  assert.equal(d.jsLinks, undefined);
});

// ---- Row 9: links_to_canonicalized + sitemap_non_canonical ----
test("links to a URL whose canonical points elsewhere: a notice on the linking page; form pre-fill variants and self-canonicals are fine", () => {
  const pages = [page("/old.html", { canonical: S + "/new.html", indexable: 0 }), page("/new.html"), page("/book.html?service=a", { canonical: S + "/book.html", indexable: 0 }, { variantOf: S + "/book.html" })];
  const out = site([link("/a.html", "/old.html"), link("/a.html", "/new.html"), link("/a.html", "/book.html?service=a"), link("/old.html", "/old.html")], { pages });
  assert.deepEqual(out, [["links_to_canonicalized", S + "/a.html", `1 link(s), e.g. ${S}/old.html (canonical ${S}/new.html)`]]);
});

test("sitemap URLs that canonicalise elsewhere are sitemap_non_canonical, not 'noindex in sitemap'; a real noindex still is", () => {
  const ctx = { siteIsHttps: true, sitemapLoaded: true };
  const canon = pageIssues(page("/old.html", { canonical: S + "/new.html", indexable: 0, in_sitemap: 1 }), ctx);
  assert.deepEqual(canon.filter(([id]) => /sitemap/.test(id)), [["sitemap_non_canonical", `canonical is ${S}/new.html`]]);
  const q = pageIssues(page("/book.html?service=a", { canonical: S + "/book.html", indexable: 0, in_sitemap: 1 }, { variantOf: S + "/book.html" }), ctx);
  assert.deepEqual(q, [["sitemap_non_canonical", `?query URL in the sitemap; its canonical is the clean URL ${S}/book.html`]]);
  const noindex = pageIssues(page("/x.html", { indexable: 0, in_sitemap: 1 }, { noindex: true }), ctx);
  assert.ok(ids(noindex).includes("noindex_in_sitemap") && !ids(noindex).includes("sitemap_non_canonical"));
  assert.ok(!ids(pageIssues(page("/ok.html", { in_sitemap: 1 }), ctx)).some((id) => /sitemap/.test(id)));
});

// ---- Row 28: internal_link_tracking_params ----
test("tracking parameters on internal links are flagged per linking page; filters are not", () => {
  assert.deepEqual(trackingParams(S + "/a?utm_source=x&utm_medium=y&color=red"), ["utm_source", "utm_medium"]);
  assert.deepEqual(trackingParams(S + "/a?gclid=1&fbclid=2&msclkid=3&_ga=4&srsltid=5&mc_cid=6&_hsenc=7"), ["gclid", "fbclid", "msclkid", "_ga", "srsltid", "mc_cid", "_hsenc"]);
  assert.deepEqual(trackingParams(S + "/shop?color=red&size=9&page=2"), []);
  const out = site([link("/a.html", "/b.html?utm_source=footer"), link("/a.html", "/c.html?color=red"), link("/a.html", "https://other.example.net/?utm_source=x")]);
  assert.deepEqual(out, [["internal_link_tracking_params", S + "/a.html", `1 link(s), e.g. ${S}/b.html?utm_source=footer (utm_source)`]]);
});

// ---- Row 29: url_variant_200 ----
test("URL forms of one page that both answer 200 with the same text: the linked variant without a canonical to the main form", () => {
  const same = { textHash: "h1" };
  const pages = [page("/services/", { inlinks: 9 }, same), page("/services/index.html", { canonical: null, inlinks: 2 }, same), page("/Services/", { canonical: S + "/services/", inlinks: 1 }, same),
    page("/About.html", { inlinks: 1 }, { textHash: "h2" }), page("/about.html", { inlinks: 4 }, { textHash: "h3" })];
  assert.deepEqual(urlVariantIssues(pages), [["url_variant_200", S + "/services/index.html",
    `same page as ${S}/services/: this form also answers 200 with the same text and no canonical; 2 internal page(s) link here`]]);
  const redirected = [page("/a/", {}, same), page("/a/index.html", { inlinks: 3 }, { ...same, redirect: { to: S + "/a/" } })];
  assert.deepEqual(urlVariantIssues(redirected), [], "a variant that redirects is set up right");
  assert.deepEqual(urlVariantIssues([page("/b/", {}, same), page("/b", { canonical: null, inlinks: 0 }, same)]), [], "no internal link to the variant");
});

// ---- Row 30: generic_anchor_text + empty_anchor ----
test("anchor text: image alt counts as anchor text; aria-label and title are kept as the label", () => {
  const p = parseHtml(`<html><body><main><a href="/a.html"><img src="/a.png" alt="Brake prices"></a><a href="/b.html" aria-label="Read more about brakes">Read more</a>
    <a href="/c.html"><img src="/c.png" alt=""></a></main></body></html>`, S + "/");
  assert.deepEqual(p.links.map((l) => [l.anchor, l.label]), [["Brake prices", undefined], ["Read more", "Read more about brakes"], ["", undefined]]);
});

test("generic and empty anchors in content links are grouped per page; menus, other hosts and descriptive labels are not counted", () => {
  for (const g of ["Read more »", "click here", "Learn more →", "MEHR", "en savoir plus", "aquí", "klik hier"]) assert.ok(isGenericAnchor(g), g);
  assert.ok(!isGenericAnchor("Read more about brake repairs"));
  const html = `<html><body><nav><a href="/x.html">Read more</a></nav><main>${'<a href="/post.html">Read more</a>'.repeat(3)}<a href="/d.html">click here</a>
    <a href="/e.html" aria-label="Brake repair prices">Learn more</a><a href="https://other.example.net/">here</a><a href="/f.html"><img src="/f.png"></a></main></body></html>`;
  const p = parseHtml(html, S + "/");
  const d = anchorFindings(p.links, inScope);
  assert.deepEqual(d, { genericAnchors: 4, genericAnchorDetail: `"read more" ×3, "click here", e.g. → ${S}/post.html`, emptyAnchors: 1, emptyAnchorExample: S + "/f.html" });
  const issues = pageIssues(page("/", {}, d), {});
  assert.match(issues.find(([id]) => id === "generic_anchor_text")[1], /^4 link\(s\): "read more" ×3/);
  assert.match(issues.find(([id]) => id === "empty_anchor")[1], /^1 link\(s\), e\.g\. → https:\/\/example\.com\/f\.html/);
});

// ---- Row 31: affiliate_link_unqualified ----
test("affiliate links need rel=sponsored or nofollow; cloaked /go/ links that redirect off the site count too", () => {
  assert.equal(affiliateOf("https://www.amazon.com.au/dp/B0X?tag=site-22"), "Amazon Associates");
  assert.equal(affiliateOf("https://www.amazon.com/dp/B0X"), null, "an Amazon link without a tag is not an affiliate link");
  for (const [u, n] of [["https://amzn.to/abc", "Amazon short link"], ["https://www.awin1.com/cread.php?a=1", "Awin"], ["https://www.anrdoezrs.net/click-1", "CJ Affiliate"],
    ["https://x.hop.clickbank.net/", "ClickBank"], ["https://go.skimresources.com/?id=1", "Skimlinks"], ["https://brand.sjv.io/c/1", "Impact"], ["https://prf.hn/click/x", "Partnerize"]]) assert.equal(affiliateOf(u), n, u);
  const rows = [link("/r.html", "https://amzn.to/abc"), link("/r.html", "https://www.awin1.com/cread.php?a=1", { rel: "sponsored noopener" }),
    link("/r.html", "https://prf.hn/click/x", { nofollow: 1, rel: "nofollow" }), link("/r.html", "/go/widget/"), link("/r.html", "/go/local/")];
  const redirOf = new Map([[S + "/go/widget/", "https://shop.example.net/widget?ref=9"], [S + "/go/local/", S + "/widget.html"]]);
  const out = site(rows, { redirOf });
  assert.deepEqual(out, [["affiliate_link_unqualified", S + "/r.html", `2 link(s), e.g. Amazon short link: https://amzn.to/abc; ${S}/go/widget/ redirects to shop.example.net`]]);
});

// ---- Row 32: ugc_link_unqualified ----
test("links in comments and reviews without rel=ugc or nofollow; the site's own links and qualified ones are fine", () => {
  const d = body(`<article><p><a href="https://partner.example.net/">editorial</a></p></article><div id="comments"><div class="comment"><div class="comment-content">
    <a href="https://spam.example.org/">cheap</a><a href="https://ok.example.org/" rel="ugc">ok</a><a href="https://nf.example.org/" rel="nofollow">nf</a><a href="/faq.html">faq</a>
    <a href="https://blog.example.com/post">our blog</a></div></div></div><div class="review-body"><a href="https://r.example.org/">site</a></div>`);
  assert.equal(d.ugcUnqualified, 2);
  assert.equal(d.ugcExample, "https://spam.example.org/");
  assert.match(pageIssues(page("/", {}, d), {}).find(([id]) => id === "ugc_link_unqualified")[1], /^2 link\(s\), e\.g\. https:\/\/spam\.example\.org\//);
  assert.equal(body('<div id="comments"><a href="https://x.example.org/" rel="ugc nofollow">x</a></div>').ugcUnqualified, undefined);
});

// ---- Row 33: crawl_trap_links ----
test("crawl traps: cart and session parameters, %25, stacked filters, far-off calendar pages; each with a robots.txt suggestion", () => {
  const t = (u) => crawlTrap(S + u, "2026-10-27");
  assert.match(t("/shop/?add-to-cart=12").reason, /add-to-cart/);
  assert.match(t("/shop/?add-to-cart=12").robots, /Disallow: \/\*\?add-to-cart= and Disallow: \/\*&add-to-cart=/);
  assert.match(t("/post/?replytocom=5").reason, /replytocom/);
  assert.match(t("/a;jsessionid=ABC").reason, /session ID/);
  assert.match(t("/search/caf%2525e9").reason, /%25/);
  assert.match(t("/shoes?color=red&size=9&sort=price").reason, /3 filter\/sort parameters/);
  assert.match(t("/events/2031/05/").reason, /calendar page for 2031/);
  assert.match(t("/events/?month=2020-01").reason, /calendar \?month=2020-01/);
  for (const ok of ["/events/2027/05/", "/blog/2019/05/post.html", "/shoes?color=red&page=2", "/book.html?service=brakes", "/search?q=brakes&page=3", "/shop/"]) assert.equal(t(ok), null, ok);
});

test("crawl-trap links are counted per path; nofollow and robots.txt-blocked links are left out", () => {
  const robots = robotsParser(S + "/robots.txt", "User-agent: *\nDisallow: /*?*add-to-wishlist=\n");
  const rows = [link("/a.html", "/shop/?add-to-cart=1"), link("/b.html", "/shop/?add-to-cart=2"), link("/a.html", "/shop/?add-to-cart=1"),
    link("/a.html", "/shop/?add-to-cart=3", { nofollow: 1 }), link("/a.html", "/shop/?add-to-wishlist=4")];
  const out = site(rows, { robots });
  assert.equal(out.length, 1);
  assert.equal(out[0][0], "crawl_trap_links");
  assert.equal(out[0][1], S + "/shop/");
  assert.match(out[0][2], /^2 linked URL\(s\), e\.g\. https:\/\/example\.com\/shop\/\?add-to-cart=1: \?add-to-cart= \(cart, session or reply action\); suggested robots\.txt: Disallow/);
});
