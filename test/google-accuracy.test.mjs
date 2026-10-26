// Accuracy against Google's guidance (REQ-044, 2026-10-27): AI search crawlers vs training opt-outs, ranking myths
// shown as information, sitemap fetch/size problems (gzip, nested indexes, 50,000 URLs / 50 MB), and URL
// Inspection states ("Indexed, though blocked by robots.txt") with sections and rises between runs. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { aiSiteIssues, aiBotAccess, AI_BOTS } = await import("../src/ai-checks.mjs");
const { CHECKS, pageIssues, healthScore } = await import("../src/checks.mjs");
const { loadSitemaps, parseSitemap, decodeSitemap } = await import("../src/sitemaps.mjs");
const { classify, folderOf, folderShares, kindRises, startIndexRun, indexData } = await import("../src/indexing.mjs");
const { run } = await import("../src/db.mjs");

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);

// ---- Row 2: AI search crawlers vs training opt-outs ----
test("blocking training tokens is an information notice; blocking AI search fetchers is an error", () => {
  const txt = ["Google-Extended", "Applebot-Extended", "GPTBot", "CCBot", "anthropic-ai", "PerplexityBot", "OAI-SearchBot"].map((b) => `User-agent: ${b}\nDisallow: /\n`).join("\n");
  const found = aiSiteIssues(txt, S);
  assert.deepEqual(found.filter((x) => x[0] === "ai_search_bot_blocked").map((x) => x[1]).sort(), ["OAI-SearchBot", "PerplexityBot"]);
  const opt = found.filter((x) => x[0] === "ai_training_optout");
  assert.deepEqual(opt.map((x) => x[1].split(":")[0]).sort(), ["Applebot-Extended", "CCBot", "GPTBot", "Google-Extended", "anthropic-ai"]);
  assert.match(opt.find((x) => x[1].startsWith("Google-Extended"))[1], /doesn't affect Google Search or AI Overviews/);
  assert.equal(CHECKS.ai_search_bot_blocked[0], "error");
  assert.equal(CHECKS.ai_training_optout[0], "notice");
  assert.match(CHECKS.ai_training_optout[2], /doesn't affect Google Search, including AI Overviews/);
  assert.ok(CHECKS.ai_bot_blocked, "older audits' rows still have a title");
  assert.deepEqual(aiSiteIssues("User-agent: *\nAllow: /\n", S), []);
});

test("the access table labels each crawler's purpose and lists GoogleOther for information", () => {
  const rows = aiBotAccess("User-agent: GoogleOther\nDisallow: /\n", S);
  assert.deepEqual(rows.find((r) => r.bot === "GoogleOther"), { bot: "GoogleOther", kind: "other", allowed: false });
  assert.equal(rows.find((r) => r.bot === "Google-Extended").kind, "training");
  assert.equal(rows.find((r) => r.bot === "Claude-SearchBot").kind, "search");
  assert.ok(AI_BOTS.includes("Bingbot") && AI_BOTS.includes("GPTBot"), "the robots tester still lists every token");
  assert.deepEqual(aiSiteIssues("User-agent: GoogleOther\nDisallow: /\n", S), [], "GoogleOther raises no issue");
});

// ---- Row 3: ranking myths shown as information ----
test("title/description length, several H1s and word count are information notices; real problems keep their severity", () => {
  for (const id of ["title_too_long", "title_too_short", "desc_length", "multiple_h1", "low_word_count", "low_text_ratio", "url_too_long", "dup_title_h1"]) {
    assert.equal(CHECKS[id][0], "notice", id);
    assert.match(CHECKS[id][1], /information: not a Google/, id);
  }
  assert.match(CHECKS.title_too_long[2], /truncates/);
  assert.deepEqual([CHECKS.missing_title[0], CHECKS.dup_title[0], CHECKS.missing_h1[0]], ["error", "error", "warning"]);
  // Detection is unchanged: the notices are still raised.
  const p = { url: S + "/a.html", final_url: S + "/a.html", status: 200, content_type: "text/html", indexable: 1, title: "x".repeat(80), description: "short", h1: "H",
    words: 120, text_ratio: 20, depth: 1, outlinks: 1, canonical: S + "/a.html", data: { h1Count: 3, canonicals: 1, viewport: true, lang: "en" } };
  const found = ids(pageIssues(p, { siteIsHttps: true }));
  for (const id of ["title_too_long", "desc_length", "multiple_h1", "low_word_count"]) assert.ok(found.includes(id), id);
  assert.ok(found.every((id) => CHECKS[id][0] === "notice"), "nothing on this page counts against Site Health");
  assert.equal(healthScore(10, 0, 0), 100);
});

// ---- Row 19: sitemap fetch errors and size limits ----
const urlset = (locs) => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${l}</loc><lastmod>2026-10-01</lastmod></url>`).join("")}</urlset>`;
const index = (locs) => `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join("")}</sitemapindex>`;
const ok = (text, type = "application/xml") => ({ status: 200, type, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text) });

test("gzip sitemaps are read; dead, HTML and nested-index children are reported", async () => {
  const files = {
    [S + "/sitemap_index.xml"]: ok(index([S + "/a.xml", S + "/b.xml.gz", S + "/c.xml", S + "/d.xml", S + "/nested.xml"])),
    [S + "/a.xml"]: ok(urlset([S + "/", S + "/a.html"])),
    [S + "/b.xml.gz"]: ok(gzipSync(urlset([S + "/b.html"])), "application/x-gzip"),
    [S + "/c.xml"]: { status: 404, type: "text/html", bytes: Buffer.alloc(0) },
    [S + "/d.xml"]: ok("<!doctype html><html><body>Home</body></html>", "text/html"),
    [S + "/nested.xml"]: ok(index([S + "/e.xml"])),
    [S + "/e.xml"]: ok(urlset([S + "/e.html"])),
  };
  const r = await loadSitemaps(S, `User-agent: *\nAllow: /\nSitemap: ${S}/sitemap_index.xml\n`, "ua", { get: async (u) => files[u] || { status: 404, bytes: Buffer.alloc(0) } });
  assert.deepEqual([...r.urls].sort(), [S + "/", S + "/a.html", S + "/b.html", S + "/e.html"]);
  assert.equal(r.lastmodOf.get(S + "/b.html"), "2026-10-01", "lastmod read from the gzip file too");
  assert.deepEqual(r.problems.map((x) => [x[0], x[1].replace(S, "")]), [["sitemap_fetch_error", "/c.xml"], ["sitemap_fetch_error", "/d.xml"], ["sitemap_too_large", "/nested.xml"]]);
  assert.match(r.problems[0][2], /HTTP 404; listed in sitemap index/);
  assert.match(r.problems[1][2], /HTML page/);
  assert.match(r.problems[2][2], /can't be nested/);
});

test("a missing /sitemap.xml that nothing declares is not a fetch error; a declared one is", async () => {
  const none = async () => ({ status: 404, bytes: Buffer.alloc(0) });
  const quiet = await loadSitemaps(S, "User-agent: *\nAllow: /\n", "ua", { get: none });
  assert.deepEqual([quiet.found, quiet.problems], [false, []]);
  const loud = await loadSitemaps(S, `Sitemap: ${S}/sitemap.xml\n`, "ua", { get: async () => ({ status: 0, error: "timeout", bytes: Buffer.alloc(0) }) });
  assert.deepEqual(loud.problems, [["sitemap_fetch_error", S + "/sitemap.xml", "no response (timeout); listed in robots.txt"]]);
});

test("over 50,000 URLs, over 50 MB, unescaped & and cut-off files are reported", async () => {
  const many = urlset(Array.from({ length: 50001 }, (_, i) => `${S}/p${i}`));
  const big = await loadSitemaps(S, `Sitemap: ${S}/big.xml\n`, "ua", { get: async () => ok(many) });
  assert.equal(big.problems[0][0], "sitemap_too_large");
  assert.match(big.problems[0][2], /50,001 URLs \(limit 50,000\)/);
  assert.equal(decodeSitemap(gzipSync(Buffer.alloc(50 * 1024 * 1024 + 10, 32))).error, "too large");
  assert.match(parseSitemap(urlset([`${S}/a?x=1&y=2`])).problems[0], /unescaped &/);
  assert.deepEqual(parseSitemap(urlset([`${S}/a?x=1&amp;y=2`])).problems, []);
  assert.equal(parseSitemap(urlset([`${S}/a?x=1&amp;y=2`])).locs[0], `${S}/a?x=1&y=2`);
  assert.match(parseSitemap(urlset([`${S}/a`]).replace("</urlset>", "")).problems[0], /no closing <\/urlset>/);
  assert.deepEqual(parseSitemap(`${S}/a\n${S}/b\n`).locs, [`${S}/a`, `${S}/b`], "plain-text sitemaps are supported");
  assert.deepEqual(parseSitemap(`<rss version="2.0"><channel><link>${S}/</link><item><link>${S}/post</link></item></channel></rss>`).locs, [`${S}/post`]);
});

// ---- Row 20: index status ----
test("'Indexed, though blocked by robots.txt' and 'Indexed without content' are problems, not plain indexed", () => {
  assert.equal(classify("Indexed, though blocked by robots.txt", "PASS").kind, "indexed_blocked");
  assert.equal(classify("Indexed without content", "PASS").kind, "indexed_no_content");
  assert.equal(classify("Submitted and indexed", "PASS").kind, "indexed");
  assert.equal(classify("Blocked by robots.txt").kind, "blocked");
});

test("sections and rises: not-indexed share per folder (10+ pages), kinds that grew 20% and 10+ URLs", () => {
  assert.deepEqual([folderOf(S + "/a.html"), folderOf(S + "/blog/x.html"), folderOf(S + "/en/blog/x.html"), folderOf(S + "/en/x.html")], ["/", "/blog/", "/en/blog/", "/en/"]);
  const rows = [...Array.from({ length: 10 }, (_, i) => ({ url: `${S}/blog/${i}.html`, kind: i < 4 ? "crawled" : "indexed" })),
    ...Array.from({ length: 5 }, (_, i) => ({ url: `${S}/shop/${i}.html`, kind: "crawled" }))];
  assert.deepEqual(folderShares(rows), [{ folder: "/blog/", inspected: 10, notIndexed: 4, share: 0.4 }], "a folder with under 10 pages isn't shown");
  assert.deepEqual(kindRises({ crawled: 50 }, { crawled: 60, indexed: 200 }), [{ kind: "crawled", from: 50, to: 60 }]);
  assert.deepEqual(kindRises({ crawled: 100 }, { crawled: 115 }), [], "15% is under the 20% bar");
  assert.deepEqual(kindRises({}, { indexed_blocked: 9 }), [], "fewer than 10 URLs");
  assert.deepEqual(kindRises(undefined, { crawled: 50 }), []);
});

test("each run stores its counts, and the next run's rise is reported with folder shares", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (990, 'Example', 'https://example.com/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (991, 990, 'done')");
  for (let i = 0; i < 24; i++) run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, depth) VALUES (991,?,?,200,1,'text/html',1)", `${S}/blog/${i}.html`, `${S}/blog/${i}.html`);
  const answer = (coverageState, verdict = "NEUTRAL") => ({ inspectionResult: { indexStatusResult: { coverageState, verdict } } });
  let r = await startIndexRun({ id: 990, start_url: S + "/", settings: "{}" }, { inspect: async () => answer("Submitted and indexed", "PASS") });
  await r.done;
  assert.deepEqual(indexData(990).rises, []);
  r = await startIndexRun({ id: 990, start_url: S + "/", settings: "{}" }, { inspect: async (u) => (+u.match(/(\d+)\.html$/)[1] < 12
    ? answer("Indexed, though blocked by robots.txt", "PASS") : answer("Submitted and indexed", "PASS")) });
  await r.done;
  const d = indexData(990);
  assert.deepEqual([d.total, d.indexed, d.indexedProblems, d.notIndexed], [24, 12, 12, 0]);
  assert.deepEqual(d.rises, [{ kind: "indexed_blocked", from: 0, to: 12 }]);
  assert.deepEqual(d.folders, [{ folder: "/blog/", inspected: 24, notIndexed: 0, share: 0 }]);
});
