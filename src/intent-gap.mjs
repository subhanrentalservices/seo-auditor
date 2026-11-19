// Search intent gap (REQ-150, 2026-11-19; two owner reels: "Search Intent Gap Optimization" and "update old pages:
// check whether the intent changed, then link from pages Google already crawls"). From Search Console's query x page
// rows and the latest audit, per page:
//   1. hidden opportunities: searches with good impressions but a low click-through rate (the reel filtered
//      impressions > 5K and CTR < 2%; small sites need lower floors, so both are options),
//   2. where it stands: page 1 (low CTR), page 2 (an update can move it to page 1), page 3-4 or deeper (an update alone
//      rarely moves it that far; the reel: "from page 5 it won't come up before" the others),
//   3. which of those searches no H2/H3 on the page answers yet: the gaps to check against the top results,
//   4. pages to link from: pages Google already shows (impressions and clicks, so its crawler visits them often) that
//      share the topic and don't link to the page from their body text yet,
//   5. the order of work: search the query, study the top results (the AI Overview gap report reads them), add what
//      the page is missing, and only then refresh the title. A title tweak on its own rarely earns the click.
// Google: no tricks are needed, a page earns clicks by being the most helpful result for the search ("Creating
// helpful, reliable, people-first content"); titles should describe the page accurately ("Influencing title links").
import { all, get } from "./db.mjs";
import { brandTest, words } from "./page2.mjs";
import { urlKey, siteWideWords, answeredBy, intentOf } from "./queries.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Someone typing a web address ("youi.insurance", "acme.com.au") or a phone number ("1300 139 591") wants that site or
// line, not a page about it: no content change wins that click.
export const lookup = (q) => /[a-z0-9]\.[a-z]{2,}/i.test(q) || /^[\d\s()+-]{6,}$/.test(String(q).trim());
const UTILITY = /\/(privacy|terms|legal|cookie|contact|about|thank|thanks|login|account|cart|checkout|search|sitemap|404)([-_./]|$)/i;

export const STEPS = [
  "Search the main query on Google and read the top 3 results.",
  "List what they cover that this page doesn't, plus the questions people still ask (AI Overview gap report for this query).",
  "Add the missing information to this page so it answers the search better than before.",
  "Then refresh the title and description to match what the page now covers.",
];

/** Where a weighted position sits, and what an update can do from there. */
export function band(position) {
  if (position == null) return { band: "unknown", note: "" };
  if (position <= 10) return { band: "page 1", note: "Shown on page 1 but rarely clicked: fill the intent gap, then the title." };
  if (position <= 20) return { band: "page 2", note: "Stuck on page 2: updating the page to the current intent can move it to page 1." };
  if (position <= 40) return { band: "page 3-4", note: "An update alone rarely moves a page this far; add internal links and check that the page type matches the results." };
  return { band: "page 5+", note: "Too deep for an update alone: check the page matches what Google shows for the search before investing in it." };
}

/**
 * pages: [{ url, title, h1, h2s, queries: [{ query, impressions, clicks, position }] }] (brand searches already out)
 * shown: [{ url, title, h1, impressions, clicks, bodyLinksTo: Set<urlKey> }] pages Google shows, any page
 * Returns the pages with hidden opportunities, most impressions first.
 */
export function intentGaps(pages, shown, { minPageImpressions = 100, minQueryImpressions = 10, maxCtr = 0.02, maxPosition = 40, ignore = new Set(), sources = 5 } = {}) {
  const out = [];
  for (const p of pages) {
    const imp = p.queries.reduce((n, q) => n + q.impressions, 0), clicks = p.queries.reduce((n, q) => n + q.clicks, 0);
    if (imp < minPageImpressions) continue;
    const pos = p.queries.reduce((n, q) => n + (q.position || 0) * q.impressions, 0) / imp;
    const ctr = clicks / imp;
    if (ctr >= maxCtr || pos > maxPosition) continue;
    const hidden = p.queries.filter((q) => q.impressions >= minQueryImpressions && q.clicks / q.impressions < maxCtr && q.position <= maxPosition)
      .sort((x, y) => y.impressions - x.impressions);
    if (!hidden.length) continue;
    const main = hidden[0];
    const unanswered = Array.isArray(p.h2s) ? hidden.filter((q) => !answeredBy(q.query, p.h2s, ignore)).map((q) => q.query) : null;
    const core = words(main.query).filter((w) => !ignore.has(w));
    const key = urlKey(p.url);
    const from = shown.filter((s) => urlKey(s.url) !== key && !s.bodyLinksTo.has(key) && (s.impressions > 0 || s.clicks > 0)
      && core.some((w) => words(`${s.title || ""} ${s.h1 || ""}`).includes(w)))
      .sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions).slice(0, sources)
      .map((s) => ({ url: s.url, title: s.title || "", clicks: s.clicks, impressions: s.impressions }));
    out.push({ url: p.url, title: p.title || "", impressions: imp, clicks, ctr, position: pos, ...band(pos), mainQuery: main.query,
      hidden: hidden.slice(0, 10), unanswered, linkFrom: from, steps: STEPS, titleLast: true });
  }
  return out.sort((x, y) => y.impressions - x.impressions);
}

export function intentGapReport(projectId, opts = {}) {
  const project = get("SELECT id, name, start_url FROM projects WHERE id=?", Number(projectId)) || fail(404, "Project not found");
  const empty = { connected: false, range: null, auditId: null, pages: [] };
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return empty;
  const rows = all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=?", project.id);
  if (!rows.length) return empty;
  const range = get("SELECT start_date, end_date FROM gsc WHERE project_id=? LIMIT 1", project.id) || null;
  const isBrand = brandTest(project.name, project.start_url);
  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  const crawled = audit ? all("SELECT url, final_url, title, h1, status, indexable, data FROM pages WHERE audit_id=? AND content_type LIKE '%html%'", audit.id) : [];
  const byKey = new Map();
  for (const p of crawled) for (const u of [p.url, p.final_url]) if (u && (!byKey.has(urlKey(u)) || p.status === 200)) byKey.set(urlKey(u), p);
  const ignore = siteWideWords(crawled.filter((p) => p.status === 200 && p.indexable));
  const bodyLinks = new Map();
  if (audit) for (const l of all("SELECT from_url, to_url FROM links WHERE audit_id=? AND kind='a' AND internal=1 AND placement='content'", audit.id)) {
    const k = urlKey(l.from_url); if (!bodyLinks.has(k)) bodyLinks.set(k, new Set()); bodyLinks.get(k).add(urlKey(l.to_url));
  }
  const groups = new Map(), totals = new Map();
  for (const r of rows) {
    const c = byKey.get(urlKey(r.page)), k = c ? urlKey(c.final_url || c.url) : urlKey(r.page);
    const t = totals.get(k) || { impressions: 0, clicks: 0 }; t.impressions += r.impressions || 0; t.clicks += r.clicks || 0; totals.set(k, t);
    if (isBrand(r.query) || lookup(r.query)) continue;
    if (!groups.has(k)) groups.set(k, new Map());
    const g = groups.get(k), q = g.get(r.query) || { query: r.query, impressions: 0, clicks: 0, w: 0 };
    q.impressions += r.impressions || 0; q.clicks += r.clicks || 0; q.w += (r.position || 0) * (r.impressions || 0); g.set(r.query, q);
  }
  const data = (p) => { try { return JSON.parse(p.data || "{}"); } catch { return {}; } };
  const pages = [];
  for (const [k, g] of groups) {
    const p = byKey.get(k);
    if (!p || p.status !== 200 || UTILITY.test(new URL(p.final_url || p.url).pathname)) continue;
    pages.push({ url: p.final_url || p.url, title: p.title, h1: p.h1, h2s: data(p).h2s,
      queries: [...g.values()].map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.impressions ? q.w / q.impressions : null })) });
  }
  const shown = [...totals].map(([k, t]) => { const p = byKey.get(k); return p && p.status === 200 ? { url: p.final_url || p.url, title: p.title, h1: p.h1, ...t, bodyLinksTo: bodyLinks.get(k) || bodyLinks.get(urlKey(p.url)) || new Set() } : null; }).filter(Boolean);
  const res = intentGaps(pages, shown, { ...opts, ignore });
  for (const x of res) x.intent = intentOf(x.mainQuery, isBrand);
  return { connected: true, range, auditId: audit?.id || null, pages: res };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/intent-gap$/, ([id], q) => intentGapReport(Number(id), {
    minPageImpressions: Number(q.minPage) || 100, minQueryImpressions: Number(q.minQuery) || 10, maxCtr: Number(q.maxCtr) || 0.02 })]);
}
