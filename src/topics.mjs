// Topic coverage (REQ-021, 2026-10-25; from a "target the topic, not one big keyword" video, checked against Google's
// helpful-content guidance): a page ranks for many long-tail variations of its topic, including "zero volume" ones no
// keyword tool lists. Search Console already shows which variations Google tries a page for; this lists, per page,
// those the page's text never actually covers and the words they keep using. Fix by answering them on the page where
// it genuinely serves the reader; never by pasting keyword or suburb lists (keyword stuffing / doorway patterns).
import { all, get } from "./db.mjs";
import { brandTest, mention, words, stem } from "./page2.mjs";
import { isQuestion } from "./queries.mjs"; // used only inside functions, so the import cycle with queries.mjs is safe

// The search's own words, as typed, without stop words.
const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim().split(" ").filter((w) => w && words(w).length);
// "log book" and "logbook" are the same word to a reader and to Google: join a pair when the page uses it joined.
export function joinCompounds(toks, has) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (i + 1 < toks.length && has(stem(toks[i] + toks[i + 1]))) { out.push(toks[i] + toks[i + 1]); i++; } else out.push(toks[i]);
  }
  return out;
}

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function topicCoverage(auditId, { maxPosition = 50, minImpressions = 2, pages = 25 } = {}) {
  const a = get("SELECT id, project_id FROM audits WHERE id=?", Number(auditId)) || fail(404, "Audit not found");
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return { connected: false, pages: [] };
  const project = get("SELECT name, start_url FROM projects WHERE id=?", a.project_id);
  const isBrand = brandTest(project.name, project.start_url);
  const rows = all("SELECT query, page, impressions, clicks, position FROM gsc_queries WHERE project_id=? AND position <= ? AND impressions >= ?",
    a.project_id, maxPosition, minImpressions).filter((r) => !isBrand(r.query));
  const byPage = new Map();
  for (const r of rows) byPage.set(r.page, [...(byPage.get(r.page) || []), r]);
  const out = [];
  for (const [url, qs] of byPage) {
    const p = get("SELECT url, title FROM pages WHERE audit_id=? AND (url=? OR final_url=?) AND status=200 AND indexable=1", a.id, url, url);
    const text = p && get("SELECT text FROM page_text WHERE audit_id=? AND url=?", a.id, p.url)?.text;
    if (!text) continue;
    const doc = `${p.title || ""} ${text}`;
    const docWords = new Set(words(doc));
    const docToks = tokens(doc);
    for (let i = 0; i + 1 < docToks.length; i++) docWords.add(stem(docToks[i] + docToks[i + 1])); // page writes "log book", search "logbook"
    const uncovered = [];
    for (const q of qs) {
      const toks = joinCompounds(tokens(q.query), (w) => docWords.has(w));
      const core = [...new Set(toks.map(stem))];
      if (!core.length || mention(doc, q.query, core) || mention(doc, toks.join(" "), core)) continue;
      const missing = [...new Set(toks.filter((w) => !docWords.has(stem(w))))];
      if (!missing.length && toks.length < tokens(q.query).length) continue; // only differed by a split word
      uncovered.push({ query: q.query, impressions: q.impressions, position: q.position, missing });
    }
    // Words that recur across the uncovered variations: the parts of the topic the page doesn't talk about.
    const gap = new Map();
    for (const u of uncovered) for (const w of u.missing) gap.set(w, (gap.get(w) || 0) + u.impressions);
    out.push({ url: p.url, title: p.title, queries: qs.length, impressions: qs.reduce((n, q) => n + q.impressions, 0),
      covered: qs.length - uncovered.length, uncovered: uncovered.sort((x, y) => y.impressions - x.impressions).slice(0, 15),
      missingWords: [...gap].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([word, impressions]) => ({ word, impressions })) });
  }
  out.sort((x, y) => y.uncovered.reduce((n, u) => n + u.impressions, 0) - x.uncovered.reduce((n, u) => n + u.impressions, 0));
  return { connected: true, maxPosition, pages: out.slice(0, pages) };
}

// Near page 1 but never clicked (REQ-062, 2026-10-31; from a Search Console walkthrough: last 28 days, sort by
// impressions, 0 clicks at positions 5–20, open the ranking page, Ctrl+F the exact search, and if it isn't there add a
// section that answers it). Google already finds the page relevant; a heading and a direct answer in the searcher's own
// words can lift it onto the first screen. Status per search: "heading" (a heading already uses it: look at the title
// and snippet instead), "exact" (in the text but not a heading), "words" (all its words close together, different
// wording), "scattered" (every word is on the page, never together: e.g. the service in one place and the area in
// another) or "missing". Never paste search lists or place names the business doesn't genuinely serve.
const normText = (s) => ` ${String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim()} `;
export function searchStatus(query, { title = "", h1 = "", headings = [], text = "" } = {}) {
  const q = normText(query).trim();
  if (!q) return "missing";
  if ([h1, ...headings].some((h) => normText(h).includes(` ${q} `))) return "heading";
  const doc = `${title} ${text}`; // phrase and proximity checks: joining the H1 onto the text would fake closeness
  if (normText(doc).includes(` ${q} `)) return "exact";
  const core = [...new Set(tokens(query).map(stem))];
  if (!core.length) return "missing";
  if (mention(doc, query, core)) return "words";
  const docWords = new Set(words(`${doc} ${h1} ${headings.join(" ")}`));
  return core.every((w) => docWords.has(w)) ? "scattered" : "missing";
}

export function zeroClickGaps(auditId, { minPosition = 5, maxPosition = 20, minImpressions = 5, limit = 50 } = {}) {
  const a = get("SELECT id, project_id FROM audits WHERE id=?", Number(auditId)) || fail(404, "Audit not found");
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return { connected: false, rows: [] };
  const project = get("SELECT name, start_url FROM projects WHERE id=?", a.project_id);
  const isBrand = brandTest(project.name, project.start_url);
  const found = all("SELECT query, page, impressions, clicks, position FROM gsc_queries WHERE project_id=? AND clicks=0 AND position>=? AND position<=? AND impressions>=?",
    a.project_id, minPosition, maxPosition, minImpressions).filter((r) => !isBrand(r.query));
  const cache = new Map();
  const pageOf = (url) => {
    if (cache.has(url)) return cache.get(url);
    const p = get("SELECT url, title, h1, data FROM pages WHERE audit_id=? AND (url=? OR final_url=?) AND status=200", a.id, url, url);
    let data = {};
    try { data = JSON.parse(p?.data || "{}"); } catch { /* old row */ }
    const v = p ? { url: p.url, title: p.title || "", h1: p.h1 || "", headings: Array.isArray(data.h2s) ? data.h2s : [],
      text: get("SELECT text FROM page_text WHERE audit_id=? AND url=?", a.id, p.url)?.text || "" } : null;
    cache.set(url, v);
    return v;
  };
  let notCrawled = 0;
  const rows = [];
  for (const r of found) {
    const p = pageOf(r.page);
    if (!p) { notCrawled++; continue; }
    const status = searchStatus(r.query, p);
    const doc = normText(`${p.title} ${p.text}`);
    rows.push({ query: r.query, url: p.url, impressions: r.impressions, position: r.position, status, question: isQuestion(r.query),
      missing: status === "missing" ? [...new Set(tokens(r.query).filter((w) => !doc.includes(` ${w} `)))] : [] });
  }
  rows.sort((x, y) => y.impressions - x.impressions);
  const counts = { heading: 0, exact: 0, words: 0, scattered: 0, missing: 0 };
  for (const r of rows) counts[r.status]++;
  return { connected: true, minPosition, maxPosition, total: rows.length, notCrawled, counts, rows: rows.filter((r) => r.status !== "heading").slice(0, limit) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/topics$/, ([id]) => topicCoverage(Number(id))]);
  routes.push(["GET", /^\/api\/audits\/(\d+)\/zero-click$/, ([id], q) => zeroClickGaps(Number(id), { minPosition: Number(q.min) || 5, maxPosition: Number(q.max) || 20 })]);
}
