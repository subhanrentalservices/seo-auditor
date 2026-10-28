// Fetch ladder for crawled pages (REQ-055 group 1, Oct 2026). When one of the site's own pages refuses the crawler's
// normal request, it is asked again the ways a visitor's tools would ask, in order:
//   1. a 429, or a 503 with Retry-After ("slow down"): wait as long as the site asks (at most 60 s, 3 min per audit)
//      and retry once; the whole crawl also drops to fewer parallel requests for the rest of the audit;
//   2. curl, with the browser headers the checker already uses for external links (status, headers and body);
//   3. a real browser (Playwright), launched only when needed and for at most 50 pages per audit.
// No third-party scraping service, no disguise beyond that browser user agent, nothing is solved or clicked: a page
// that still shows a challenge stays refused. robots.txt is obeyed by every step, including the browser's redirects
// and files. A slow-down answer is never escalated to curl or the browser. botWall() recognises bot challenge and
// firewall block pages. curl, the browser and sleeping are injected, so tests need no network.
import { spawn } from "node:child_process";
import { decodeBody, MAX_HTML } from "./body.mjs";

export const AUDITOR_UA = "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)"; // the default crawl user agent (db.mjs)
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
export const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const REFUSED = new Set([401, 403, 429, 503]);
export const RETRY_MAX_MS = 60_000;    // a longer Retry-After isn't retried early: the page stays as answered
export const WAIT_BUDGET_MS = 180_000; // total waiting per audit
export const DEFAULT_429_MS = 10_000;  // a 429 without Retry-After
export const BROWSER_PAGES = 50;       // browser fallbacks per audit
export const MAX_BODY = MAX_HTML; // 15 MB, as for the normal fetch (body.mjs)
export const WALL_BODY = 64 * 1024;    // kept from a refused answer, only to recognise a challenge page
export const FALLBACK_MODES = ["off", "curl", "browser"];

const hget = (h, k) => String((typeof h?.get === "function" ? h.get(k) : h?.[k] ?? h?.[k.toLowerCase()]) ?? "");

/** Reads at most `max` bytes of a fetch Response body as text (in its declared charset), then drops the rest. */
export async function readCapped(res, max = WALL_BODY) {
  if (!res.body) return "";
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  try {
    while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; }
  } finally { reader.cancel().catch(() => {}); }
  return decodeBody(Buffer.concat(parts).subarray(0, max), res.headers?.get?.("content-type") || "").text;
}

// ---------------- Bot walls ----------------
// Titles of interstitial check pages (Cloudflare "Just a moment...", Sucuri, DDoS-Guard and similar) and block pages.
const CHECK_TITLE = /^(?:just a moment|checking (?:your|if the site connection is secure)|verify(?:ing)? you are (?:a )?human|one more step|please wait while we verify|security check|ddos-guard)/;
const BLOCK_TITLE = /attention required|you have been blocked|^access denied\b.*\b(?:sucuri|firewall)|^request (?:blocked|rejected)/;
// Scripts and endpoints that only challenge pages load.
const CHALLENGE_SCRIPT = /\/cdn-cgi\/challenge-platform\/|_cf_chl_opt|\bcf-chl-|captcha-delivery\.com|_incapsula_resource|sucuri_cloudproxy_js|awswaf\.com|ddos-guard\.net\/|\/_sec\/cp_challenge\//;
const CAPTCHA_WIDGET = /\bg-recaptcha\b|\bh-captcha\b|hcaptcha\.com\/1\/api|\bcf-turnstile\b|challenges\.cloudflare\.com\/turnstile|px-captcha|arkoselabs\.com|funcaptcha/;
const BLOCK_TEXT = /are you a (?:robot|human)|request (?:was )?blocked|request unsuccessful\. incapsula|you have been blocked|automated (?:access|requests?|queries)|unusual traffic from your (?:computer|network)|bot protection|pardon our interruption/;
const AKAMAI_REF = /reference\s*(?:#|&#35;|&#32;&#35;)\s*[\d.]+[0-9a-f]/i;

function vendorOf(h, text) {
  const server = hget(h, "server").toLowerCase();
  if (hget(h, "cf-ray") || hget(h, "cf-mitigated") || server.includes("cloudflare") || /\/cdn-cgi\/|_cf_chl|cloudflare/.test(text)) return "Cloudflare";
  if (server.includes("akamai") || /errors\.edgesuite\.net|akamai/.test(text)) return "Akamai";
  if (hget(h, "x-sucuri-id") || server.includes("sucuri") || text.includes("sucuri")) return "Sucuri";
  if (hget(h, "x-iinfo") || /incapsula|imperva/.test(text)) return "Imperva";
  if (hget(h, "x-datadome") || /captcha-delivery\.com|datadome/.test(text)) return "DataDome";
  if (/px-captcha|perimeterx|_pxappid/.test(text)) return "HUMAN (PerimeterX)";
  if (hget(h, "x-amzn-waf-action") || /awswaf|aws-waf-token/.test(text)) return "AWS WAF";
  if (hget(h, "x-vercel-mitigated")) return "Vercel";
  if (server.includes("ddos-guard") || text.includes("ddos-guard")) return "DDoS-Guard";
  return "unknown";
}

/** A bot challenge or firewall block page, or null. headers: a Headers object or a plain object; body: the HTML
 *  (only the first 200 KB is read). Returns { vendor, kind } with kind "challenge" (a browser check page),
 *  "captcha" or "block". A 200 page counts only with a CDN's own mitigation header or a check-page title plus a
 *  vendor sign (a contact form with a reCAPTCHA is a normal page); a 401 asking for HTTP authentication is a login,
 *  not a bot wall; a plain 403/429/503 without these markers is not one either. */
export function botWall({ status = 0, headers = {}, body = "" } = {}) {
  const html = String(body || "").slice(0, 200_000), text = html.toLowerCase();
  const title = (/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim().toLowerCase();
  const vendor = () => vendorOf(headers, text);
  const mitigated = [hget(headers, "cf-mitigated"), hget(headers, "x-vercel-mitigated"), hget(headers, "x-amzn-waf-action")].join(" ").toLowerCase();
  if (/captcha/.test(mitigated)) return { vendor: vendor(), kind: "captcha" };
  if (/challenge/.test(mitigated)) return { vendor: vendor(), kind: "challenge" };
  if (/\bblock/.test(mitigated)) return { vendor: vendor(), kind: "block" };
  if (status === 401 && hget(headers, "www-authenticate")) return null;
  if (status < 400) return CHECK_TITLE.test(title) && (vendor() !== "unknown" || CHALLENGE_SCRIPT.test(text)) ? { vendor: vendor(), kind: "challenge" } : null;
  if (!REFUSED.has(status)) return null; // a 404 or 500 page is the site's own error page
  if (CHECK_TITLE.test(title)) return { vendor: vendor(), kind: CAPTCHA_WIDGET.test(text) ? "captcha" : "challenge" };
  if (/^access denied/.test(title) && AKAMAI_REF.test(html)) return { vendor: vendor() === "unknown" ? "Akamai" : vendor(), kind: "block" };
  if (BLOCK_TITLE.test(title)) return { vendor: vendor(), kind: CAPTCHA_WIDGET.test(text) ? "captcha" : "block" };
  if (CHALLENGE_SCRIPT.test(text)) return { vendor: vendor(), kind: CAPTCHA_WIDGET.test(text) ? "captcha" : "challenge" };
  const visible = (title + " " + text.slice(0, 50_000).replace(/<(script|style)[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  // A captcha widget counts on a short refusal page only: a full page that happens to carry a form's widget is the site's own.
  if (/captcha/.test(title) || (CAPTCHA_WIDGET.test(text) && visible.split(" ").length < 300)) return { vendor: vendor(), kind: "captcha" };
  if (BLOCK_TEXT.test(visible)) return { vendor: vendor(), kind: "block" };
  return null;
}

/** Retry-After (seconds or an HTTP date) in ms, or null when absent or unreadable. */
export function retryAfterMs(value, now = Date.now()) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

// ---------------- curl ----------------
/** curl options read from stdin (-K -): custom headers go there, so their values never appear in the process list. */
export function curlConfig(headers) {
  const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return Object.entries(headers || {}).map(([k, v]) => `header = ${q(`${k}: ${v}`)}\n`).join("");
}
// The fallbacks keep the crawl's own user agent: a refused crawler doesn't come back disguised as a browser.
export const curlArgs = (url, { ua = AUDITOR_UA, timeoutS = 20 } = {}) => ["-s", "-i", "--compressed", "-m", String(timeoutS), "-A", ua,
  "-H", `Accept: ${ACCEPT}`, "-H", "Accept-Language: en-AU,en;q=0.9", "-K", "-", url];

/** curl -i output → { status, headers, type, body, wallBody, location }. Skips 1xx and proxy CONNECT blocks; the body
 *  is kept for text types (as body below 300, as wallBody for an error answer), at most maxBytes. */
export function parseCurlOutput(buf, maxBytes = MAX_BODY) {
  let rest = Buffer.from(buf || []);
  for (let guard = 0; guard < 6; guard++) {
    const s = rest.subarray(0, 65536).toString("latin1"); // one char per byte: indexes are byte offsets
    const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(s), sep = /\r?\n\r?\n/.exec(s);
    if (!m || !sep) break;
    const status = Number(m[1]), after = rest.subarray(sep.index + sep[0].length);
    if ((status < 200 || /^HTTP\/[\d.]+\s+200 connection established/i.test(s)) && /^HTTP\/[\d.]+\s+\d{3}/.test(after.subarray(0, 20).toString("latin1"))) { rest = after; continue; }
    const headers = new Headers();
    for (const line of s.slice(0, sep.index).split(/\r?\n/).slice(1)) {
      const i = line.indexOf(":");
      if (i > 0) try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* not a valid header line */ }
    }
    const type = headers.get("content-type") || "";
    const text = /html|xml|text/.test(type) ? decodeBody(after.subarray(0, maxBytes), type).text : "";
    return { status, headers, type, body: status < 300 ? text : "", wallBody: status >= 300 ? text.slice(0, WALL_BODY) : "", location: headers.get("location") };
  }
  return { status: 0, headers: new Headers(), type: "", body: "", wallBody: "", location: null, error: "no HTTP response from curl" };
}

/** One request with curl (no redirects followed: the ladder follows them, checking robots.txt and where headers may
 *  go). Returns parseCurlOutput's fields plus ms, and truncated when the body passed maxBytes. */
export function curlFetch(url, { headers = null, ua = AUDITOR_UA, timeoutS = 20, maxBytes = MAX_BODY, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(), chunks = [];
    let n = 0, truncated = false, settled = false, child, killer;
    const finish = (out) => { if (settled) return; settled = true; clearTimeout(killer); resolve({ ...out, ms: Date.now() - t0, ...(truncated ? { truncated: true } : {}) }); };
    const none = { status: 0, headers: new Headers(), type: "", body: "", wallBody: "", location: null, error: "curl not available" };
    try { child = spawnFn("curl", curlArgs(url, { ua, timeoutS }), { windowsHide: true }); } catch { return finish(none); }
    killer = setTimeout(() => child.kill(), (timeoutS + 5) * 1000);
    child.on("error", () => finish(none));
    child.stdout.on("data", (b) => { if (truncated) return; chunks.push(b); n += b.length; if (n > maxBytes + 65536) { truncated = true; child.kill(); } });
    child.on("close", () => finish(parseCurlOutput(Buffer.concat(chunks), maxBytes)));
    child.stdin.on("error", () => {});
    child.stdin.end(curlConfig(headers));
  });
}

// ---------------- Real browser ----------------
const SKIP_TYPES = new Set(["image", "media", "font"]); // not needed to read the page's HTML

/** What of the project's request headers a browser can send without leaking them to other hosts: cookies (the
 *  browser keeps them to this host) and Basic authentication (limited to this origin). Other headers would follow a
 *  redirect to any host, so the browser step doesn't send them (`skipped`). */
export function browserAccess(headers, url) {
  const out = { cookies: [], httpCredentials: null, skipped: [] };
  const origin = new URL(url).origin;
  for (const [name, value] of Object.entries(headers || {})) {
    const k = name.toLowerCase();
    if (k === "cookie") {
      for (const part of String(value).split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out.cookies.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), url: origin });
      }
    } else if (k === "authorization" && /^basic\s+/i.test(value)) {
      const pair = Buffer.from(String(value).replace(/^basic\s+/i, ""), "base64").toString("utf8"), i = pair.indexOf(":");
      if (i >= 0) out.httpCredentials = { username: pair.slice(0, i), password: pair.slice(i + 1), origin };
      else out.skipped.push(name);
    } else out.skipped.push(name);
  }
  return out;
}

/** Opens a URL in the browser as a reader would and returns the document response as served:
 *  { status, headers, type, body, wallBody, finalUrl, redirect, ms }. Images, media and fonts aren't downloaded;
 *  same-site URLs robots.txt disallows (blocked(url) → true) are never requested, redirects included. A check page
 *  ("Just a moment…") gets up to settleMs to reload itself, as it does in any browser; nothing is clicked or solved. */
export async function browserFetch(browser, url, { headers = null, ua = AUDITOR_UA, blocked = () => false, timeout = 30000, settleMs = 8000 } = {}) {
  const t0 = Date.now(), access = browserAccess(headers, url);
  const context = await browser.newContext({ userAgent: ua, locale: "en-AU", ...(access.httpCredentials ? { httpCredentials: access.httpCredentials } : {}) });
  try {
    if (access.cookies.length) await context.addCookies(access.cookies);
    const page = await context.newPage();
    await page.route("**/*", (route) => (SKIP_TYPES.has(route.request().resourceType()) || blocked(route.request().url()) ? route.abort() : route.continue()));
    let doc = null;
    page.on("response", (res) => { if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) doc = res; });
    const none = (e) => ({ status: 0, headers: new Headers(), type: "", body: "", wallBody: "", error: String(e?.message || e || "no response").split("\n")[0].slice(0, 120), ms: Date.now() - t0 });
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout }); } catch (e) { if (!doc) return none(e); }
    if (!doc) return none();
    if (CHECK_TITLE.test((await page.title().catch(() => "")).toLowerCase().trim())) {
      await page.waitForFunction((src) => !new RegExp(src).test(document.title.toLowerCase().trim()), CHECK_TITLE.source, { timeout: settleMs })
        .then(() => page.waitForLoadState("domcontentloaded", { timeout: settleMs })).catch(() => {});
    }
    const status = doc.status(), raw = await doc.allHeaders().catch(() => ({})), h = new Headers();
    for (const [k, v] of Object.entries(raw)) for (const x of String(v).split("\n")) try { h.append(k, x); } catch { /* skip */ }
    const type = h.get("content-type") || "";
    // The raw bytes, decoded with the page's own charset like the normal fetch (older fakes offer text() only).
    const bytes = /html|xml|text/.test(type) && doc.body ? await doc.body().catch(() => null) : null;
    const text = !/html|xml|text/.test(type) ? "" : bytes ? decodeBody(bytes.subarray(0, MAX_BODY), type).text : (await doc.text().catch(() => "")).slice(0, MAX_BODY);
    let q = doc.request(), hops = 0;
    while (q.redirectedFrom()) { q = q.redirectedFrom(); hops++; }
    const firstStatus = hops ? (await q.response().catch(() => null))?.status() : null;
    return { status, headers: h, type, body: status < 300 ? text : "", wallBody: status >= 300 ? text.slice(0, WALL_BODY) : "", finalUrl: doc.url(),
      redirect: hops ? { hops, to: doc.url(), firstStatus, finalStatus: status } : null, location: h.get("location"), ms: Date.now() - t0 };
  } finally { await context.close().catch(() => {}); }
}

/** One browser per audit, started on first use: the crawl's rendering browser when there is one, otherwise launched
 *  here and closed by close(). A failed launch is remembered, so it isn't retried for every page. */
export function lazyBrowser(shared, launch) {
  let p = null;
  return {
    get: () => (p ||= shared ? Promise.resolve(shared) : launch()),
    async close() { if (!p || shared) return; const b = await p.catch(() => null); await b?.close().catch(() => {}); },
  };
}

// ---------------- The ladder ----------------
const resolveUrl = (u, base) => { try { const x = new URL(u, base); if (!/^https?:$/.test(x.protocol)) return null; x.hash = ""; return x.href; } catch { return null; } };
const waitWithStop = async (ms, stop) => { const end = Date.now() + ms; while (Date.now() < end && !stop()) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now()))); };

/** Creates the ladder for one audit. fetchPage(url) → the crawler's normal result ({ status, headers, body, wallBody,
 *  finalUrl, redirect, ms, error }); curl(url, { headers }) and browser(url, { headers }) → the same shape;
 *  inScope(url): the project's own hosts; blocked(url): robots.txt disallows it; headersFor(url): the project's request
 *  headers for that URL (null off-site); width(): the crawl's current parallel requests, when it changes them itself.
 *  Returns { fetch(url), parallel(), stats }. */
export function createLadder({ mode = "browser", concurrency = 6, fetchPage, curl = null, browser = null, inScope = () => true, blocked = () => false,
  headersFor = () => null, sleep = waitWithStop, stop = () => false, now = Date.now, browserPages = BROWSER_PAGES, browserParallel = 2, width = null } = {}) {
  if (!FALLBACK_MODES.includes(mode)) mode = "browser";
  let parallel = Math.max(1, Math.floor(concurrency) || 1), browserUsed = 0, active = 0;
  const waiters = [];
  const stats = { from: parallel, parallel, slowDowns: 0, statuses: {}, retryAfterMaxS: 0, waitedMs: 0, retried: 0, notRetried: 0,
    walls: 0, via: { fetch: 0, retry: 0, curl: 0, browser: 0 }, browserUnavailable: false };
  const wallOf = (r) => (r ? botWall({ status: r.status, headers: r.headers, body: r.body || r.wallBody }) : null);
  const slowDownOf = (r) => r.status === 429 || (r.status === 503 && Boolean(hget(r.headers, "retry-after")));
  const note = (r) => {
    // width(): the crawl's current parallel requests (adaptive speed, crawl-speed.mjs); a slow-down halves what is in use.
    const current = Math.min(parallel, width ? Math.max(1, width()) : parallel);
    if (!stats.slowDowns) stats.from = current;
    stats.slowDowns++;
    stats.statuses[r.status] = (stats.statuses[r.status] || 0) + 1;
    const ra = retryAfterMs(hget(r.headers, "retry-after"), now());
    if (ra !== null) stats.retryAfterMaxS = Math.max(stats.retryAfterMaxS, Math.round(ra / 1000));
    parallel = stats.parallel = Math.max(1, Math.floor(current / 2)); // fewer parallel requests for the rest of the audit
  };
  const answered = (r) => r && r.status > 0 && !REFUSED.has(r.status) && !wallOf(r);
  const merge = (direct, r, extraHops, firstStatus) => {
    const before = direct.redirect?.hops || 0, hops = before + extraHops;
    const redirect = hops ? { hops, to: r.finalUrl, firstStatus: direct.redirect?.firstStatus ?? firstStatus, finalStatus: r.status } : null;
    // Timing from curl or the browser isn't the server's answer to a crawler: kept as fallbackMs, not as the response time.
    return { ...r, redirect, ms: null, fallbackMs: r.ms ?? null, directStatus: direct.status };
  };
  const done = (r, via, extra) => { stats.via[via]++; return { ...r, via, ...extra }; };

  async function viaCurl(start) {
    const chain = [start];
    let c, first = null;
    for (;;) {
      const u = chain.at(-1);
      c = await curl(u, { headers: headersFor(u) });
      if (first === null) first = c.status;
      if (!(c.status >= 300 && c.status < 400 && c.location) || chain.length > 5) break;
      const next = resolveUrl(c.location, u);
      if (!next || chain.includes(next) || (inScope(next) && blocked(next))) break; // never follow into a robots.txt-disallowed URL
      chain.push(next);
    }
    return { r: { ...c, finalUrl: chain.at(-1) }, hops: chain.length - 1, first };
  }
  async function viaBrowser(u) {
    if (active >= browserParallel) await new Promise((r) => waiters.push(r)); else active++;
    try { return await browser(u, { headers: headersFor(u) }); }
    catch (e) { stats.browserUnavailable = true; return { status: 0, headers: new Headers(), body: "", error: String(e.message || e).split("\n")[0].slice(0, 120) }; }
    finally { const w = waiters.shift(); if (w) w(); else active--; }
  }

  async function fetchUrl(url) {
    let r = await fetchPage(url), via = "fetch", rateLimited = false;
    let wall = wallOf(r);
    const target = () => r.finalUrl || url;
    if (!wall && slowDownOf(r) && inScope(target())) {
      rateLimited = true;
      note(r);
      const ra = retryAfterMs(hget(r.headers, "retry-after"), now());
      const wait = ra ?? (r.status === 429 ? DEFAULT_429_MS : null);
      if (wait !== null && wait <= RETRY_MAX_MS && stats.waitedMs + wait <= WAIT_BUDGET_MS && !stop()) {
        stats.waitedMs += wait;
        await sleep(wait, stop);
        if (!stop()) { r = await fetchPage(url); via = "retry"; stats.retried++; wall = wallOf(r); if (!wall && slowDownOf(r)) note(r); }
      } else stats.notRetried++;
    }
    if (wall) stats.walls++;
    const refused = wall || r.status === 0 || r.status === 403 || (r.status === 401 && !hget(r.headers, "www-authenticate")) || (r.status === 503 && !slowDownOf(r));
    const extra = { botWall: wall, rateLimited, tried: [] };
    if (!refused || mode === "off" || !inScope(target()) || blocked(target()) || stop()) return done(r, via, extra);
    if (curl) {
      extra.tried.push("curl");
      const c = await viaCurl(target());
      if (answered(c.r)) return done(merge(r, c.r, c.hops, c.first), "curl", extra);
      extra.botWall ||= wallOf(c.r);
    }
    if (mode === "browser" && browser && browserUsed < browserPages && !stats.browserUnavailable && !stop()) {
      browserUsed++;
      extra.tried.push("the browser");
      const b = await viaBrowser(target());
      if (answered(b)) return done(merge(r, { ...b, finalUrl: b.finalUrl || target() }, b.redirect?.hops || 0, b.redirect?.firstStatus), "browser", extra);
      extra.botWall ||= wallOf(b);
    }
    if (extra.botWall && !wall) stats.walls++;
    return done(r, via, extra);
  }
  return { fetch: fetchUrl, parallel: () => parallel, stats };
}

/** Site-level findings from the ladder's counts: crawl_rate_limited. Returns [[id, url, detail]]. */
export function ladderSiteIssues(stats, url) {
  if (!stats?.slowDowns) return [];
  const codes = Object.entries(stats.statuses).map(([s, n]) => `HTTP ${s} ×${n}`).join(", ");
  const parts = [`${stats.slowDowns} slow-down answer(s) (${codes})`];
  if (stats.retryAfterMaxS) parts.push(`Retry-After up to ${stats.retryAfterMaxS} s`);
  if (stats.retried) parts.push(`waited ${Math.round(stats.waitedMs / 1000)} s in total and retried ${stats.retried} page(s) once`);
  if (stats.notRetried) parts.push(`${stats.notRetried} not retried (Retry-After over ${RETRY_MAX_MS / 1000} s or the ${WAIT_BUDGET_MS / 60000}-minute waiting budget used up)`);
  if (stats.parallel < stats.from) parts.push(`parallel requests lowered from ${stats.from} to ${stats.parallel} for the rest of the audit`);
  return [["crawl_rate_limited", url, parts.join("; ")]];
}
