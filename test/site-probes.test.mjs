// Site probes and site rules (REQ-044 build rows 16-18, 21, 34, 35, 46, 50-53, Oct 2026): internal search pages,
// smartphone vs desktop parity, Googlebot vs browser, robots.txt syntax and group override, staging hosts, login pages,
// email in URLs, sitemap lastmod accuracy, 304 and compression, exposed secret files, certificate expiry and language
// redirects. Network calls are faked (fetch, DNS and TLS are injected). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import robotsParser from "robots-parser";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { robotsTxtIssues, robotsGroups } = await import("../src/robots-txt.mjs");
const { siteRuleIssues, emailInUrl, lastmodDrift, saveLastmods, lastmodAccuracyIssues } = await import("../src/site-rules.mjs");
const probes = await import("../src/site-probes.mjs");
const { prober, searchVerdict, searchIssues, stagingIssues, nonProductionHosts, cachingIssues, secretFileIssues, certIssues, localeIssues, siteProbeIssues, PROBE_BUDGET } = probes;
const { parityIssues, referrerIssues, GOOGLEBOT_SMARTPHONE_UA, MOBILE_UA, DESKTOP_UA } = await import("../src/ua-parity.mjs");
const { sourceMapOf, scriptTrapIssues } = await import("../src/crawlability.mjs");
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const { run } = await import("../src/db.mjs");
const { textFingerprint } = await import("../src/google-signals.mjs");

const S = "https://example.com";
const ids = (xs) => xs.map((x) => x[0]);
const words = (n, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const html = ({ title = "Example page", h1 = "Heading", body = "<p>text</p>", head = "" } = {}) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><h1>${h1}</h1><main>${body}</main></body></html>`;
// A fake web: url → { status, body, headers, url (final) } or a function (url, init) → that. Unknown URLs are 404.
const fakeFetch = (map, log = []) => async (url, init = {}) => {
  log.push({ url, headers: init.headers || {} });
  let r = map[url];
  if (typeof r === "function") r = r(url, init);
  r ||= { status: 404, body: "not found", headers: { "content-type": "text/html" } };
  const res = new Response([204, 304].includes(r.status) ? null : r.body ?? "", { status: r.status, headers: { "content-type": "text/html; charset=utf-8", ...(r.headers || {}) } });
  Object.defineProperty(res, "url", { value: r.url || url });
  return res;
};
const req0 = (map, log) => prober({ gapMs: 0, fetchFn: fakeFetch(map, log) });

test("the new checks are catalogued with the right severity; the crawl ones show under Crawlability", () => {
  const sev = { internal_search_indexable: "warning", internal_search_echoed: "error", mobile_desktop_parity: "warning", googlebot_ua_diff: "warning", search_referrer_redirect: "error",
    robots_txt_syntax: "notice", robots_group_override: "notice", staging_host_exposed: "warning", login_page_indexable: "notice", login_redirect_hub: "notice", email_in_url: "warning",
    sitemap_lastmod_inaccurate: "notice", no_conditional_get: "notice", no_compression: "warning", exposed_secret_files: "error", source_map_exposed: "notice",
    tls_cert_expiring: "warning", tls_cert_critical: "error", locale_redirect: "warning" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); }
  for (const id of ["internal_search_indexable", "mobile_desktop_parity", "googlebot_ua_diff", "robots_txt_syntax", "staging_host_exposed", "no_compression", "tls_cert_expiring", "locale_redirect"]) assert.ok(CRAWL.has(id), id);
});

// ---------------- Row 21: robots.txt ----------------
test("robots_txt_syntax: ignored fields, unreadable lines, typos, non-ASCII, relative sitemap, paths without /", () => {
  const txt = ["User-agent: *", "Crawl-delay: 10", "Noindex: /old/", "Dissallow: /tmp/", "Disallow: private", "Disallow: /café/", "this line is junk", "Sitemap: /sitemap.xml", "Allow: /"].join("\n");
  const [[id, url, det]] = robotsTxtIssues({ origin: S, status: 200, type: "text/plain", text: txt });
  assert.equal(id, "robots_txt_syntax"); assert.equal(url, S + "/robots.txt");
  for (const s of ["crawl-delay (line 2)", "noindex (line 3)", "\"Dissallow\"", "accepted by Google", "/café/", "relative Sitemap", "\"private\"", "this line is junk"]) assert.ok(det.includes(s), s);
});

test("robots_txt_syntax: an HTML robots.txt or a non-text/plain type is reported; a clean file is not", () => {
  assert.match(robotsTxtIssues({ origin: S, status: 200, type: "text/html", text: "<!doctype html><html>…" })[0][2], /HTML/);
  assert.match(robotsTxtIssues({ origin: S, status: 200, type: "application/octet-stream", text: "User-agent: *\nDisallow:" })[0][2], /not text\/plain/);
  assert.deepEqual(robotsTxtIssues({ origin: S, status: 200, type: "text/plain; charset=utf-8", text: "# hi\nUser-agent: *\nDisallow: /admin/ # private\nSitemap: https://example.com/sitemap.xml\n" }), []);
  assert.deepEqual(robotsTxtIssues({ origin: S, status: 404, type: "text/html", text: "<html>" }), []);
});

test("robots_group_override: a Googlebot group drops the * group's Disallow rules it doesn't repeat", () => {
  const txt = "User-agent: *\nDisallow: /admin/\nDisallow: /cart/\n\nUser-agent: Googlebot\nDisallow: /admin/\n";
  const out = robotsTxtIssues({ origin: S, status: 200, type: "text/plain", text: txt });
  assert.deepEqual(ids(out), ["robots_group_override"]);
  assert.match(out[0][2], /\/cart\//); assert.doesNotMatch(out[0][2], /\/admin\//);
  // Same rules, or a group shared by both agents: nothing to report.
  assert.deepEqual(robotsTxtIssues({ origin: S, status: 200, type: "text/plain", text: "User-agent: Googlebot\nUser-agent: *\nDisallow: /cart/\n" }), []);
  assert.deepEqual([...robotsGroups("User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nAllow: /y").keys()], ["a", "b", "c"]);
});

// ---------------- Row 35: login pages and email addresses ----------------
const pg = (url, over = {}, data = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 400, text_ratio: 20, depth: 1, outlinks: 1, inlinks: 1, canonical: S + url, data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });

test("login_page_indexable: an indexable page with a password field and under 150 words; a described login page passes", () => {
  const form = '<form><input name="user"><input type="Password" name="pw"><button>Log in</button></form>';
  const d = parseHtml(html({ body: form + "<p>Sign in to your account.</p>" }), S + "/login").data;
  assert.equal(d.passwordField, true);
  assert.ok(ids(pageIssues(pg("/login", { words: 40 }, d), {})).includes("login_page_indexable"));
  assert.ok(!ids(pageIssues(pg("/login", { words: 300 }, d), {})).includes("login_page_indexable"));
  assert.ok(!ids(pageIssues(pg("/login", { words: 40, indexable: 0 }, { ...d, noindex: true }), {})).includes("login_page_indexable"));
  assert.equal(parseHtml(html(), S + "/").data.passwordField, undefined);
});

test("login_redirect_hub: 5 or more crawled URLs redirecting to one login URL; email_in_url finds addresses but not retina images", () => {
  const redirected = Array.from({ length: 5 }, (_, i) => pg(`/orders/${i}`, { status: 302 }, { redirect: { hops: 1, to: S + "/wp-login.php?redirect_to=x", firstStatus: 302 } }));
  const out = siteRuleIssues([...redirected, pg("/"), pg("/unsubscribe?email=jane%40example.com"), pg("/img/logo@2x.png")]);
  assert.deepEqual(ids(out), ["login_redirect_hub", "email_in_url"]);
  assert.equal(out[0][1], S + "/wp-login.php?redirect_to=x");
  assert.equal(out[1][1], S + "/unsubscribe?email=jane%40example.com");
  assert.deepEqual(ids(siteRuleIssues(redirected.slice(0, 4))), []);
  assert.equal(emailInUrl(S + "/u/jane@example.com"), "jane@example.com");
  assert.equal(emailInUrl(S + "/@handle/post"), null);
  assert.equal(emailInUrl(S + "/accountants/"), null);
});

// ---------------- Row 46: sitemap lastmod accuracy ----------------
test("lastmodDrift: lastmod bumped without a change, or a change without a new lastmod", () => {
  const prev = new Map([["a", { lastmod: "2026-09-01", hash: "h1" }], ["b", { lastmod: "2026-09-01", hash: "h2" }], ["c", { lastmod: "2026-09-01", hash: "h3" }], ["d", { lastmod: "2026-09-01", hash: null }]]);
  const cur = new Map([["a", { lastmod: "2026-10-20", hash: "h1" }], ["b", { lastmod: "2026-09-01", hash: "h2x" }], ["c", { lastmod: "2026-10-20", hash: "h3x" }], ["d", { lastmod: "2026-10-20", hash: "h4" }]]);
  assert.deepEqual(lastmodDrift(prev, cur, "2026-10-01"), { bumped: ["a"], stale: ["b"], compared: 3 });
});

test("sitemap_lastmod_inaccurate: compares with the previous finished audit; under 5 URLs and 20% stays quiet", () => {
  const P = Number(run("INSERT INTO projects (name, start_url) VALUES ('t', ?)", S + "/").lastInsertRowid);
  const audit = () => Number(run("INSERT INTO audits (project_id, status, finished_at) VALUES (?, 'done', '2026-10-01 10:00:00')", P).lastInsertRowid);
  const a1 = audit(), urls = Array.from({ length: 10 }, (_, i) => `${S}/p${i}`);
  saveLastmods(a1, new Map(urls.map((u) => [u, "2026-09-01"])));
  for (const u of urls) run("INSERT INTO pages (audit_id, url, final_url, status, data) VALUES (?,?,?,200,?)", a1, u, u, JSON.stringify({ textHash: "same-" + u }));
  const a2 = Number(run("INSERT INTO audits (project_id, status) VALUES (?, 'running')", P).lastInsertRowid);
  const pagesNow = urls.map((u, i) => ({ url: u, final_url: u, status: 200, data: { textHash: i < 6 ? "same-" + u : "changed-" + u } }));
  // p0-p5 got a new lastmod with the same text (6 bumped); p6-p9 changed text with the old lastmod (4 stale).
  const lastmodNow = new Map(urls.map((u, i) => [u, i < 6 ? "2026-10-20" : "2026-09-01"]));
  const out = lastmodAccuracyIssues(P, a2, lastmodNow, pagesNow, S + "/sitemap.xml");
  assert.deepEqual(ids(out), ["sitemap_lastmod_inaccurate", "sitemap_lastmod_inaccurate"]);
  assert.match(out[0][2], /^6 of 10 URLs: lastmod moved forward/); assert.match(out[1][2], /^4 of 10 URLs: main text changed/);
  // One bump in ten URLs is under both thresholds.
  const quiet = new Map(urls.map((u, i) => [u, i === 0 ? "2026-10-20" : "2026-09-01"]));
  assert.deepEqual(lastmodAccuracyIssues(P, a2, quiet, urls.map((u) => ({ url: u, final_url: u, status: 200, data: { textHash: "same-" + u } })), S + "/sitemap.xml"), []);
});

// ---------------- Row 16: internal search ----------------
test("searchVerdict: home copies, home canonicals and the 404 page are not search pages; an echoed query is an error", () => {
  const home = { url: S + "/", hash: "home", canonical: S + "/" };
  assert.equal(searchVerdict({ url: S + "/?s=x", hash: "home" }, { home }), null);
  assert.equal(searchVerdict({ url: S + "/?s=x", hash: "other", canonical: S + "/" }, { home }), null);
  assert.equal(searchVerdict({ url: S + "/search?q=x", hash: "nf" }, { home, notFoundHash: "nf" }), null);
  assert.equal(searchVerdict({ url: S + "/search?q=brakes", hash: "r", title: "Results" }, { home, term: "brakes" })[0], "internal_search_indexable");
  assert.equal(searchVerdict({ url: S + "/search?q=brakes", hash: "r", title: "Results for Brakes" }, { home, term: "brakes" })[0], "internal_search_echoed");
});

test("searchIssues: probes skip robots-blocked paths and noindex results, and flag an indexable echo", async () => {
  const token = "seoauditortok";
  const homeHtml = html({ title: "Home", body: `<p>${words(80, "home")}</p>` });
  const results = html({ title: `Search results for ${token}`, h1: `Results: ${token}`, body: `<p>${words(80, "result")}</p>` });
  const log = [];
  const req = req0({
    [S + `/?s=${token}`]: { status: 200, body: homeHtml }, // no search: the home page again
    [S + `/search?q=${token}`]: { status: 200, body: results },
    [S + `/search?query=${token}`]: { status: 200, body: results.replace("<head>", '<head><meta name="robots" content="noindex">') },
  }, log);
  const homeParsed = parseHtml(homeHtml, S + "/");
  const pages = [pg("/", { canonical: S + "/" }, { textHash: textFingerprint(homeParsed.text) }), pg("/search?q=oil", { title: "Search: oil" }, { textHash: "x" })];
  const out = await searchIssues({ start: S + "/", pages, robots: null, req, ua: "t", parse: parseHtml, notFoundHash: null, token });
  assert.deepEqual(out.map((x) => [x[0], x[1]]), [["internal_search_echoed", S + "/search?q=oil"], ["internal_search_echoed", S + `/search?q=${token}`]]);
  const blocked = robotsParser(S + "/robots.txt", "User-agent: *\nDisallow: /search\nDisallow: /?s=");
  const log2 = [];
  assert.deepEqual(await searchIssues({ start: S + "/", pages: pages.slice(0, 1), robots: blocked, req: req0({}, log2), ua: "t", parse: parseHtml, token }), []);
  assert.equal(log2.length, 0); // blocked probes are never fetched
});

// ---------------- Rows 17 and 18: smartphone, desktop, Googlebot ----------------
const page3 = ({ g, m = g, d = g }) => (url, init) => (init.headers["User-Agent"] === GOOGLEBOT_SMARTPHONE_UA ? g : init.headers["User-Agent"] === MOBILE_UA ? m : d);
const full = html({ title: "Service", body: `<p>${words(300)}</p>` + Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("") + '<script type="application/ld+json">{"@type":"LocalBusiness","name":"X"}</script>' });
const thin = html({ title: "Service", body: `<p>${words(100)}</p><a href="/p0">p0</a>` });

test("mobile_desktop_parity: less text, links and markup for the smartphone crawler; an m-dot redirect", async () => {
  const req = req0({ [S + "/a"]: page3({ g: { status: 200, body: thin }, m: { status: 200, body: thin }, d: { status: 200, body: full } }),
    [S + "/b"]: page3({ g: { status: 200, body: full, url: "https://m.example.com/b" }, m: { status: 200, body: full, url: "https://m.example.com/b" }, d: { status: 200, body: full } }),
    [S + "/c"]: { status: 200, body: full } });
  const out = await parityIssues({ urls: [S + "/a", S + "/b", S + "/c"], req, parse: parseHtml });
  assert.deepEqual(out.map((x) => [x[0], x[1]]), [["mobile_desktop_parity", S + "/a"], ["mobile_desktop_parity", S + "/b"]]);
  assert.match(out[0][2], /100 words vs 30\d on desktop/); assert.match(out[0][2], /internal links/); assert.match(out[0][2], /LocalBusiness/);
  assert.match(out[1][2], /m\.example\.com/);
});

test("googlebot_ua_diff: status, challenge page, cloaked links; search_referrer_redirect only with Google's referrer", async () => {
  const cloaked = full.replace("</main>", '<a href="https://spam.example.net/x">cheap</a></main>');
  const req = req0({ [S + "/a"]: page3({ g: { status: 403, body: "no" }, m: { status: 200, body: full } }),
    [S + "/b"]: page3({ g: { status: 200, body: html({ title: "Just a moment..." }) }, m: { status: 200, body: full } }),
    [S + "/c"]: page3({ g: { status: 200, body: cloaked }, m: { status: 200, body: full } }) });
  const keep = {};
  const out = await parityIssues({ urls: [S + "/a", S + "/b", S + "/c"], req, parse: parseHtml, keep });
  assert.deepEqual(ids(out), ["googlebot_ua_diff", "googlebot_ua_diff", "googlebot_ua_diff"]); // no parity issue repeats them
  assert.match(out[0][2], /HTTP 403.*URL Inspection live test/); assert.match(out[1][2], /bot challenge/); assert.match(out[2][2], /spam\.example\.net only for Googlebot/);
  const hacked = req0({ [S + "/c"]: (u, init) => (init.headers.Referer ? { status: 200, body: "x", url: "https://casino.example.org/" } : { status: 200, body: full }) });
  assert.deepEqual(ids(await referrerIssues({ urls: [S + "/c"], req: hacked, browserHost: keep.browserHost })), ["search_referrer_redirect"]);
  assert.deepEqual(await referrerIssues({ urls: [S + "/c"], req: req0({ [S + "/c"]: { status: 200, body: full } }), browserHost: keep.browserHost }), []);
});

// ---------------- Row 34: staging hosts ----------------
test("staging_host_exposed: an open copy of production; login-protected, noindexed, robots-blocked or different sites pass", async () => {
  const prodHtml = html({ title: "Example Co | Home", body: `<p>${words(120, "prod")}</p>` });
  const prod = parseHtml(prodHtml, S + "/");
  const resolvable = new Set(["staging.example.com", "dev.example.com", "test.example.com", "beta.example.com", "preview.example.com", "shop-preview.netlify.app"]);
  const lookup = async (h) => { if (!resolvable.has(h)) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); return { address: "192.0.2.1" }; };
  const req = req0({
    "https://staging.example.com/": { status: 200, body: prodHtml },
    "https://dev.example.com/": { status: 401, body: "auth" },
    "https://test.example.com/": { status: 200, body: prodHtml.replace("<head>", '<head><meta name="robots" content="noindex">') },
    "https://beta.example.com/": { status: 200, body: html({ title: "Beta app", body: `<p>${words(120, "other")}</p>` }) },
    "https://preview.example.com/": { status: 200, body: prodHtml }, "https://preview.example.com/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /", headers: { "content-type": "text/plain" } },
    "https://shop-preview.netlify.app/": { status: 200, body: prodHtml },
  });
  const out = await stagingIssues({ start: S + "/", prod: { title: prod.title, text: prod.text }, seenUrls: [S + "/x", "https://shop-preview.netlify.app/old", "https://www.example.org/"], req, ua: "t", parse: parseHtml, lookup });
  assert.deepEqual(out.map((x) => x[1]), ["https://staging.example.com/", "https://shop-preview.netlify.app/"]);
  assert.deepEqual(nonProductionHosts(["https://uat2.example.com/a", "https://blog.example.com/", "https://www.example.com/"], S + "/"), ["uat2.example.com"]);
  // Wildcard DNS: guessed names are skipped, only named hosts are checked.
  assert.deepEqual(await stagingIssues({ start: S + "/", prod, seenUrls: [], req, ua: "t", parse: parseHtml, lookup: async () => ({}) }), []);
});

// ---------------- Row 50: caching and compression ----------------
test("no_compression and no_conditional_get: uncompressed text, no validators, 200 on revalidation; a 304 passes", async () => {
  const big = html({ body: `<p>${words(400)}</p>` });
  const req = req0({
    [S + "/plain"]: { status: 200, body: big },
    [S + "/etag-ignored"]: { status: 200, body: big, headers: { etag: '"v1"', "content-encoding": "gzip" } },
    [S + "/good"]: (u, init) => (init.headers["If-None-Match"] === '"v2"' ? { status: 304 } : { status: 200, body: big, headers: { etag: '"v2"', "content-encoding": "br" } }),
    [S + "/app.js"]: (u, init) => (init.headers["If-Modified-Since"] ? { status: 304 } : { status: 200, body: "x".repeat(2000), headers: { "content-type": "application/javascript", "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" } }),
  });
  // Bodies here are not really gzip, so the fake marks them encoded only by header; the decoded size is what counts.
  const out = await cachingIssues({ htmlUrls: [S + "/plain", S + "/etag-ignored", S + "/good"], assetUrls: [S + "/app.js"], req, ua: "t" });
  assert.deepEqual(out.map((x) => [x[0], x[1]]), [["no_compression", S + "/plain"], ["no_conditional_get", S + "/plain"], ["no_conditional_get", S + "/etag-ignored"], ["no_compression", S + "/app.js"]]);
  assert.match(out[2][2], /answered 200/);
});

// ---------------- Row 51: secret files ----------------
test("exposed_secret_files: content patterns decide, the body is never returned; soft-404 sites pass; source maps are a notice", async () => {
  const secret = "DB_PASSWORD=hunter2-very-secret\nAPI_KEY=sk_live_abcdef\n";
  const req = req0({ [S + "/.env"]: { status: 200, body: secret, headers: { "content-type": "text/plain" } }, [S + "/.git/HEAD"]: { status: 200, body: "ref: refs/heads/main\n" },
    [S + "/.git/config"]: { status: 200, body: html({ title: "Home" }) }, [S + "/assets/app.js.map"]: { status: 200, body: '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}' } });
  const out = await secretFileIssues({ start: S + "/", req, ua: "t", sourceMaps: [{ script: S + "/assets/app.js", map: S + "/assets/app.js.map" }] });
  assert.deepEqual(out.map((x) => [x[0], x[1]]), [["exposed_secret_files", S + "/.env"], ["exposed_secret_files", S + "/.git/HEAD"], ["source_map_exposed", S + "/assets/app.js.map"]]);
  const text = JSON.stringify(out);
  for (const s of ["hunter2", "sk_live", "refs/heads/main", "DB_PASSWORD"]) assert.ok(!text.includes(s), s);
  // A site that answers 200 with its home page for every path is not flagged.
  const soft = prober({ gapMs: 0, fetchFn: async () => new Response(html({ title: "Home" }), { status: 200, headers: { "content-type": "text/html" } }) });
  assert.deepEqual(await secretFileIssues({ start: S + "/", req: soft, ua: "t" }), []);
});

test("sourceMapOf reads the trailing comment (same origin only); scriptTrapIssues keeps it", async () => {
  assert.equal(sourceMapOf("var a=1;\n//# sourceMappingURL=app.js.map", S + "/js/app.js"), S + "/js/app.js.map");
  assert.equal(sourceMapOf("x\n/*# sourceMappingURL=main.css.map */", S + "/main.css"), S + "/main.css.map");
  assert.equal(sourceMapOf("x//# sourceMappingURL=data:application/json;base64,e30=", S + "/a.js"), null);
  assert.equal(sourceMapOf("x//# sourceMappingURL=https://cdn.example.net/a.map", S + "/a.js"), null);
  const keep = {};
  await scriptTrapIssues({ start: S + "/", html: '<script src="/js/app.js"></script>', ua: "t", keep, getBytes: async () => ({ status: 200, bytes: Buffer.from("a()\n//# sourceMappingURL=app.js.map") }) });
  assert.deepEqual(keep.sourceMaps, [{ script: S + "/js/app.js", map: S + "/js/app.js.map" }]);
});

// ---------------- Row 52: TLS ----------------
test("certIssues: 21 days for ordinary certificates, 10 for auto-renewing ones, error at 7 days or expired", () => {
  const now = Date.parse("2026-10-27T00:00:00Z"), day = 86_400_000;
  const cert = (daysLeft, issuer, life = 365) => ({ validTo: new Date(now + daysLeft * day).toUTCString(), validFrom: new Date(now + (daysLeft - life) * day).toUTCString(), issuer });
  assert.deepEqual(ids(certIssues(S + "/", cert(15, "Sectigo Limited"), now)), ["tls_cert_expiring"]);
  assert.deepEqual(ids(certIssues(S + "/", cert(25, "Sectigo Limited"), now)), []);
  assert.deepEqual(ids(certIssues(S + "/", cert(15, "Let's Encrypt", 90), now)), []);
  assert.deepEqual(ids(certIssues(S + "/", cert(9, "Let's Encrypt", 90), now)), ["tls_cert_expiring"]);
  assert.deepEqual(ids(certIssues(S + "/", cert(15, "Some CA", 90), now)), []); // a 90-day certificate renews automatically
  assert.deepEqual(ids(certIssues(S + "/", cert(5, "Sectigo Limited"), now)), ["tls_cert_critical"]);
  assert.match(certIssues(S + "/", cert(-2, "Sectigo Limited"), now)[0][2], /expired 2 day/);
  assert.deepEqual(certIssues(S + "/", { error: "ECONNREFUSED" }, now), []);
});

// ---------------- Row 53: language redirects ----------------
test("locale_redirect: different targets by Accept-Language; one redirect for everyone passes", async () => {
  const byLang = (u, init) => { const l = init.headers["Accept-Language"]; return l === "de" ? { status: 302, headers: { location: "/de/" } } : l === "fr" ? { status: 302, headers: { location: "/fr/" } } : { status: 200, body: "home" }; };
  const out = await localeIssues({ start: S + "/", req: req0({ [S + "/"]: byLang }) });
  assert.deepEqual(ids(out), ["locale_redirect"]);
  assert.match(out[0][2], /de → 302 https:\/\/example\.com\/de\//); assert.match(out[0][2], /no preference → no redirect/);
  assert.deepEqual(await localeIssues({ start: S + "/", req: req0({ [S + "/"]: { status: 301, headers: { location: "/en/" } } }) }), []);
  assert.deepEqual(await localeIssues({ start: S + "/", req: req0({ [S + "/"]: { status: 200, body: "home with a language banner" } }) }), []);
});

// ---------------- Budget, pacing, setting ----------------
test("siteProbeIssues stays within the request budget, one request at a time, and waits the robots.txt Crawl-delay", async () => {
  const log = [];
  let inFlight = 0, maxInFlight = 0;
  const base = fakeFetch({}, log);
  const fetchFn = async (u, init) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setImmediate(r)); try { return await base(u, init); } finally { inFlight--; } };
  const pages = Array.from({ length: 30 }, (_, i) => pg(i ? `/p${i}` : "/", { inlinks: 30 - i }, { textHash: "h" + i }));
  const waits = [];
  const robots = robotsParser(S + "/robots.txt", "User-agent: *\nCrawl-delay: 2\n");
  await siteProbeIssues({ start: S + "/", pages, robots, ua: "t", parse: parseHtml, resUrls: [S + "/a.css", S + "/b.js", S + "/c.js"], fetchFn,
    lookup: async () => { throw new Error("nx"); }, getCert: async () => ({ error: "x" }), sleep: async (ms) => { waits.push(ms); } });
  assert.ok(log.length <= PROBE_BUDGET, `${log.length} requests`);
  assert.ok(log.length >= 30, `${log.length} requests`);
  assert.equal(maxInFlight, 1);
  assert.ok(waits.length > 0 && waits.every((ms) => ms > 1000 && ms <= 2000), "waits the 2 s Crawl-delay");
  // A hard budget: the 61st request is refused without a fetch.
  const tiny = prober({ max: 2, gapMs: 0, fetchFn: fakeFetch({}, []) });
  await tiny(S + "/1"); await tiny(S + "/2");
  assert.equal((await tiny(S + "/3")).error, "BUDGET");
  // A Crawl-delay over 10 s: no HTTP probes at all.
  const log3 = [];
  await siteProbeIssues({ start: S + "/", pages, robots: robotsParser(S + "/robots.txt", "User-agent: *\nCrawl-delay: 30\n"), ua: "t", parse: parseHtml, fetchFn: fakeFetch({}, log3),
    lookup: async () => { throw new Error("nx"); }, getCert: async () => ({ error: "x" }) });
  assert.equal(log3.length, 0);
});
