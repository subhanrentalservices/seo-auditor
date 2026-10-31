// Content inventory (REQ-055 group 6, item 4): every indexable HTML page of the latest audit with its words, last
// modified date (the page's own dateModified, else the sitemap's lastmod), Search Console clicks and impressions for
// the last 28 days against the 28 before and a weekly series, internal links in, and the decay verdict (decay.mjs).
// Each page gets one suggested action with its reason. Suggestions only, from rules (labelled as such); the owner decides.
//   refresh  - clicks decaying, or shown at positions 8-20, or last modified over 12 months ago while still shown
//   merge    - Google shows it and another page for largely the same searches, and the other page is the keeper
//              (queries.mjs overlapPairs): 301 into the keeper or make each page distinct
//   prune    - thin (< 300 words), no impressions in 90 days, <= 2 internal links in, first seen 90+ days ago and not a
//              utility page: improve it, merge it, noindex it or remove it (Google: thin pages with little value)
//   keep     - everything else
import { all, get } from "./db.mjs";
import { brandTest } from "./page2.mjs";
import { decayReport } from "./decay.mjs";
import { overlapPairs, urlKey } from "./queries.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const RULES = { thinWords: 300, staleMonths: 12, minPos: 8, maxPos: 20, pruneInlinks: 2, pruneAgeDays: 90, weeks: 12 };
// Pages meant to get no search traffic: never pruned for having none.
const UTILITY = /\/(privacy|terms|legal|cookie|contact|about|thank|thanks|login|logout|signin|signup|register|account|cart|checkout|basket|search|404|sitemap|unsubscribe)([-_./]|$)/i;
const has = (t) => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t));
const day = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const monthsSince = (d, today) => (Date.parse(today) - Date.parse(d)) / (30.44 * 864e5);

/** One page's action from its numbers (pure; exported for tests). p: { url, words, inlinks, lastModified, ageDays,
 *  clicks, impressions, position, impressions90, decay, mergeInto }. Returns { action, reason }. */
export function suggest(p, { today = new Date().toISOString().slice(0, 10), home = "", gsc = true } = {}) {
  const R = RULES;
  if (p.mergeInto) return { action: "merge", into: p.mergeInto.url, reason: `Google shows it and ${p.mergeInto.url} for largely the same searches (${p.mergeInto.shared} shared, e.g. “${p.mergeInto.query}”), and that page does better on them. 301 it into that page, or make each page answer a distinct search.` };
  if (p.decay && !p.decay.seasonal) return { action: "refresh", reason: `Clicks fell ${Math.round(p.decay.pct * 100)}% (${p.decay.cause}). ${p.decay.advice}` };
  if (p.position !== null && p.position >= R.minPos && p.position <= R.maxPos && p.impressions > 0) return { action: "refresh", reason: `Shown at position ${p.position} on average (${p.impressions} impressions in 28 days): close to page one. Answer the searches it's shown for better and link to it from strong pages.` };
  if (p.lastModified && monthsSince(p.lastModified, today) > R.staleMonths && p.impressions > 0) return { action: "refresh", reason: `Last modified ${p.lastModified} (over ${R.staleMonths} months) and still shown in Google: check its facts, dates and examples are current. Change the date only if the content really changed.` };
  const utility = UTILITY.test(new URL(p.url).pathname) || urlKey(p.url) === urlKey(home);
  if (gsc && !utility && (p.words ?? 0) < R.thinWords && !p.impressions90 && (p.inlinks ?? 0) <= R.pruneInlinks && p.ageDays !== null && p.ageDays >= R.pruneAgeDays)
    return { action: "prune", reason: `Thin (${p.words ?? 0} words), no impressions in 90 days, ${p.inlinks ?? 0} internal links in, first seen ${Math.round(p.ageDays)} days ago. Improve it, merge it into a related page, or noindex or remove it if it serves no reader.` };
  return { action: "keep", reason: p.decay?.seasonal ? "Lower than last month but level with last year: probably seasonal." : "Nothing in the rules flags it." };
}

/** The inventory of the latest audit. today: yyyy-mm-dd (tests). */
export function inventory(projectId, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const project = get("SELECT * FROM projects WHERE id=?", Number(projectId)) || fail(404, "Project not found");
  const a = get("SELECT id, started_at FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  if (!a) return { audited: false, pages: [] };
  const rows = all("SELECT url, title, words, inlinks, data FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE '%html%'", a.id);
  const lastmod = new Map(has("audit_lastmod") ? all("SELECT url, lastmod FROM audit_lastmod WHERE audit_id=?", a.id).map((r) => [urlKey(r.url), r.lastmod]) : []);
  const gscOn = has("gsc_page_daily");

  // Search Console per page: last 28 days vs the 28 before, 90-day impressions and a weekly series (gsc_page_daily),
  // else the 28-day totals (gsc) and the previous window (gsc_pages_past).
  const stats = new Map();
  const S = (k) => { if (!stats.has(k)) stats.set(k, { clicks: 0, impressions: 0, posW: 0, prevClicks: 0, prevImpressions: 0, impressions90: 0, weeks: new Array(RULES.weeks).fill(0) }); return stats.get(k); };
  let window = null;
  const last = gscOn ? get("SELECT MAX(date) d FROM gsc_page_daily WHERE project_id=?", project.id)?.d : null;
  if (last) {
    const from28 = day(last, -27), from56 = day(last, -55), from90 = day(last, -89), fromW = day(last, -(RULES.weeks * 7 - 1));
    window = { from: from28, to: last };
    for (const r of all("SELECT url, date, clicks, impressions, position FROM gsc_page_daily WHERE project_id=? AND date>=?", project.id, [from90, fromW].sort()[0])) {
      const s = S(urlKey(r.url));
      if (r.date >= from28) { s.clicks += r.clicks || 0; s.impressions += r.impressions || 0; s.posW += (r.position || 0) * (r.impressions || 0); }
      else if (r.date >= from56) { s.prevClicks += r.clicks || 0; s.prevImpressions += r.impressions || 0; }
      if (r.date >= from90) s.impressions90 += r.impressions || 0;
      if (r.date >= fromW) s.weeks[Math.floor((Date.parse(r.date) - Date.parse(fromW)) / (7 * 864e5))] += r.clicks || 0;
    }
  } else if (has("gsc")) {
    for (const r of all("SELECT url, clicks, impressions, position FROM gsc WHERE project_id=?", project.id)) Object.assign(S(urlKey(r.url)), { clicks: r.clicks || 0, impressions: r.impressions || 0, posW: (r.position || 0) * (r.impressions || 0), impressions90: r.impressions || 0, weeks: null });
    if (has("gsc_pages_past")) for (const r of all("SELECT url, clicks, impressions FROM gsc_pages_past WHERE project_id=? AND period='prev'", project.id)) {
      const s = S(urlKey(r.url)); s.prevClicks = r.clicks || 0; s.prevImpressions = r.impressions || 0; s.impressions90 += r.impressions || 0; if (!s.weeks?.some(Boolean)) s.weeks = null;
    }
  }
  const connected = stats.size > 0;
  const decay = new Map(connected && has("gsc_pages_past") ? decayReport(project.id).decaying.map((d) => [urlKey(d.url), { pct: (d.vsYear || d.vsPrev).pct, cause: d.cause, advice: d.advice, seasonal: d.seasonal }]) : []);

  // Merge candidates: page pairs sharing many non-brand searches (28-day query x page rows).
  const mergeInto = new Map();
  if (has("gsc_queries")) {
    const isBrand = brandTest(project.name, project.start_url);
    const byPage = new Map();
    for (const r of all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=?", project.id)) {
      if (isBrand(r.query)) continue;
      if (!byPage.has(r.page)) byPage.set(r.page, []);
      byPage.get(r.page).push(r);
    }
    const inl = new Map(rows.map((r) => [urlKey(r.url), r.inlinks]));
    for (const pr of overlapPairs([...byPage].map(([url, queries]) => ({ url, queries })), { inlinks: (u) => inl.get(urlKey(u)) }))
      if (!mergeInto.has(urlKey(pr.other.url))) mergeInto.set(urlKey(pr.other.url), { url: pr.keeper.url, shared: pr.shared, query: pr.queries[0] });
  }

  const pages = rows.map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { /* old row */ }
    const k = urlKey(r.url), s = stats.get(k);
    const first = get("SELECT MIN(a.started_at) t FROM pages x JOIN audits a ON a.id=x.audit_id WHERE a.project_id=? AND x.url=?", project.id, r.url)?.t;
    const seen = [first && first.slice(0, 10), d.datePublished].filter(Boolean).sort()[0] || null;
    const p = {
      url: r.url, title: r.title, words: r.words, inlinks: r.inlinks, lastModified: d.dateModified || lastmod.get(k) || null,
      lastModifiedFrom: d.dateModified ? "page" : lastmod.get(k) ? "sitemap" : null, firstSeen: seen, ageDays: seen ? (Date.parse(today) - Date.parse(seen)) / 864e5 : null,
      clicks: s?.clicks ?? 0, impressions: s?.impressions ?? 0, prevClicks: s?.prevClicks ?? 0, prevImpressions: s?.prevImpressions ?? 0,
      position: s?.impressions ? Math.round((s.posW / s.impressions) * 10) / 10 : null, impressions90: s?.impressions90 ?? 0, weekly: s?.weeks ?? null,
      decay: decay.get(k) || null, mergeInto: mergeInto.get(k) || null,
    };
    return { ...p, ...suggest(p, { today, home: project.start_url, gsc: connected }) };
  });
  const order = { merge: 0, refresh: 1, prune: 2, keep: 3 };
  pages.sort((x, y) => order[x.action] - order[y.action] || y.impressions - x.impressions || x.url.localeCompare(y.url));
  const counts = Object.fromEntries(Object.keys(order).map((k) => [k, pages.filter((p) => p.action === k).length]));
  return { audited: true, auditId: a.id, connected, window, rules: RULES, counts, pages };
}

const csvCell = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
export function inventoryCsv(projectId) {
  const r = inventory(projectId);
  const cols = ["url", "title", "action", "into", "reason", "words", "inlinks", "lastModified", "clicks", "prevClicks", "impressions", "prevImpressions", "position"];
  return [cols.join(","), ...r.pages.map((p) => cols.map((c) => csvCell(p[c])).join(","))].join("\r\n") + "\r\n";
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/inventory$/, ([id]) => inventory(Number(id))]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/inventory\.csv$/, ([id]) => ({ __raw: true, body: inventoryCsv(Number(id)), type: "text/csv; charset=utf-8",
    headers: { "Content-Disposition": `attachment; filename="content-inventory-${Number(id)}.csv"` } })]);
}
