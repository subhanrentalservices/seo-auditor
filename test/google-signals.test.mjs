// Index signals as Google reads them (REQ-044, 2026-10-27): robots directives scoped per crawler (none, bingbot:,
// max-snippet, unavailable_after), canonical conflicts (raw href with #, placeholders, Link header, noindex target,
// chains, home-page canonicals), soft-404 content and redirects to the home page, and noindex hidden behind
// robots.txt. Network calls are faked. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { splitDirectives, robotsDirectives, applyHeaderRobots, canonicalHrefProblem, linkHeaderCanonical, canonicalSiteIssues, soft404Issues, textFingerprint } = await import("../src/google-signals.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const { crawlabilitySiteIssues, robotsBlockedIssues } = await import("../src/crawlability.mjs");
const robotsParser = (await import("robots-parser")).default;

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);
const ctx = { siteIsHttps: true, auditDate: "2026-10-27" };
const page = (url, over = {}, data = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 400, text_ratio: 20, depth: 1, outlinks: 1, inlinks: 1, canonical: S + url, data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });
const doc = (head, body = "<p>text</p>") => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;

test("the new checks are catalogued with the right severity; the crawl ones show under Crawlability", () => {
  const sev = { unavailable_after_passed: "warning", unavailable_after_invalid: "notice", robots_other_bot: "notice", canonical_conflict: "warning", canonical_form: "notice",
    soft_404_content: "warning", redirect_to_home: "warning", robots_blocked_noindex: "warning", robots_blocked_linked: "notice", sitemap_fetch_error: "warning", sitemap_too_large: "error" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); }
  for (const id of ["canonical_conflict", "soft_404_content", "redirect_to_home", "robots_blocked_noindex", "sitemap_fetch_error", "sitemap_too_large"]) assert.ok(CRAWL.has(id), id);
});

// ---- Row 1: robots directives ----
test("header values keep their user-agent scopes; only googlebot: and unscoped lines bind Google", () => {
  assert.deepEqual(splitDirectives("googlebot: nofollow, otherbot: noindex, nofollow"), [["googlebot", "nofollow"], ["otherbot", "noindex"], ["otherbot", "nofollow"]]);
  const r = robotsDirectives([], "googlebot: nofollow, otherbot: noindex, nofollow");
  assert.equal(r.noindex, false, "otherbot's noindex is not Google's");
  assert.equal(r.nofollow, true);
  assert.deepEqual(r.others, ["otherbot: noindex", "otherbot: nofollow"]);
  assert.equal(robotsDirectives([], "bingbot: noindex").noindex, false);
  assert.equal(robotsDirectives([], "noindex, bingbot: nofollow").noindex, true);
});

test("none means noindex + nofollow; every robots meta tag counts; other bots' meta tags are listed only", () => {
  const none = parseHtml(doc('<meta name="robots" content="none">'), S + "/a.html").data;
  assert.equal(none.noindex, true);
  assert.equal(none.nofollowMeta, true);
  const two = parseHtml(doc('<meta name="robots" content="index, follow"><meta name="googlebot" content="noindex">'), S + "/a.html").data;
  assert.equal(two.noindex, true, "the googlebot tag adds noindex to the robots tag");
  const bing = parseHtml(doc('<meta name="robots" content="index"><meta name="bingbot" content="noindex">'), S + "/a.html").data;
  assert.equal(bing.noindex, false);
  assert.deepEqual(bing.robotsOtherBots, ["bingbot: noindex"]);
  assert.deepEqual(pageIssues(page("/a.html", {}, bing), ctx).filter((x) => x[0] === "robots_other_bot"), [["robots_other_bot", "bingbot: noindex"]]);
  assert.equal(parseHtml(doc('<meta name="description" content="noindex is a word here">'), S + "/a.html").data.noindex, false);
});

test("X-Robots-Tag: noindex, nofollow and snippet limits; bingbot-only lines don't make a page noindex", () => {
  assert.deepEqual([applyHeaderRobots({}, "noindex").noindex, applyHeaderRobots({}, "noindex").noindexSource], [true, "X-Robots-Tag"]);
  const bing = applyHeaderRobots({}, "bingbot: noindex");
  assert.equal(bing.noindex, undefined);
  assert.deepEqual(bing.robotsOtherBots, ["bingbot: noindex (X-Robots-Tag)"]);
  assert.equal(applyHeaderRobots({ noindex: true }, "").noindexSource, "meta robots");
  assert.equal(applyHeaderRobots({}, "nofollow").nofollowMeta, "X-Robots-Tag");
  assert.equal(applyHeaderRobots({}, "max-snippet: 20").snippetBlock, "max-snippet: 20 (X-Robots-Tag)");
  assert.equal(applyHeaderRobots({}, "max-snippet: -1").snippetBlock, undefined, "-1 means no limit");
  assert.equal(applyHeaderRobots({}, "max-snippet: 160").snippetBlock, undefined);
  assert.equal(parseHtml(doc('<meta name="robots" content="max-snippet:0">'), S + "/a.html").data.snippetBlock, "max-snippet:0");
});

test("unavailable_after: a passed date is a warning, a future one is fine, an unreadable one is a notice", () => {
  const passed = applyHeaderRobots({}, "unavailable_after: Wed, 25 Jun 2025 15:00:00 GMT, noindex");
  assert.equal(passed.unavailableAfter.raw, "Wed, 25 Jun 2025 15:00:00 GMT", "the date keeps its comma");
  assert.equal(passed.noindex, true, "the directive after the date still counts");
  const iss = (d) => ids(pageIssues(page("/offer.html", {}, d), ctx)).filter((x) => x.startsWith("unavailable_after"));
  assert.deepEqual(iss(passed), ["unavailable_after_passed"]);
  assert.deepEqual(iss(parseHtml(doc('<meta name="robots" content="unavailable_after: 25 Jun 2010 15:00:00 PST">'), S + "/a.html").data), ["unavailable_after_passed"]);
  assert.deepEqual(iss(applyHeaderRobots({}, "unavailable_after: 2099-01-01")), []);
  assert.deepEqual(iss(applyHeaderRobots({}, "unavailable_after: when the sale ends")), ["unavailable_after_invalid"]);
});

// ---- Row 6: canonical conflicts ----
test("raw canonical hrefs Google can't use, and relative or cross-host ones", () => {
  const u = S + "/page.html";
  for (const bad of ["", "  ", `${S}/{{ page.slug }}`, `${S}/\${slug}`, `${S}/%7B%7Bslug%7D%7D`, `${S}/blog/undefined`, `${S}/null`, `${S}/page.html#top`, "#"])
    assert.ok(canonicalHrefProblem(bad, u)?.bad, JSON.stringify(bad));
  assert.match(canonicalHrefProblem("/page.html", u).form, /relative/);
  assert.match(canonicalHrefProblem("https://news.example.org/story", u).form, /another host/);
  for (const ok of [u, `${S}/null-hypothesis.html`, `${S}/page.html?id=3`]) assert.equal(canonicalHrefProblem(ok, u), null, ok);
  const d = parseHtml(doc(`<link rel="canonical" href="${S}/page.html#main">`), u).data;
  assert.match(d.canonicalProblem, /# fragment/);
  assert.deepEqual(ids(pageIssues(page("/page.html", {}, d), ctx)).filter((x) => x.startsWith("canonical_")), ["canonical_conflict"]);
  const rel = parseHtml(doc('<link rel="canonical" href="/page.html">'), u).data;
  assert.deepEqual(ids(pageIssues(page("/page.html", {}, rel), ctx)).filter((x) => x.startsWith("canonical_")), ["canonical_form"]);
});

test("a Link header canonical that differs from the HTML one is a conflict", () => {
  assert.equal(linkHeaderCanonical(`<${S}/de/>; rel="alternate"; hreflang="de", <${S}/a.html>; rel="canonical"`, S + "/a.html"), S + "/a.html");
  assert.equal(linkHeaderCanonical('</a.html>; rel=canonical', S + "/x"), S + "/a.html");
  assert.equal(linkHeaderCanonical('<https://example.com/x.css>; rel="preload"', S), null);
  const found = pageIssues(page("/a.html", {}, { canonicalHeader: S + "/b.html" }), ctx).find((x) => x[0] === "canonical_conflict");
  assert.match(found[1], /Link header canonical https:\/\/example\.com\/b\.html, HTML canonical https:\/\/example\.com\/a\.html/);
  assert.equal(pageIssues(page("/a.html", {}, { canonicalHeader: S + "/a.html" }), ctx).some((x) => x[0] === "canonical_conflict"), false);
});

test("site canonical rules: noindex target, chain, loop and template canonicals to the home page", () => {
  const home = page("/", {}, { textHash: "home" });
  const pages = [home,
    page("/a.html", { canonical: S + "/b.html", indexable: 0 }), page("/b.html", { indexable: 0 }, { noindex: true, noindexSource: "meta robots" }),
    page("/c.html", { canonical: S + "/d.html", indexable: 0 }), page("/d.html", { canonical: S + "/e.html", indexable: 0 }), page("/e.html"),
    page("/f.html", { canonical: S + "/g.html", indexable: 0 }), page("/g.html", { canonical: S + "/f.html", indexable: 0 }),
    page("/form.html?service=x", { canonical: S + "/form.html", indexable: 0 }, { variantOf: S + "/form.html", noindex: false }), page("/form.html")];
  const found = canonicalSiteIssues(pages, S + "/");
  const on = (u) => found.filter((x) => x[1] === S + u).map((x) => x[2]);
  assert.match(on("/a.html")[0], /is noindex/);
  assert.match(on("/c.html")[0], /chain: .*d\.html canonicalises on to .*e\.html/);
  assert.match(on("/f.html")[0], /loop/);
  assert.deepEqual(on("/form.html?service=x"), [], "form pre-fill variants are skipped");
  // Home-page canonicals: flagged only when 3+ pages (10%+ of HTML pages) with their own text do it.
  const site = (n) => [home, ...Array.from({ length: n }, (_, i) => page(`/s${i}.html`, { canonical: S + "/", indexable: 0 }, { textHash: "t" + i })),
    ...Array.from({ length: 12 }, (_, i) => page(`/p${i}.html`))];
  assert.equal(canonicalSiteIssues(site(3), S + "/").length, 3);
  assert.equal(canonicalSiteIssues(site(2), S + "/").length, 0);
  const same = [home, ...Array.from({ length: 4 }, (_, i) => page(`/copy${i}.html`, { canonical: S + "/", indexable: 0 }, { textHash: "home" }))];
  assert.equal(canonicalSiteIssues(same, S + "/").length, 0, "copies of the home page may canonicalise to it");
});

// ---- Row 8: soft-404 content and redirects to the home page ----
test("error-page wording on a short 200 page, or the 404 page's text, is a soft 404; articles, products and the home page are not", () => {
  const nf = textFingerprint("sorry we couldn't find that page");
  const pages = [page("/", { title: "Not found? We repair everything" }, { textHash: "home" }),
    page("/gone.html", { title: "Page not found | Example", words: 40 }),
    page("/search.html?q=zz", { h1: "No results found", words: 25 }),
    page("/how-to-fix-404-errors.html", { title: "How to fix 404 errors", words: 1200 }),
    page("/widget.html", { title: "Widget: temporarily unavailable", words: 80 }, { schemaTypes: ["Product"] }),
    page("/copy.html", { title: "Welcome", words: 6 }, { textHash: nf }),
    page("/hidden.html", { title: "Page not found", words: 30, indexable: 0 }, { noindex: true })];
  const found = soft404Issues(pages, { start: S + "/", notFoundHash: nf }).filter((x) => x[0] === "soft_404_content").map((x) => x[1]);
  assert.deepEqual(found, [S + "/gone.html", S + "/search.html?q=zz", S + "/copy.html"]);
});

test("a deep URL that 301/302s to the home page is flagged; host, /index.html and ordinary redirects are not", () => {
  const redir = (from, to, status = 301, over = {}) => page(from, { status, final_url: to, content_type: "", indexable: 0, ...over }, { redirect: { hops: 1, to, firstStatus: status } });
  const pages = [page("/"), redir("/old-service.html", S + "/", 301, { in_sitemap: 1 }), redir("/promo/", S + "/", 302), redir("/index.html", S + "/"), redir("/old.html", S + "/new.html"),
    { ...redir("/", S + "/"), url: "http://example.com/" }];
  const found = soft404Issues(pages, { start: S + "/" }).filter((x) => x[0] === "redirect_to_home");
  assert.deepEqual(found.map((x) => x[1]), [S + "/old-service.html", S + "/promo/"]);
  assert.match(found[0][2], /301 → https:\/\/example\.com\/ \(listed in the sitemap\)/);
});

test("the 404 probe's page is kept for the soft-404 text comparison", async () => {
  const keep = {};
  const get = async (u) => (u.includes("seo-auditor-missing-page-") ? { status: 404, body: "<html><body><main>Sorry, nothing here</main></body></html>" } : { status: 301, location: S + "/" });
  await crawlabilitySiteIssues({ start: S + "/", robotsRes: { status: 404 }, robotsTxt: "", robots: robotsParser(S + "/robots.txt", ""), ua: "ua", get, keep });
  assert.equal(keep.notFound.status, 404);
  assert.match(keep.notFound.body, /nothing here/);
  assert.equal(textFingerprint(parseHtml(keep.notFound.body, keep.notFound.url).text), textFingerprint("Sorry, nothing here"));
});

// ---- Row 15: noindex hidden behind robots.txt ----
test("robots-blocked URLs the site links to are fetched once for noindex; heavily linked ones are noted", async () => {
  const blocked = (u, over) => page(u, { status: 0, content_type: "", indexable: 0, ...over }, { blockedByRobots: true });
  const pages = [blocked("/private/a.html", { inlinks: 3 }), blocked("/private/b.pdf", { inlinks: 0, in_sitemap: 1 }), blocked("/cart/", { inlinks: 40 }),
    blocked("/never-linked.html", { inlinks: 0, in_sitemap: 0 }), page("/open.html")];
  const asked = [];
  const get = async (u) => {
    asked.push(u);
    if (u.endsWith("/a.html")) return { status: 200, body: '<html><head><meta name="robots" content="noindex"></head></html>', xRobots: "" };
    if (u.endsWith(".pdf")) return { status: 200, body: "", xRobots: "googlebot: noindex" };
    return { status: 200, body: "<html><head></head></html>", xRobots: "bingbot: noindex" };
  };
  const found = await robotsBlockedIssues(pages, { ua: "ua", get });
  assert.deepEqual(found.map((x) => [x[0], x[1].replace(S, "")]), [["robots_blocked_noindex", "/private/a.html"], ["robots_blocked_noindex", "/private/b.pdf"], ["robots_blocked_linked", "/cart/"]]);
  assert.match(found[0][2], /robots meta tag/);
  assert.match(found[1][2], /X-Robots-Tag.*listed in the sitemap/);
  assert.ok(!asked.some((u) => u.includes("never-linked")) && !asked.some((u) => u.includes("open.html")), "only blocked URLs the site links to or lists are fetched");
  assert.equal((await robotsBlockedIssues(pages, { ua: "ua", get, max: 2 })).filter((x) => x[0] === "robots_blocked_noindex").length, 1, "capped, most-linked first");
});
