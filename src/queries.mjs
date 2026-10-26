// Query-page alignment and merge candidates (REQ-040, 2026-10-26; gaps G5, G8, G10, G11 from the analysis of the Ahrefs
// and Brian Dean videos). From Search Console's query x page rows and the latest audit:
//   1. per page, its top non-brand search and the words of it that neither the title nor the H1 uses,
//   2. question searches (10+ impressions) that no H2/H3 on the ranking page asks or answers,
//   3. impressions and clicks per search intent (question, comparison, transactional, navigational, informational),
//   4. page pairs Google shows for largely the same searches: merge (301 into the keeper) or make each page distinct.
// The fix is always to answer the search on the page where it genuinely serves the reader; never to paste keyword
// lists into titles, headings or text (keyword stuffing).
import { all, get } from "./db.mjs";
import { brandTest, mention, words, stem } from "./page2.mjs";
import { joinCompounds } from "./topics.mjs";

const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();
// One key per page: www, trailing slash and index.html don't make a different page.
export const urlKey = (u) => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/index\.html?$/, "/").replace(/(.)\/$/, "$1")).toLowerCase(); } catch { return String(u); } };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const sum = (rs, k = "impressions") => rs.reduce((n, r) => n + (r[k] || 0), 0);
const wpos = (rs) => { const i = sum(rs); return i ? rs.reduce((n, r) => n + (r.position || 0) * r.impressions, 0) / i : null; };

// Intent from the search's own words (English modifiers; pass other rules for another language). Order matters: a
// brand search is navigational, "how much does X cost" is a question first.
export const INTENT_RULES = {
  question: /^(how|what|whats|why|when|where|who|whose|which|can|could|does|do|did|is|are|was|were|should|will|would)\b|\?\s*$/,
  comparison: /\b(vs|versus|best|reviews?|alternatives?|compare|comparison)\b/,
  transactional: /\b(prices?|pricing|costs?|buy|(?<!log )book|booking|quotes?|hire|near me|discounts?|coupons?|cheap)\b/, // "log book" is a noun
};
// A street address ("12 Example Street springfield"): often another business at that address, never a title to write.
const ADDRESS = /^\d+[a-z]?\s+(\S+\s+){0,4}(st|street|rd|road|hwy|highway|ave|avenue|dr|drive|blvd|boulevard|ln|lane|way|cres|crescent|pde|parade|pl|place|ct|court|tce|terrace)\b/;
// Pages meant to rank for nothing in particular; never merge candidates.
const UTILITY = /\/(privacy|terms|legal|cookie|contact|about|thank|thanks|login|account|cart|checkout|search|sitemap|404)([-_./]|$)/i;
export const INTENTS = ["question", "comparison", "transactional", "navigational", "informational"];
export const isQuestion = (q, rules = INTENT_RULES) => rules.question.test(String(q || "").toLowerCase().trim());
export function intentOf(q, isBrand = () => false, rules = INTENT_RULES) {
  const s = String(q || "").toLowerCase().trim();
  if (isBrand(s)) return "navigational";
  for (const k of ["question", "comparison", "transactional"]) if (rules[k].test(s)) return k;
  return "informational";
}

/** Words in 40%+ of the pages' titles/H1s (brand, town): they appear everywhere, so they can't be "missing". */
export function siteWideWords(pages, share = 0.4) {
  const df = new Map();
  for (const p of pages) for (const w of new Set(words(`${p.title || ""} ${p.h1 || ""}`))) df.set(w, (df.get(w) || 0) + 1);
  return new Set(pages.length >= 5 ? [...df].filter(([, n]) => n / pages.length >= share).map(([w]) => w) : []);
}

/** Words of the search (as typed, stop words out) that neither the title nor the H1 uses, stemmed on both sides. */
export function titleGap(query, title, h1, ignore = new Set()) {
  const doc = `${title || ""} ${h1 || ""}`, have = new Set(words(doc));
  const docToks = norm(doc).split(" ").filter(Boolean);
  for (let i = 0; i + 1 < docToks.length; i++) have.add(stem(docToks[i] + docToks[i + 1])); // title "log book", search "logbook"
  const toks = joinCompounds(norm(query).split(" ").filter((w) => w && words(w).length), (w) => have.has(w));
  return [...new Set(toks.filter((w) => !ignore.has(stem(w)) && !have.has(stem(w))))];
}

// Question words a heading doesn't need to repeat: "How long brake pads last" answers "how long do brake pads last".
const AUX = new Set("do does did can could should would will are is was were which whose whats".split(" ").map(stem));
/** The first H2/H3 that asks or answers the question (its words close together in one heading), else null. */
export function answeredBy(query, headings, ignore = new Set()) {
  const all_ = [...new Set(words(query).filter((w) => !AUX.has(w)))], core = all_.filter((w) => !ignore.has(w));
  const need = core.length ? core : all_;
  if (!need.length) return null;
  return (headings || []).find((hd) => mention(hd, query, need)) ?? null;
}

/** Page pairs whose non-brand query sets overlap: shared impressions (the smaller page's, on shared searches) over the
 *  smaller page's impressions >= minShare, with >= minShared shared searches. pages: [{url, queries:[{query,impressions,
 *  clicks,position}]}] with brand searches already removed. Keeper: more clicks on the shared searches, then better
 *  position on them, then more internal links. */
export function overlapPairs(pages, { minShare = 0.5, minShared = 3, minImpressions = 10, inlinks = () => 0 } = {}) {
  const list = pages.map((p) => ({ url: p.url, q: new Map(p.queries.map((r) => [r.query, r])), total: sum(p.queries) }));
  const byQuery = new Map();
  list.forEach((p, i) => { for (const k of p.q.keys()) { if (!byQuery.has(k)) byQuery.set(k, []); byQuery.get(k).push(i); } });
  const shared = new Map();
  for (const [k, idx] of byQuery) for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++) {
    const key = `${idx[x]},${idx[y]}`;
    if (!shared.has(key)) shared.set(key, []);
    shared.get(key).push(k);
  }
  const out = [];
  for (const [key, qs] of shared) {
    if (qs.length < minShared) continue;
    const [a, b] = key.split(",").map((i) => list[i]);
    const small = a.total <= b.total ? a : b;
    const sharedImpressions = qs.reduce((n, k) => n + small.q.get(k).impressions, 0);
    const share = small.total ? sharedImpressions / small.total : 0;
    if (share < minShare || sharedImpressions < minImpressions) continue;
    const side = (p) => { const rs = qs.map((k) => p.q.get(k)); return { url: p.url, clicks: sum(rs, "clicks"), impressions: sum(rs), position: wpos(rs), inlinks: inlinks(p.url) || 0 }; };
    const [sa, sb] = [side(a), side(b)];
    const r1 = (x) => (x === null ? Infinity : Math.round(x * 10) / 10);
    let reason = "clicks", d = sb.clicks - sa.clicks;
    if (!d) { reason = "position"; d = r1(sa.position) - r1(sb.position); }
    if (!d) { reason = "inlinks"; d = sb.inlinks - sa.inlinks; }
    if (!d) reason = "tie";
    const [keeper, other] = d > 0 ? [sb, sa] : [sa, sb];
    const top = qs.map((k) => ({ query: k, impressions: a.q.get(k).impressions + b.q.get(k).impressions })).sort((x, y) => y.impressions - x.impressions);
    out.push({ keeper, other, reason, share, shared: qs.length, sharedImpressions, queries: top.slice(0, 5).map((x) => x.query) });
  }
  return out.sort((x, y) => y.sharedImpressions - x.sharedImpressions);
}

export function queryAlignment(projectId, { minQuestionImpressions = 10, limit = 100 } = {}) {
  const project = get("SELECT id, name, start_url FROM projects WHERE id=?", Number(projectId)) || fail(404, "Project not found");
  const empty = { connected: false, range: null, auditId: null, pagesChecked: 0, titleGaps: [], questions: [], noHeadingData: 0, intents: [], pairs: [], minQuestionImpressions };
  // gsc_queries is created by gsc.mjs; without it Search Console was never connected on this install.
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return empty;
  const rows = all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=?", project.id);
  if (!rows.length) return empty;
  const range = get("SELECT start_date, end_date FROM gsc WHERE project_id=? LIMIT 1", project.id) || null;
  const isBrand = brandTest(project.name, project.start_url);

  // Search intent mix over every row (brand searches included, as navigational).
  const buckets = new Map(INTENTS.map((k) => [k, { intent: k, queries: new Map(), impressions: 0, clicks: 0 }]));
  for (const r of rows) {
    const b = buckets.get(intentOf(r.query, isBrand));
    b.impressions += r.impressions || 0; b.clicks += r.clicks || 0;
    b.queries.set(r.query, (b.queries.get(r.query) || 0) + (r.impressions || 0));
  }
  const intents = [...buckets.values()].map((b) => ({ intent: b.intent, queries: b.queries.size, impressions: b.impressions, clicks: b.clicks,
    examples: [...b.queries].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([q]) => q) }));

  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  const pages = audit ? all("SELECT url, final_url, title, h1, inlinks, status, indexable, data FROM pages WHERE audit_id=? AND content_type LIKE '%html%'", audit.id) : [];
  const byKey = new Map();
  for (const p of pages) for (const u of [p.url, p.final_url]) if (u && (!byKey.has(urlKey(u)) || p.status === 200)) byKey.set(urlKey(u), p);
  const siteWide = siteWideWords(pages.filter((p) => p.status === 200 && p.indexable));

  // Non-brand rows per page, one row per search (www/slash variants of a URL merged).
  const home = urlKey(project.start_url), nameWords = new Set(norm(project.name).split(" ").filter(Boolean));
  const groups = new Map();
  for (const r of rows) {
    if (isBrand(r.query)) continue;
    const crawled = byKey.get(urlKey(r.page)), k = crawled ? urlKey(crawled.final_url || crawled.url) : urlKey(r.page); // redirect -> its target
    // On the home page, a search with a word of the business name ("acmee widgets") is a misspelt brand search.
    if (k === home && norm(r.query).split(" ").some((w) => nameWords.has(w))) continue;
    if (!groups.has(k)) groups.set(k, { url: crawled ? crawled.final_url || crawled.url : r.page, q: new Map() });
    const g = groups.get(k), q = g.q.get(r.query) || { query: r.query, impressions: 0, clicks: 0, w: 0 };
    q.impressions += r.impressions || 0; q.clicks += r.clicks || 0; q.w += (r.position || 0) * (r.impressions || 0);
    g.q.set(r.query, q);
  }
  for (const g of groups.values()) g.queries = [...g.q.values()].map((q) => ({ query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.impressions ? q.w / q.impressions : null }));

  const titleGaps = [], questions = [];
  let pagesChecked = 0, noHeadingData = 0;
  for (const [k, g] of groups) {
    const p = byKey.get(k);
    if (!p || p.status !== 200 || !g.queries.length) continue;
    pagesChecked++;
    const url = p.final_url || p.url;
    const top = g.queries.filter((q) => !ADDRESS.test(norm(q.query))).sort((x, y) => y.impressions - x.impressions || y.clicks - x.clicks)[0];
    const missing = top ? titleGap(top.query, p.title, p.h1, siteWide) : [];
    if (missing.length) titleGaps.push({ url, title: p.title || "", h1: p.h1 || "", query: top.query, impressions: top.impressions, clicks: top.clicks,
      position: top.position, intent: intentOf(top.query, isBrand), missing, queries: g.queries.length });
    let data = {};
    try { data = JSON.parse(p.data || "{}"); } catch { /* old row */ }
    const qs = g.queries.filter((q) => q.impressions >= minQuestionImpressions && isQuestion(q.query));
    if (!Array.isArray(data.h2s)) { if (qs.length) noHeadingData++; continue; } // audited before headings were stored
    for (const q of qs) if (!answeredBy(q.query, data.h2s, siteWide)) questions.push({ url, query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.position, headings: data.h2s.length });
  }

  // Near-duplicate pairs from the same audit (detail names the other URL).
  const near = new Set();
  if (audit) for (const i of all("SELECT url, detail FROM issues WHERE audit_id=? AND check_id='near_duplicate'", audit.id)) {
    const other = String(i.detail || "").match(/https?:\/\/\S+/)?.[0];
    if (other) near.add([urlKey(i.url), urlKey(other)].sort().join(" "));
  }
  // Merge candidates: the home page ranks for a bit of everything and legal/contact pages aren't topic pages, so neither
  // is compared; and a search where a page sits below position 30 is Google trying it out, not real overlap.
  const pairs = overlapPairs([...groups.entries()].filter(([k, g]) => k !== home && !UTILITY.test(new URL(g.url).pathname))
    .map(([, g]) => ({ url: g.url, queries: g.queries.filter((q) => q.position !== null && q.position <= 30) })),
    { inlinks: (u) => byKey.get(urlKey(u))?.inlinks || 0 });
  for (const x of pairs) x.nearDuplicate = near.has([urlKey(x.keeper.url), urlKey(x.other.url)].sort().join(" "));

  return { connected: true, range, auditId: audit?.id || null, minQuestionImpressions, pagesChecked, noHeadingData,
    titleGaps: titleGaps.sort((x, y) => y.impressions - x.impressions).slice(0, limit),
    questions: questions.sort((x, y) => y.impressions - x.impressions).slice(0, limit), intents, pairs: pairs.slice(0, limit) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/query-alignment$/, ([id], q) => queryAlignment(Number(id), { minQuestionImpressions: Number(q.min) || 10 })]);
}
