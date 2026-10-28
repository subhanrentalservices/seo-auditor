// Fetch ladder (REQ-055 group 1, Oct 2026): bot-wall recognition, Retry-After waits and crawl slow-down, curl and
// real-browser fallbacks that obey robots.txt and keep request headers on the site's own hosts, and the three checks.
// curl, the browser and sleeping are faked, so nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const L = await import("../src/fetch-ladder.mjs");
const { botWall, retryAfterMs, createLadder, ladderSiteIssues, parseCurlOutput, curlConfig, curlArgs, curlFetch, browserAccess, browserFetch, lazyBrowser, AUDITOR_UA } = L;
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");

const S = "https://example.com";
const page = (title, body = "") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const ok = (url, extra = {}) => ({ status: 200, headers: new Headers({ "content-type": "text/html" }), type: "text/html", body: page("Real page", "<p>content</p>"), finalUrl: url, ms: 120, ...extra });
const res = (status, headers = {}, body = "", extra = {}) => ({ status, headers: new Headers({ "content-type": "text/html", ...headers }), type: "text/html",
  body: status < 300 ? body : "", wallBody: status >= 300 ? body : "", ms: 80, ...extra });
const CF_CHALLENGE = page("Just a moment...", '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>');
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

// ---------------- botWall ----------------
test("botWall recognises Cloudflare, Akamai, captcha and block pages", () => {
  assert.deepEqual(botWall({ status: 403, headers: new Headers({ "cf-mitigated": "challenge", "cf-ray": "1" }), body: CF_CHALLENGE }), { vendor: "Cloudflare", kind: "challenge" });
  assert.deepEqual(botWall({ status: 503, headers: { "cf-ray": "8a1", server: "cloudflare" }, body: page("Just a moment...") }), { vendor: "Cloudflare", kind: "challenge" });
  assert.deepEqual(botWall({ status: 403, headers: { server: "cloudflare" }, body: page("Attention Required! | Cloudflare", "Sorry, you have been blocked") }), { vendor: "Cloudflare", kind: "block" });
  assert.deepEqual(botWall({ status: 403, headers: { server: "AkamaiGHost" }, body: page("Access Denied", "You don't have permission to access this server. Reference&#32;&#35;18&#46;2c4e1402&#46;1730&#46;9f2a") }).vendor, "Akamai");
  assert.deepEqual(botWall({ status: 403, headers: {}, body: page("Access Denied", "Reference #18.2c4e1402.1730.9f2a") }), { vendor: "Akamai", kind: "block" });
  assert.equal(botWall({ status: 403, headers: {}, body: page("Security check", '<div class="g-recaptcha" data-sitekey="x"></div>') }).kind, "captcha");
  assert.equal(botWall({ status: 429, headers: {}, body: page("Blocked", "Are you a robot? Please confirm.") }).kind, "block");
  assert.equal(botWall({ status: 403, headers: {}, body: page("Error", "<h1>Request blocked.</h1>") }).kind, "block");
  assert.equal(botWall({ status: 403, headers: { "x-datadome": "protected" }, body: page("example.com", '<script src="https://ct.captcha-delivery.com/c.js"></script>') }).vendor, "DataDome");
  // A 200 challenge page counts only with a vendor sign or the CDN's own header.
  assert.deepEqual(botWall({ status: 200, headers: { "cf-mitigated": "challenge" }, body: page("Just a moment...") }), { vendor: "Cloudflare", kind: "challenge" });
  assert.equal(botWall({ status: 200, headers: {}, body: CF_CHALLENGE })?.kind, "challenge");
});

test("botWall leaves normal pages alone: a plain 403, a login, a 429 without a page, a contact form with a captcha", () => {
  const apache403 = page("403 Forbidden", "<h1>Forbidden</h1><p>You don't have permission to access this resource.</p><address>Apache/2.4.62 Server at example.com Port 443</address>");
  assert.equal(botWall({ status: 403, headers: { server: "Apache" }, body: apache403 }), null);
  assert.equal(botWall({ status: 401, headers: { "www-authenticate": 'Basic realm="staging"' }, body: page("Captcha login") }), null);
  assert.equal(botWall({ status: 429, headers: { "retry-after": "30" }, body: "" }), null);
  assert.equal(botWall({ status: 503, headers: {}, body: page("Down for maintenance", "Back soon") }), null);
  assert.equal(botWall({ status: 200, headers: {}, body: page("Contact us", `<form><div class="g-recaptcha"></div></form><p>${words(50)}</p>`) }), null);
  assert.equal(botWall({ status: 200, headers: {}, body: page("Just a moment with our team", words(400)) }), null); // a title alone isn't enough on a 200
  assert.equal(botWall({ status: 404, headers: {}, body: page("Not found", '<div class="g-recaptcha"></div>') }), null); // the site's own error page
  assert.equal(botWall({ status: 403, headers: {}, body: page("Members only", `<div class="g-recaptcha"></div><p>${words(400)}</p>`) }), null); // a full page, not a refusal page
});

test("retryAfterMs reads seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("30"), 30000);
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 10:00:10 GMT", Date.parse("Wed, 28 Oct 2026 10:00:00 GMT")), 10000);
  assert.equal(retryAfterMs("Wed, 28 Oct 2026 09:00:00 GMT", Date.parse("Wed, 28 Oct 2026 10:00:00 GMT")), 0);
  assert.equal(retryAfterMs(""), null);
  assert.equal(retryAfterMs("soon"), null);
  assert.equal(retryAfterMs(null), null);
});

// ---------------- The ladder ----------------
function harness({ direct, curl = null, browser = null, mode = "browser", concurrency = 8, blocked = () => false, headersFor = () => null, browserPages } = {}) {
  const log = { fetch: [], curl: [], browser: [], sleep: [] };
  const queue = [...[].concat(direct)];
  const ladder = createLadder({ mode, concurrency, browserPages, inScope: (u) => new URL(u).hostname.replace(/^www\./, "") === "example.com", blocked, headersFor,
    sleep: async (ms) => { log.sleep.push(ms); },
    fetchPage: async (u) => { log.fetch.push(u); const r = queue.length > 1 ? queue.shift() : queue[0]; return typeof r === "function" ? r(u) : { finalUrl: u, ...r }; },
    curl: curl && (async (u, o) => { log.curl.push([u, o.headers]); return typeof curl === "function" ? curl(u, o) : curl; }),
    browser: browser && (async (u, o) => { log.browser.push([u, o.headers]); return typeof browser === "function" ? browser(u, o) : browser; }) });
  return { ladder, log };
}

test("a normal answer goes straight through: no retry, no fallback", async () => {
  const { ladder, log } = harness({ direct: ok(S + "/a"), curl: ok(S + "/a"), browser: ok(S + "/a") });
  const r = await ladder.fetch(S + "/a");
  assert.equal(r.via, "fetch");
  assert.equal(r.ms, 120);
  assert.equal(log.curl.length + log.browser.length + log.sleep.length, 0);
});

test("429 with Retry-After: waits as asked, retries once, and the crawl slows down for the rest of the audit", async () => {
  const { ladder, log } = harness({ direct: [res(429, { "retry-after": "5" }), ok(S + "/a")], curl: ok(S + "/a") });
  assert.equal(ladder.parallel(), 8);
  const r = await ladder.fetch(S + "/a");
  assert.equal(r.via, "retry");
  assert.equal(r.status, 200);
  assert.deepEqual(log.sleep, [5000]);
  assert.equal(log.fetch.length, 2);
  assert.equal(log.curl.length, 0);
  assert.equal(ladder.parallel(), 4);
  assert.equal(r.rateLimited, true);
  const [[id, url, detail]] = ladderSiteIssues(ladder.stats, S + "/");
  assert.equal(id, "crawl_rate_limited");
  assert.equal(url, S + "/");
  assert.match(detail, /1 slow-down answer\(s\) \(HTTP 429 ×1\); Retry-After up to 5 s; waited 5 s in total and retried 1 page\(s\) once; parallel requests lowered from 8 to 4/);
});

test("a slow-down is never escalated: still 429 after the retry stays 429; a long Retry-After isn't retried early", async () => {
  const still = harness({ direct: res(429, { "retry-after": "2" }), curl: ok(S + "/a"), browser: ok(S + "/a") });
  const r = await still.ladder.fetch(S + "/a");
  assert.equal(r.status, 429);
  assert.equal(still.log.curl.length + still.log.browser.length, 0);
  assert.equal(still.ladder.stats.slowDowns, 2);
  assert.equal(still.ladder.parallel(), 2); // halved twice

  const long = harness({ direct: res(503, { "retry-after": "120" }), curl: ok(S + "/a") });
  const r2 = await long.ladder.fetch(S + "/a");
  assert.equal(r2.status, 503);
  assert.deepEqual(long.log.sleep, []);
  assert.equal(long.log.curl.length, 0); // a 503 with Retry-After is a slow-down, not a wall
  assert.match(ladderSiteIssues(long.ladder.stats, S + "/")[0][2], /1 not retried \(Retry-After over 60 s/);
});

test("the waiting budget per audit is capped; a 429 without Retry-After waits 10 s", async () => {
  const { ladder, log } = harness({ direct: (u) => ({ ...res(429, { "retry-after": "60" }), finalUrl: u }) });
  for (let i = 0; i < 5; i++) await ladder.fetch(`${S}/p${i}`);
  assert.deepEqual(log.sleep, [60000, 60000, 60000]); // 3 minutes, then no more waiting
  assert.equal(ladder.stats.notRetried, 2);
  assert.equal(ladder.parallel(), 1);
  const plain = harness({ direct: [res(429), ok(S + "/a")] });
  await plain.ladder.fetch(S + "/a");
  assert.deepEqual(plain.log.sleep, [10000]);
});

test("a Cloudflare challenge is read through curl: botWall recorded, timing not the server's", async () => {
  const { ladder, log } = harness({ direct: res(403, { "cf-mitigated": "challenge", "cf-ray": "1" }, CF_CHALLENGE), curl: { ...ok(S + "/a"), ms: 900, location: null }, browser: ok(S + "/a") });
  const r = await ladder.fetch(S + "/a");
  assert.equal(r.via, "curl");
  assert.equal(r.status, 200);
  assert.deepEqual(r.botWall, { vendor: "Cloudflare", kind: "challenge" });
  assert.equal(r.ms, null);
  assert.equal(r.fallbackMs, 900);
  assert.equal(r.directStatus, 403);
  assert.equal(log.browser.length, 0);
  assert.deepEqual(r.tried, ["curl"]);
});

test("curl refused too: the real browser gets the page; mode curl and off stop earlier", async () => {
  const wall = res(403, { server: "AkamaiGHost" }, page("Access Denied", "Reference #18.2c4e1402.1730.9f2a"));
  const b = harness({ direct: wall, curl: wall, browser: { ...ok(S + "/a"), finalUrl: S + "/a", redirect: null } });
  const r = await b.ladder.fetch(S + "/a");
  assert.equal(r.via, "browser");
  assert.equal(r.botWall.vendor, "Akamai");
  assert.deepEqual(r.tried, ["curl", "the browser"]);

  const c = harness({ direct: wall, curl: wall, browser: ok(S + "/a"), mode: "curl" });
  const rc = await c.ladder.fetch(S + "/a");
  assert.equal(rc.status, 403);
  assert.equal(c.log.browser.length, 0);
  assert.deepEqual(rc.tried, ["curl"]);

  const off = harness({ direct: wall, curl: ok(S + "/a"), browser: ok(S + "/a"), mode: "off" });
  const ro = await off.ladder.fetch(S + "/a");
  assert.equal(ro.status, 403);
  assert.equal(ro.botWall.vendor, "Akamai");
  assert.equal(off.log.curl.length + off.log.browser.length, 0);
});

test("fallbacks never fetch a robots.txt-disallowed URL or another site's page", async () => {
  const blocked = harness({ direct: (u) => ({ ...res(403), finalUrl: S + "/private/x" }), curl: ok(S + "/x"), browser: ok(S + "/x"), blocked: (u) => u.includes("/private/") });
  const r = await blocked.ladder.fetch(S + "/go");
  assert.equal(r.status, 403);
  assert.equal(blocked.log.curl.length + blocked.log.browser.length, 0);
  const offsite = harness({ direct: (u) => ({ ...res(403), finalUrl: "https://other.example.org/x" }), curl: ok("https://other.example.org/x") });
  await offsite.ladder.fetch(S + "/out");
  assert.equal(offsite.log.curl.length, 0);
});

test("curl redirects are followed by the ladder: headers only on own hosts, never into a disallowed URL", async () => {
  const secret = { Authorization: "Basic c3RhZ2U6cGFzcw==" };
  const hops = {
    [S + "/a"]: res(301, { location: "/b" }, "", { location: "/b" }),
    [S + "/b"]: res(302, { location: "https://cdn.example.net/c" }, "", { location: "https://cdn.example.net/c" }),
    "https://cdn.example.net/c": ok("https://cdn.example.net/c"),
  };
  const { ladder, log } = harness({ direct: res(403, { "cf-mitigated": "challenge" }), curl: (u) => hops[u], headersFor: (u) => (u.startsWith(S) ? secret : null) });
  const r = await ladder.fetch(S + "/a");
  assert.equal(r.via, "curl");
  assert.equal(r.finalUrl, "https://cdn.example.net/c");
  assert.deepEqual(r.redirect, { hops: 2, to: "https://cdn.example.net/c", firstStatus: 301, finalStatus: 200 });
  assert.deepEqual(log.curl.map(([u, h]) => [u, Boolean(h)]), [[S + "/a", true], [S + "/b", true], ["https://cdn.example.net/c", false]]);

  const stop = harness({ direct: res(403), curl: (u) => (u === S + "/a" ? res(301, { location: "/private" }, "", { location: "/private" }) : ok(u)), blocked: (u) => u.endsWith("/private") });
  const r2 = await stop.ladder.fetch(S + "/a");
  assert.deepEqual(stop.log.curl.map(([u]) => u), [S + "/a"]);
  assert.equal(r2.status, 301); // the redirect is what the crawl records; its disallowed target is never fetched
});

test("the browser fallback is capped per audit, and a browser that can't start is tried once", async () => {
  const { ladder, log } = harness({ direct: (u) => ({ ...res(403), finalUrl: u }), curl: res(403), browser: (u) => ok(u), browserPages: 2 });
  for (let i = 0; i < 4; i++) await ladder.fetch(`${S}/p${i}`);
  assert.equal(log.browser.length, 2);
  assert.equal(ladder.stats.via.browser, 2);
  const broken = createLadder({ fetchPage: async (u) => ({ ...res(403), finalUrl: u }), browser: async () => { throw new Error("No browser found"); } });
  const r = await broken.fetch(S + "/x");
  assert.equal(r.status, 403);
  assert.equal(broken.stats.browserUnavailable, true);
});

test("status 0 (no answer) and a plain 403 also try the fallbacks; a 401 asking for a login doesn't", async () => {
  const z = harness({ direct: { status: 0, headers: new Headers(), body: "", error: "ECONNRESET" }, curl: ok(S + "/a") });
  assert.equal((await z.ladder.fetch(S + "/a")).via, "curl");
  const auth = harness({ direct: res(401, { "www-authenticate": "Basic" }), curl: ok(S + "/a") });
  assert.equal((await auth.ladder.fetch(S + "/a")).status, 401);
  assert.equal(auth.log.curl.length, 0);
});

// ---------------- curl ----------------
test("curl output is parsed: 100 Continue and proxy blocks skipped, error bodies kept only as wallBody", () => {
  const out = Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/2 200\r\ncontent-type: text/html; charset=utf-8\r\nx-robots-tag: noindex\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n\r\n<html><title>Hi</title></html>");
  const r = parseCurlOutput(out);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal(r.body, "<html><title>Hi</title></html>");
  assert.equal(r.wallBody, "");
  const proxied = parseCurlOutput(Buffer.from("HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n\r\n<title>Just a moment...</title>"));
  assert.equal(proxied.status, 403);
  assert.equal(proxied.body, "");
  assert.match(proxied.wallBody, /Just a moment/);
  const redirect = parseCurlOutput(Buffer.from("HTTP/1.1 301 Moved\nLocation: /b\n\n"));
  assert.equal(redirect.location, "/b");
  assert.equal(parseCurlOutput(Buffer.from("")).status, 0);
  assert.equal(parseCurlOutput(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n${"x".repeat(100)}`), 10).body.length, 10);
});

test("curl gets custom headers on stdin, never on its command line", async () => {
  const args = curlArgs(S + "/a");
  assert.ok(args.includes("-K") && args.includes("-") && !args.includes("-L"));
  assert.ok(args.includes(AUDITOR_UA)); // the crawler's own identity, not a browser disguise
  assert.ok(curlArgs(S + "/a", { ua: "MyBot/2" }).includes("MyBot/2"));
  assert.equal(curlConfig({ Cookie: 'bypass="x\\y"' }), 'header = "Cookie: bypass=\\"x\\\\y\\""\n');
  let seen = null, stdin = "";
  const spawnFn = (cmd, a) => {
    seen = a;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: (s) => { stdin = s; setImmediate(() => { child.stdout.emit("data", Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<p>ok</p>")); child.emit("close", 0); }); } });
    child.kill = () => {};
    return child;
  };
  const r = await curlFetch(S + "/a", { headers: { "X-Bypass-Token": "s3cret-value" }, spawnFn });
  assert.equal(r.status, 200);
  assert.equal(r.body, "<p>ok</p>");
  assert.ok(!seen.join(" ").includes("s3cret-value"));
  assert.match(stdin, /X-Bypass-Token: s3cret-value/);
  const missing = await curlFetch(S + "/a", { spawnFn: () => { throw new Error("ENOENT"); } });
  assert.equal(missing.status, 0);
  assert.equal(missing.error, "curl not available");
});

// ---------------- Browser ----------------
test("browserAccess: cookies stay on the page's host, Basic auth on its origin, other headers aren't sent", () => {
  const a = browserAccess({ Cookie: "bypass=abc; region=au", Authorization: "Basic " + Buffer.from("stage:pa:ss").toString("base64"), "X-Token": "t" }, S + "/a?b=1");
  assert.deepEqual(a.cookies, [{ name: "bypass", value: "abc", url: S }, { name: "region", value: "au", url: S }]);
  assert.deepEqual(a.httpCredentials, { username: "stage", password: "pa:ss", origin: S });
  assert.deepEqual(a.skipped, ["X-Token"]);
  assert.deepEqual(browserAccess(null, S), { cookies: [], httpCredentials: null, skipped: [] });
});

test("browserFetch: images and disallowed URLs are never requested; the served document is returned", async () => {
  const routed = [], made = {};
  const navResponse = (url, status, redirectedFrom = null) => {
    const req = { isNavigationRequest: () => true, redirectedFrom: () => redirectedFrom, response: async () => ({ status: () => status }) };
    return { url: () => url, status: () => status, request: () => req, frame: () => "main", allHeaders: async () => ({ "content-type": "text/html", "set-cookie": "a=1\nb=2" }), text: async () => page("Real page", "<p>hello</p>") };
  };
  const fakePage = {
    handlers: {}, title: async () => "Real page", mainFrame: () => "main",
    route: async (_, fn) => { fakePage.router = fn; },
    on: (ev, fn) => { fakePage.handlers[ev] = fn; },
    goto: async (url) => {
      for (const [u, type] of [["https://example.com/logo.png", "image"], ["https://example.com/private/data.json", "fetch"], ["https://example.com/app.js", "script"]]) {
        fakePage.router({ request: () => ({ url: () => u, resourceType: () => type }), abort: () => routed.push(["abort", u]), continue: () => routed.push(["continue", u]) });
      }
      const first = { isNavigationRequest: () => true, redirectedFrom: () => null, response: async () => ({ status: () => 301 }) }; // http → https
      fakePage.handlers.response(navResponse(url, 200, first));
    },
    waitForFunction: async () => {}, waitForLoadState: async () => {},
  };
  const browser = { newContext: async (opts) => { made.opts = opts; return { addCookies: async (c) => { made.cookies = c; }, newPage: async () => fakePage, close: async () => { made.closed = true; } }; } };
  const r = await browserFetch(browser, S + "/a", { headers: { Cookie: "bypass=abc" }, blocked: (u) => u.includes("/private/") });
  assert.equal(r.status, 200);
  assert.match(r.body, /hello/);
  assert.equal(r.headers.get("set-cookie"), "a=1, b=2");
  assert.deepEqual(r.redirect, { hops: 1, to: S + "/a", firstStatus: 301, finalStatus: 200 });
  assert.deepEqual(routed, [["abort", "https://example.com/logo.png"], ["abort", "https://example.com/private/data.json"], ["continue", "https://example.com/app.js"]]);
  assert.equal(made.opts.userAgent, AUDITOR_UA);
  assert.deepEqual(made.cookies, [{ name: "bypass", value: "abc", url: S }]);
  assert.equal(made.closed, true);
});

test("lazyBrowser launches once, only when asked, and closes only its own browser", async () => {
  let launched = 0, closed = 0;
  const own = lazyBrowser(null, async () => { launched++; return { close: async () => { closed++; } }; });
  await own.close();
  assert.equal(launched, 0);
  await own.get(); await own.get();
  assert.equal(launched, 1);
  await own.close();
  assert.equal(closed, 1);
  const shared = { close: async () => { throw new Error("must not close the rendering browser"); } };
  const s = lazyBrowser(shared, async () => { throw new Error("must not launch"); });
  assert.equal(await s.get(), shared);
  await s.close();
});

// ---------------- Checks ----------------
const pg = (data, over = {}) => ({ url: S + "/a", final_url: S + "/a", status: 200, content_type: "text/html", indexable: 1, title: "A page title for the tests here",
  description: "x".repeat(130), h1: "Heading", words: 300, text_ratio: 20, depth: 0, outlinks: 1, canonical: S + "/a", response_ms: 3000,
  data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en", ...data }, ...over });
const ids = (xs) => xs.map((x) => x[0]);

test("the three checks are catalogued with the right severity and show under Crawlability", () => {
  for (const [id, sev] of Object.entries({ bot_wall_blocked: "warning", fetched_via_fallback: "notice", crawl_rate_limited: "notice" })) {
    assert.equal(CHECKS[id]?.[0], sev, id);
    assert.equal(CHECKS[id].length, 4, id);
    assert.ok(CRAWL.has(id), id);
  }
  assert.match(CHECKS.bot_wall_blocked[3], /allowlist verified Googlebot/i);
  assert.match(CHECKS.bot_wall_blocked[3], /URL Inspection/);
});

test("pageIssues: a walled page is bot_wall_blocked, not a 4xx; fallback pages skip the speed checks", () => {
  const walled = pageIssues(pg({ botWall: { vendor: "Cloudflare", kind: "challenge", status: 403 }, fetchedVia: "fetch", fallbackTried: ["curl", "the browser"] }, { status: 403, response_ms: 50 }), {});
  assert.deepEqual(ids(walled), ["bot_wall_blocked"]);
  assert.equal(walled[0][1], "Cloudflare challenge page (HTTP 403); still refused after curl and the browser");
  const viaCurl = pageIssues(pg({ botWall: { vendor: "unknown", kind: "captcha", status: 403 }, fetchedVia: "curl", directStatus: 403 }, { response_ms: null }), {});
  // A wall the fallback got past is information only: the tool can't tell whether verified Googlebot is let through.
  assert.ok(!ids(viaCurl).includes("bot_wall_blocked"));
  assert.equal(viaCurl.find((x) => x[0] === "fetched_via_fallback")[1], "loaded via curl after the normal request got captcha page (HTTP 403)");
  const noWall = pageIssues(pg({ fetchedVia: "curl", directStatus: 403 }, { response_ms: null }), {});
  assert.equal(noWall.find((x) => x[0] === "fetched_via_fallback")[1], "loaded via curl after the normal request got HTTP 403");
  // A browser-fetched page with a (meaningless) response time still skips the speed checks.
  const viaBrowser = ids(pageIssues(pg({ fetchedVia: "browser", directStatus: 0 }, { response_ms: 6000 }), {}));
  assert.ok(viaBrowser.includes("fetched_via_fallback") && !viaBrowser.includes("very_slow") && !viaBrowser.includes("slow_page"));
  // Direct and retried pages keep them; a plain 403 without a wall is still a 4xx.
  assert.ok(ids(pageIssues(pg({ fetchedVia: "retry" }), {})).includes("slow_page"));
  assert.ok(ids(pageIssues(pg({ fetchedVia: "fetch" }, { status: 403 }), {})).includes("http_4xx"));
  assert.deepEqual(ladderSiteIssues({ slowDowns: 0 }, S), []);
});
