// Site probes: a few extra requests after the crawl (REQ-044 build rows 16, 34, 50-53, Oct 2026), from Google
// Search Central docs and videos: indexable internal search pages, staging copies of the site, conditional GET and
// compression, exposed secret files, TLS certificate expiry and forced language redirects. Rows 17-18 (smartphone
// vs desktop, Googlebot vs browser) are in ua-parity.mjs and share the same request budget.
// Every request is sequential, has a timeout, waits the robots.txt Crawl-delay (at least 250 ms) between requests,
// and counts against one budget (60 per audit). They run only when the project setting siteProbes is true (opt-in: own sites only).
import tls from "node:tls";
import { lookup as dnsLookup } from "node:dns/promises";
import robotsParser from "robots-parser";
import { all } from "./db.mjs";
import { robotsDirectives, textFingerprint } from "./google-signals.mjs";
import { similarPairs } from "./quality.mjs";
import { parityIssues, referrerIssues, MOBILE_UA } from "./ua-parity.mjs";

export const PROBE_BUDGET = 60;
const ENCODINGS = "gzip, deflate, br"; // what Google's crawlers send (Google crawler docs)

/** Reads at most `max` bytes of a response body as text, then drops the rest. */
async function readCapped(res, max) {
  if (!res.body) return "";
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  try {
    while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(value); n += value.length; }
  } finally { reader.cancel().catch(() => {}); }
  return Buffer.concat(parts.map((p) => Buffer.from(p))).subarray(0, max).toString("utf8");
}

/** A sequential request function with a budget and a pause between requests. Returns
 *  { status, url (final), headers, type, body, error }; status 0 when the budget is used up or the request failed. */
export function prober({ max = PROBE_BUDGET, gapMs = 250, fetchFn = fetch, stop = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let used = 0, last = 0;
  const req = async (url, { ua, headers = {}, redirect = "follow", maxBody = 2_000_000, timeout = 15000 } = {}) => {
    if (used >= max || stop()) return { status: 0, error: "BUDGET", headers: new Headers(), body: "" };
    used++;
    const wait = last + gapMs - Date.now();
    if (last && wait > 0) await sleep(wait);
    try {
      const res = await fetchFn(url, { redirect, signal: AbortSignal.timeout(timeout),
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Encoding": ENCODINGS, ...headers } });
      const body = maxBody ? await readCapped(res, maxBody) : (res.body?.cancel?.().catch(() => {}), "");
      return { status: res.status, url: res.url || url, headers: res.headers, type: res.headers.get("content-type") || "", location: res.headers.get("location"), body };
    } catch (e) {
      return { status: 0, url, error: e.cause?.code || (e.name === "TimeoutError" ? "TIMEOUT" : e.name), headers: new Headers(), body: "" };
    } finally { last = Date.now(); }
  };
  req.used = () => used;
  return req;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const homeOf = (start) => new URL(start).origin + "/";
const noindexOf = (r, parsed) => Boolean(parsed?.data?.noindex) || robotsDirectives([], r.headers.get("x-robots-tag") || "").noindex;

// ---------------- Row 16: internal search pages ----------------
const SEARCH_URL = /\/search(?:[/?.]|$)|[?&](?:s|q|query|keyword)=/i;
const searchTerm = (u) => { try { const x = new URL(u); for (const k of ["s", "q", "query", "keyword"]) if (x.searchParams.get(k)) return x.searchParams.get(k); } catch {} return null; };

/** Verdict for one search-results URL: null, or [id, url, detail]. page: { url, title, h1, canonical, hash };
 *  home: { url, hash, canonical }. A page identical to the home page, canonicalised to it, or identical to the
 *  site's 404 page is not a search page. */
export function searchVerdict(page, { home, notFoundHash, term }) {
  if (!page.hash || page.hash === home?.hash || page.hash === notFoundHash) return null;
  if (page.canonical && home && [home.url, home.canonical].includes(page.canonical)) return null;
  const t = String(term || "").toLowerCase().trim();
  const echoed = t.length >= 3 && [["title", page.title], ["H1", page.h1]].find(([, s]) => String(s || "").toLowerCase().includes(t));
  return echoed
    ? ["internal_search_echoed", page.url, `the search words "${t.slice(0, 40)}" appear in the ${echoed[0]} of an indexable page (no noindex, not blocked by robots.txt)`]
    : ["internal_search_indexable", page.url, "search results page answers 200 with no noindex and isn't blocked by robots.txt"];
}

/** Crawled search-results URLs (indexable, allowed for Googlebot) plus up to 3 probes with a made-up query. */
export async function searchIssues({ start, pages, robots, req, ua, parse, notFoundHash, token }) {
  const out = [], home = pages.find((p) => (p.final_url || p.url) === homeOf(start) && p.status === 200);
  const homeInfo = home && { url: homeOf(start), hash: home.data?.textHash, canonical: home.canonical };
  const allowed = (u) => !robots || robots.isAllowed(u, "Googlebot") !== false;
  for (const p of pages) {
    if (out.length >= 20) break;
    if (p.status !== 200 || !p.indexable || !SEARCH_URL.test(p.url) || p.url === homeOf(start) || !allowed(p.url)) continue;
    const v = searchVerdict({ url: p.url, title: p.title, h1: p.h1, canonical: p.canonical, hash: p.data?.textHash }, { home: homeInfo, notFoundHash, term: searchTerm(p.url) });
    if (v) out.push(v);
  }
  const origin = new URL(start).origin;
  for (const path of [`/?s=${token}`, `/search?q=${token}`, `/search?query=${token}`]) {
    const u = origin + path;
    if (!allowed(u) || out.some((x) => x[1] === u)) continue;
    const r = await req(u, { ua });
    if (r.status !== 200 || !/html/.test(r.type) || !r.body) continue;
    const parsed = parse(r.body, r.url);
    if (noindexOf(r, parsed) || !allowed(r.url)) continue;
    const v = searchVerdict({ url: u, title: parsed.title, h1: parsed.h1, canonical: parsed.canonical, hash: textFingerprint(parsed.text) }, { home: homeInfo, notFoundHash, term: token });
    if (v) out.push(v);
  }
  return out;
}

// ---------------- Row 34: staging and preview hosts ----------------
const STAGING = ["staging", "stage", "dev", "test", "uat", "beta", "preview"];
const NONPROD_LABEL = /^(?:staging|stage|stg|dev|develop|development|test|testing|uat|qa|beta|preview|demo|sandbox)\d*$/i;
const PREVIEW_HOST = /\.(?:netlify\.app|vercel\.app|pages\.dev|herokuapp\.com|wpengine\.com|wpenginepowered\.com|kinsta\.cloud|onrender\.com|azurewebsites\.net|web\.app|firebaseapp\.com|webflow\.io)$/i;

/** Non-production hosts named in links, canonicals or sitemaps: a staging-style subdomain of the site, or a
 *  preview-platform host. */
export function nonProductionHosts(urls, start) {
  const bare = hostOf(start), out = new Set();
  for (const u of urls) {
    let h; try { h = new URL(u).hostname.toLowerCase(); } catch { continue; }
    if (h === bare || h === "www." + bare) continue;
    if ((h.endsWith("." + bare) && NONPROD_LABEL.test(h.slice(0, -bare.length - 1).split(".")[0])) || PREVIEW_HOST.test(h)) out.add(h);
  }
  return [...out];
}

/** Does a copy's home page match production? Same title, or 50% of 5-word phrases shared (quality.mjs). */
export function matchesProduction(copy, prod) {
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (norm(copy.title) && norm(copy.title) === norm(prod.title)) return "same home page title";
  const pair = similarPairs([{ url: "https://copy.invalid/", text: copy.text || "" }, { url: "https://prod.invalid/", text: prod.text || "" }], { min: 0.5 })[0];
  return pair ? `${Math.round(pair.score * 100)}% of 5-word phrases shared with production` : null;
}

export async function stagingIssues({ start, prod, seenUrls = [], req, ua, parse, lookup = dnsLookup }) {
  const bare = hostOf(start), out = [];
  const resolves = async (h) => { try { await lookup(h); return true; } catch { return false; } };
  // Wildcard DNS answers for every name: guessed names prove nothing then, so only hosts the site names are checked.
  const wildcard = await resolves(`seo-auditor-${Date.now().toString(36)}.${bare}`);
  const hosts = [...new Set([...(wildcard ? [] : STAGING.map((p) => `${p}.${bare}`)), ...nonProductionHosts(seenUrls, start).slice(0, 3)])];
  for (const h of hosts) {
    if (!(await resolves(h))) continue;
    let r = await req(`https://${h}/`, { ua });
    if (r.status === 0 && r.error !== "BUDGET") r = await req(`http://${h}/`, { ua });
    if (r.status !== 200 || !/html/.test(r.type) || new URL(r.url).hostname !== h) continue; // login, error, or redirect away
    const parsed = parse(r.body, r.url);
    if (noindexOf(r, parsed)) continue;
    const match = matchesProduction(parsed, prod);
    if (!match) continue; // a real sub-site (blog., shop.)
    const rt = await req(`${new URL(r.url).origin}/robots.txt`, { ua, maxBody: 100_000 });
    if (rt.status === 200 && robotsParser(`${new URL(r.url).origin}/robots.txt`, rt.body).isAllowed(r.url, "Googlebot") === false) continue;
    out.push(["staging_host_exposed", r.url, `answers 200 without a login, no noindex, robots.txt doesn't block it; ${match}`]);
  }
  return out;
}

// ---------------- Row 50: conditional GET and compression ----------------
/** HTML and CSS/JS sample: each fetched once (compression, validators) and once more with If-None-Match /
 *  If-Modified-Since. Returns [[id, url, detail]]. */
export async function cachingIssues({ htmlUrls, assetUrls, req, ua }) {
  const out = [];
  for (const u of [...htmlUrls, ...assetUrls]) {
    const r = await req(u, { ua, maxBody: 3_000_000 });
    if (r.status !== 200) continue;
    const enc = (r.headers.get("content-encoding") || "").toLowerCase(), size = Buffer.byteLength(r.body);
    if (size > 1024 && /text|html|css|javascript|json|xml|svg/.test(r.type) && !/gzip|br|deflate|zstd/.test(enc))
      out.push(["no_compression", u, `${Math.round(size / 1024)} KB ${r.type.split(";")[0]} sent without gzip or Brotli (Content-Encoding: ${enc || "none"})`]);
    const etag = r.headers.get("etag"), lm = r.headers.get("last-modified");
    if (!etag && !lm) { out.push(["no_conditional_get", u, "no ETag or Last-Modified header, so a crawler can't ask \"has this changed?\""]); continue; }
    const again = await req(u, { ua, maxBody: 0, headers: { ...(etag ? { "If-None-Match": etag } : {}), ...(lm ? { "If-Modified-Since": lm } : {}) } });
    if (again.status === 200) out.push(["no_conditional_get", u, `sent ${etag ? "If-None-Match" : "If-Modified-Since"} from the server's own ${etag ? "ETag" : "Last-Modified"}; it answered 200 with the full file instead of 304`]);
  }
  return out;
}

// ---------------- Row 51: exposed secret files ----------------
// Only the path, the status and which pattern matched are kept: never the body (this is the audited site's own data).
const SECRET_FILES = [
  ["/.env", "KEY=value lines", (t) => (t.match(/^[A-Z][A-Z0-9_]+=.+$/gm) || []).length >= 2],
  ["/.git/HEAD", "ref: refs/…", (t) => /^ref: refs\//.test(t)],
  ["/.git/config", "[core] section", (t) => /^\s*\[core\]/m.test(t)],
];

export async function secretFileIssues({ start, req, ua, sourceMaps = [] }) {
  const origin = new URL(start).origin, out = [];
  for (const [path, pattern, test] of SECRET_FILES) {
    const r = await req(origin + path, { ua, redirect: "manual", maxBody: 8192 });
    const hit = r.status === 200 && test(r.body); // the body goes out of scope here
    if (hit) out.push(["exposed_secret_files", origin + path, `HTTP 200 and the content matches the ${pattern} pattern (content not stored)`]);
  }
  for (const { script, map } of sourceMaps.slice(0, 2)) {
    const r = await req(map, { ua, redirect: "manual", maxBody: 4096 });
    if (r.status === 200 && /"mappings"\s*:|"version"\s*:\s*3\b/.test(r.body)) out.push(["source_map_exposed", map, `source map for ${script} answers 200`]);
  }
  return out;
}

// ---------------- Row 52: TLS certificate expiry ----------------
/** The certificate the host serves on port 443: { validFrom, validTo, issuer } or { error }. Not verified on purpose,
 *  so an expired certificate can still be read. */
export function certInfo(host, timeout = 10000) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? { validFrom: c.valid_from, validTo: c.valid_to, issuer: c.issuer?.O || c.issuer?.CN || "" } : { error: "no certificate" });
    });
    s.on("timeout", () => { s.destroy(); resolve({ error: "TIMEOUT" }); });
    s.on("error", (e) => resolve({ error: e.code || e.message }));
  });
}

const AUTO_RENEW = /let'?s encrypt|zerossl|google trust services|buypass|cpanel/i;
/** tls_cert_expiring (warning) / tls_cert_critical (error, 7 days or less, or expired). Certificates that renew
 *  automatically (ACME issuers, or valid for 100 days or less) are warned about at 10 days instead of 21. */
export function certIssues(url, info, now = Date.now()) {
  if (!info?.validTo) return [];
  const to = Date.parse(info.validTo), from = Date.parse(info.validFrom);
  if (Number.isNaN(to)) return [];
  const days = Math.floor((to - now) / 86_400_000);
  const auto = AUTO_RENEW.test(info.issuer || "") || (!Number.isNaN(from) && to - from <= 100 * 86_400_000);
  const what = `certificate from ${info.issuer || "unknown issuer"} ${days < 0 ? `expired ${-days} day(s) ago` : `expires in ${days} day(s)`} (${new Date(to).toISOString().slice(0, 10)})`;
  if (days <= 7) return [["tls_cert_critical", url, what]];
  if (days <= (auto ? 10 : 21)) return [["tls_cert_expiring", url, what + (auto ? "; it should have renewed automatically by now" : "")]];
  return [];
}

// ---------------- Row 53: forced language redirects ----------------
export async function localeIssues({ start, req }) {
  const home = homeOf(start), seen = [];
  for (const lang of [null, "de", "fr", "ja", "es-MX"]) {
    const r = await req(home, { ua: MOBILE_UA, redirect: "manual", maxBody: 0, headers: lang ? { "Accept-Language": lang } : {} });
    if (r.status === 0) continue;
    let to = null; try { to = r.status >= 300 && r.status < 400 && r.location ? new URL(r.location, home).href : null; } catch {}
    seen.push({ lang: lang || "no preference", to, status: r.status });
  }
  const targets = new Set(seen.map((s) => s.to || `stay (${s.status})`));
  if (targets.size < 2) return [];
  return [["locale_redirect", home, seen.map((s) => `${s.lang} → ${s.to ? `${s.status} ${s.to}` : `no redirect (HTTP ${s.status})`}`).join("; ")]];
}

// ---------------- All probes ----------------
const crawlDelayOf = (robots) => { try { return robots?.getCrawlDelay("SEOAuditor") ?? robots?.getCrawlDelay("*") ?? 0; } catch { return 0; } };

/** Runs every probe in turn under one budget. pages: this audit's pages (with data); parse: parseHtml; resUrls:
 *  same-site scripts/styles found; seenUrls: external link, canonical and sitemap URLs; sourceMaps: [{ script, map }]
 *  from the home page's scripts; stop: () => true when the user stops the audit. Returns [[id, url, detail]]. */
export async function siteProbeIssues({ start, pages, robots, ua, parse, notFoundHash = null, resUrls = [], seenUrls = [], sourceMaps = [], stop = () => false,
  fetchFn = fetch, lookup = dnsLookup, getCert = certInfo, sleep, now = Date.now() }) {
  const delay = crawlDelayOf(robots);
  const out = [], step = async (fn) => { try { out.push(...(await fn())); } catch { /* one failing probe doesn't stop the others */ } };
  if (start.startsWith("https://")) await step(async () => certIssues(homeOf(start), await getCert(new URL(start).hostname), now));
  if (delay > 10) return out; // a Crawl-delay over 10 s: the HTTP probes would take too long at that pace
  const req = prober({ gapMs: Math.max(250, delay * 1000), fetchFn, stop, ...(sleep ? { sleep } : {}) });
  const html = pages.filter((p) => p.status === 200 && p.indexable && /html/.test(p.content_type || ""));
  const homeRow = html.find((p) => (p.final_url || p.url) === homeOf(start)) || html[0];
  const top = [homeRow, ...html.filter((p) => p !== homeRow).sort((a, b) => (b.inlinks || 0) - (a.inlinks || 0))].filter(Boolean);
  await step(() => secretFileIssues({ start, req, ua, sourceMaps }));
  await step(() => searchIssues({ start, pages, robots, req, ua, parse, notFoundHash, token: `seoauditor${now.toString(36)}` }));
  await step(() => localeIssues({ start, req }));
  const keep = {}; // parityIssues keeps where each sampled URL ends up for a browser (referrer check)
  await step(() => parityIssues({ urls: top.slice(0, 6).map((p) => p.final_url || p.url), req, parse, start, keep }));
  await step(() => referrerIssues({ urls: top.slice(0, 2).map((p) => p.final_url || p.url), req, browserHost: keep.browserHost }));
  await step(() => cachingIssues({ htmlUrls: top.slice(0, 3).map((p) => p.final_url || p.url), assetUrls: resUrls.filter((u) => /\.(css|js|mjs)(\?|$)/i.test(u)).slice(0, 2), req, ua }));
  if (homeRow) await step(() => stagingIssues({ start, prod: { title: homeRow.title, text: homeRow.text ?? textOf(homeRow) }, seenUrls, req, ua, parse, lookup }));
  return out;
}

/** A crawled page's main text (stored in page_text for indexable pages; the pages rows don't carry it). */
const textOf = (row) => (row.audit_id ? all("SELECT text FROM page_text WHERE audit_id=? AND url=?", row.audit_id, row.final_url || row.url)[0]?.text || "" : "");
