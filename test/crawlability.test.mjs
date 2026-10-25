// Crawlability (REQ-023, 2026-10-25): robots.txt errors, blanket disallow, blocked CSS/JS, soft 404s, host variants
// (http/https, www/non-www, certificates), JavaScript-only links, meta refresh, page nofollow, parameter traps.
// Network calls are faked. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import robotsParser from "robots-parser";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { crawlabilitySiteIssues, hostVariants, paramTraps } = await import("../src/crawlability.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");

const S = "https://acmemotors.com.au/";
const ok = { status: 200, body: "" };
// A fake web: map of URL → response; unknown URLs are 404.
const web = (map) => async (u) => map[u] || (Object.entries(map).find(([k]) => k.endsWith("*") && u.startsWith(k.slice(0, -1)))?.[1]) || { status: 404 };
const goodHosts = {
  "http://acmemotors.com.au/": { status: 301, location: S }, "http://www.acmemotors.com.au/": { status: 301, location: S },
  "https://www.acmemotors.com.au/": { status: 301, location: S }, [S]: ok,
};
const ids = (issues) => issues.map((i) => i[0]).sort();

test("every crawlability check is defined in the catalog", () => {
  for (const id of CRAWL) assert.ok(CHECKS[id], id);
});

test("host variants that all 301 to the main address pass", async () => {
  assert.deepEqual(await hostVariants(S, "ua", web(goodHosts)), []);
});

test("a www variant with the wrong certificate is an error; one with no DNS record is a warning", async () => {
  const tls = { ...goodHosts, "http://www.acmemotors.com.au/": { status: 301, location: "https://www.acmemotors.com.au/" },
    "https://www.acmemotors.com.au/": { status: 0, error: "ERR_TLS_CERT_ALTNAME_INVALID" } };
  const r = await hostVariants(S, "ua", web(tls));
  assert.deepEqual(ids(r), ["host_variant_tls", "host_variant_tls"]);
  assert.match(r.find((x) => x[1].startsWith("http://"))[2], /after 301/);
  const nodns = { ...goodHosts, "http://www.acmemotors.com.au/": { status: 0, error: "ENOTFOUND" }, "https://www.acmemotors.com.au/": { status: 0, error: "ENOTFOUND" } };
  assert.deepEqual(ids(await hostVariants(S, "ua", web(nodns))), ["host_variant_missing", "host_variant_missing"]);
});

test("a variant that 302s or serves its own copy is flagged", async () => {
  const r = await hostVariants(S, "ua", web({ ...goodHosts, "http://acmemotors.com.au/": { status: 302, location: S }, "https://www.acmemotors.com.au/": ok }));
  assert.deepEqual(ids(r), ["host_variant_redirect", "host_variant_redirect"]);
});

test("robots.txt 5xx, blanket disallow, blocked CSS/JS and soft 404s", async () => {
  const site = { ...goodHosts, [S]: { status: 200, body: '<link rel="stylesheet" href="/assets/site.css"><script src="/assets/app.js"></script><script src="https://cdn.example.com/x.js"></script>' },
    "https://acmemotors.com.au/seo-auditor-missing-page-*": ok };
  const base = { start: S, ua: "ua", get: web(site) };
  const err = await crawlabilitySiteIssues({ ...base, robotsRes: { status: 503 }, robotsTxt: "", robots: robotsParser(S + "robots.txt", "") });
  assert.ok(ids(err).includes("robots_txt_error"));
  assert.ok(ids(err).includes("soft_404"), "a missing page answering 200 is a soft 404");
  const txt = "User-agent: *\nDisallow: /assets/\n";
  const res = await crawlabilitySiteIssues({ ...base, robotsRes: { status: 200 }, robotsTxt: txt, robots: robotsParser(S + "robots.txt", txt) });
  const blocked = res.find((x) => x[0] === "robots_blocks_resources");
  assert.match(blocked[2], /^2 file\(s\)/, "only this site's own files count");
  const all = "User-agent: *\nDisallow: /\n";
  assert.ok(ids(await crawlabilitySiteIssues({ ...base, robotsRes: { status: 200 }, robotsTxt: all, robots: robotsParser(S + "robots.txt", all) })).includes("robots_disallow_all"));
});

test("a site that returns 404 for missing pages and allows everything is clean", async () => {
  const txt = "User-agent: *\nAllow: /\n";
  const r = await crawlabilitySiteIssues({ start: S, ua: "ua", get: web(goodHosts), robotsRes: { status: 200 }, robotsTxt: txt, robots: robotsParser(S + "robots.txt", txt) });
  assert.deepEqual(r, []);
});

test("JavaScript-only navigation, meta refresh and page-level nofollow are flagged; ordinary buttons are not", () => {
  const html = `<html><head><meta name="robots" content="index, nofollow"><meta http-equiv="refresh" content="0; url=/new.html"></head><body>
    <div onclick="location.href='/brakes.html'">Brakes</div><a href="javascript:window.open('/quote.html')">Quote</a>
    <button onclick="toggleMenu()">Menu</button><a href="javascript:void(0)">x</a><a href="/tyres.html">Tyres</a></body></html>`;
  const p = parseHtml(html, S);
  assert.equal(p.data.jsLinks, 2);
  assert.equal(p.data.jsLinkExample, "/brakes.html");
  const found = pageIssues({ url: S, final_url: S, status: 200, content_type: "text/html", indexable: 1, words: 300, text_ratio: 20, title: "Acme Motors | Car repairs in Springfield", description: "x".repeat(130), h1: "Car repairs", depth: 0, outlinks: 1, data: { ...p.data, h1Count: 1 } }, { siteIsHttps: true }).map((x) => x[0]);
  for (const id of ["uncrawlable_links", "meta_refresh", "nofollow_page"]) assert.ok(found.includes(id), id);
  const clean = parseHtml('<html><head><meta name="robots" content="index,follow"></head><body><a href="/a.html">A</a></body></html>', S).data;
  assert.equal([clean.jsLinks, clean.metaRefresh, clean.nofollowMeta].filter(Boolean).length, 0);
});

test("parameter traps: many ?variants of one path, not a handful", () => {
  const urls = [...Array(35)].map((_, i) => `${S}shop.html?colour=${i}`).concat([...Array(5)].map((_, i) => `${S}book.html?service=${i}`), [S]);
  assert.deepEqual(paramTraps(urls), [[S + "shop.html", 35]]);
});
