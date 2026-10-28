// Page requests for the crawler (REQ-055 group 2, Oct 2026): one request (fetchOnce) and a redirect chain followed
// hop by hop (fetchFollow), with
//   - bodies read as a capped byte stream and decoded with the page's own charset (body.mjs);
//   - transient failures (connection reset, socket hang up, connect timeout, DNS EAI_AGAIN, 502, 504) retried up to
//     twice with a short backoff; the count is kept as `retries`, and a page that still fails keeps its real error;
//   - stateless crawling like Googlebot: no cookies are kept between requests. When a redirect chain loops or runs
//     past 10 hops and the server set cookies inside it, the chain is repeated once with those cookies (in memory,
//     for that chain only). If that resolves it, the result carries `cookieLoop` (cookie_required_redirect): Google
//     can't keep the cookie, so it sees the loop. The page itself stays the cookie-less answer.
// fetch and sleeping can be injected (opts.fetchFn, opts.sleep), so tests need no network.
import { REFUSED, WALL_BODY } from "./fetch-ladder.mjs";
import { readBody, decodeBody, MAX_HTML } from "./body.mjs";

export const RETRY_DELAYS = [500, 1500]; // ms before retry 1 and 2
export const MAX_HOPS = 10;
const TRANSIENT_ERROR = /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b|socket hang up|other side closed/i;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalize(u, base) {
  try {
    const x = new URL(u, base);
    if (!/^https?:$/.test(x.protocol)) return null;
    x.hash = "";
    if ((x.protocol === "https:" && x.port === "443") || (x.protocol === "http:" && x.port === "80")) x.port = "";
    return x.href;
  } catch { return null; }
}

/** The real reason a fetch failed: Node reports "fetch failed" and keeps the network error in e.cause. Our own
 *  20-second limit is "timeout" (not retried: the page is slow, not flaky). */
export function errorText(e) {
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return "timeout";
  const c = e?.cause;
  if (c?.code) return String(c.message || "").includes(c.code) ? String(c.message) : `${c.code}: ${c.message || e.message}`;
  return String(c?.message || e?.message || e);
}

/** A failure worth one more try: a dropped connection, a connect timeout, a DNS hiccup, or a gateway answering
 *  502/504. A 503 isn't one: the fetch ladder handles it (Retry-After). */
export const isTransient = (r) => r.status === 502 || r.status === 504 || (r.status === 0 && TRANSIENT_ERROR.test(r.error || ""));

/** extra: the project's request headers (own hosts only) and conditional headers. Returns { status, headers, type,
 *  body, wallBody, ms (time to headers), location, size (bytes read), truncated?, charset? (when not UTF-8), error? }. */
export async function fetchOnce(url, ua, method = "GET", timeout = 20000, extra = null, { fetchFn = fetch, maxBytes = MAX_HTML } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, { method, redirect: "manual", signal: ctl.signal, headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en;q=0.9", ...extra } });
    const ttfb = Date.now() - t0; // server response time = time to headers, not download
    const type = res.headers.get("content-type") || "";
    const textual = method === "GET" && /html|xml|text/.test(type);
    const out = { status: res.status, headers: res.headers, type, body: "", wallBody: "", ms: ttfb, location: res.headers.get("location"), size: 0 };
    if (textual && res.status < 300) {
      const b = await readBody(res, maxBytes), dec = decodeBody(b.buf, type);
      out.body = dec.text; out.size = b.size;
      if (b.truncated) out.truncated = true;
      if (dec.charset !== "utf-8") out.charset = dec.charset;
    } else if (textual && REFUSED.has(res.status)) {
      // A refused answer keeps the start of its page, only to recognise a bot challenge (botWall); it isn't the page.
      const b = await readBody(res, WALL_BODY).catch(() => null);
      out.wallBody = b ? decodeBody(b.buf, type).text : "";
    } else await res.body?.cancel().catch(() => {});
    return out;
  } catch (e) {
    return { status: 0, headers: new Headers(), type: "", body: "", ms: Date.now() - t0, error: errorText(e) };
  } finally { clearTimeout(t); }
}

/** fetchOnce (GET) with up to two retries of a transient failure; adds `retries` when it retried. */
export async function fetchRetrying(url, ua, extra, { sleep = delay, delays = RETRY_DELAYS, stop = () => false, timeout = 20000, ...o } = {}) {
  let r = await fetchOnce(url, ua, "GET", timeout, extra, o), retries = 0;
  while (isTransient(r) && retries < delays.length && !stop()) {
    await sleep(delays[retries]);
    retries++;
    r = await fetchOnce(url, ua, "GET", timeout, extra, o);
  }
  return retries ? { ...r, retries } : r;
}

// ---------------- Cookies, for the redirect-loop test only ----------------
/** One Set-Cookie line → { name, value, domain, hostOnly, path, expired }, or null. */
export function parseSetCookie(line, url) {
  const [pair, ...attrs] = String(line || "").split(";");
  const i = pair.indexOf("=");
  if (i <= 0) return null;
  const u = new URL(url), c = { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), domain: u.hostname, hostOnly: true, expired: false,
    path: u.pathname.slice(0, u.pathname.lastIndexOf("/")) || "/" };
  for (const a of attrs) {
    const [k, ...v] = a.split("="), key = k.trim().toLowerCase(), val = v.join("=").trim();
    if (key === "domain" && val) {
      const d = val.replace(/^\./, "").toLowerCase();
      if (u.hostname !== d && !u.hostname.endsWith("." + d)) return null; // a cookie for another site is ignored, as in a browser
      c.domain = d; c.hostOnly = false;
    } else if (key === "path" && val.startsWith("/")) c.path = val;
    else if (key === "max-age" && /^-?\d+$/.test(val)) c.expired = Number(val) <= 0;
    else if (key === "expires" && Number.isFinite(Date.parse(val))) c.expired = Date.parse(val) <= Date.now();
  }
  return c;
}

/** A cookie jar that lives for one redirect chain: set(lines, url), header(url) → "a=1; b=2" or "", names(). */
export function cookieJar() {
  const jar = new Map(); // domain|path|name → cookie
  return {
    set(lines, url) {
      for (const line of lines || []) {
        const c = parseSetCookie(line, url);
        if (!c) continue;
        const k = `${c.domain}|${c.path}|${c.name}`;
        if (c.expired) jar.delete(k); else jar.set(k, c);
      }
    },
    header(url) {
      const u = new URL(url);
      return [...jar.values()].filter((c) => (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith("." + c.domain))
        && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"))).map((c) => `${c.name}=${c.value}`).join("; ");
    },
    names: () => [...new Set([...jar.values()].map((c) => c.name))],
  };
}

const withCookie = (extra, cookie) => {
  if (!cookie) return extra;
  const out = { ...extra }, k = Object.keys(out).find((x) => x.toLowerCase() === "cookie");
  if (k) out[k] = `${out[k]}; ${cookie}`; else out.Cookie = cookie;
  return out;
};

/** Repeats a looping chain once, as a browser would, with the cookies the server set in the first pass and those it
 *  sets now. Never enters a URL blocked(url) disallows. Returns { status, to, hops, cookies: names } when the chain
 *  ends in a 2xx page, else null. Cookie values are never returned. */
export async function replayWithCookies(url, ua, extraFor, firstPass, { blocked = () => false, ...o } = {}) {
  const jar = cookieJar();
  for (const [u, lines] of firstPass) jar.set(lines, u);
  const chain = [url];
  let r = null;
  for (let i = 0; i <= MAX_HOPS; i++) {
    const u = chain.at(-1);
    if (blocked(u)) return null;
    r = await fetchOnce(u, ua, "GET", 20000, withCookie(extraFor(u) || {}, jar.header(u)), o);
    jar.set(r.headers.getSetCookie?.() || [], u);
    if (!(r.status >= 300 && r.status < 400 && r.location)) break;
    const next = normalize(r.location, u);
    if (!next) return null;
    chain.push(next); // the same URL may come back: with the cookie set it can answer differently
  }
  return r && r.status >= 200 && r.status < 300 ? { status: r.status, to: chain.at(-1), hops: chain.length - 1, cookies: jar.names() } : null;
}

/** Follows redirects manually (max 10) so chains and loops are visible. extraFor(url): request headers for that hop
 *  (null for other hosts, so a redirect never carries them off the site). opts: conditional (If-None-Match /
 *  If-Modified-Since for the first request only), blocked(url) (robots.txt, for the cookie replay), sleep, stop,
 *  fetchFn. The result adds finalUrl, redirect, ms (time to headers over all hops), retries, cookieLoop. */
export async function fetchFollow(url, ua, extraFor = () => null, opts = {}) {
  const { conditional = null, ...o } = opts;
  const seen = [url], cookies = [];
  const hop = async (u, extra) => {
    const x = await fetchRetrying(u, ua, extra, o);
    const sc = x.headers?.getSetCookie?.() || [];
    if (sc.length) cookies.push([u, sc]);
    return x;
  };
  let r = await hop(url, conditional ? { ...extraFor(url), ...conditional } : extraFor(url));
  const firstStatus = r.status;
  let total = r.ms, retries = r.retries || 0, loopTo = null;
  while (r.status >= 300 && r.status < 400 && r.location && seen.length <= MAX_HOPS) {
    const next = normalize(r.location, seen.at(-1));
    if (!next) break;
    if (seen.includes(next)) { loopTo = next; break; }
    seen.push(next);
    r = await hop(next, extraFor(next));
    total += r.ms; retries += r.retries || 0;
  }
  const tooMany = !loopTo && r.status >= 300 && r.status < 400 && r.location && seen.length > MAX_HOPS;
  const extra = { ...(retries ? { retries } : {}) };
  if ((loopTo || tooMany) && cookies.length) {
    const fixed = await replayWithCookies(url, ua, extraFor, cookies, o).catch(() => null);
    if (fixed) extra.cookieLoop = fixed;
  }
  if (loopTo) return { ...r, ...extra, finalUrl: loopTo, redirect: { hops: seen.length, to: loopTo, firstStatus, loop: true }, ms: total };
  const redirect = seen.length > 1 ? { hops: seen.length - 1, to: seen.at(-1), firstStatus, finalStatus: r.status } : null;
  return { ...r, ...extra, finalUrl: seen.at(-1), redirect, ms: total };
}
