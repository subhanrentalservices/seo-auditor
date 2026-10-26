// Search Console findings for a project (REQ-044 build rows 25, 47 and 56), shown on the Search Console screen. Same
// shape as the audit checks (id: [severity, title, why, fix]) but raised per project from Search Console data, so they
// never change an audit's Site Health:
//   brand_not_top           searches for the business name don't put the site first, or lead to a deep page (row 25)
//   search_appearance_gap   5+ pages with markup for a rich result for 28+ days and no impressions for it (row 47)
//   search_appearance_drop  a rich result type's impressions fell 30%+ week on week (row 47)
//   target_keyword_gap / target_page_not_shown   owner-entered targets with no impressions (row 56, queries.mjs)
import { all, get, projectSettings } from "./db.mjs";
import { brandTest } from "./page2.mjs";
import { brandTerms } from "./trends.mjs";
import { urlKey, targetReport } from "./queries.mjs";

export const FINDINGS = {
  brand_not_top: ["warning", "Your site isn't the top result for its own name",
    "John Mueller (Google, \"SEO for small businesses\", 2025) suggests searching for your business name as a quick check: if your own pages show up, the technical basics are probably fine. In the last 28 days of Search Console data, searches for your name show your site below first place on average, or mostly lead to a page that isn't the home, about or contact page. The thresholds (20+ impressions, average position worse than 1.5) are this tool's heuristic.",
    "Search your name in Google. If another business or a directory is above you, make sure the home page is indexed (URL Inspection) and names the business clearly in its title, main heading and Organization or LocalBusiness markup, and that your Business Profile and social profiles link to it. If a deep page wins, check the home page isn't blocked, noindexed or canonicalised away."],
  search_appearance_gap: ["notice", "Rich result markup with no rich result impressions",
    "Search Console's Performance report shows traffic for each rich result type under Search appearance (Daniel Waisberg, \"Rich Results & Google Search Console\", 2020). Markup makes a page eligible; it doesn't guarantee a rich result. Here 5 or more pages have had markup for the feature for at least 28 days, and Search Console shows no impressions for it in 90 days. Rich result types Google has retired are not checked.",
    "Test one of the pages in the Rich Results Test and open the matching enhancement report in Search Console for errors and warnings. If the markup is valid, check the feature's guidelines (eligible page types, content policies, e.g. review stars a business adds about itself aren't shown) before changing more."],
  search_appearance_drop: ["notice", "Rich result impressions fell 30% or more in a week",
    "Daniel Waisberg (Google, 2020) recommends watching Search appearance traffic per rich result type: Search Console emails about new structured data issues, but not when an existing issue spreads to more pages. The 30% fall with 50+ impressions the week before is this tool's heuristic.",
    "Open the feature's enhancement report and the Search appearance filter in the Performance report; look for new errors, or pages that lost the markup (the audit's page changes list schema types removed). Check the Search trend card for a Google update or incident in the same week."],
  target_keyword_gap: ["notice", "Target keyword with no page and no impressions",
    "Google's Search Central videos on Google Trends (Google Search News, Nov 2024; Daniel Waisberg and Omri Wiseman, \"Google Trends for Marketing & Sales\", 2024) suggest checking real demand and publishing only where you can add value. This target from Settings had no impressions in the last 28 days and no crawled page has all its words in its title or main heading.",
    "If you genuinely offer this, extend or write one page that serves it well and names it in the title and H1. If you don't, remove it from the targets. Don't make near-identical pages for each wording or town (doorway pages)."],
  target_page_not_shown: ["notice", "Target keyword has a page but no impressions",
    "A crawled page names this target in its title or main heading, but Search Console shows no impressions for any search containing all its words in the last 28 days.",
    "Check the page is indexed (URL Inspection), linked from related pages in body text, and answers the search better than the pages that rank. Demand may also be very low: check the wording people actually use (Google Trends, Search Console queries)."],
};
const finding = (id, extra) => { const [severity, title, why, fix] = FINDINGS[id]; return { id, severity, title, why, fix, ...extra }; };

// ---- Row 25: brand not top ----
const HOME_LIKE = /\/(about|about-us|contact|contact-us|our-story|company)(\.[a-z]+)?$/i;
/** Home page, its index file, or an about/contact page. */
export function homeLike(url, home) {
  if (urlKey(url) === urlKey(home)) return true;
  let p = "/";
  try { p = new URL(url).pathname.replace(/\/$/, ""); } catch { /* not a URL */ }
  return /^\/?(index\.[a-z]+)?$/i.test(p) || HOME_LIKE.test(p);
}

/** Every brand name is one plain short word ("apple", "notion"): searches for it may mean the everyday word, so the
 *  finding is only information. A heuristic (no dictionary): one alphabetic word of 8 letters or fewer. */
export function ambiguousBrand(terms) {
  const toks = (t) => String(t).toLowerCase().replace(/\.(com|net|org|co|io|app|biz|info)(\.[a-z]{2})?$|\.[a-z]{2}$/, "").split(/[^a-z0-9]+/).filter(Boolean);
  return terms.length > 0 && terms.every((t) => { const w = toks(t); return w.length === 1 && /^[a-z]{2,8}$/.test(w[0]); });
}

/** Brand searches from query x page rows (28 days). Per search: the best position any of our pages had and the most
 *  impressions one page got (query-level figures; adding pages up would double-count). Null when the site is first for
 *  its name and the home/about/contact page takes most of those impressions, or with under 20 impressions. */
export function brandNotTop(rows, { isBrand, home, ambiguous = false, minImpressions = 20, maxPosition = 1.5 }) {
  const byQuery = new Map(), byPage = new Map();
  for (const r of rows) {
    if (!r.impressions || !isBrand(r.query)) continue;
    const q = byQuery.get(r.query) || { query: r.query, impressions: 0, clicks: 0, position: Infinity };
    q.impressions = Math.max(q.impressions, r.impressions); q.clicks += r.clicks || 0; q.position = Math.min(q.position, r.position);
    byQuery.set(r.query, q);
    byPage.set(r.page, (byPage.get(r.page) || 0) + r.impressions);
  }
  const qs = [...byQuery.values()], impressions = qs.reduce((n, q) => n + q.impressions, 0);
  if (impressions < minImpressions) return null;
  const position = qs.reduce((n, q) => n + q.position * q.impressions, 0) / impressions;
  const [topPage, topImpressions] = [...byPage].sort((a, b) => b[1] - a[1])[0];
  const pageOk = homeLike(topPage, home);
  if (position <= maxPosition && pageOk) return null;
  const why = [position > maxPosition ? `average position ${position.toFixed(1)} on ${impressions} brand impressions` : null,
    pageOk ? null : `most brand impressions (${topImpressions}) go to ${topPage}, not the home, about or contact page`].filter(Boolean).join("; ");
  return finding("brand_not_top", { severity: ambiguous ? "info" : "warning", impressions, position, topPage, pageOk,
    detail: why + (ambiguous ? ". Your brand looks like a single everyday word, so many of these searches may not be for you: information only." : ""),
    items: qs.sort((a, b) => b.impressions - a.impressions).slice(0, 5).map((q) => ({ query: q.query, impressions: q.impressions, position: q.position })) });
}

// ---- Row 47: search appearance ----
// Rich result features the crawl can see markup for, and the Search appearance values (by pattern; Search Console's
// codes are matched loosely) that show them. Retired features (src/retired-schema.json: FAQ, HowTo, ...) aren't here.
const REVIEW_ITEMS = new Set(["Product", "ProductGroup", "Recipe", "Book", "Course", "CreativeWorkSeason", "CreativeWorkSeries", "Episode", "Game",
  "VideoGame", "MediaObject", "Movie", "MusicPlaylist", "MusicRecording", "SoftwareApplication", "WebApplication", "MobileApplication"]);
const physicalEvent = (t) => t.some((x) => /Event$/.test(x)) && !(t.includes("VirtualLocation") && !t.some((x) => x === "Place" || x === "PostalAddress"));
export const APPEARANCE_FEATURES = [
  { feature: "Product snippets and merchant listings", like: "Product", match: /product|merchant|shopping/i, test: (t) => t.some((x) => /^(Product|ProductGroup|IndividualProduct|ProductModel)$/.test(x)) },
  // Self-serving reviews (a LocalBusiness or Organization rating itself) never show stars, so only eligible item types count.
  { feature: "Review snippets", like: "Rating", match: /review/i, test: (t) => (t.includes("AggregateRating") || t.includes("Review")) && (t.some((x) => REVIEW_ITEMS.has(x)) || physicalEvent(t)) },
  { feature: "Videos", like: "VideoObject", match: /video/i, test: (t) => t.includes("VideoObject") },
  { feature: "Recipes", like: "Recipe", match: /recipe/i, test: (t) => t.includes("Recipe") },
  { feature: "Events", like: "Event", match: /event/i, test: physicalEvent },
  { feature: "Job postings", like: "JobPosting", match: /job/i, test: (t) => t.includes("JobPosting") },
];
export const appearanceLabel = (a) => String(a || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** Per appearance: 90-day totals and the latest 7 days against the 7 before. daily: [{appearance, date, clicks,
 *  impressions, position}]; drop = 50+ impressions the week before and 30%+ fewer in the latest week (heuristic). */
export function appearanceTable(daily, endDate) {
  const last = endDate || daily.reduce((m, r) => (r.date > m ? r.date : m), "");
  const from = addDays(last, -6), prevFrom = addDays(last, -13), prevTo = addDays(last, -7);
  const by = new Map();
  for (const r of daily) {
    const a = by.get(r.appearance) || { appearance: r.appearance, label: appearanceLabel(r.appearance), clicks: 0, impressions: 0, pw: 0, lastWeek: 0, prevWeek: 0 };
    a.clicks += r.clicks || 0; a.impressions += r.impressions || 0; a.pw += (r.position || 0) * (r.impressions || 0);
    if (r.date >= from && r.date <= last) a.lastWeek += r.impressions || 0;
    else if (r.date >= prevFrom && r.date <= prevTo) a.prevWeek += r.impressions || 0;
    by.set(r.appearance, a);
  }
  return [...by.values()].map(({ pw, ...a }) => ({ ...a, position: a.impressions ? pw / a.impressions : null,
    change: a.prevWeek ? a.lastWeek / a.prevWeek - 1 : null, drop: a.prevWeek >= 50 && a.lastWeek <= 0.7 * a.prevWeek }))
    .sort((a, b) => b.impressions - a.impressions);
}

/** Features with markup on minPages+ pages for minDays+ (from the first audit that saw it to the end of the Search
 *  Console window) and no impressions for a matching appearance. pages: [{url, types}]; firstSeen(feature) → day|null. */
export function appearanceGaps({ pages, appearances, firstSeen, endDate, minPages = 5, minDays = 28 }) {
  const gaps = [];
  for (const f of APPEARANCE_FEATURES) {
    const on = pages.filter((p) => f.test(p.types || []));
    if (on.length < minPages || appearances.some((a) => f.match.test(a.appearance) && a.impressions > 0)) continue;
    const first = firstSeen(f);
    const age = first ? Math.round((Date.parse(endDate + "T00:00:00Z") - Date.parse(first + "T00:00:00Z")) / 864e5) : null;
    if (age === null || age < minDays) continue;
    gaps.push({ feature: f.feature, pages: on.length, examples: on.slice(0, 5).map((p) => p.url), firstSeen: first, ageDays: age });
  }
  return gaps;
}

/** The first finished audit with a page carrying the feature's markup (a cheap LIKE first, then the real test). */
function firstSeenIn(projectId, f) {
  for (const a of all("SELECT id, started_at FROM audits WHERE project_id=? AND status='done' ORDER BY id", projectId)) {
    const rows = all("SELECT json_extract(data,'$.schemaTypes') t FROM pages WHERE audit_id=? AND json_extract(data,'$.schemaTypes') LIKE ?", a.id, `%${f.like}%`);
    if (rows.some((r) => { try { return f.test(JSON.parse(r.t || "[]")); } catch { return false; } })) return String(a.started_at || "").slice(0, 10) || null;
  }
  return null;
}

/** Search appearance card data: per-appearance totals and weekly change, and the markup gaps. */
export function appearanceReport(projectId) {
  const m = get("SELECT value FROM meta WHERE key=?", `gsc-appearance:${projectId}`);
  const meta = m ? JSON.parse(m.value) : null;
  if (!meta || !get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='gsc_appearance'")) return { fetched: false, error: meta?.error || null, appearances: [], gaps: [] };
  const appearances = appearanceTable(all("SELECT appearance, date, clicks, impressions, position FROM gsc_appearance WHERE project_id=?", projectId), meta.endDate);
  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  const pages = audit ? all(`SELECT url, json_extract(data,'$.schemaTypes') t FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE '%html%'`, audit.id)
    .map((p) => { let types = []; try { types = JSON.parse(p.t || "[]"); } catch { /* old row */ } return { url: p.url, types }; }) : [];
  // Gaps only from a successful fetch: a failed one would make every feature look unshown.
  const gaps = meta.error ? [] : appearanceGaps({ pages, appearances, endDate: meta.endDate, firstSeen: (f) => firstSeenIn(projectId, f) });
  return { fetched: Boolean(meta.fetchedAt), error: meta.error || null, startDate: meta.startDate, endDate: meta.endDate, fetchedAt: meta.fetchedAt, auditId: audit?.id || null, appearances, gaps };
}

/** Everything the Search Console findings card lists, worst first. */
export function projectFindings(projectId, ap = appearanceReport(projectId)) {
  const p = get("SELECT * FROM projects WHERE id=?", projectId);
  if (!p) return [];
  const out = [];
  const rows = all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=?", projectId);
  const brand = brandNotTop(rows, { isBrand: brandTest(p.name, p.start_url), home: p.start_url, ambiguous: ambiguousBrand(brandTerms(p, projectSettings(p))) });
  if (brand) out.push(brand);
  for (const g of ap.gaps) out.push(finding("search_appearance_gap", { detail: `${g.feature}: markup on ${g.pages} pages since at least ${g.firstSeen} (${g.ageDays} days), no impressions in ${ap.startDate} → ${ap.endDate}`, items: g.examples.map((url) => ({ url })) }));
  for (const a of ap.appearances.filter((x) => x.drop)) out.push(finding("search_appearance_drop", { detail: `${a.label}: ${a.prevWeek} → ${a.lastWeek} impressions (${Math.round(a.change * 100)}%) in the latest week` }));
  const t = targetReport(projectId);
  for (const x of t.targets.filter((y) => y.status === "no-page")) out.push(finding("target_keyword_gap", { detail: `"${x.keyword}": no impressions and no page with all its words in the title or H1` }));
  for (const x of t.targets.filter((y) => y.status === "page-not-shown")) out.push(finding("target_page_not_shown", { detail: `"${x.keyword}": ${x.page} names it, no impressions`, url: x.page }));
  const rank = { error: 0, warning: 1, notice: 2, info: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
