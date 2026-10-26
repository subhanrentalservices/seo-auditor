// XML sitemaps: discovery from robots.txt (or /sitemap.xml), sitemap indexes, gzip files, and the problems Google
// reports for them (Google sitemaps docs: 50,000 URLs or 50 MB uncompressed per file; sitemap indexes can't be
// nested; XML, RSS/Atom and plain-text sitemaps are supported). REQ-044, Oct 2026.
import { gunzipSync } from "node:zlib";

export const MAX_URLS = 50000, MAX_BYTES = 50 * 1024 * 1024;

/** GET a sitemap as bytes (redirects followed; gzip with Content-Encoding is decoded by fetch, a .gz file is not). */
export async function fetchSitemap(url, ua, timeout = 30000) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeout), headers: { "User-Agent": ua, Accept: "application/xml,text/xml,*/*;q=0.8" } });
    const bytes = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    return { status: res.status, type: res.headers.get("content-type") || "", bytes };
  } catch (e) {
    return { status: 0, type: "", bytes: Buffer.alloc(0), error: e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message };
  }
}

/** Bytes → { text, size, gz } or { error }; a gzip file is decompressed (capped just over 50 MB). */
export function decodeSitemap(bytes) {
  let buf = Buffer.from(bytes || []), gz = false;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    gz = true;
    try { buf = gunzipSync(buf, { maxOutputLength: MAX_BYTES + 1 }); }
    catch (e) { return e.code === "ERR_BUFFER_TOO_LARGE" ? { error: "too large", gz } : { error: `gzip file can't be decompressed (${e.code || e.message})`, gz }; }
  }
  return { text: buf.toString("utf8").replace(/^﻿/, ""), size: buf.length, gz };
}

const unescape = (s) => s.trim().replace(/&amp;/g, "&");

/** Sitemap text → { kind: "index" | "urlset" | "feed" | "text" | null, locs, lastmodOf: [[loc, date]], problems, why }. */
export function parseSitemap(text) {
  const t = String(text || "").trim(), problems = [];
  const locsOf = (s) => [...s.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => m[1]);
  const amp = (raw) => { const n = raw.filter((l) => /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(l)).length; if (n) problems.push(`${n} <loc> value(s) with an unescaped & (invalid XML: write &amp;)`); };
  if (/<sitemapindex[\s>]/i.test(t)) {
    if (!/<\/sitemapindex\s*>/i.test(t)) problems.push("no closing </sitemapindex> (file cut off or not well-formed XML)");
    const raw = locsOf(t); amp(raw);
    return { kind: "index", locs: raw.map(unescape), lastmodOf: [], problems };
  }
  if (/<urlset[\s>]/i.test(t)) {
    if (!/<\/urlset\s*>/i.test(t)) problems.push("no closing </urlset> (file cut off or not well-formed XML)");
    const raw = locsOf(t); amp(raw);
    const lastmodOf = [];
    for (const [, block] of t.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = block.match(/<loc>\s*([^<]*?)\s*<\/loc>/), lm = block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/);
      if (loc && lm) lastmodOf.push([unescape(loc[1]), lm[1]]);
    }
    return { kind: "urlset", locs: raw.map(unescape), lastmodOf, problems };
  }
  if (/<rss[\s>]/i.test(t)) return { kind: "feed", locs: [...t.matchAll(/<item\b[\s\S]*?<link>\s*([^<]+?)\s*<\/link>/g)].map((m) => unescape(m[1])), lastmodOf: [], problems };
  if (/<feed[\s>]/i.test(t)) return { kind: "feed", locs: [...t.matchAll(/<entry\b[\s\S]*?<link\b[^>]*\bhref=["']([^"']+)["']/g)].map((m) => unescape(m[1])), lastmodOf: [], problems };
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) return { kind: "text", locs: lines, lastmodOf: [], problems };
  return { kind: null, locs: [], lastmodOf: [], problems, why: /<html[\s>]|<!doctype html/i.test(t) ? "the URL returns an HTML page" : t ? "not sitemap XML, RSS/Atom or a URL list" : "empty file" };
}

/** Reads every sitemap declared in robots.txt (or /sitemap.xml when none is declared), following sitemap indexes.
 *  Returns { urls, lastmods, lastmodOf, found, declared, problems: [[id, url, detail]] }. A missing or non-sitemap
 *  /sitemap.xml that nothing declared is not a problem (no_sitemap covers it). `normalize` cleans each URL. */
export async function loadSitemaps(origin, robotsTxt, ua, { get = fetchSitemap, normalize = (u) => u } = {}) {
  const declared = [...String(robotsTxt || "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = (declared.length ? declared : [origin + "/sitemap.xml"]).map((url) => ({ url, from: declared.length ? "robots.txt" : null, index: null }));
  const urls = new Set(), seen = new Set(), lastmods = [], lastmodOf = new Map(), problems = [];
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  while (queue.length && seen.size < 50) {
    const { url: sm, from, index } = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    const r = await get(sm, ua);
    if (r.status !== 200) {
      if (from) problems.push(["sitemap_fetch_error", sm, `${r.error ? `no response (${r.error})` : `HTTP ${r.status}`}; listed in ${from}`]);
      continue;
    }
    const dec = decodeSitemap(r.bytes);
    if (dec.error === "too large") { problems.push(["sitemap_too_large", sm, "over 50 MB uncompressed (gzip file); Google's limit is 50 MB"]); continue; }
    if (dec.error) { problems.push(["sitemap_fetch_error", sm, dec.error]); continue; }
    const x = parseSitemap(dec.text);
    if (!x.kind) { if (from) problems.push(["sitemap_fetch_error", sm, `not a sitemap: ${x.why} (Content-Type ${r.type || "none"}); listed in ${from}`]); continue; }
    if (x.problems.length) problems.push(["sitemap_fetch_error", sm, x.problems.join("; ")]);
    const big = [dec.size > MAX_BYTES ? `${mb(dec.size)} uncompressed (limit 50 MB)` : "", x.locs.length > MAX_URLS ? `${x.locs.length.toLocaleString("en")} ${x.kind === "index" ? "sitemaps" : "URLs"} (limit 50,000)` : ""].filter(Boolean);
    if (big.length) problems.push(["sitemap_too_large", sm, big.join(", ") + ": Google may reject the whole file; split it and list the parts in a sitemap index"]);
    if (x.kind === "index") {
      if (index) problems.push(["sitemap_too_large", sm, `sitemap index listed inside the sitemap index ${index}: sitemap indexes can't be nested (Search Console: "Nested indexing")`]);
      queue.push(...x.locs.map((url) => ({ url, from: `sitemap index ${sm}`, index: sm })));
      continue;
    }
    for (const l of x.locs) { const u = normalize(l); if (u && urls.size < 100000) urls.add(u); }
    for (const [l, lm] of x.lastmodOf) { lastmods.push(lm); const u = normalize(l); if (u && lastmodOf.size < 100000) lastmodOf.set(u, lm.slice(0, 10)); }
  }
  return { urls, lastmods, lastmodOf, found: seen.size > 0 && urls.size > 0, declared: declared.length > 0, problems };
}
