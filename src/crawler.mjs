// Site crawler: unlimited (or capped) BFS over one site, sitemap discovery, redirect chains,
// optional JavaScript rendering. Stores pages, links and issues for one audit.
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { db, run, get, all } from "./db.mjs";
import { CHECKS, pageIssues, healthScore } from "./checks.mjs";
import { crawlabilitySiteIssues, paramTraps, headClosedEarly, robotsDiff, faviconIssues, historyTraps, scriptTrapIssues, robotsBlockedIssues } from "./crawlability.mjs";
import { aiPageIssues, aiSiteIssues, aiBotAccess, aiReadiness } from "./ai-checks.mjs";
import { similarForAudit, crawlerAccess, lastmodUniformity, lastmodChanged } from "./quality.mjs";
import { conversionIssues } from "./conversion.mjs";
import { robotsDirectives, applyHeaderRobots, canonicalHrefProblem, linkHeaderCanonical, textFingerprint, canonicalSiteIssues, soft404Issues } from "./google-signals.mjs";
import { loadSitemaps } from "./sitemaps.mjs";
import { rawRenderedDiff, renderPage, renderFindings, mergeRender, jsRedirectOf } from "./render-checks.mjs";
import { uncrawlableLinks, anchorOf, ugcLinks, anchorFindings, linkSiteIssues, urlVariantIssues } from "./link-signals.mjs";
import { schemaFindings } from "./schema.mjs";
import { siteNameIssues, merchantPolicyIssues, localNapIssues } from "./schema-site.mjs";
import { siteProbeIssues } from "./site-probes.mjs";
import { robotsTxtIssues } from "./robots-txt.mjs";
import { siteRuleIssues, saveLastmods, lastmodAccuracyIssues } from "./site-rules.mjs";
import { pageSignals, signalSiteIssues } from "./page-signals.mjs";
import { videoUrlsOf, videoFileIssues } from "./video-checks.mjs";
import { CTA, ctaFoldIssues } from "./fold-check.mjs";
import { brandTerms } from "./trends.mjs";
import { createLadder, curlFetch, browserFetch, lazyBrowser, ladderSiteIssues, readCapped, REFUSED, BROWSER_UA } from "./fetch-ladder.mjs";
import { requestHeaderValues, headersFor, redact } from "./request-headers.mjs";
export { rawRenderedDiff };

// Some sites (government WAFs, Cloudflare) reject unknown bots; external/image checks retry as a browser (BROWSER_UA,
// fetch-ladder.mjs), and crawled pages go through the fetch ladder.
const running = new Map(); // auditId -> { stop: bool }
export const isRunning = (id) => running.has(id);
export const stopAudit = (id) => { const r = running.get(id); if (r) r.stop = true; };

/** Why Google can't use an hreflang value, or null. Google supports ISO 639-1 languages and ISO 3166-1 alpha-2
 *  regions only: numeric regions such as es-419 are named as unsupported in its localized-versions docs. */
const NOT_REGIONS = { UK: "use GB", EU: "EU is not a country", LA: "LA is Laos, not Latin America" };
export function hreflangCodeProblem(code) {
  if (/^x-default$/i.test(code)) return null;
  const m = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i.exec(code || "");
  if (!m) return "not language[-REGION]";
  if (m[3] && /^\d{3}$/.test(m[3])) return "numeric regions aren't supported by Google";
  return m[3] ? NOT_REGIONS[m[3].toUpperCase()] || null : null;
}

export function normalize(u, base) {
  try {
    const x = new URL(u, base);
    if (!/^https?:$/.test(x.protocol)) return null;
    x.hash = "";
    if ((x.protocol === "https:" && x.port === "443") || (x.protocol === "http:" && x.port === "80")) x.port = "";
    return x.href;
  } catch { return null; }
}
const hostKey = (h) => h.replace(/^www\./, "");

// robots.txt as fetched by each audit, so the next audit can report what changed (robots_txt_changed / _disallow_added).
db.exec("CREATE TABLE IF NOT EXISTS audit_robots (audit_id INTEGER PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE, status INTEGER, body TEXT)");
export const saveRobots = (auditId, status, body) => run("INSERT OR REPLACE INTO audit_robots (audit_id, status, body) VALUES (?,?,?)", auditId, status, String(body || "").slice(0, 600 * 1024));
const robotsUsable = (s) => s === 200 || (s >= 400 && s < 500); // 4xx = no robots.txt (allow all); 5xx/timeouts are robots_txt_error
/** Compares this audit's robots.txt with the newest earlier finished audit of the project that stored one. */
export function robotsChangeIssues(projectId, auditId, status, body, origin) {
  const prev = get(`SELECT a.id, r.status, r.body FROM audits a JOIN audit_robots r ON r.audit_id=a.id
    WHERE a.project_id=? AND a.id<? AND a.status='done' ORDER BY a.id DESC LIMIT 1`, projectId, auditId);
  if (!prev || !robotsUsable(prev.status) || !robotsUsable(status)) return [];
  const pages = all("SELECT url, final_url FROM pages WHERE audit_id=? AND status=200 AND indexable=1", prev.id).flatMap((p) => [p.url, p.final_url || p.url]);
  return robotsDiff(prev.status === 200 ? prev.body : "", status === 200 ? body : "", pages, origin, prev.id);
}

/** extra: the project's request headers, only ever passed for its own hosts (request-headers.mjs). */
async function fetchOnce(url, ua, method = "GET", timeout = 20000, extra = null) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, redirect: "manual", signal: ctl.signal, headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en;q=0.9", ...extra } });
    const ttfb = Date.now() - t0; // server response time = time to headers, not download
    const type = res.headers.get("content-type") || "";
    const body = method === "GET" && res.status < 300 && /html|xml|text/.test(type) ? await res.text() : "";
    // A refused answer keeps the start of its page, only to recognise a bot challenge (botWall); it isn't the page.
    const wallBody = method === "GET" && REFUSED.has(res.status) && /html|xml|text/.test(type) ? await readCapped(res).catch(() => "") : "";
    return { status: res.status, headers: res.headers, type, body, wallBody, ms: ttfb, location: res.headers.get("location") };
  } catch (e) {
    return { status: 0, headers: new Headers(), type: "", body: "", ms: Date.now() - t0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally { clearTimeout(t); }
}

/** Bot walls (Akamai, Cloudflare) fingerprint Node's TLS and refuse it even with a browser UA; curl usually passes. */
function curlStatus(url) {
  return new Promise((resolve) => {
    // Some government sites (e.g. transport.vic.gov.au) answer 403 unless the request carries a browser's Accept headers.
    execFile("curl", ["-s", "-L", "--max-redirs", "5", "-m", "15", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}", "-A", BROWSER_UA,
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "-H", "Accept-Language: en-AU,en;q=0.9", url],
      { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(Number(stdout) || 0));
  });
}

/** Follows redirects manually (max 10) so chains and loops are visible. extraFor(url): request headers for that hop
 *  (null for other hosts, so a redirect never carries them off the site). */
async function fetchFollow(url, ua, extraFor = () => null) {
  const seen = [url];
  let r = await fetchOnce(url, ua, "GET", 20000, extraFor(url));
  const firstStatus = r.status;
  let total = r.ms;
  while (r.status >= 300 && r.status < 400 && r.location && seen.length <= 10) {
    const next = normalize(r.location, seen.at(-1));
    if (!next) break;
    if (seen.includes(next)) return { ...r, finalUrl: next, redirect: { hops: seen.length, to: next, firstStatus, loop: true }, ms: total };
    seen.push(next);
    r = await fetchOnce(next, ua, "GET", 20000, extraFor(next));
    total += r.ms;
  }
  const redirect = seen.length > 1 ? { hops: seen.length - 1, to: seen.at(-1), firstStatus, finalStatus: r.status } : null;
  return { ...r, finalUrl: seen.at(-1), redirect, ms: total };
}

// Content age: a date the page states about itself, as yyyy-mm-dd. Accepts ISO dates/timestamps, "5 January 2024"
// and "January 5, 2024". Numeric d/m/y forms are skipped (05/01/2024 is ambiguous between countries).
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function isoDate(s) {
  s = String(s || "").trim();
  let x, y, m, d;
  if ((x = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) [y, m, d] = [+x[1], +x[2], +x[3]];
  else if ((x = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/i))) [y, m, d] = [+x[3], MONTHS.indexOf(x[2].toLowerCase()) + 1, +x[1]];
  else if ((x = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i))) [y, m, d] = [+x[3], MONTHS.indexOf(x[1].toLowerCase()) + 1, +x[2]];
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const STATED_DATE = /(?<![a-z])(last\s+updated|last\s+modified|updated|modified|published|posted)\s*(?:on)?\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?,?\s+\d{4}|[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/gi;

export function parseHtml(html, url) {
  const $ = cheerio.load(html);
  const d = {};
  // Every robots meta tag counts (Google combines them); name="robots" and "googlebot" apply to Googlebot, other bot
  // names (bingbot…) are listed only. none = noindex + nofollow.
  const metas = $("meta[name][content]").map((_, e) => ({ name: $(e).attr("name").toLowerCase(), content: $(e).attr("content") })).get()
    .filter((m) => /^(robots|[\w-]*bot[\w-]*)$/.test(m.name));
  const robotsMeta = metas.filter((m) => m.name === "robots" || m.name === "googlebot").map((m) => m.content).join(" ");
  const rd = robotsDirectives(metas);
  d.noindex = rd.noindex;
  // nosnippet / noarchive / nocache / max-snippet under 50 limit how search and AI answers (Bing Copilot) may quote the page.
  if (rd.snippet) d.snippetBlock = rd.snippet;
  if (rd.unavailableAfter) d.unavailableAfter = rd.unavailableAfter;
  if (rd.others.length) d.robotsOtherBots = rd.others;
  // Crawlability: page-level nofollow, meta refresh redirects, and navigation done in JavaScript (not an <a href>).
  if (rd.nofollow) d.nofollowMeta = true;
  const refresh = $("meta[http-equiv]").filter((_, e) => /^refresh$/i.test($(e).attr("http-equiv"))).attr("content");
  if (refresh && /url\s*=/i.test(refresh)) d.metaRefresh = refresh.slice(0, 120);
  if ($('input[type="password" i]').length) d.passwordField = true; // a login page (login_page_indexable)
  const jsNav = uncrawlableLinks($); // also <a> without href, #! routes, role="link" / data-href elements
  if (jsNav.length) { d.jsLinks = jsNav.length; d.jsLinkExample = jsNav[0].slice(0, 80); }
  // Possible back-button hijacking in the page's own inline scripts (Google spam policies, Apr 2026).
  $("script:not([src])").each((k, e) => {
    if (d.backButton || /json|template|text\/(?!javascript)/i.test($(e).attr("type") || "")) return;
    const found = historyTraps($(e).text());
    if (found.length) d.backButton = `inline script #${k + 1}: ${found.join("; ")}`;
  });
  const canon = $('link[rel="canonical"]');
  d.canonicals = canon.length;
  const canonical = canon.length ? normalize(canon.first().attr("href"), url) : null;
  if (canon.length) { // checked on the raw href: normalize() drops a #fragment and resolves relative paths
    const cp = canonicalHrefProblem(canon.first().attr("href"), url);
    if (cp?.bad) d.canonicalProblem = cp.bad; else if (cp?.form) d.canonicalForm = cp.form;
  }
  d.h1Count = $("h1").length;
  d.lang = $("html").attr("lang") || "";
  d.viewport = $('meta[name="viewport"]').length > 0;
  d.og = $('meta[property="og:title"]').length > 0 && $('meta[property="og:image"]').length > 0;
  d.jsonld = 0; d.jsonldInvalid = 0; d.schemaTypes = [];
  const faqNames = [], ld = []; let bizRating = false, crumbs = false;
  const declared = { m: [], p: [] }; // dates from JSON-LD and meta tags (m = modified, p = published)
  const BIZ = /^(LocalBusiness|Organization|AutoRepair|AutoBodyShop|Store|ProfessionalService|.*Business)$/;
  const scan = (o) => {
    if (Array.isArray(o)) return o.forEach(scan);
    if (!o || typeof o !== "object") return;
    const types = [].concat(o["@type"] || []);
    if (types.includes("FAQPage")) for (const q of [].concat(o.mainEntity || [])) if (q && q.name) faqNames.push(String(q.name));
    if (types.includes("BreadcrumbList")) crumbs = true;
    if (types.some((t) => BIZ.test(t)) && (o.aggregateRating || o.review)) bizRating = true;
    if (o.dateModified) declared.m.push(o.dateModified);
    if (o.datePublished) declared.p.push(o.datePublished);
    // A node with only @type/@id is a reference to a VideoObject described elsewhere, not one to validate.
    if (types.includes("VideoObject") && Object.keys(o).some((k) => !k.startsWith("@"))) {
      d.videoObjects = (d.videoObjects || 0) + 1;
      const miss = ["name", "thumbnailUrl", "uploadDate"].filter((k) => !o[k] || (Array.isArray(o[k]) && !o[k].length));
      if (miss.length) { d.videoObjectsIncomplete = (d.videoObjectsIncomplete || 0) + 1; d.videoObjectMissing ||= miss.join(", "); }
      const vu = videoUrlsOf(o); // thumbnail and file URLs: robots.txt and reachability checks after the crawl
      if (vu && (d.videoUrls ||= []).length < 5) d.videoUrls.push(vu);
    }
    Object.values(o).forEach(scan);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    d.jsonld++;
    try {
      const j = JSON.parse($(el).contents().text());
      ld.push(j);
      scan(j);
      const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === "object") { if (o["@type"]) d.schemaTypes.push(...[].concat(o["@type"])); Object.values(o).forEach(walk); } };
      walk(j);
    } catch { d.jsonldInvalid++; }
  });
  d.schemaTypes = [...new Set(d.schemaTypes)].slice(0, 20);
  d.microdata = $("[itemscope]").length > 0;
  // hreflang sanity
  const hl = $('link[rel="alternate"][hreflang]');
  if (hl.length) {
    const codes = hl.map((_, e) => $(e).attr("hreflang")).get();
    const bad = codes.filter((c) => hreflangCodeProblem(c)).map((c) => `${c} (${hreflangCodeProblem(c)})`);
    const self = hl.filter((_, e) => normalize($(e).attr("href"), url) === url).length;
    if (bad.length) d.hreflangBad = `invalid codes: ${bad.slice(0, 3).join(", ")}`;
    else if (!self) d.hreflangBad = "no self-referencing hreflang";
    // Language versions of one page: their shared text/titles are not duplicates (see site rules).
    d.hreflangAlts = [...new Set(hl.map((_, e) => normalize($(e).attr("href"), url)).get().filter(Boolean))].slice(0, 60);
    const xd = normalize(hl.filter((_, e) => /^x-default$/i.test($(e).attr("hreflang"))).first().attr("href") || "", url);
    if (xd) d.hreflangXDefault = xd; // compared across the cluster (hreflang.mjs)
  }
  // links. placement: "content" = in the page's own text; "nav" = template (menus, header, footer, breadcrumbs, or
  // anything outside <main> when the page has one). A menu link on every page says little about its target, so
  // contextual-link checks must not count it.
  const links = [];
  const hasMain = $("main").length > 0;
  // Conversion path: ways for a visitor to act on this page (call, email, a form that isn't site search, a CTA button).
  d.convTel = $('a[href^="tel:" i]').length;
  d.convMail = $('a[href^="mailto:" i]').length;
  d.convForm = $("form").filter((_, f) => $(f).attr("role") !== "search" && $(f).find("input,textarea,select").filter((_, i) =>
    !/^(hidden|search|submit|button)$/i.test($(i).attr("type") || "") && !/^(q|s|search|query)$/i.test($(i).attr("name") || "")).length > 0).length;
  d.convCta = $("a[href], button, input[type=submit]").filter((_, e) => CTA.test(($(e).text() || $(e).attr("value") || "").trim())).length;
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || /^(mailto|tel|javascript|sms|#)/i.test(href.trim())) return;
    const to = normalize(href, url);
    const template = (hasMain && !$(a).closest("main").length) || $(a).closest("header, nav, footer, aside, [role=navigation], [role=banner], [role=contentinfo]").length > 0;
    const rel = ($(a).attr("rel") || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (to) links.push({ to, ...anchorOf($, a), nofollow: /nofollow/i.test(rel), ...(rel ? { rel } : {}), placement: template ? "nav" : "content" });
  });
  const ugc = ugcLinks($, url);
  if (ugc.n) { d.ugcUnqualified = ugc.n; d.ugcExample = ugc.example; }
  // Files the page needs to render: same-site ones are status-checked (broken_internal_resource).
  const res = new Set([...$("script[src]").map((_, e) => $(e).attr("src")).get(),
    ...$("link[href]").filter((_, e) => /\b(stylesheet|preload|modulepreload)\b/i.test($(e).attr("rel") || "")).map((_, e) => $(e).attr("href")).get()]);
  $("style").each((_, e) => { for (const m of $(e).text().matchAll(/url\(\s*['"]?([^'")]+\.(?:woff2?|ttf|otf|eot)(?:[?#][^'")]*)?)['"]?\s*\)/gi)) res.add(m[1]); });
  // images
  const imgs = [];
  $("img").each((_, i) => {
    const src = $(i).attr("src") || ($(i).attr("srcset") || "").split(/[ ,]/)[0];
    const to = src ? normalize(src, url) : null;
    if (to) imgs.push(to);
    if (!$(i).attr("alt") && $(i).attr("alt") !== "" && $(i).attr("role") !== "presentation") d.imgNoAlt = (d.imgNoAlt || 0) + 1;
  });
  // mixed content
  if (url.startsWith("https://")) {
    const res = [...$("script[src]").map((_, e) => $(e).attr("src")).get(), ...$('link[rel="stylesheet"][href]').map((_, e) => $(e).attr("href")).get(), ...$("img[src]").map((_, e) => $(e).attr("src")).get(), ...$("iframe[src]").map((_, e) => $(e).attr("src")).get()];
    const mixed = res.filter((r) => /^http:\/\//i.test(r));
    if (mixed.length) { d.mixed = mixed.length; d.mixedExample = mixed[0].slice(0, 100); }
  }
  // AI-readability signals
  const headings = $("h2,h3").map((_, h) => $(h).text().trim()).get();
  d.questionHeadings = headings.filter((h) => /\?\s*$/.test(h)).length;
  d.headings = headings.length;
  d.author = Boolean($('meta[name="author"]').attr("content") || $('[rel="author"]').length || /"author"\s*:/.test(html) || /\bBy\s+[A-Z][a-z]+\s+[A-Z][a-z]+/.test($("main").text() || $("body").text()));
  d.dated = Boolean($("time[datetime]").length || /"date(Modified|Published)"\s*:/.test(html) || /article:(modified|published)_time/.test(html) || /(Last updated|Updated|Published)\s*:?\s*\d{1,2}\s+\w+\s+\d{4}/i.test($("body").text()));
  // Content age: the newest date the page states. Declared dates (JSON-LD, meta tags) win; <time datetime> and
  // visible "Updated / Published <date>" text are used only when no date of that kind is declared (they may belong
  // to related posts listed on the page).
  const metaDate = (sel) => $(sel).map((_, e) => $(e).attr("content")).get();
  declared.m.push(...metaDate('meta[property="article:modified_time"], meta[property="og:updated_time"], meta[itemprop="dateModified"]'));
  declared.p.push(...metaDate('meta[property="article:published_time"], meta[itemprop="datePublished"]'));
  const shown = { m: [], p: [] }, stated = { m: [], p: [] }; // stated: visible "Published / Updated <date>" text only
  $("time[datetime]").each((_, e) => { const t = $(e); shown[t.attr("itemprop") === "dateModified" || /updat|modif/i.test((t.attr("class") || "") + " " + t.parent().text().slice(0, 80)) ? "m" : "p"].push(t.attr("datetime")); });
  for (const [, kind, date] of $("body").text().replace(/\s+/g, " ").matchAll(STATED_DATE)) {
    const k = /updat|modif/i.test(kind) ? "m" : "p";
    shown[k].push(date);
    if (isoDate(date)) stated[k].push(isoDate(date));
  }
  const newest = (list) => list.map(isoDate).filter(Boolean).sort().at(-1);
  const dm = newest(declared.m) || newest(shown.m), dp = newest(declared.p) || newest(shown.p);
  if (dm) d.dateModified = dm;
  if (dp) d.datePublished = dp;
  // Long-content structure: heading order inside the page's own content (menus, sidebars and the site header/footer
  // are left out; an H1 always counts), and jump links to those headings.
  const $c = hasMain ? $("main") : $("body");
  const chrome = (h) => $(h).closest("nav, aside, [role=navigation], [role=banner], [role=contentinfo]").length
    || $(h).closest("header, footer").filter((_, e) => !$(e).closest("article, section").length).length;
  const hs = $c.find("h1,h2,h3,h4,h5,h6").toArray().filter((h) => h.name === "h1" || !chrome(h));
  let prev = 0;
  for (const h of hs) {
    const lv = +h.name[1];
    if (prev && lv > prev + 1) { d.headingSkips = (d.headingSkips || 0) + 1; d.headingSkipExample ||= `H${prev} → H${lv} "${$(h).text().replace(/\s+/g, " ").trim().slice(0, 60)}"`; }
    prev = lv;
  }
  const firstH1 = hs.findIndex((h) => h.name === "h1");
  if (firstH1 > 0) d.headingsBeforeH1 = firstH1;
  d.h2Count = hs.filter((h) => h.name === "h2").length;
  const targets = new Set(); // ids a table of contents can point at: the heading, its section wrapper, or an empty anchor before it
  for (const h of hs) {
    if (h.name === "h1") continue;
    const own = $(h), parent = own.parent(), before = own.prev();
    for (const e of [own, parent.is("main, body, article") ? null : parent, before.length && !before.text().trim() ? before : null]) {
      if (e?.attr("id")) targets.add(e.attr("id"));
      if (e?.attr("name")) targets.add(e.attr("name"));
    }
  }
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  d.jumpLinks = new Set($('a[href^="#"]').map((_, a) => dec($(a).attr("href").slice(1))).get().filter((id) => targets.has(id))).size;
  if ($('[itemtype*="VideoObject" i]').length) d.videoObjects = (d.videoObjects || 0) + $('[itemtype*="VideoObject" i]').length; // microdata: present, fields not validated
  // text
  const $t = cheerio.load(html);
  $t("script,style,noscript,svg,template,iframe").remove();
  const scope = $t("main").length ? $t("main") : $t("body");
  const text = scope.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  // Video embeds and their position, images, spam words, keyword stuffing, script hosts (page-signals.mjs).
  Object.assign(d, pageSignals($, { url, $c, text }));
  // Text-to-HTML ratio compares all visible text with the whole HTML (header and footer included on both sides);
  // using only <main> text against the whole file under-counted pages with a big header/footer.
  d.visibleBytes = Buffer.byteLength($t("body").text().replace(/\s+/g, " ").trim());
  // Booking and claim pages are mostly form fields; their labels and options are the content.
  d.formShare = +($("form").toArray().reduce((n, f) => n + ($.html(f) || "").length, 0) / Math.max(html.length, 1)).toFixed(2);
  const paras = scope.find("p").map((_, p) => $t(p).text().replace(/\s+/g, " ").trim()).get().filter((p) => p.split(" ").length >= 25);
  // Very long paragraphs: over 180 words, the top of the citable-passage range (ai_no_citable_block, ai_no_answer
  // ask for 40–180 words), so the checks never contradict each other.
  const longParas = paras.map((p) => p.split(" ").length).filter((n) => n > 180);
  if (longParas.length) { d.longParas = longParas.length; d.longParaMax = Math.max(...longParas); }
  const firstPos = paras.length ? text.indexOf(paras[0].slice(0, 40)) / Math.max(text.length, 1) : 1;
  // Up to 180 words, the same range as a citable passage (ai_no_citable_block): a 150-word opening paragraph that
  // answers the question is both. The old 120-word cap made the two checks contradict each other.
  d.answerEarly = paras.length > 0 && firstPos <= 0.3 && paras[0].split(" ").length <= 180;
  d.citableBlocks = paras.filter((p) => { const n = p.split(" ").length; return n >= 100 && n <= 180; }).length;
  // I5: the passage an AI answer would most likely lift — self-contained, specific, early, ideally 134–167 words.
  let best = null;
  for (const p of paras) {
    const n = p.split(" ").length;
    if (n < 40 || n > 220) continue;
    const pos = Math.max(0, text.indexOf(p.slice(0, 40))) / Math.max(text.length, 1);
    const lenScore = n >= 134 && n <= 167 ? 1 : 1 - Math.min(Math.abs(n - 150) / 150, 0.8);
    const standalone = /^(this|that|these|those|it|they|he|she|also|however|but|and|so)\b/i.test(p) ? 0.5 : 1;
    const specific = /\d/.test(p) ? 1 : 0.8;
    const score = lenScore * standalone * specific * (1.2 - Math.min(pos, 1) * 0.6);
    if (!best || score > best.score) best = { score, text: p.slice(0, 1400), words: n, pos: Math.round(pos * 100) };
  }
  if (best) d.bestPassage = { text: best.text, words: best.words, pos: best.pos, score: Math.round(best.score * 100) };
  d.h2s = headings.slice(0, 30).map((x) => x.slice(0, 120));
  // Structured data must describe visible content (Google SD policies): FAQ questions on the page, a visible trail
  // for BreadcrumbList, and no self-serving rating markup on the business's own entity.
  const norm = (x) => x.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
  const visible = norm($t("body").text());
  const hiddenFaq = faqNames.filter((n) => !visible.includes(norm(n)));
  if (hiddenFaq.length) d.faqHidden = hiddenFaq.length + " of " + faqNames.length + ": " + hiddenFaq[0].slice(0, 80);
  if (crumbs && !$('[aria-label*="readcrumb" i], [class*="crumb" i], [itemtype*="BreadcrumbList"]').length) d.crumbHidden = true;
  if (bizRating) d.selfReview = true;
  // Required/recommended properties, values the page doesn't show, retired types, dates, conflicts (schema.mjs).
  Object.assign(d, schemaFindings(ld, { text: $t("body").text().replace(/\s+/g, " "), stated, ogSiteName: $('meta[property="og:site_name"]').attr("content"),
    itemtypes: $("[itemtype]").map((_, e) => $(e).attr("itemtype")).get() }));
  // Listing pages (a blog index, a category) link to many pages below their own folder.
  const here = new URL(url);
  if (here.pathname.endsWith("/") && here.pathname !== "/") {
    d.childLinks = new Set(links.map((l) => { try { const x = new URL(l.to); return x.host === here.host && x.pathname.startsWith(here.pathname) && x.pathname !== here.pathname ? x.pathname : null; } catch { return null; } }).filter(Boolean)).size;
  }
  return {
    title: $("title").first().text().replace(/\s+/g, " ").trim(),
    description: ($('meta[name="description"]').attr("content") || "").trim(),
    h1: $("h1").first().text().replace(/\s+/g, " ").trim(),
    canonical, links, imgs, words, text, res: [...res].map((x) => normalize(x.trim(), url)).filter(Boolean),
    robotsMeta: robotsMeta.trim().toLowerCase().replace(/\s+/g, " "),
    textHash: words > 50 ? createHash("md5").update(text.toLowerCase()).digest("hex") : null,
    data: d,
  };
}

/** Last try for a link that still refuses automated checks: open it in Chrome/Edge as a reader would. A bot
 *  challenge ("Just a moment…", "Access denied") still counts as refused. */
async function browserStatus(browser, url) {
  const page = await browser.newPage({ userAgent: BROWSER_UA, locale: "en-AU" });
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const status = res?.status() || 0;
    const title = (await page.title()).toLowerCase();
    if (/just a moment|attention required|access denied|forbidden|are you a robot|captcha|request blocked/.test(title)) return status >= 400 ? status : 403;
    return status;
  } catch { return 0; } finally { await page.close(); }
}

/** Runs fn over items with n workers; n may be a function, so the crawl can slow down mid-batch (fetch ladder). */
async function pool(n, items, fn, shouldStop) {
  let i = 0;
  const width = typeof n === "function" ? n : () => n;
  await Promise.all(Array.from({ length: width() }, async (_, w) => { while (i < items.length && !shouldStop() && w < width()) { const k = i++; await fn(items[k], k); } }));
}

/** deps: test seams for the fetch ladder's curl, browser and sleep (fetch-ladder.mjs). */
export async function runAudit(auditId, project, settings, onProgress = () => {}, deps = {}) {
  const ctl = { stop: false };
  running.set(auditId, ctl);
  const ua = settings.userAgent;
  const start = normalize(project.start_url);
  const origin = new URL(start).origin;
  const siteHost = hostKey(new URL(start).hostname);
  const inScope = (u) => { try { const h = hostKey(new URL(u).hostname); return h === siteHost || (settings.includeSubdomains && h.endsWith("." + siteHost)); } catch { return false; } };
  run("UPDATE audits SET status='running', started_at=datetime('now'), settings=? WHERE id=?", JSON.stringify(settings), auditId);
  // The project's request headers: values stay out of settings and audit rows, and go to its own hosts only.
  const own = requestHeaderValues(project.id), extraFor = headersFor(own, inScope);

  let browser = null, fallbackBrowser = null;
  try {
    const robotsRes = await fetchFollow(origin + "/robots.txt", ua, extraFor);
    const robotsTxt = robotsRes.status === 200 ? robotsRes.body : "";
    const robots = robotsParser(origin + "/robots.txt", robotsTxt);
    saveRobots(auditId, robotsRes.status, robotsTxt);
    // robots.txt of the hosts rendered pages load files from (same site only; up to 10 hosts, fetched once each).
    const robotsByOrigin = new Map([[origin, Promise.resolve(robotsTxt ? robots : null)]]);
    const robotsFor = (o) => {
      if (!robotsByOrigin.has(o) && robotsByOrigin.size < 10) robotsByOrigin.set(o, fetchOnce(o + "/robots.txt", ua, "GET", 10000, extraFor(o + "/robots.txt")).then((x) => (x.status === 200 && x.body ? robotsParser(o + "/robots.txt", x.body) : null)));
      return robotsByOrigin.get(o) || Promise.resolve(null);
    };
    let home = null; // the start page's raw HTML, for the favicon and script checks
    const sitemap = await loadSitemaps(origin, robotsTxt, ua, { normalize });
    saveLastmods(auditId, sitemap.lastmodOf); // the next audit checks them against page changes (sitemap_lastmod_inaccurate)
    const llms = await fetchOnce(origin + "/llms.txt", ua, "GET", 20000, extraFor(origin + "/llms.txt"));
    if (settings.renderJs) { const { launchChromium } = await import("./browser.mjs"); browser = await launchChromium(); }
    // Pages that refuse the normal request: polite retry, curl, then a real browser (setting blockedFallback). Every
    // step obeys robots.txt exactly like the crawl itself.
    const robotsBlocked = (u) => Boolean(settings.respectRobots && robotsTxt && robots.isAllowed(u, "SEOAuditor") === false && robots.isAllowed(u, "*") === false);
    fallbackBrowser = lazyBrowser(browser, async () => (await import("./browser.mjs")).launchChromium());
    const ladder = createLadder({ mode: settings.blockedFallback, concurrency: settings.concurrency, inScope, blocked: robotsBlocked, headersFor: extraFor,
      stop: () => ctl.stop, sleep: deps.sleep, fetchPage: (u) => fetchFollow(u, ua, extraFor), curl: deps.curl || ((u, o) => curlFetch(u, { ...o, ua })),
      browser: deps.browser || (async (u, o) => browserFetch(await fallbackBrowser.get(), u, { ...o, ua, blocked: (x) => inScope(x) && robotsBlocked(x) })) });

    const seen = new Map([[start, 0]]);
    const queue = [start];
    for (const u of sitemap.urls) if (u && inScope(u) && !seen.has(u)) { seen.set(u, null); queue.push(u); }
    const insPage = db.prepare(`INSERT OR REPLACE INTO pages (audit_id,url,final_url,status,depth,content_type,response_ms,bytes,title,description,h1,canonical,indexable,in_sitemap,outlinks,words,text_ratio,data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insLink = db.prepare("INSERT INTO links (audit_id,from_url,to_url,anchor,internal,nofollow,kind,placement,rel) VALUES (?,?,?,?,?,?,?,?,?)");
    const insText = db.prepare("INSERT OR REPLACE INTO page_text (audit_id, url, text) VALUES (?,?,?)"); // for link suggestions (I4)
    const hashes = new Map();
    const imgSet = new Set(); const extSet = new Set(); const resSet = new Set();
    let crawled = 0, started = 0; // started: reserves slots so parallel workers respect maxPages

    while (queue.length && !ctl.stop) {
      const batch = queue.splice(0, Math.max(settings.concurrency * 4, 20));
      await pool(ladder.parallel, batch, async (url) => {
        if (settings.maxPages && started >= settings.maxPages) return;
        started++;
        const depth = seen.get(url);
        if (robotsBlocked(url)) { insPage.run(auditId, url, url, 0, depth, "", 0, 0, "", "", "", null, 0, sitemap.urls.has(url) ? 1 : 0, 0, 0, 0, JSON.stringify({ blockedByRobots: true })); crawled++; return; }
        const r = await ladder.fetch(url);
        const final = r.finalUrl;
        const direct = r.via === "fetch" || r.via === "retry"; // a fallback's HTML isn't re-rendered: the renderer would meet the wall again
        let html = r.body;
        let jsWordsRaw = null, raw = null, rawParse = null, rendered = null;
        if (browser && direct && r.status === 200 && /html/.test(r.type)) {
          rawParse = parseHtml(html, final);
          rendered = await renderPage(browser, final, ua);
          // After a JavaScript redirect the rendered DOM is another URL's page (crawled on its own): keep the raw HTML.
          if (rendered?.html && !jsRedirectOf(final, rendered, rawParse.data.metaRefresh)) { jsWordsRaw = rawParse.words; raw = rawParse; html = rendered.html; }
        }
        const isHtml = /html/.test(r.type) && r.status === 200;
        const p = isHtml ? parseHtml(html, final) : { title: "", description: "", h1: "", canonical: null, links: [], imgs: [], res: [], words: 0, text: "", data: {} };
        const d = { ...p.data, redirect: r.redirect || undefined, error: r.error ? redact(r.error, own) : undefined, fetchedVia: r.via };
        if (r.botWall) d.botWall = { ...r.botWall, status: r.directStatus ?? r.status };
        if (r.tried?.length) d.fallbackTried = r.tried;
        if (!direct) { d.directStatus = r.directStatus; d.fallbackMs = r.fallbackMs; } // response_ms stays empty: not the server's answer to a crawler
        if (r.rateLimited) d.rateLimited = true;
        if (isHtml) {
          const hc = headClosedEarly(r.body); // always the raw source: a rendered DOM has already been repaired
          if (hc) d.headClosedEarly = hc;
          const found = rendered && await renderFindings({ fetched: final, render: rendered, robotsFor, metaRefresh: Boolean(rawParse.data.metaRefresh),
            words: { raw: rawParse.words, rendered: raw ? p.words : null } }).catch(() => null);
          mergeRender(d, raw, p, final, found); // raw vs rendered, render log: blocked files, errors, JavaScript redirect
          for (const u of found?.renderFailed || []) if (!p.res.includes(u)) p.res.push(u);
          // Google follows a JavaScript redirect after rendering: crawl the target like a linked page.
          const to = d.jsRedirect?.to && normalize(d.jsRedirect.to);
          if (to && inScope(to) && !seen.has(to)) { seen.set(to, (depth ?? 0) + 1); queue.push(to); }
          if (url === start) home = { html: r.body, url: final, dom: html }; // dom: the rendered HTML when rendering is on
        }
        // Indexing directives in headers count from a fallback too: the server sends them with the page itself.
        applyHeaderRobots(d, r.headers.get("x-robots-tag") || ""); // only googlebot: or unscoped header lines count
        const linkCanon = linkHeaderCanonical(r.headers.get("link"), final);
        if (linkCanon) d.canonicalHeader = linkCanon;
        if (isHtml && p.text) d.textHash = textFingerprint(p.text); // every page, even short ones (soft-404 and canonical checks)
        if (jsWordsRaw !== null) { d.jsWordsRaw = jsWordsRaw; d.jsWordsRendered = p.words; }
        const indexable = r.status === 200 && isHtml && !d.noindex && (!p.canonical || p.canonical === final || p.canonical === url) ? 1 : 0;
        const bytes = Buffer.byteLength(r.body || "");
        const ratio = bytes ? +(((d.visibleBytes ?? Buffer.byteLength(p.text)) / bytes) * 100).toFixed(1) : 0;
        // ?service=… style links that pre-fill a form: the URL's canonical is the same page without the query, so its
        // page checks belong to that clean URL (crawl it if no link reaches it).
        if (p.canonical && new URL(final).search && p.canonical === final.split("?")[0]) {
          d.variantOf = p.canonical;
          if (inScope(p.canonical) && !seen.has(p.canonical)) { seen.set(p.canonical, depth); queue.push(p.canonical); }
        }
        let internalOut = 0, extLinks = 0, extNofollow = 0, nofollowInternal = 0;
        for (const l of p.links) {
          const internal = inScope(l.to);
          insLink.run(auditId, final, l.to, l.anchor, internal ? 1 : 0, l.nofollow ? 1 : 0, "a", l.placement, l.rel || null);
          if (internal) {
            internalOut++; if (l.nofollow) nofollowInternal++;
            if (!seen.has(l.to) && /^https?:/.test(l.to) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(new URL(l.to).pathname)) {
              seen.set(l.to, (depth ?? 0) + 1); queue.push(l.to);
            } else if (seen.get(l.to) === null) seen.set(l.to, (depth ?? 0) + 1);
          } else { extLinks++; if (l.nofollow) extNofollow++; extSet.add(l.to); }
        }
        for (const im of p.imgs) { insLink.run(auditId, final, im, "", inScope(im) ? 1 : 0, 0, "img", null, null); if (inScope(im)) imgSet.add(im); }
        for (const u of p.res) if (inScope(u)) { insLink.run(auditId, final, u, "", 1, 0, "res", null, null); resSet.add(u); } // scripts, styles, fonts
        Object.assign(d, { nofollowInternal, externalLinks: extLinks, externalNofollow: extNofollow }, anchorFindings(p.links, inScope));
        if (p.textHash && indexable) { const prev = hashes.get(p.textHash); if (prev) d.dupOf = prev; else hashes.set(p.textHash, url); }
        insPage.run(auditId, url, final, r.status, depth, r.type.split(";")[0], r.ms, bytes, p.title, p.description, p.h1, p.canonical, indexable,
          sitemap.urls.has(url) || sitemap.urls.has(final) ? 1 : 0, p.links.length, p.words, ratio, JSON.stringify(d));
        if (indexable && p.text) insText.run(auditId, final, p.text.slice(0, 30000));
        crawled++;
      }, () => ctl.stop || (settings.maxPages && crawled >= settings.maxPages));
      run("UPDATE audits SET pages_crawled=?, pages_queued=? WHERE id=?", crawled, queue.length, auditId);
      onProgress({ crawled, queued: queue.length });
      if (settings.maxPages && crawled >= settings.maxPages) break;
    }

    // ---- post-crawl: link graph, resource checks, site rules ----
    run(`UPDATE pages SET inlinks = (SELECT COUNT(DISTINCT l.from_url) FROM links l WHERE l.audit_id=pages.audit_id AND l.kind='a' AND l.internal=1 AND l.to_url IN (pages.url, pages.final_url) AND l.from_url <> pages.url) WHERE audit_id=?`, auditId);
    const statusOf = new Map(all("SELECT url, final_url, status FROM pages WHERE audit_id=?", auditId).flatMap((p) => [[p.url, p.status], [p.final_url, p.status]]));
    const checkStatus = async (set, limit, width = settings.concurrency) => {
      const out = new Map(); const list = [...set].filter((u) => !statusOf.has(u)).slice(0, limit);
      await pool(width, list, async (u) => {
        let r = await fetchOnce(u, ua, "HEAD", 15000, extraFor(u));
        if (r.status === 0 || r.status === 405 || r.status >= 400) r = await fetchOnce(u, BROWSER_UA, "GET", 15000, extraFor(u));
        if ([0, 401, 403, 429].includes(r.status)) r = { status: (await curlStatus(u)) || r.status };
        out.set(u, r.status);
      }, () => ctl.stop);
      return out;
    };
    const imgStatus = await checkStatus(imgSet, 20000, ladder.parallel); // own files: at the crawl's (possibly lowered) pace
    const resStatus = await checkStatus(resSet, 5000, ladder.parallel);
    const extStatus = settings.checkExternalLinks ? await checkStatus(extSet, 5000) : new Map();
    const refused = [...extStatus].filter(([, s]) => [401, 403, 429].includes(s)).map(([u]) => u).slice(0, 40);
    if (refused.length && !ctl.stop) {
      let b = browser;
      try {
        if (!b) { const { launchChromium } = await import("./browser.mjs"); b = await launchChromium(); }
        await pool(3, refused, async (u) => { const s = await browserStatus(b, u); if (s && s < 400) extStatus.set(u, s); }, () => ctl.stop);
      } catch { /* no browser on this computer: keep the refused status */ }
      finally { if (b && b !== browser) await b.close().catch(() => {}); }
    }
    const sOf = (u) => statusOf.get(u) ?? imgStatus.get(u) ?? resStatus.get(u) ?? extStatus.get(u);

    // Click depth = shortest link path from the start page (sitemap-seeded pages may be crawled before a link to them is seen).
    {
      const adj = new Map();
      for (const l of db.prepare("SELECT DISTINCT from_url, to_url FROM links WHERE audit_id=? AND kind='a' AND internal=1").iterate(auditId)) {
        if (!adj.has(l.from_url)) adj.set(l.from_url, []); adj.get(l.from_url).push(l.to_url);
      }
      const finals = new Map(all("SELECT url, final_url FROM pages WHERE audit_id=?", auditId).map((p) => [p.url, p.final_url || p.url]));
      const depth = new Map([[start, 0]]); const q = [start];
      while (q.length) {
        const u = q.shift(); const d = depth.get(u);
        for (const v of adj.get(finals.get(u) || u) || []) if (!depth.has(v)) { depth.set(v, d + 1); q.push(v); }
      }
      const upd = db.prepare("UPDATE pages SET depth=? WHERE audit_id=? AND url=?");
      db.exec("BEGIN"); for (const u of finals.keys()) upd.run(depth.has(u) ? depth.get(u) : null, auditId, u); db.exec("COMMIT");
    }
    // Re-time slow pages one at a time: parallel crawling on small hosts inflates response times.
    for (const p of all("SELECT url, final_url, response_ms FROM pages WHERE audit_id=? AND response_ms > 1500 ORDER BY response_ms DESC LIMIT 50", auditId)) {
      if (ctl.stop) break;
      const r = await fetchOnce(p.final_url || p.url, ua, "GET", 20000, extraFor(p.final_url || p.url));
      if (r.status === 200 && r.ms < p.response_ms) run("UPDATE pages SET response_ms=? WHERE audit_id=? AND url=?", r.ms, auditId, p.url);
    }
    const pages = all("SELECT * FROM pages WHERE audit_id=?", auditId).map((p) => ({ ...p, data: JSON.parse(p.data) }));
    // auditDate: the day the crawl finished (UTC), used by date checks such as content_stale.
    const ctx = { siteIsHttps: start.startsWith("https://"), sitemapLoaded: sitemap.found, auditDate: new Date().toISOString().slice(0, 10), renderJs: Boolean(settings.renderJs) };
    const insIssue = db.prepare("INSERT INTO issues (audit_id,check_id,severity,url,detail) VALUES (?,?,?,?,?)");
    const raise = (id, url, detail = "") => insIssue.run(auditId, id, CHECKS[id][0], url, String(detail).slice(0, 300));
    // hreflang clusters (union-find): language versions of one page may share text, titles and descriptions.
    const parent = new Map();
    const find = (u) => { while (parent.has(u)) u = parent.get(u); return u; };
    const finalOf = new Map(pages.map((p) => [p.url, p.final_url || p.url]));
    for (const p of pages) for (const alt of p.data.hreflangAlts || []) {
      const ra = find(finalOf.get(p.url)), rb = find(alt);
      if (ra !== rb) parent.set(ra, rb);
    }
    const cluster = (u) => find(finalOf.get(u) || u);
    // Research-based site checks (quality.mjs): computed before the write transaction because they fetch.
    const near = similarForAudit(auditId, { min: 0.5 }).filter((x) => cluster(x.a) !== cluster(x.b));
    const access = ctl.stop ? null : await crawlerAccess(start, ua);
    const keep = {}; // crawlabilitySiteIssues keeps the 404 probe's response here (soft_404_content compares texts)
    const crawlSite = ctl.stop ? [] : await crawlabilitySiteIssues({ start, robotsRes, robotsTxt, robots, ua, keep }).catch(() => []);
    const notFoundHash = keep.notFound?.body ? textFingerprint(parseHtml(keep.notFound.body, keep.notFound.url).text) : null;
    // Robots-blocked URLs the site links to or lists, fetched once each: a noindex there is invisible to Google.
    const blockedChecks = ctl.stop || !settings.respectRobots || settings.auditBlockedUrls !== true ? [] : await robotsBlockedIssues(pages, { ua }).catch(() => []);
    const robotsChanges = robotsChangeIssues(project.id, auditId, robotsRes.status, robotsTxt, origin);
    const favicon = ctl.stop || !home ? [] : await faviconIssues({ start: home.url, html: home.html, robotsTxt, ua }).catch(() => []);
    const scripts = {}; // scriptTrapIssues keeps the scripts' source map URLs here
    const homeScripts = ctl.stop || !home ? [] : await scriptTrapIssues({ start: home.url, html: home.html, ua, keep: scripts }).catch(() => []);
    // Extra probes (up to 60 sequential requests, setting siteProbes): search pages, smartphone/Googlebot parity,
    // staging hosts, 304 and compression, secret files, certificate expiry, language redirects.
    const probes = ctl.stop || settings.siteProbes !== true ? [] : await siteProbeIssues({ start, pages, robots: robotsTxt ? robots : null, ua, parse: parseHtml, notFoundHash,
      resUrls: [...resSet], seenUrls: [...extSet, ...pages.map((p) => p.canonical).filter(Boolean), ...sitemap.urls], sourceMaps: scripts.sourceMaps || [], stop: () => ctl.stop }).catch(() => []);
    const localNap = ctl.stop || !home ? [] : await localNapIssues({ url: home.url, html: home.dom }, settings).catch(() => []);
    // VideoObject thumbnails and files (up to 20 requests, one at a time), and CTAs below the first phone screen (up
    // to 6 pages, in the rendering browser, or in one launched for this when Lighthouse is on).
    const videoFiles = ctl.stop ? [] : await videoFileIssues(pages, { stop: () => ctl.stop }).catch(() => []);
    let fold = [];
    if (!ctl.stop && (browser || settings.cwvPages > 0)) {
      let b = browser;
      try {
        if (!b) { const { launchChromium } = await import("./browser.mjs"); b = await launchChromium(); }
        fold = await ctaFoldIssues({ pages, start, browser: b, stop: () => ctl.stop });
      } catch { /* no browser on this computer: not checked */ } finally { if (b && b !== browser) await b.close().catch(() => {}); }
    }
    const redirOf = new Map(pages.filter((p) => p.data.redirect).map((p) => [p.url, p.data.redirect.to]));
    // Pages still behind a bot wall: reported as bot_wall_blocked, not as broken links or bad sitemap URLs.
    const walled = new Set(pages.filter((p) => p.data.botWall && p.status >= 400).flatMap((p) => [p.url, p.final_url]));
    const lm = lastmodUniformity(sitemap.lastmods || []);
    // A shared date is honest after a real site-wide edit: check those pages' text against the audit before that date.
    if (lm && lm.share >= 0.6) lm.check = lastmodChanged(project.id, auditId, lm.date, sitemap.lastmodOf);
    db.exec("BEGIN");
    for (const p of pages) {
      for (const [id, det] of pageIssues(p, ctx)) raise(id, p.url, det);
      for (const [id, det] of aiPageIssues(p)) raise(id, p.url, det);
      if (p.data.dupOf && cluster(p.url) !== cluster(p.data.dupOf)) raise("dup_content", p.url, `same text as ${p.data.dupOf}`);
      if (p.status === 200 && p.indexable && p.inlinks === 1) raise("single_inlink", p.url);
      if (p.in_sitemap && p.inlinks === 0 && p.url !== start) raise("sitemap_orphan", p.url);
      if (p.in_sitemap && p.data.blockedByRobots) raise("sitemap_blocked", p.url);
      if (p.in_sitemap && (p.status !== 200 || p.data.redirect) && !walled.has(p.url)) raise("sitemap_bad_url", p.url, p.data.redirect ? "redirects" : `HTTP ${p.status}`);
      if (p.canonical && p.canonical !== p.url) { const s = sOf(p.canonical); if (s && s !== 200) raise("canonical_broken", p.url, `${p.canonical} → HTTP ${s}`); }
    }
    for (const l of db.prepare("SELECT DISTINCT from_url,to_url,internal,kind FROM links WHERE audit_id=?").iterate(auditId)) { // streamed: large sites have millions of links
      if (l.kind === "a" && l.internal && redirOf.has(l.to_url)) raise("links_to_redirect", l.from_url, `${l.to_url} → ${redirOf.get(l.to_url)}`);
      const s = sOf(l.to_url);
      if (!s || s < 400 || walled.has(l.to_url)) continue;
      if (l.kind === "img" && l.internal) raise("broken_internal_image", l.from_url, `${l.to_url} → ${s}`);
      else if (l.kind === "res") { if (![401, 403, 429].includes(s)) raise("broken_internal_resource", l.from_url, `${l.to_url} → ${s}`); } // still refused after the retries: a bot wall, not a broken file
      else if (l.kind === "a" && l.internal) raise("broken_internal_link", l.from_url, `${l.to_url} → ${s}`);
      else if (l.kind === "a") raise([401, 403, 429].includes(s) ? "external_link_blocked" : "broken_external_link", l.from_url, `${l.to_url} → ${s}`);
    }
    const byTitle = new Map(), byDesc = new Map();
    for (const p of pages.filter((x) => x.indexable)) {
      if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) || []), p.url]);
      if (p.description) byDesc.set(p.description, [...(byDesc.get(p.description) || []), p.url]);
    }
    const crossCluster = (us) => new Set(us.map(cluster)).size > 1;
    for (const [t, us] of byTitle) if (us.length > 1 && crossCluster(us)) us.forEach((u) => raise("dup_title", u, `"${t.slice(0, 80)}" on ${us.length} pages`));
    for (const [t, us] of byDesc) if (us.length > 1 && crossCluster(us)) us.forEach((u) => raise("dup_description", u, `shared by ${us.length} pages`));
    const contentLinks = new Map();
    for (const l of db.prepare("SELECT DISTINCT from_url, to_url FROM links WHERE audit_id=? AND internal=1 AND kind='a' AND placement='content'").iterate(auditId))
      contentLinks.set(l.from_url, [...(contentLinks.get(l.from_url) || []), redirOf.get(l.to_url) || l.to_url]);
    for (const [id, u, det] of conversionIssues(pages, contentLinks, start)) raise(id, u, det);
    for (const x of near) { raise("near_duplicate", x.a, `${Math.round(x.score * 100)}% of 5-word phrases shared with ${x.b}`); raise("near_duplicate", x.b, `${Math.round(x.score * 100)}% shared with ${x.a}`); }
    if (lm && lm.share >= 0.6 && !(lm.check?.share >= 0.7)) raise("sitemap_lastmod_uniform", origin + "/sitemap.xml",
      `${lm.n} of ${lm.total} URLs have lastmod ${lm.date}` + (lm.check ? `; only ${lm.check.changed} of ${lm.check.n} changed since audit #${lm.check.baseAudit}` : ""));
    for (const b of access?.blocked || []) raise("ai_bot_blocked_server", start, `${b.bot}: HTTP ${b.status || "no response"}, ${b.bytes} bytes (browser: HTTP ${access.base.status}, ${access.base.bytes} bytes)`);
    if (!robotsTxt) raise("no_robots_txt", origin + "/robots.txt");
    if (!sitemap.found) raise("no_sitemap", origin + "/sitemap.xml");
    else if (robotsTxt && !sitemap.declared) raise("sitemap_not_in_robots", origin + "/robots.txt");
    if (llms.status !== 200) raise("no_llms_txt", origin + "/llms.txt");
    for (const [id, det] of aiSiteIssues(robotsTxt, origin)) raise(id, origin + "/robots.txt", det);
    for (const [id, u, det] of [...crawlSite, ...robotsChanges, ...favicon, ...homeScripts, ...blockedChecks, ...sitemap.problems]) raise(id, u, det);
    for (const [id, u, det] of [...canonicalSiteIssues(pages, start), ...soft404Issues(pages, { start, notFoundHash })]) raise(id, u, det);
    for (const [id, u, det] of [...siteNameIssues(pages, start), ...merchantPolicyIssues(pages, start), ...localNap]) raise(id, u, det);
    for (const [id, u, det] of [...probes, ...robotsTxtIssues({ origin, status: robotsRes.status, type: robotsRes.type, text: robotsTxt }), ...siteRuleIssues(pages),
      ...lastmodAccuracyIssues(project.id, auditId, sitemap.lastmodOf, pages, origin + "/sitemap.xml")]) raise(id, u, det);
    for (const [path, n] of paramTraps(pages.map((p) => p.url))) raise("param_trap", path, `${n} ?parameter variants crawled`);
    const signals = signalSiteIssues({ auditId, projectId: project.id, pages, start, cluster, brandTerms: brandTerms(project, settings), robots: robotsTxt ? robots : null,
      robotsTxt, origin, allow: String(settings.spamAllowTerms || "").split(",").map((t) => t.trim()).filter(Boolean) });
    for (const [id, u, det] of [...signals, ...videoFiles, ...fold, ...ladderSiteIssues(ladder.stats, start)]) raise(id, u, det);
    const aLinks = db.prepare("SELECT DISTINCT from_url,to_url,internal,nofollow,rel FROM links WHERE audit_id=? AND kind='a'").iterate(auditId);
    for (const [id, u, det] of [...linkSiteIssues(aLinks, { pages, redirOf, inScope, robots: robotsTxt ? robots : null, auditDate: ctx.auditDate }), ...urlVariantIssues(pages)]) raise(id, u, det);
    db.exec("COMMIT");

    // ---- totals and health ----
    const sev = all("SELECT severity, COUNT(*) n, COUNT(DISTINCT url) pages FROM issues WHERE audit_id=? AND check_id NOT LIKE 'ai_%' GROUP BY severity", auditId);
    const count = (s) => sev.find((x) => x.severity === s)?.n || 0;
    const errPages = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='error' AND check_id NOT LIKE 'ai_%'", auditId).n;
    const warnOnly = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='warning' AND check_id NOT LIKE 'ai_%' AND url NOT IN (SELECT url FROM issues WHERE audit_id=? AND severity='error')", auditId, auditId).n;
    const health = healthScore(pages.length, errPages, warnOnly);
    // Only blocked search/answer fetchers cost points; training opt-outs (Google-Extended, GPTBot…) cost nothing.
    const aiRows = all("SELECT url, severity FROM issues WHERE audit_id=? AND check_id LIKE 'ai_%' AND check_id NOT IN ('ai_search_bot_blocked', 'ai_training_optout')", auditId);
    const blocks = get("SELECT COUNT(*) n FROM issues WHERE audit_id=? AND check_id='ai_search_bot_blocked'", auditId).n;
    const aiScore = aiReadiness(aiRows, pages.filter((p) => p.indexable).length, blocks);
    const siteInfo = { robotsTxt: Boolean(robotsTxt), sitemapUrls: sitemap.urls.size, sitemapDeclared: sitemap.declared, llmsTxt: llms.status === 200,
      aiBots: aiBotAccess(robotsTxt, origin), crawlerAccess: access, renderJs: Boolean(settings.renderJs),
      fetchLadder: { via: ladder.stats.via, walls: ladder.stats.walls, slowDowns: ladder.stats.slowDowns, parallel: ladder.stats.parallel } };
    run("UPDATE audits SET ai_readiness=?, site_info=? WHERE id=?", aiScore, JSON.stringify(siteInfo), auditId);
    run("UPDATE audits SET status=?, finished_at=datetime('now'), pages_crawled=?, pages_queued=0, health=?, errors=?, warnings=?, notices=?, message=? WHERE id=?",
      ctl.stop ? "stopped" : "done", pages.length, health, count("error"), count("warning"), count("notice"), ctl.stop ? "Stopped by user" : null, auditId);
    return { pages: pages.length, health };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    run("UPDATE audits SET status='failed', finished_at=datetime('now'), message=? WHERE id=?", redact(String(e.stack || e), own).slice(0, 500), auditId);
    throw e;
  } finally {
    await fallbackBrowser?.close(); // only when the ladder launched its own
    if (browser) await browser.close().catch(() => {});
    running.delete(auditId);
  }
}
