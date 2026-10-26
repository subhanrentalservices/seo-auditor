// hreflang clusters, keyword stuffing, hacked-spam signals, title quality and duplicate H1s (REQ-044 build rows 7, 10,
// 26, 39, 40, Oct 2026). Pure functions over parsed pages; no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { hreflangClusterIssues } = await import("../src/hreflang.mjs");
const { listVerdict, stuffedList, repeatedPhrases, keywordStuffingIssues, hackedSpamIssues } = await import("../src/spam-signals.mjs");
const { titleProblem, titleQualityIssues, dupH1Issues, brandCount } = await import("../src/title-signals.mjs");
const { signalSiteIssues } = await import("../src/page-signals.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { CHECKS } = await import("../src/checks.mjs");
const cheerio = await import("cheerio");

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);
const page = (url, over = {}, data = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title: `Page ${url}`, h1: `Heading ${url}`,
  canonical: S + url, words: 400, data: { lang: "en", ...data }, ...over });
const doc = (body, head = "") => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body>${body}</body></html>`;
const PLACES = "Northvale, Southbank, Eastwood, Westmere, Hillcrest, Lakeside, Brookfield, Riverton, Oakridge, Pinecrest, Maplewood, Fairview, Glenhaven, Ashford, Kingsley, Ridgemont";

test("the new checks are catalogued with the right severity", () => {
  const sev = { hreflang_no_return: "warning", hreflang_bad_target: "warning", hreflang_xdefault_conflict: "notice", keyword_stuffing: "warning", hacked_spam_signals: "error",
    new_external_script: "notice", lcp_image_lazy: "warning", img_src_placeholder: "notice", img_alt_generic: "notice", images_blocked_by_robots: "notice", dup_h1: "notice",
    title_quality: "notice", video_not_main: "notice", video_thumbnail_unreachable: "warning", cta_below_fold: "notice" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); }
  assert.match(CHECKS.cta_below_fold[1], /not a Google ranking issue/);
  assert.match(CHECKS.keyword_stuffing[2], /Blocks of text that list cities and regions that a web page is trying to rank for/);
  assert.match(CHECKS.keyword_stuffing[2], /heuristic/);
});

// ---- Row 7: hreflang clusters ----
test("hreflang: x-default is recorded; alternates that don't link back are reported", () => {
  const d = parseHtml(doc("<p>x</p>", `<link rel="alternate" hreflang="en" href="${S}/en/"><link rel="alternate" hreflang="de" href="${S}/de/"><link rel="alternate" hreflang="x-default" href="${S}/">`), S + "/en/").data;
  assert.equal(d.hreflangXDefault, S + "/");
  const en = page("/en/", {}, { hreflangAlts: [S + "/en/", S + "/de/"] });
  const de = page("/de/", {}, { hreflangAlts: [S + "/de/"] }); // no link back to /en/
  const out = hreflangClusterIssues([en, de]);
  assert.deepEqual(out, [["hreflang_no_return", S + "/en/", `1 alternate(s) don't link back: ${S}/de/`]]);
  de.data.hreflangAlts.push(S + "/en/");
  assert.deepEqual(hreflangClusterIssues([en, de]), [], "a complete pair is fine");
});

test("hreflang: targets that redirect, 404, are noindex or canonicalise elsewhere are bad; uncrawled ones aren't checked", () => {
  const alts = ["/en/", "/de/", "/fr/", "/it/", "/es/", "/nl/"].map((u) => S + u);
  const src = page("/en/", {}, { hreflangAlts: alts });
  const back = { hreflangAlts: alts };
  const pages = [src, page("/de/", {}, { ...back, redirect: { to: S + "/de-de/" } }), page("/fr/", { status: 404 }, back), page("/it/", { indexable: 0 }, { ...back, noindex: true }),
    page("/es/", { canonical: S + "/en/" }, back)];
  const out = hreflangClusterIssues(pages);
  const bad = out.find((x) => x[0] === "hreflang_bad_target" && x[1] === S + "/en/");
  assert.match(bad[2], /^4 target\(s\): .*\/de\/ \(redirects to .*de-de/);
  assert.match(bad[2], /1 target\(s\) not crawled, not checked/);
  assert.ok(!out.some((x) => x[0] === "hreflang_no_return" && x[1] === S + "/en/"), "only valid targets are checked for return links");
});

test("hreflang: different x-default URLs in one cluster are reported on the odd one out", () => {
  const alts = [S + "/en/", S + "/de/", S + "/fr/"];
  const pages = [page("/en/", {}, { hreflangAlts: alts, hreflangXDefault: S + "/" }), page("/de/", {}, { hreflangAlts: alts, hreflangXDefault: S + "/" }),
    page("/fr/", {}, { hreflangAlts: alts, hreflangXDefault: S + "/fr/" })];
  assert.deepEqual(hreflangClusterIssues(pages), [["hreflang_xdefault_conflict", S + "/fr/", `x-default is ${S}/fr/ here, ${S}/ on 2 other page(s) of the same cluster`]]);
});

// ---- Row 10: keyword stuffing ----
test("keyword stuffing: a block of 15+ place names or a repeated service word is flagged; shorter lists are not", () => {
  assert.match(listVerdict(`We cover ${PLACES}.`).kind, /capitalised names/);
  assert.match(listVerdict(PLACES.split(", ").map((p) => `plumber ${p}`).join(" | ")).kind, /"plumber" repeated/);
  assert.equal(listVerdict(PLACES.split(", ").slice(0, 14).join(", ")), null, "a service-area line under 15 items is never flagged");
  assert.equal(listVerdict(`${PLACES}`, 16), null, "items with their own links are distinct items");
  const lines = Array.from({ length: 16 }, (_, i) => `this is sentence number ${i} about something quite different here`).join(", ");
  assert.equal(listVerdict(lines), null, "sentences are not a keyword list");
});

test("keyword stuffing: menus, tables, address blocks and linked lists are left out; line breaks split items", () => {
  const $ = (b) => cheerio.load(doc(b));
  assert.ok(stuffedList($(`<main><p>${PLACES.replaceAll(", ", "<br>")}</p></main>`)), "<br>-separated block");
  assert.ok(stuffedList($(`<footer><p>Areas: ${PLACES}</p></footer>`)), "the footer counts");
  assert.equal(stuffedList($(`<nav><p>${PLACES}</p></nav>`)), null);
  assert.equal(stuffedList($(`<table><tr><td>${PLACES}</td></tr></table>`)), null);
  assert.equal(stuffedList($(`<address>${PLACES}</address>`)), null);
  const li = PLACES.split(", ").map((p) => `<li><a href="/${p}">${p}</a></li>`).join("");
  assert.equal(stuffedList($(`<main><ul>${li}</ul></main>`)), null, "a list of distinct linked items");
  assert.ok(stuffedList($(`<main><ul>${PLACES.split(", ").map((p) => `<li>${p}</li>`).join("")}</ul></main>`)), "a bare list of 16 places");
});

test("keyword stuffing: a phrase repeated 10+ times and 4%+ of the words is flagged; brand names and normal text are not", () => {
  const filler = Array.from({ length: 300 }, (_, i) => `word${i % 50}x`).join(" ");
  const stuffed = filler + " cheap blue widgets".repeat(12);
  const hits = repeatedPhrases(stuffed);
  assert.equal(hits[0].phrase, "cheap blue widgets");
  assert.equal(hits[0].n, 12);
  assert.deepEqual(repeatedPhrases(filler + " cheap blue widgets".repeat(9)), [], "under 10 times");
  assert.deepEqual(repeatedPhrases(filler.repeat(4) + " cheap blue widgets".repeat(10)), [], "under 4% of the words");
  const p = page("/w", {}, { stuffPhrases: hits });
  assert.match(keywordStuffingIssues([p])[0][2], /"cheap blue widgets" 12 times/);
  assert.deepEqual(keywordStuffingIssues([p], { brandTerms: ["Cheap Blue Widgets"] }), [], "the brand is ignored");
  const d = parseHtml(doc(`<main><p>${stuffed}</p></main>`), S + "/w").data;
  assert.equal(d.stuffPhrases[0].phrase, "cheap blue widgets");
});

// ---- Row 26: hacked content ----
test("hacked spam: spam words in hidden text, titles or links are flagged unless the home page, brand or allowlist has them", () => {
  const hacked = parseHtml(doc(`<main><p>Brake repairs.</p><div style="display: none"><a href="https://spam.example.net">cheap viagra online</a></div></main>`), S + "/brakes").data;
  assert.deepEqual(hacked.spam.hidden, ["viagra"]);
  const home = page("/", {}, parseHtml(doc("<main><p>Welcome</p></main>"), S + "/").data);
  const p = page("/brakes", {}, hacked);
  const out = hackedSpamIssues([home, p], { home });
  assert.deepEqual(ids(out), ["hacked_spam_signals"]);
  assert.match(out[0][2], /hidden text: viagra/);
  assert.deepEqual(hackedSpamIssues([home, p], { home, allow: ["viagra"] }), []);
  const casinoHome = page("/", {}, parseHtml(doc("<main><h1>Casino reviews</h1></main>"), S + "/").data);
  const casinoPage = page("/a", {}, parseHtml(doc("<main><h1>Best casino bonuses</h1></main>", "").replace("<title>T</title>", "<title>Casino</title>"), S + "/a").data);
  assert.deepEqual(hackedSpamIssues([casinoHome, casinoPage], { home: casinoHome }), [], "the site is about casinos");
  assert.equal(parseHtml(doc("<main><p>We service the Ford Escort and slot in your booking.</p></main>"), S + "/f").data.spam, undefined, "ambiguous words alone don't count");
});

test("hacked spam: body text of pages new since the last audit, and Japanese titles on a non-Japanese site", () => {
  const home = page("/", {}, { lang: "en" });
  const fresh = page("/new", {}, { spam: { text: ["payday loans"] } });
  assert.deepEqual(hackedSpamIssues([home, fresh], { home }), [], "without a previous audit body text isn't checked");
  assert.match(hackedSpamIssues([home, fresh], { home, prevUrls: new Set([S + "/"]) })[0][2], /new since the last audit: payday loans/);
  assert.deepEqual(hackedSpamIssues([home, fresh], { home, prevUrls: new Set([S + "/", S + "/new"]) }), [], "old pages: only title, H1, links and hidden text");
  const jp = parseHtml(doc("<h1>激安ブランドバッグ通販</h1>"), S + "/x").data;
  assert.ok(jp.kana >= 4);
  assert.match(hackedSpamIssues([home, page("/x", {}, jp)], { home })[0][2], /Japanese keyword hack/);
  const jaHome = page("/", {}, { lang: "ja" });
  assert.deepEqual(hackedSpamIssues([jaHome, page("/x", {}, jp)], { home: jaHome }), [], "a Japanese site");
  const noLang = page("/", { }, { lang: "", kana: 6 });
  assert.deepEqual(hackedSpamIssues([noLang, page("/x", {}, jp)], { home: noLang }), [], "a Japanese home page without a lang attribute");
  assert.deepEqual(hackedSpamIssues([home, page("/ja/", {}, { ...jp, lang: "ja", hreflangAlts: [S + "/"] })], { home }), [], "a real Japanese version with hreflang");
});

test("new external script: a host on most pages now and on none in the previous audit", () => {
  const ps = ["/", "/a", "/b", "/c"].map((u) => page(u, {}, { scriptHosts: ["cdn.example.net"] }));
  assert.deepEqual(ids(hackedSpamIssues(ps, { home: ps[0], prevScriptHosts: new Map(), prevAudit: 7 })), ["new_external_script"]);
  assert.deepEqual(hackedSpamIssues(ps, { home: ps[0], prevScriptHosts: new Map([["cdn.example.net", 4]]) }), []);
  assert.deepEqual(hackedSpamIssues(ps, { home: ps[0], prevScriptHosts: null }), [], "no comparison without a previous record");
  assert.deepEqual(parseHtml(doc('<script src="/app.js"></script><script src="https://cdn.example.net/x.js"></script>'), S + "/").data.scriptHosts, ["cdn.example.net"]);
});

// ---- Rows 39 and 40: duplicate H1s and title quality ----
test("dup_h1: the same H1 on pages outside one hreflang cluster; series, short H1s and shared titles are left out", () => {
  const a = page("/a", {}, {}), b = page("/b", {}, {});
  a.h1 = b.h1 = "Brake Repairs";
  assert.deepEqual(ids(dupH1Issues([a, b])), ["dup_h1", "dup_h1"]);
  assert.deepEqual(dupH1Issues([a, b], () => "one-cluster"), [], "language versions");
  const p2 = page("/a?page=2"); p2.h1 = "Brake Repairs";
  assert.equal(dupH1Issues([a, p2]).length, 0, "pagination");
  const x = page("/x"), y = page("/y"); x.h1 = y.h1 = "Hi";
  assert.deepEqual(dupH1Issues([x, y]), [], "too short");
  b.title = a.title;
  assert.deepEqual(dupH1Issues([a, b]), [], "already dup_title");
});

test("title_quality: repeated brand, keyword lists and boilerplate; a brand suffix once is normal", () => {
  const brand = ["Example Motors"];
  assert.equal(brandCount("Example Motors | Brakes | ExampleMotors", brand), 2);
  assert.match(titleProblem("Example Motors Brakes | Example Motors", brand), /brand appears 2 times/);
  assert.match(titleProblem("Brakes, Tyres, Servicing, Repairs", brand), /4 segments/);
  assert.match(titleProblem("Brake repair and brakes: brake pads", brand), /"brake" 3 times/);
  assert.equal(titleProblem("Brake Repairs in Northvale | Example Motors", brand), null);
  const ps = Array.from({ length: 10 }, (_, i) => page(`/p${i}`, { title: `P${i} | Example Motors has videos and posters of everything` }));
  const out = titleQualityIssues(ps, { brandTerms: brand });
  assert.equal(out.length, 10);
  assert.match(out[0][2], /boilerplate: the trailing part/);
  assert.equal(titleQualityIssues(ps.slice(0, 9), { brandTerms: brand }).length, 0, "fewer than 10 pages");
});

test("signalSiteIssues runs every site rule on the crawled pages", () => {
  const a = page("/a"), b = page("/b");
  a.h1 = b.h1 = "Same Heading";
  const out = signalSiteIssues({ auditId: 999999, projectId: 999999, pages: [a, b], start: S + "/", cluster: (u) => u, origin: S });
  assert.deepEqual(ids(out), ["dup_h1", "dup_h1"]);
});
