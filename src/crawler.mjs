// Site crawler: unlimited (or capped) BFS over one site, sitemap discovery, redirect chains,
// optional JavaScript rendering. Stores pages, links and issues for one audit.
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { db, run, get, all } from "./db.mjs";
import { CHECKS, pageIssues, healthScore } from "./checks.mjs";
import { aiPageIssues, aiSiteIssues, aiBotAccess, aiReadiness } from "./ai-checks.mjs";
import { similarForAudit, crawlerAccess, lastmodUniformity } from "./quality.mjs";

// Some sites (government WAFs, Cloudflare) reject unknown bots; external/image checks retry as a browser.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const running = new Map(); // auditId -> { stop: bool }
export const isRunning = (id) => running.has(id);
export const stopAudit = (id) => { const r = running.get(id); if (r) r.stop = true; };

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

async function fetchOnce(url, ua, method = "GET", timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, redirect: "manual", signal: ctl.signal, headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en;q=0.9" } });
    const ttfb = Date.now() - t0; // server response time = time to headers, not download
    const type = res.headers.get("content-type") || "";
    const body = method === "GET" && res.status < 300 && /html|xml|text/.test(type) ? await res.text() : "";
    return { status: res.status, headers: res.headers, type, body, ms: ttfb, location: res.headers.get("location") };
  } catch (e) {
    return { status: 0, headers: new Headers(), type: "", body: "", ms: Date.now() - t0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally { clearTimeout(t); }
}

/** Bot walls (Akamai, Cloudflare) fingerprint Node's TLS and refuse it even with a browser UA; curl usually passes. */
function curlStatus(url) {
  return new Promise((resolve) => {
    execFile("curl", ["-s", "-L", "--max-redirs", "5", "-m", "15", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}", "-A", BROWSER_UA, url],
      { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(Number(stdout) || 0));
  });
}

/** Follows redirects manually (max 10) so chains and loops are visible. */
async function fetchFollow(url, ua) {
  const seen = [url];
  let r = await fetchOnce(url, ua);
  const firstStatus = r.status;
  let total = r.ms;
  while (r.status >= 300 && r.status < 400 && r.location && seen.length <= 10) {
    const next = normalize(r.location, seen.at(-1));
    if (!next) break;
    if (seen.includes(next)) return { ...r, finalUrl: next, redirect: { hops: seen.length, to: next, firstStatus, loop: true }, ms: total };
    seen.push(next);
    r = await fetchOnce(next, ua);
    total += r.ms;
  }
  const redirect = seen.length > 1 ? { hops: seen.length - 1, to: seen.at(-1), firstStatus, finalStatus: r.status } : null;
  return { ...r, finalUrl: seen.at(-1), redirect, ms: total };
}

async function loadSitemaps(origin, robotsTxt, ua) {
  const declared = [...robotsTxt.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  const queue = declared.length ? [...declared] : [origin + "/sitemap.xml"];
  const urls = new Set(); const seen = new Set(); const lastmods = [];
  while (queue.length && seen.size < 50) {
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    const r = await fetchFollow(sm, ua);
    if (r.status !== 200) continue;
    const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (/<sitemapindex/i.test(r.body)) queue.push(...locs);
    else { locs.forEach((l) => urls.size < 100000 && urls.add(normalize(l))); lastmods.push(...[...r.body.matchAll(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/g)].map((m) => m[1])); }
  }
  return { urls, lastmods, found: seen.size > 0 && urls.size > 0, declared: declared.length > 0 };
}

function parseHtml(html, url) {
  const $ = cheerio.load(html);
  const d = {};
  const robotsMeta = ($('meta[name="robots"]').attr("content") || "") + " " + ($('meta[name="googlebot"]').attr("content") || "");
  d.noindex = /noindex/i.test(robotsMeta);
  // nosnippet / noarchive / nocache / max-snippet:0 limit how search and AI answers (Bing Copilot) may quote the page.
  const snip = robotsMeta.match(/nosnippet|noarchive|nocache|max-snippet\s*:\s*0\b/i);
  if (snip) d.snippetBlock = snip[0];
  const canon = $('link[rel="canonical"]');
  d.canonicals = canon.length;
  const canonical = canon.length ? normalize(canon.first().attr("href"), url) : null;
  d.h1Count = $("h1").length;
  d.lang = $("html").attr("lang") || "";
  d.viewport = $('meta[name="viewport"]').length > 0;
  d.og = $('meta[property="og:title"]').length > 0 && $('meta[property="og:image"]').length > 0;
  d.jsonld = 0; d.jsonldInvalid = 0; d.schemaTypes = [];
  const faqNames = []; let bizRating = false, crumbs = false;
  const BIZ = /^(LocalBusiness|Organization|AutoRepair|AutoBodyShop|Store|ProfessionalService|.*Business)$/;
  const scan = (o) => {
    if (Array.isArray(o)) return o.forEach(scan);
    if (!o || typeof o !== "object") return;
    const types = [].concat(o["@type"] || []);
    if (types.includes("FAQPage")) for (const q of [].concat(o.mainEntity || [])) if (q && q.name) faqNames.push(String(q.name));
    if (types.includes("BreadcrumbList")) crumbs = true;
    if (types.some((t) => BIZ.test(t)) && (o.aggregateRating || o.review)) bizRating = true;
    Object.values(o).forEach(scan);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    d.jsonld++;
    try {
      const j = JSON.parse($(el).contents().text());
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
    const bad = codes.filter((c) => !/^([a-z]{2,3}(-[A-Za-z]{2}|-\d{3})?|x-default)$/i.test(c));
    const self = hl.filter((_, e) => normalize($(e).attr("href"), url) === url).length;
    if (bad.length) d.hreflangBad = `invalid codes: ${bad.slice(0, 3).join(", ")}`;
    else if (!self) d.hreflangBad = "no self-referencing hreflang";
    // Language versions of one page: their shared text/titles are not duplicates (see site rules).
    d.hreflangAlts = [...new Set(hl.map((_, e) => normalize($(e).attr("href"), url)).get().filter(Boolean))].slice(0, 60);
  }
  // links
  const links = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || /^(mailto|tel|javascript|sms|#)/i.test(href.trim())) return;
    const to = normalize(href, url);
    if (to) links.push({ to, anchor: $(a).text().replace(/\s+/g, " ").trim().slice(0, 120), nofollow: /nofollow/i.test($(a).attr("rel") || "") });
  });
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
  // text
  const $t = cheerio.load(html);
  $t("script,style,noscript,svg,template,iframe").remove();
  const scope = $t("main").length ? $t("main") : $t("body");
  const text = scope.text().replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  const paras = scope.find("p").map((_, p) => $t(p).text().replace(/\s+/g, " ").trim()).get().filter((p) => p.split(" ").length >= 25);
  const firstPos = paras.length ? text.indexOf(paras[0].slice(0, 40)) / Math.max(text.length, 1) : 1;
  d.answerEarly = paras.length > 0 && firstPos <= 0.3 && paras[0].split(" ").length <= 120;
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
  return {
    title: $("title").first().text().replace(/\s+/g, " ").trim(),
    description: ($('meta[name="description"]').attr("content") || "").trim(),
    h1: $("h1").first().text().replace(/\s+/g, " ").trim(),
    canonical, links, imgs, words, text,
    textHash: words > 50 ? createHash("md5").update(text.toLowerCase()).digest("hex") : null,
    data: d,
  };
}

async function renderPage(browser, url, ua) {
  const page = await browser.newPage({ userAgent: ua });
  try { await page.goto(url, { waitUntil: "networkidle", timeout: 45000 }); return await page.content(); }
  catch { return null; } finally { await page.close(); }
}

async function pool(n, items, fn, shouldStop) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length && !shouldStop()) { const k = i++; await fn(items[k], k); } }));
}

export async function runAudit(auditId, project, settings, onProgress = () => {}) {
  const ctl = { stop: false };
  running.set(auditId, ctl);
  const ua = settings.userAgent;
  const start = normalize(project.start_url);
  const origin = new URL(start).origin;
  const siteHost = hostKey(new URL(start).hostname);
  const inScope = (u) => { try { const h = hostKey(new URL(u).hostname); return h === siteHost || (settings.includeSubdomains && h.endsWith("." + siteHost)); } catch { return false; } };
  run("UPDATE audits SET status='running', started_at=datetime('now'), settings=? WHERE id=?", JSON.stringify(settings), auditId);

  let browser = null;
  try {
    const robotsRes = await fetchFollow(origin + "/robots.txt", ua);
    const robotsTxt = robotsRes.status === 200 ? robotsRes.body : "";
    const robots = robotsParser(origin + "/robots.txt", robotsTxt);
    const sitemap = await loadSitemaps(origin, robotsTxt, ua);
    const llms = await fetchOnce(origin + "/llms.txt", ua, "GET");
    if (settings.renderJs) { const { launchChromium } = await import("./browser.mjs"); browser = await launchChromium(); }

    const seen = new Map([[start, 0]]);
    const queue = [start];
    for (const u of sitemap.urls) if (u && inScope(u) && !seen.has(u)) { seen.set(u, null); queue.push(u); }
    const insPage = db.prepare(`INSERT OR REPLACE INTO pages (audit_id,url,final_url,status,depth,content_type,response_ms,bytes,title,description,h1,canonical,indexable,in_sitemap,outlinks,words,text_ratio,data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insLink = db.prepare("INSERT INTO links (audit_id,from_url,to_url,anchor,internal,nofollow,kind) VALUES (?,?,?,?,?,?,?)");
    const insText = db.prepare("INSERT OR REPLACE INTO page_text (audit_id, url, text) VALUES (?,?,?)"); // for link suggestions (I4)
    const hashes = new Map();
    const imgSet = new Set(); const extSet = new Set();
    let crawled = 0, started = 0; // started: reserves slots so parallel workers respect maxPages

    while (queue.length && !ctl.stop) {
      const batch = queue.splice(0, Math.max(settings.concurrency * 4, 20));
      await pool(settings.concurrency, batch, async (url) => {
        if (settings.maxPages && started >= settings.maxPages) return;
        started++;
        const depth = seen.get(url);
        const blocked = settings.respectRobots && robotsTxt && robots.isAllowed(url, "SEOAuditor") === false && robots.isAllowed(url, "*") === false;
        if (blocked) { insPage.run(auditId, url, url, 0, depth, "", 0, 0, "", "", "", null, 0, sitemap.urls.has(url) ? 1 : 0, 0, 0, 0, JSON.stringify({ blockedByRobots: true })); crawled++; return; }
        const r = await fetchFollow(url, ua);
        const final = r.finalUrl;
        let html = r.body;
        let jsWordsRaw = null;
        if (browser && r.status === 200 && /html/.test(r.type)) {
          const rawWords = parseHtml(html, final).words;
          const rendered = await renderPage(browser, final, ua);
          if (rendered) { jsWordsRaw = rawWords; html = rendered; }
        }
        const isHtml = /html/.test(r.type) && r.status === 200;
        const p = isHtml ? parseHtml(html, final) : { title: "", description: "", h1: "", canonical: null, links: [], imgs: [], words: 0, text: "", data: {} };
        const d = { ...p.data, redirect: r.redirect || undefined, error: r.error };
        const xr = r.headers.get("x-robots-tag") || "";
        if (/noindex/i.test(xr)) { d.noindex = true; d.noindexSource = "X-Robots-Tag"; } else if (d.noindex) d.noindexSource = "meta robots";
        if (jsWordsRaw !== null) { d.jsWordsRaw = jsWordsRaw; d.jsWordsRendered = p.words; }
        const indexable = r.status === 200 && isHtml && !d.noindex && (!p.canonical || p.canonical === final || p.canonical === url) ? 1 : 0;
        const bytes = Buffer.byteLength(r.body || "");
        const ratio = bytes ? +((Buffer.byteLength(p.text) / bytes) * 100).toFixed(1) : 0;
        let internalOut = 0, extLinks = 0, extNofollow = 0, nofollowInternal = 0;
        for (const l of p.links) {
          const internal = inScope(l.to);
          insLink.run(auditId, final, l.to, l.anchor, internal ? 1 : 0, l.nofollow ? 1 : 0, "a");
          if (internal) {
            internalOut++; if (l.nofollow) nofollowInternal++;
            if (!seen.has(l.to) && /^https?:/.test(l.to) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$/i.test(new URL(l.to).pathname)) {
              seen.set(l.to, (depth ?? 0) + 1); queue.push(l.to);
            } else if (seen.get(l.to) === null) seen.set(l.to, (depth ?? 0) + 1);
          } else { extLinks++; if (l.nofollow) extNofollow++; extSet.add(l.to); }
        }
        for (const im of p.imgs) { insLink.run(auditId, final, im, "", inScope(im) ? 1 : 0, 0, "img"); if (inScope(im)) imgSet.add(im); }
        Object.assign(d, { nofollowInternal, externalLinks: extLinks, externalNofollow: extNofollow });
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
    const checkStatus = async (set, limit) => {
      const out = new Map(); const list = [...set].filter((u) => !statusOf.has(u)).slice(0, limit);
      await pool(settings.concurrency, list, async (u) => {
        let r = await fetchOnce(u, ua, "HEAD", 15000);
        if (r.status === 0 || r.status === 405 || r.status >= 400) r = await fetchOnce(u, BROWSER_UA, "GET", 15000);
        if ([0, 401, 403, 429].includes(r.status)) r = { status: (await curlStatus(u)) || r.status };
        out.set(u, r.status);
      }, () => ctl.stop);
      return out;
    };
    const imgStatus = await checkStatus(imgSet, 20000);
    const extStatus = settings.checkExternalLinks ? await checkStatus(extSet, 5000) : new Map();
    const sOf = (u) => statusOf.get(u) ?? imgStatus.get(u) ?? extStatus.get(u);

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
      const r = await fetchOnce(p.final_url || p.url, ua, "GET");
      if (r.status === 200 && r.ms < p.response_ms) run("UPDATE pages SET response_ms=? WHERE audit_id=? AND url=?", r.ms, auditId, p.url);
    }
    const pages = all("SELECT * FROM pages WHERE audit_id=?", auditId).map((p) => ({ ...p, data: JSON.parse(p.data) }));
    const ctx = { siteIsHttps: start.startsWith("https://"), sitemapLoaded: sitemap.found };
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
    const lm = lastmodUniformity(sitemap.lastmods || []);
    db.exec("BEGIN");
    for (const p of pages) {
      for (const [id, det] of pageIssues(p, ctx)) raise(id, p.url, det);
      for (const [id, det] of aiPageIssues(p)) raise(id, p.url, det);
      if (p.data.dupOf && cluster(p.url) !== cluster(p.data.dupOf)) raise("dup_content", p.url, `same text as ${p.data.dupOf}`);
      if (p.status === 200 && p.indexable && p.inlinks === 1) raise("single_inlink", p.url);
      if (p.in_sitemap && p.inlinks === 0 && p.url !== start) raise("sitemap_orphan", p.url);
      if (p.in_sitemap && (p.status !== 200 || p.data.redirect)) raise("sitemap_bad_url", p.url, p.data.redirect ? "redirects" : `HTTP ${p.status}`);
      if (p.canonical && p.canonical !== p.url) { const s = sOf(p.canonical); if (s && s !== 200) raise("canonical_broken", p.url, `${p.canonical} → HTTP ${s}`); }
    }
    for (const l of db.prepare("SELECT DISTINCT from_url,to_url,internal,kind FROM links WHERE audit_id=?").iterate(auditId)) { // streamed: large sites have millions of links
      const s = sOf(l.to_url);
      if (!s || s < 400) continue;
      if (l.kind === "img" && l.internal) raise("broken_internal_image", l.from_url, `${l.to_url} → ${s}`);
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
    for (const x of near) { raise("near_duplicate", x.a, `${Math.round(x.score * 100)}% of 5-word phrases shared with ${x.b}`); raise("near_duplicate", x.b, `${Math.round(x.score * 100)}% shared with ${x.a}`); }
    if (lm && lm.share >= 0.6) raise("sitemap_lastmod_uniform", origin + "/sitemap.xml", `${lm.n} of ${lm.total} URLs have lastmod ${lm.date}`);
    for (const b of access?.blocked || []) raise("ai_bot_blocked_server", start, `${b.bot}: HTTP ${b.status || "no response"}, ${b.bytes} bytes (browser: HTTP ${access.base.status}, ${access.base.bytes} bytes)`);
    if (!robotsTxt) raise("no_robots_txt", origin + "/robots.txt");
    if (!sitemap.found) raise("no_sitemap", origin + "/sitemap.xml");
    else if (robotsTxt && !sitemap.declared) raise("sitemap_not_in_robots", origin + "/robots.txt");
    if (llms.status !== 200) raise("no_llms_txt", origin + "/llms.txt");
    for (const [id, det] of aiSiteIssues(robotsTxt, origin)) raise(id, origin + "/robots.txt", det);
    db.exec("COMMIT");

    // ---- totals and health ----
    const sev = all("SELECT severity, COUNT(*) n, COUNT(DISTINCT url) pages FROM issues WHERE audit_id=? AND check_id NOT LIKE 'ai_%' GROUP BY severity", auditId);
    const count = (s) => sev.find((x) => x.severity === s)?.n || 0;
    const errPages = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='error' AND check_id NOT LIKE 'ai_%'", auditId).n;
    const warnOnly = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='warning' AND check_id NOT LIKE 'ai_%' AND url NOT IN (SELECT url FROM issues WHERE audit_id=? AND severity='error')", auditId, auditId).n;
    const health = healthScore(pages.length, errPages, warnOnly);
    const aiRows = all("SELECT url, severity FROM issues WHERE audit_id=? AND check_id LIKE 'ai_%' AND check_id <> 'ai_bot_blocked'", auditId);
    const blocks = get("SELECT COUNT(*) n FROM issues WHERE audit_id=? AND check_id='ai_bot_blocked'", auditId).n;
    const aiScore = aiReadiness(aiRows, pages.filter((p) => p.indexable).length, blocks);
    const siteInfo = { robotsTxt: Boolean(robotsTxt), sitemapUrls: sitemap.urls.size, sitemapDeclared: sitemap.declared, llmsTxt: llms.status === 200,
      aiBots: aiBotAccess(robotsTxt, origin), crawlerAccess: access, renderJs: Boolean(settings.renderJs) };
    run("UPDATE audits SET ai_readiness=?, site_info=? WHERE id=?", aiScore, JSON.stringify(siteInfo), auditId);
    run("UPDATE audits SET status=?, finished_at=datetime('now'), pages_crawled=?, pages_queued=0, health=?, errors=?, warnings=?, notices=?, message=? WHERE id=?",
      ctl.stop ? "stopped" : "done", pages.length, health, count("error"), count("warning"), count("notice"), ctl.stop ? "Stopped by user" : null, auditId);
    return { pages: pages.length, health };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    run("UPDATE audits SET status='failed', finished_at=datetime('now'), message=? WHERE id=?", String(e.stack || e).slice(0, 500), auditId);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    running.delete(auditId);
  }
}
