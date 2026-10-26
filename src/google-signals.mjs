// Indexing signals as Google reads them (Google Search Central docs, REQ-044, Oct 2026): robots meta / X-Robots-Tag
// directives scoped per crawler, canonical hrefs and conflicts between canonical signals, soft-404 content and
// redirects to the home page. Pure functions: the crawler passes in what it fetched.
import { createHash } from "node:crypto";

// Directive names Google (and Bing) document for robots meta tags and X-Robots-Tag. Any other "name:" prefix in a
// header value is a user agent ("googlebot: noindex", "bingbot: nofollow").
const DIRECTIVES = new Set(["all", "index", "follow", "noindex", "nofollow", "none", "noarchive", "nocache", "nosnippet", "notranslate", "noimageindex",
  "indexifembedded", "max-snippet", "max-image-preview", "max-video-preview", "unavailable_after", "noodp", "noydir", "noai", "noimageai"]);
// Scopes Googlebot obeys for web search: unscoped (meta name="robots", a header line without a user agent) and googlebot.
const GOOGLE = new Set(["*", "robots", "googlebot"]);

/** A robots meta content or X-Robots-Tag value → [[scope, directive]]. A "bot:" prefix scopes the directives after it
 *  (Node joins repeated headers with ", ", so "googlebot: nofollow, otherbot: noindex, nofollow" keeps its scopes);
 *  the commas inside an unavailable_after date stay with the date. */
export function splitDirectives(value, scope = "*") {
  const out = [];
  let cur = String(scope || "*").toLowerCase();
  for (const raw of String(value || "").split(",")) {
    let t = raw.trim();
    if (!t) continue;
    const w = t.match(/^([a-z][\w.-]*)\s*(:)?/i);
    const name = w?.[1].toLowerCase(), known = name && DIRECTIVES.has(name), isScope = Boolean(w?.[2]) && !known;
    const last = out.at(-1);
    if (!known && !isScope && last && /^unavailable_after\s*:/i.test(last[1])) { last[1] += ", " + t; continue; }
    if (isScope) { cur = name; t = t.slice(w[0].length).trim(); if (!t) continue; }
    out.push([cur, t]);
  }
  return out;
}

/** What Googlebot takes from robots meta tags ([{name, content}]) and an X-Robots-Tag header value:
 *  { noindex, nofollow, snippet, unavailableAfter: {raw, at}, others: ["bingbot: noindex"] }. `none` = noindex +
 *  nofollow; max-snippet under 50 characters counts as a snippet limit; directives for other crawlers are listed only. */
export function robotsDirectives(metas = [], header = "") {
  const pairs = [...metas.flatMap((m) => splitDirectives(m.content, m.name)), ...splitDirectives(header)];
  const r = { noindex: false, nofollow: false, snippet: null, unavailableAfter: null, others: [] };
  for (const [scope, raw] of pairs) {
    const t = raw.toLowerCase().replace(/\s+/g, " ");
    if (!GOOGLE.has(scope)) { if (r.others.length < 6) r.others.push(`${scope}: ${t}`); continue; }
    if (t === "noindex" || t === "none") r.noindex = true;
    if (t === "nofollow" || t === "none") r.nofollow = true;
    const max = t.match(/^max-snippet\s*:\s*(-?\d+)/);
    if (!r.snippet && (/^(nosnippet|noarchive|nocache)$/.test(t) || (max && +max[1] >= 0 && +max[1] < 50))) r.snippet = t;
    const ua = raw.match(/^unavailable_after\s*:\s*(.*)$/i);
    if (ua && !r.unavailableAfter) { const ms = Date.parse(ua[1].trim()); r.unavailableAfter = { raw: ua[1].trim().slice(0, 60), at: Number.isNaN(ms) ? null : new Date(ms).toISOString() }; }
  }
  return r;
}

/** Adds the X-Robots-Tag header's directives to a page's data (meta tags are already in it from parseHtml). */
export function applyHeaderRobots(d, header) {
  if (d.noindex) d.noindexSource = "meta robots";
  if (!header) return d;
  const h = robotsDirectives([], header);
  if (h.noindex) { d.noindex = true; d.noindexSource = "X-Robots-Tag"; }
  if (h.nofollow && !d.nofollowMeta) d.nofollowMeta = "X-Robots-Tag";
  if (h.snippet && !d.snippetBlock) d.snippetBlock = `${h.snippet} (X-Robots-Tag)`;
  if (h.unavailableAfter && !d.unavailableAfter) d.unavailableAfter = h.unavailableAfter;
  if (h.others.length) d.robotsOtherBots = [...new Set([...(d.robotsOtherBots || []), ...h.others.map((x) => x + " (X-Robots-Tag)")])].slice(0, 6);
  return d;
}

/** Robots meta tags in raw HTML, for pages not parsed with cheerio (e.g. a robots-blocked URL fetched once). */
export function metaRobotsTags(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const name = m[0].match(/\bname\s*=\s*["']?([^"'\s>]+)/i)?.[1], content = m[0].match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (name && /^(robots|[\w-]*bot[\w-]*)$/i.test(name) && content) out.push({ name: name.toLowerCase(), content: content[1] ?? content[2] ?? content[3] });
  }
  return out;
}

/** Why a raw canonical href can't be used as written, or null: { bad } for hrefs Google can't use (empty, a template
 *  placeholder, a #fragment), { form } for ones that work but are risky (relative, another host). */
export function canonicalHrefProblem(raw, pageUrl) {
  const href = String(raw ?? "").trim();
  if (!href) return { bad: "the canonical href is empty" };
  if (/\{\{|\}\}|\$\{|%7B%7B|%7D%7D/i.test(href) || /(^|[/=?#&])(undefined|null|NaN)([/?#&.]|$)/.test(href))
    return { bad: `the canonical is an unfilled template value: ${href.slice(0, 120)}` };
  if (href.includes("#")) return { bad: `the canonical contains a # fragment, which Google doesn't use: ${href.slice(0, 120)}` };
  let abs;
  try { abs = new URL(href, pageUrl); } catch { return { bad: `the canonical isn't a valid URL: ${href.slice(0, 120)}` }; }
  if (!/^https?:\/\//i.test(href)) return { form: `relative canonical "${href.slice(0, 100)}" (Google accepts it but recommends a full absolute URL)` };
  if (abs.host !== new URL(pageUrl).host) return { form: `canonical points to another host: ${abs.href.slice(0, 120)} (fine for syndicated copies)` };
  return null;
}

/** rel="canonical" target from an HTTP Link header, resolved against the page URL, or null. */
export function linkHeaderCanonical(header, base) {
  for (const part of String(header || "").split(/,\s*(?=<)/)) {
    const m = part.match(/^\s*<([^>]*)>(.*)$/);
    if (m && /;\s*rel\s*=\s*"?[^";]*\bcanonical\b/i.test(m[2])) { try { const u = new URL(m[1].trim(), base); u.hash = ""; return u.href; } catch { return null; } }
  }
  return null;
}

/** Fingerprint of a page's main text, kept for every HTML page (textHash in parseHtml skips pages under 50 words). */
export const textFingerprint = (text) => (text ? createHash("md5").update(String(text).toLowerCase()).digest("hex") : null);

const homeOf = (start) => { const u = new URL(start); return u.origin + "/"; };
// The home page, including /index.html-style and /home addresses of it (redirecting those to / is normal).
const isHome = (u, start) => {
  try { const x = new URL(u); return x.origin + x.pathname === homeOf(start) || (x.origin === new URL(start).origin && /^\/(index|default|home)(\.\w+)?$/i.test(x.pathname)); }
  catch { return false; }
};

/** Site canonical rules: the canonical target is noindex, or canonicalises on to a third URL (chain or loop), and
 *  many pages with their own content canonicalising to the home page (at least 3 and 10% of HTML pages). Pages that
 *  only pre-fill a form (variantOf) are skipped. Returns [[id, url, detail]]. */
export function canonicalSiteIssues(pages, start) {
  const out = [], byUrl = new Map();
  for (const p of pages) for (const u of [p.url, p.final_url || p.url]) if (!byUrl.has(u) || p.status === 200) byUrl.set(u, p);
  const self = (p, c) => c === p.url || c === (p.final_url || p.url);
  const home = byUrl.get(homeOf(start)) || byUrl.get(start);
  const html = pages.filter((p) => p.status === 200 && /html/.test(p.content_type || "") && !p.data.variantOf);
  const toHome = [];
  for (const p of html) {
    if (!p.canonical || self(p, p.canonical)) continue;
    const t = byUrl.get(p.canonical);
    if (home && t === home && p !== home) { toHome.push(p); continue; }
    if (!t || t.status !== 200) continue; // a missing or broken target is canonical_broken
    if (t.data.noindex) out.push(["canonical_conflict", p.url, `canonical ${p.canonical} is noindex (${t.data.noindexSource || "robots"}): the page names a version Google is told not to index`]);
    else if (t.canonical && !self(t, t.canonical)) out.push(["canonical_conflict", p.url, self(p, t.canonical)
      ? `canonical loop: ${p.canonical} points back to this page` : `canonical chain: ${p.canonical} canonicalises on to ${t.canonical}; point straight at the final URL`]);
  }
  const hh = home?.data.textHash;
  const differ = toHome.filter((p) => hh && p.data.textHash && p.data.textHash !== hh);
  if (differ.length >= 3 && differ.length >= 0.1 * html.length)
    for (const p of differ) out.push(["canonical_conflict", p.url, `canonical points to the home page although the content differs (${differ.length} pages do this; often a template default)`]);
  return out;
}

// Title or H1 wording of an error page (English); a heuristic, so short pages only.
const ERROR_WORDS = /\b(page not found|not found|404|no longer (?:available|exists)|doesn'?t exist|does not exist|no (?:results|products) found|0 results|temporarily unavailable|under maintenance)\b/i;

/** soft_404_content: a 200 HTML indexable page that reads like an error page (title or H1 says not found / no results
 *  and the main text is under 300 words), or whose text is identical to the site's own 404 page. Product pages with
 *  Product markup and the home page are never flagged on wording. redirect_to_home: a URL with a path that 301/302s
 *  to the home page (Google treats that like a soft 404). notFoundHash: textFingerprint of the 404 response. */
export function soft404Issues(pages, { start, notFoundHash = null }) {
  const out = [];
  const homeHash = pages.find((p) => isHome(p.final_url || p.url, start) && p.status === 200)?.data.textHash;
  for (const p of pages) {
    const u = p.final_url || p.url;
    if (p.status === 200 && p.indexable && /html/.test(p.content_type || "") && !isHome(u, start) && !p.data.variantOf) {
      const product = (p.data.schemaTypes || []).some((t) => /^(Product|ProductGroup|Offer)$/.test(t));
      const said = [["title", p.title], ["H1", p.h1]].find(([, s]) => s && ERROR_WORDS.test(s));
      if (notFoundHash && notFoundHash !== homeHash && p.data.textHash === notFoundHash) out.push(["soft_404_content", p.url, "same text as the site's 404 page, but answers HTTP 200"]);
      else if (said && !product && (p.words || 0) < 300) out.push(["soft_404_content", p.url, `${said[0]} "${said[1].slice(0, 80)}" with ${p.words || 0} words, answering HTTP 200`]);
    }
    const r = p.data.redirect;
    // A path that isn't the home page itself (http→https or www hops of "/" and "/?query" variants have none).
    if (r && [301, 302, 303, 307, 308].includes(r.firstStatus) && new URL(p.url).pathname !== "/" && !isHome(p.url, start) && isHome(r.to, start))
      out.push(["redirect_to_home", p.url, `${r.firstStatus} → ${r.to}${p.in_sitemap ? " (listed in the sitemap)" : ""}`]);
  }
  return out;
}
