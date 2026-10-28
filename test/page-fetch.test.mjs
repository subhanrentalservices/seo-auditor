// Fetching quality (REQ-055 group 2, Oct 2026): charsets from real non-UTF-8 bytes, the streamed size cap, transient
// retries and the cookie-required redirect loop. fetch and sleeping are faked, so nothing touches the network.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { decodeBody, declaredCharset, headerCharset, bomOf, encodingOf, readBody } = await import("../src/body.mjs");
const { fetchOnce, fetchFollow, fetchRetrying, isTransient, errorText, parseSetCookie, cookieJar } = await import("../src/page-fetch.mjs");
const { parseCurlOutput } = await import("../src/fetch-ladder.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");

const S = "https://example.com";
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
// Real encoded bytes: "日本語" in Shift_JIS, "中文" in GBK, "Café €5" in windows-1252, "Привет" in windows-1251.
const SJIS = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea], GBK = [0xd6, 0xd0, 0xce, 0xc4], CP1252 = bytes("Caf", [0xe9], " ", [0x80], "5");
const CP1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];
const html = (head, body) => bytes(`<!doctype html><html><head>${head}<title>`, body, "</title></head><body></body></html>");
const title = (s) => /<title>(.*?)<\/title>/.exec(s)[1];

test("charset: the Content-Type header's charset decodes Shift_JIS and windows-1251 bytes", () => {
  assert.equal(title(decodeBody(html("", SJIS), "text/html; charset=Shift_JIS").text), "日本語");
  assert.equal(title(decodeBody(html("", CP1251), 'text/html; charset="windows-1251"').text), "Привет");
  assert.equal(headerCharset("text/html;charset=utf-8"), "utf-8");
  assert.equal(encodingOf("latin1"), "windows-1252"); // WHATWG labels
  assert.equal(encodingOf("no-such-charset"), null);
});

test("charset: <meta charset> and http-equiv in the first 1,024 bytes; an unknown header label falls through to them", () => {
  assert.deepEqual(decodeBody(html('<meta charset="windows-1252">', CP1252), "text/html"), { text: decodeBody(html('<meta charset="windows-1252">', CP1252), "text/html").text, charset: "windows-1252", source: "meta" });
  assert.equal(title(decodeBody(html('<meta charset="windows-1252">', CP1252), "text/html").text), "Café €5");
  assert.equal(title(decodeBody(html('<meta http-equiv="Content-Type" content="text/html; charset=gbk">', GBK), "text/html").text), "中文");
  assert.equal(title(decodeBody(html("<meta charset=shift_jis>", SJIS), "text/html; charset=bogus").text), "日本語");
  // Not a declaration: charset= in another meta's content, a meta inside a comment, a meta after the first 1,024 bytes.
  assert.equal(declaredCharset(bytes('<meta name="description" content="charset=gbk">')), null);
  assert.equal(declaredCharset(bytes('<!-- <meta charset="gbk"> --><meta charset="utf-8">')), "utf-8");
  assert.equal(declaredCharset(bytes(" ".repeat(1100) + '<meta charset="gbk">')), null);
  // A meta naming UTF-16 means UTF-8; an XML declaration counts for XML.
  assert.equal(declaredCharset(bytes('<meta charset="utf-16">')), "utf-8");
  assert.equal(title(decodeBody(bytes('<?xml version="1.0" encoding="windows-1252"?><title>', CP1252, "</title>"), "application/xml").text), "Café €5");
});

test("charset: a byte order mark wins, even over the header; UTF-8 is the default", () => {
  const utf8 = bytes([0xef, 0xbb, 0xbf], Buffer.from("<title>Café</title>", "utf8"));
  assert.equal(bomOf(utf8), "utf-8");
  assert.deepEqual([title(decodeBody(utf8, "text/html; charset=windows-1252").text), decodeBody(utf8, "text/html; charset=windows-1252").source], ["Café", "bom"]);
  const le = bytes([0xff, 0xfe], Buffer.from("<title>Ünïcode</title>", "utf16le"));
  assert.equal(title(decodeBody(le, "text/html").text), "Ünïcode");
  assert.deepEqual([title(decodeBody(Buffer.from("<title>Café</title>", "utf8"), "text/html").text), decodeBody(Buffer.from("x"), "text/html").source], ["Café", "default"]);
});

const stream = (chunks, log = []) => new ReadableStream({ pull(c) { const x = chunks.shift(); log.push(x ? x.length : "end"); if (x) c.enqueue(x); else c.close(); } });

test("fetchOnce decodes the page in its charset, reports the bytes served and keeps the charset when not UTF-8", async () => {
  const fetchFn = async () => new Response(html('<meta charset="shift_jis">', SJIS), { status: 200, headers: { "content-type": "text/html" } });
  const r = await fetchOnce(S + "/jp", "UA", "GET", 5000, null, { fetchFn });
  assert.equal(title(r.body), "日本語");
  assert.equal(r.charset, "shift_jis");
  assert.equal(r.size, html('<meta charset="shift_jis">', SJIS).length);
  // curl output is decoded the same way.
  const curl = parseCurlOutput(Buffer.concat([Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=gbk\r\n\r\n"), html("", GBK)]));
  assert.equal(title(curl.body), "中文");
});

test("size cap: the body is read as a stream and stops at the cap; the true size still reaches the 2 MB check", async () => {
  const log = [], chunk = () => new Uint8Array(400_000).fill(0x61);
  const res = new Response(stream([chunk(), chunk(), chunk(), chunk(), chunk()], log), { headers: { "content-type": "text/html" } });
  const b = await readBody(res, 1_000_000);
  assert.equal(b.truncated, true);
  assert.equal(b.buf.length, 1_000_000);
  assert.ok(b.size > 1_000_000);
  assert.ok(log.length < 5, "the rest of the body isn't downloaded");
  // A 3 MB page under the 15 MB cap is read in full; large_html sees its real size.
  const big = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const r = await fetchOnce(S + "/big", "UA", "GET", 5000, null, { fetchFn: async () => new Response(big, { headers: { "content-type": "text/html" } }) });
  assert.equal(r.size, big.length);
  assert.equal(r.truncated, undefined);
  const capped = await fetchOnce(S + "/big", "UA", "GET", 5000, null, { maxBytes: 1024 * 1024, fetchFn: async () => new Response(big, { headers: { "content-type": "text/html" } }) });
  assert.equal(capped.truncated, true);
  assert.equal(capped.body.length, 1024 * 1024);
  const issues = pageIssues({ url: S + "/big", final_url: S + "/big", status: 200, content_type: "text/html", bytes: r.size, words: 300, title: "A page title that is long enough", indexable: 1, data: {} }, {});
  assert.ok(issues.some(([id]) => id === "large_html"));
});

const netError = (code, message = `read ${code}`) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

test("transient failures are retried twice with a short backoff; others keep their real error", async () => {
  assert.equal(errorText(netError("ECONNRESET")), "read ECONNRESET");
  assert.equal(errorText(netError("UND_ERR_SOCKET", "other side closed")), "UND_ERR_SOCKET: other side closed");
  assert.equal(errorText(Object.assign(new Error("x"), { name: "AbortError" })), "timeout");
  for (const r of [{ status: 502 }, { status: 504 }, { status: 0, error: "read ECONNRESET" }, { status: 0, error: "socket hang up" }, { status: 0, error: "getaddrinfo EAI_AGAIN example.com" }, { status: 0, error: "connect ETIMEDOUT 1.2.3.4:443" }])
    assert.equal(isTransient(r), true, JSON.stringify(r));
  for (const r of [{ status: 503 }, { status: 404 }, { status: 500 }, { status: 0, error: "timeout" }, { status: 0, error: "getaddrinfo ENOTFOUND example.com" }])
    assert.equal(isTransient(r), false, JSON.stringify(r));

  let n = 0; const slept = [];
  const flaky = async () => { if (++n <= 2) throw netError("ECONNRESET"); return new Response("<title>ok</title>", { headers: { "content-type": "text/html" } }); };
  const ok = await fetchRetrying(S + "/a", "UA", null, { fetchFn: flaky, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual([ok.status, ok.retries, slept], [200, 2, [500, 1500]]);

  let m = 0;
  const gateway = await fetchRetrying(S + "/b", "UA", null, { fetchFn: async () => { m++; return new Response("bad gateway", { status: 502 }); }, sleep: async () => {} });
  assert.deepEqual([gateway.status, gateway.retries, m], [502, 2, 3]); // still failing: the real answer is kept

  let k = 0;
  const dns = await fetchRetrying(S + "/c", "UA", null, { fetchFn: async () => { k++; throw netError("ENOTFOUND", "getaddrinfo ENOTFOUND example.com"); }, sleep: async () => {} });
  assert.deepEqual([dns.status, dns.retries, dns.error, k], [0, undefined, "getaddrinfo ENOTFOUND example.com", 1]);

  // fetchFollow adds up the retries of every hop.
  let hops = 0;
  const follow = await fetchFollow(S + "/old", "UA", () => null, { sleep: async () => {}, fetchFn: async (u) => {
    if (++hops === 1) throw netError("ECONNRESET");
    return u.endsWith("/old") ? new Response(null, { status: 301, headers: { location: "/new" } }) : new Response("<title>new</title>", { headers: { "content-type": "text/html" } });
  } });
  assert.deepEqual([follow.status, follow.finalUrl, follow.retries], [200, S + "/new", 1]);
});

test("cookies: parsed per host and path, other sites' cookies ignored, deleted when expired", () => {
  assert.deepEqual(parseSetCookie("sid=abc; Path=/; HttpOnly; Secure", S + "/a/b"), { name: "sid", value: "abc", domain: "example.com", hostOnly: true, expired: false, path: "/" });
  assert.equal(parseSetCookie("x=1; Domain=other.org", S + "/"), null);
  assert.equal(parseSetCookie("x=1; Domain=.example.com", "https://www.example.com/").domain, "example.com");
  const jar = cookieJar();
  jar.set(["a=1; Path=/", "b=2; Path=/shop", "c=3; Domain=example.com"], "https://www.example.com/");
  assert.equal(jar.header("https://www.example.com/shop/x"), "a=1; b=2; c=3");
  assert.equal(jar.header("https://www.example.com/blog"), "a=1; c=3");
  assert.equal(jar.header("https://example.com/"), "c=3");
  jar.set(["a=; Max-Age=0"], "https://www.example.com/");
  assert.deepEqual(jar.names(), ["b", "c"]);
});

/** A site whose /a sets a cookie and bounces through /check back to /a until the cookie comes back. */
function cookieSite(log, { setCookie = true, helps = true } = {}) {
  return async (u, init) => {
    const x = new URL(u), cookie = init.headers.Cookie || "";
    log.push([x.pathname, cookie]);
    if (x.pathname === "/a") return helps && /seen=1/.test(cookie) ? new Response("<title>A</title>", { headers: { "content-type": "text/html" } })
      : new Response(null, { status: 302, headers: { location: "/check", ...(setCookie ? { "set-cookie": "seen=1; Path=/" } : {}) } });
    if (x.pathname === "/check") return new Response(null, { status: 302, headers: { location: "/a" } });
    return new Response("nf", { status: 404 });
  };
}

test("a redirect loop the server's own cookie resolves is cookie_required_redirect; the page stays the cookie-less loop", async () => {
  const log = [];
  const r = await fetchFollow(S + "/a", "UA", () => ({ "X-Own": "1" }), { fetchFn: cookieSite(log) });
  assert.equal(r.redirect.loop, true);
  assert.equal(r.status, 302);
  assert.deepEqual(r.cookieLoop, { status: 200, to: S + "/a", hops: 0, cookies: ["seen"] });
  assert.deepEqual(log, [["/a", ""], ["/check", ""], ["/a", "seen=1"]]); // first pass without cookies, then the replay
  const issues = pageIssues({ url: S + "/a", final_url: S + "/a", status: 302, content_type: "", data: { redirect: r.redirect, cookieRedirect: r.cookieLoop } }, {});
  assert.deepEqual(issues.find(([id]) => id === "cookie_required_redirect"), ["cookie_required_redirect", `with the cookie seen the chain ends at ${S}/a (HTTP 200) after 0 hop(s)`]);
  assert.ok(issues.some(([id]) => id === "redirect_chain"));
  assert.deepEqual([CHECKS.cookie_required_redirect[0], CRAWL.has("cookie_required_redirect")], ["warning", true]);
});

test("no cookie replay without Set-Cookie, nothing reported when cookies don't help, and never into a blocked URL", async () => {
  const quiet = [];
  const a = await fetchFollow(S + "/a", "UA", () => null, { fetchFn: cookieSite(quiet, { setCookie: false }) });
  assert.equal(a.cookieLoop, undefined);
  assert.equal(quiet.length, 2);
  const stuck = [];
  const b = await fetchFollow(S + "/a", "UA", () => null, { fetchFn: cookieSite(stuck, { helps: false }) });
  assert.equal(b.cookieLoop, undefined);
  assert.ok(stuck.length <= 2 + 11, "the replay is capped at 10 hops");
  const blocked = [];
  const c = await fetchFollow(S + "/a", "UA", () => null, { fetchFn: cookieSite(blocked), blocked: (u) => u.endsWith("/a") });
  assert.equal(c.cookieLoop, undefined);
  assert.equal(blocked.length, 2);
});
