// Link signals as Google reads them (REQ-044 build rows 5, 9, 28-33, Oct 2026): links Google can't follow, anchor text,
// rel qualifiers on paid and user-generated links, tracking parameters, crawl traps, links to canonicalised URLs and
// URL forms of one page that all answer 200. Pure functions: parseHtml passes in cheerio, the crawler passes in rows.
const hostKey = (h) => h.replace(/^www\./, "");
const urlOf = (u, base) => { try { return new URL(u, base); } catch { return null; } };

// ---------------- In the page (parseHtml) ----------------

// JavaScript that navigates: location = …, location.assign/replace(…), window.open(…), a router's push(…) or navigate(…).
const JSNAV = /(?:location(?:\.href)?\s*=|location\.(?:assign|replace)\(|window\.open\(|router\.push\(|\bnavigate\()\s*['"`]([^'"`]+)/i;

/** Links Google can't follow (Google follows only <a> elements with an href URL): JavaScript navigation (onclick or a
 *  javascript: href), <a> with text but no href, #! / #/ hash routes and _escaped_fragment_ URLs, and role="link",
 *  routerlink, data-href or <…-link to> elements without an href. Not counted: named anchors without text, #section
 *  jump links, and toggles (aria-expanded, aria-controls, role="button"). Returns descriptions, in page order. */
export function uncrawlableLinks($) {
  const out = [];
  $("[onclick], a, [role=link], [routerlink], [data-href], [to]").each((_, e) => {
    const $e = $(e), href = $e.attr("href"), tag = e.name.toLowerCase();
    const nav = ($e.attr("onclick") || (/^\s*javascript:/i.test(href || "") ? href : "")).match(JSNAV)?.[1];
    if (nav) return void out.push(nav);
    const text = $e.text().replace(/\s+/g, " ").trim().slice(0, 40);
    if (href !== undefined) {
      const h = href.trim();
      if (tag === "a" && (/^#[!/]/.test(h) || /[?&]_escaped_fragment_=/.test(h))) out.push(`hash route ${h.slice(0, 60)}`);
      return;
    }
    if ($e.is("[aria-expanded], [aria-controls], [role=button]")) return;
    if (tag === "a") { if (text) out.push(`<a> without href: "${text}"`); return; }
    const target = $e.attr("data-href") || $e.attr("routerlink") || (tag.includes("link") ? $e.attr("to") : "");
    if (target || $e.attr("role") === "link") out.push(`<${tag}${target ? ` → ${target.slice(0, 50)}` : ' role="link"'}> without href${text ? `: "${text}"` : ""}`);
  });
  return out;
}

/** Anchor text as Google reads it: the link's text, or the alt text of an image inside it. label = aria-label or
 *  title (kept so a generic text with a descriptive label isn't flagged). */
export function anchorOf($, a) {
  const $a = $(a);
  const text = $a.text().replace(/\s+/g, " ").trim();
  const alt = text ? "" : $a.find("img[alt]").map((_, i) => $(i).attr("alt").trim()).get().filter(Boolean).join(" ");
  const label = ($a.attr("aria-label") || $a.attr("title") || "").replace(/\s+/g, " ").trim();
  return { anchor: (text || alt).slice(0, 120), ...(label ? { label: label.slice(0, 120) } : {}) };
}

// Comment, forum and review areas (WordPress, bbPress, schema.org comment markup, review widgets).
const UGC = "#comments, .comment, .comment-content, [itemprop=comment], .bbp-reply-content, .forum-post, .review-body, [class*=ugc]";

/** External links inside user-generated content without rel="ugc" or "nofollow". Links to the site's own host (or
 *  its subdomains) are left out. Returns { n, example }. */
export function ugcLinks($, pageUrl) {
  const own = hostKey(new URL(pageUrl).hostname), seen = new Set(), bad = [];
  $(UGC).find("a[href]").each((_, a) => {
    if (seen.has(a)) return; seen.add(a);
    const u = urlOf($(a).attr("href").trim(), pageUrl);
    if (!u || !/^https?:$/.test(u.protocol)) return;
    const h = hostKey(u.hostname);
    if (h === own || h.endsWith("." + own)) return;
    if (!/\b(ugc|nofollow)\b/i.test($(a).attr("rel") || "")) bad.push(u.href);
  });
  return { n: bad.length, example: bad[0] };
}

// ---------------- Anchor text (crawler, per page) ----------------

const GENERIC = new Set(["here", "click here", "click", "read more", "more", "learn more", "this", "link", "continue", "details", "more info", "find out more",
  "continue reading", "this page", "this link", "hier", "hier klicken", "mehr", "weiterlesen", "aquí", "haga clic aquí", "leer más", "ici", "cliquez ici",
  "en savoir plus", "lire la suite", "clicca qui", "klik hier"]);
const normAnchor = (s) => String(s || "").normalize("NFC").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/\s+/g, " ");
export const isGenericAnchor = (s) => GENERIC.has(normAnchor(s));

/** Internal content links (not menus, header or footer) with generic text ("read more", "click here", "mehr"…) and no
 *  aria-label/title adding words, and links with no text, image alt or label at all. Returns page data fields. */
export function anchorFindings(links, inScope) {
  const generic = new Map(), empty = [];
  let genericExample = null;
  for (const l of links) {
    if (l.placement !== "content" || !inScope(l.to)) continue;
    if (!l.anchor && !l.label) { empty.push(l.to); continue; }
    if (!isGenericAnchor(l.anchor)) continue;
    const label = normAnchor(l.label);
    if (label && !GENERIC.has(label) && label.split(" ").length > normAnchor(l.anchor).split(" ").length) continue; // the label describes the target
    const k = normAnchor(l.anchor);
    generic.set(k, (generic.get(k) || 0) + 1);
    genericExample ||= l.to;
  }
  const d = {};
  if (generic.size) {
    d.genericAnchors = [...generic.values()].reduce((a, b) => a + b, 0);
    d.genericAnchorDetail = [...generic].map(([k, n]) => `"${k}"${n > 1 ? ` ×${n}` : ""}`).slice(0, 4).join(", ") + `, e.g. → ${genericExample}`;
  }
  if (empty.length) { d.emptyAnchors = empty.length; d.emptyAnchorExample = empty[0]; }
  return d;
}

// ---------------- Link URLs (site rules) ----------------

const TRACKING = /^(utm_\w+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|srsltid)$/i;
/** Tracking parameter names in a URL's query (utm_*, gclid, fbclid, msclkid, _ga…). Filters such as ?color= aren't. */
export const trackingParams = (url) => [...new Set([...(urlOf(url)?.searchParams.keys() || [])].filter((k) => TRACKING.test(k)))];

// Affiliate networks and link formats: [name, host test, extra URL test].
const AFFILIATES = [
  ["Amazon Associates", (h) => /(^|\.)amazon\.[a-z.]+$/.test(h), (u) => u.searchParams.has("tag")],
  ["Amazon short link", (h) => h === "amzn.to"],
  ["Awin", (h) => h === "awin1.com" || h.endsWith(".awin1.com")],
  ["ShareASale", (h) => h === "shareasale.com" || h.endsWith(".shareasale.com")],
  ["Partnerize", (h) => h === "prf.hn"],
  ["CJ Affiliate", (h) => /(^|\.)(anrdoezrs\.net|jdoqocy\.com|tkqlhce\.com|dpbolvw\.net|kqzyfj\.com)$/.test(h)],
  ["ClickBank", (h) => h.endsWith("hop.clickbank.net")],
  ["Skimlinks", (h) => h === "go.skimresources.com"],
  ["Rakuten", (h) => h === "click.linksynergy.com"],
  ["Impact", (h) => /(^|\.)(sjv\.io|pxf\.io|7eer\.net)$/.test(h)],
];
/** The affiliate network an outbound URL belongs to, or null. */
export function affiliateOf(url) {
  const u = urlOf(url);
  if (!u) return null;
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  return AFFILIATES.find(([, host, extra]) => host(h) && (!extra || extra(u)))?.[0] || null;
}
const qualified = (l, words) => new RegExp(`\\b(${words})\\b`, "i").test(l.rel || "") || (words.includes("nofollow") && Boolean(l.nofollow));

const ACTION_PARAMS = /^(add-to-cart|add_to_cart|add-to-wishlist|add_to_wishlist|action|sessionid|jsessionid|phpsessid|sid|replytocom)$/i;
const FILTER_PARAMS = /^(sort|sortby|sort_by|order|orderby|order_by|dir|direction|filter|filters|f|fq|facet|refine|color|colour|size|brand|price|min_?price|max_?price|rating|view|display|layout|limit|per_?page|show|tag|category|cat|pa_\w+|filter_\w+|attr_?\w*)(\[.*\])?$/i;
const CAL_DIRS = /^(calendar|calendars|events?|agenda|schedule|kalender|calendrier|calendario)$/i;
const CAL_PARAMS = /^(year|month|date|day|week|ym|cal|calendar|eventdate|tribe-bar-date|event_date)$/i;
const yearIn = (s) => [...String(s).matchAll(/(?<!\d)((?:19|20|21)\d{2})/g)].map((m) => +m[1]);

/** Why an internal link URL is a crawl trap, or null: { reason, robots } with a suggested robots.txt rule. Cart and
 *  wishlist actions, session IDs and comment-reply links; double-encoded %25; three or more filter/sort parameters;
 *  calendar pages more than 2 years before or after the audit date. */
export function crawlTrap(url, auditDate) {
  const u = urlOf(url);
  if (!u) return null;
  const names = [...u.searchParams.keys()];
  const action = names.find((k) => ACTION_PARAMS.test(k));
  if (action) return { reason: `?${action}= (cart, session or reply action)`, robots: `Disallow: /*?${action}= and Disallow: /*&${action}=` };
  const sess = u.pathname.match(/;(jsessionid|phpsessid|sid)=/i);
  if (sess) return { reason: `;${sess[1]}= session ID in the path`, robots: `Disallow: /*;${sess[1].toLowerCase()}=` };
  if (/%25/i.test(u.pathname + u.search)) return { reason: "double-encoded %25 in the URL", robots: "Disallow: /*%25" };
  const filters = [...new Set(names.filter((k) => FILTER_PARAMS.test(k)).map((k) => k.replace(/\[.*$/, "")))];
  if (filters.length >= 3) return { reason: `${filters.length} filter/sort parameters (${filters.slice(0, 4).join(", ")})`, robots: `Disallow: ${u.pathname}?*&*& (three or more parameters on this path)` };
  const year = +String(auditDate || new Date().toISOString()).slice(0, 4);
  const far = (ys) => ys.find((y) => Math.abs(y - year) > 2);
  const segs = u.pathname.split("/").filter(Boolean);
  const cal = segs.findIndex((s) => CAL_DIRS.test(s));
  if (cal >= 0) { const y = far(segs.slice(cal + 1).flatMap(yearIn)); if (y) return { reason: `calendar page for ${y} (more than 2 years from the audit date)`, robots: `Disallow: /${segs.slice(0, cal + 1).join("/")}/ (or nofollow the next/previous links)` }; }
  for (const [k, v] of u.searchParams) if (CAL_PARAMS.test(k)) { const y = far(yearIn(v)); if (y) return { reason: `calendar ?${k}=${v.slice(0, 12)} (more than 2 years from the audit date)`, robots: `Disallow: /*?*${k}=` }; }
  return null;
}

const keyOf = (u) => { const x = urlOf(u); return x ? x.origin + x.pathname : u; };

/** Site rules over the audit's <a> links (rows: from_url, to_url, internal, nofollow, rel): links to canonicalised
 *  URLs, internal links with tracking parameters, affiliate links without rel="sponsored"/"nofollow" (also internal
 *  /go/, /out/ and /recommends/ links that redirect off the site) and crawl-trap links. pages: the audit's pages;
 *  redirOf: url → redirect target; robots: robots-parser object or null. Returns [[id, url, detail]]. */
export function linkSiteIssues(rows, { pages, redirOf = new Map(), inScope, robots = null, auditDate }) {
  const byUrl = new Map(pages.map((p) => [p.url, p])); // a URL's own row first, then the row that redirected to it
  for (const p of pages) if (p.final_url && !byUrl.has(p.final_url)) byUrl.set(p.final_url, p);
  const per = { links_to_canonicalized: new Map(), internal_link_tracking_params: new Map(), affiliate_link_unqualified: new Map() };
  const note = (id, from, text) => { const m = per[id]; if (!m.has(from)) m.set(from, []); m.get(from).push(text); };
  const traps = new Map(); // path → { urls: Set, trap }
  for (const l of rows) {
    if (l.kind && l.kind !== "a") continue;
    if (l.internal) {
      const t = byUrl.get(l.to_url);
      // A link to a redirecting URL is links_to_redirect; one to a redirect's final URL is checked against that page.
      if (t && l.from_url !== l.to_url && t.status === 200 && !(t.url === l.to_url && t.data?.redirect) && !t.data?.variantOf && t.canonical && t.canonical !== l.to_url && t.canonical !== (t.final_url || t.url))
        note("links_to_canonicalized", l.from_url, `${l.to_url} (canonical ${t.canonical})`);
      const tp = trackingParams(l.to_url);
      if (tp.length) note("internal_link_tracking_params", l.from_url, `${l.to_url.slice(0, 120)} (${tp.join(", ")})`);
      const out = redirOf.get(l.to_url);
      if (out && /^\/(go|out|recommends)\//i.test(urlOf(l.to_url)?.pathname || "") && !inScope(out) && !qualified(l, "sponsored|nofollow"))
        note("affiliate_link_unqualified", l.from_url, `${l.to_url} redirects to ${urlOf(out)?.host}${affiliateOf(out) ? ` (${affiliateOf(out)})` : ""}`);
      if (!l.nofollow && !(robots && robots.isAllowed(l.to_url, "Googlebot") === false)) {
        const trap = crawlTrap(l.to_url, auditDate);
        if (trap) { const k = keyOf(l.to_url); if (!traps.has(k)) traps.set(k, { urls: new Set(), trap }); traps.get(k).urls.add(l.to_url); }
      }
    } else {
      const net = affiliateOf(l.to_url);
      if (net && !qualified(l, "sponsored|nofollow")) note("affiliate_link_unqualified", l.from_url, `${net}: ${l.to_url.slice(0, 120)}`);
    }
  }
  const out = [];
  for (const [id, m] of Object.entries(per)) for (const [from, xs] of m) {
    const u = [...new Set(xs)];
    out.push([id, from, `${u.length} link(s), e.g. ${u.slice(0, 2).join("; ")}`]);
  }
  for (const [path, { urls, trap }] of traps) out.push(["crawl_trap_links", path, `${urls.size} linked URL(s), e.g. ${[...urls][0].slice(0, 120)}: ${trap.reason}; suggested robots.txt: ${trap.robots}`]);
  return out;
}

// /index.html, /index.php, /default.aspx… and a trailing slash are other forms of the same address; so is letter case.
const formKey = (u) => {
  const x = urlOf(u);
  if (!x) return u;
  let p = x.pathname.replace(/\/(index|default)\.(html?|php|aspx?)$/i, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return (x.origin + p).toLowerCase() + x.search;
};

/** url_variant_200: two crawled URLs that differ only by /index.html (or .php), a trailing slash or letter case both
 *  answer 200 with the same text, and the variant (linked internally) has no canonical to the main form. The main form
 *  is the self-canonical one with the most internal links. Pages with different text are never grouped. */
export function urlVariantIssues(pages) {
  const groups = new Map();
  for (const p of pages) {
    if (p.status !== 200 || p.data?.redirect || p.data?.variantOf || !p.data?.textHash || !/html/.test(p.content_type || "")) continue;
    const k = formKey(p.url) + " " + p.data.textHash;
    if (!groups.has(k)) groups.set(k, []);
    if (!groups.get(k).some((q) => q.url === p.url)) groups.get(k).push(p);
  }
  const out = [];
  const self = (p) => !p.canonical || p.canonical === p.url;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const main = [...g].sort((a, b) => self(b) - self(a) || (b.inlinks || 0) - (a.inlinks || 0) || a.url.length - b.url.length || (a.url < b.url ? -1 : 1))[0];
    for (const p of g) {
      if (p === main || p.canonical === main.url || !(p.inlinks > 0)) continue;
      out.push(["url_variant_200", p.url, `same page as ${main.url}: this form also answers 200 with the same text and ${p.canonical ? `its canonical is ${p.canonical}` : "no canonical"}; ${p.inlinks} internal page(s) link here`]);
    }
  }
  return out;
}
