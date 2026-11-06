// Off-page audit from Google Search Console's free Links report exports (owner reel 2026-11-06: "off-page audit:
// where backlinks come from, how relevant, how real, which anchor text, are they spam"). Search Console has no
// links API, so the owner exports CSV from Links → External links ("Top linking sites" or "Latest links") and this
// module reads it. Pure functions; the CLI command `offpage <csv> [--site host]` prints the summary.
// Google: most sites don't need to disavow; links are one of many signals; link spam is ignored or acted on
// (spam policies, "Link spam"). So the audit leads with how many real sites vouch for you, then flags spam patterns.

const SPAM_TLD = /\.(xyz|top|click|icu|buzz|monster|rest|cyou|cfd|sbs|bond|quest|lol|work|loan|men|gq|ml|cf|tk|ga)$/i;
const SPAM_HOST = /(seo|backlink|links?|bookmark|rank|webdir|submit|directory-?list|linkbuild|guestpost|article-?(dir|base)|pbn)/i;
const LISTING_HOST = /(yelp|yellowpages|whitepages|truelocal|hotfrog|brownbook|startlocal|localsearch|aussieweb|cylex|birdeye|provenexpert|productreview|foursquare|mapquest|womo|wordofmouth|oneflare|hipages|autoguru|showmelocal|cybo|wheree|calso|top4|bing|apple|facebook|instagram|linkedin|tiktok|youtube|pinterest)[.-]/i;
const SOCIAL = /(^|\.)(facebook|instagram|linkedin|tiktok|youtube|pinterest|x|twitter)\.com$/i;

/** Splits one CSV line (quotes, commas inside quotes). */
export function csvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const hostOf = (s) => { try { return new URL(/^https?:/i.test(s) ? s : "https://" + s).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** Reads a Search Console links export: "Top linking sites" (Site, Linking pages, Target pages) or "Latest links"
 *  (Linking page, Last crawled). Returns [{ site, linkingPages, pages: [urls] }], one row per linking site. */
export function parseGscLinks(text) {
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = csvLine(lines[0]).map((h) => h.toLowerCase());
  const iSite = head.findIndex((h) => h === "site" || h === "linking site" || h === "top linking sites");
  const iPage = head.findIndex((h) => h === "linking page" || h === "linking pages url" || h === "url");
  const iCount = head.findIndex((h) => h === "linking pages" || h === "incoming links");
  if (iSite < 0 && iPage < 0) throw new Error("not a Search Console links export (no Site or Linking page column)");
  const by = new Map();
  for (const l of lines.slice(1)) {
    const c = csvLine(l);
    const raw = iSite >= 0 ? c[iSite] : c[iPage];
    const site = hostOf(raw || "");
    if (!site) continue;
    const r = by.get(site) || { site, linkingPages: 0, pages: [] };
    if (iSite >= 0) r.linkingPages += Number(String(c[iCount] ?? "1").replace(/[^\d]/g, "")) || 1;
    else { r.linkingPages += 1; if (r.pages.length < 5) r.pages.push(raw); }
    by.set(site, r);
  }
  return [...by.values()].sort((a, b) => b.linkingPages - a.linkingPages);
}

/** Sorts one linking site: "listing" (business directory or social profile), "spam" (pattern of a link network),
 *  or "editorial" (anything else: articles, partners, associations, press). Reasons say why. */
export function classifySite(row) {
  const s = row.site, reasons = [];
  if (SPAM_TLD.test(s)) reasons.push("cheap TLD often used by link networks");
  if (SPAM_HOST.test(s.replace(/\.[a-z.]+$/, ""))) reasons.push("host name sells links or SEO");
  if (row.pages?.some((p) => /\/detail\/\d+\/?/i.test(p))) reasons.push('numbered "/detail/<id>/" directory network page');
  if (row.linkingPages >= 200) reasons.push(`${row.linkingPages} linking pages from one site (sitewide or generated)`);
  if (reasons.length) return { ...row, type: "spam", reasons };
  if (LISTING_HOST.test(s) || SOCIAL.test(s)) return { ...row, type: "listing", reasons: ["business listing or social profile"] };
  return { ...row, type: "editorial", reasons: [] };
}

/** The off-page summary: counts by type, flagged sites and a plain verdict. `competitors` = [{ name, sites }] optional. */
export function offpageAudit(rows, { site = "", competitors = [] } = {}) {
  const own = hostOf(site);
  const list = rows.filter((r) => r.site !== own && !(own && r.site.endsWith("." + own))).map(classifySite);
  const count = (t) => list.filter((r) => r.type === t).length;
  const total = list.length, spam = count("spam"), listing = count("listing"), editorial = count("editorial");
  let verdict;
  if (total < 10) verdict = `Only ${total} other site${total === 1 ? "" : "s"} link to you. The problem is too few links, not bad ones: earn listings on real directories, mentions from partners, associations and local press.`;
  else if (spam / total > 0.5) verdict = `${spam} of ${total} linking sites look like link networks. Google usually ignores such links; disavow only if you bought them or got a manual action.`;
  else if (editorial < 5) verdict = `${total} linking sites, but only ${editorial} are editorial. Listings help people find you; articles, partners and press help rankings more.`;
  else verdict = `${total} linking sites, ${editorial} editorial. Keep earning links from relevant sites.`;
  const gap = competitors.filter((c) => Number(c.sites) > total).map((c) => `${c.name}: ${c.sites} linking sites vs your ${total}`);
  return { total, editorial, listing, spam, verdict, gap, flagged: list.filter((r) => r.type === "spam"), sites: list };
}
