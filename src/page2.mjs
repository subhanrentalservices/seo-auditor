// Page 2 → page 1 (owner request 2026-10-23; method from a "jump from Google's 2nd page" video, checked against Google's
// documentation). For each page Search Console shows at positions 8–20 for a non-brand query:
//   1. the site's own pages that talk about that query (what "site:example.com query" would list), from the crawl,
//   2. whether each already links to it from its body text (menu/footer links don't count: placement="nav"),
//   3. the words used in body links to it (Google's link best practices: descriptive anchor text helps Google
//      understand the target; avoid keyword stuffing),
//   4. query words missing from its title,
//   5. what to recrawl afterwards. Paid "indexers" are not suggested: Google's Indexing API is only for JobPosting and
//      BroadcastEvent pages and abuse can revoke access; Search Console "Request indexing", an honest sitemap lastmod
//      and IndexNow (Bing) are the legitimate ways.
import { all, get } from "./db.mjs";

const STOP = new Set(("a an and are as at be by for from how i in is it its me my near of on or our the to us we what when where who " +
  "why will with you your vs best top cheap").split(" "));
const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim();
// Light stemmer, applied to both sides: service/services/servicing → "servic", repairs → "repair", cars → "car".
const stem = (w) => (w.length > 4 ? w.replace(/(ings|ing|es|e|s)$/, "") : w.length === 4 ? w.replace(/([^s])s$/, "$1") : w);
const words = (s) => norm(s).split(" ").filter((w) => w && !STOP.has(w)).map(stem);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** Brand queries ("acme", "acme plumbing", "acme plumbers") say nothing about a topic page; skip them. */
export function brandTest(name, startUrl) {
  const compact = (s) => norm(s).replace(/[^a-z0-9]/g, "");
  const label = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, "").split(".")[0]; } catch { return ""; } })();
  const nameWords = norm(name).split(" ").filter(Boolean), first = nameWords[0] || "";
  return (q) => {
    const c = compact(q), t = norm(q).split(" ");
    return (label.length > 3 && c.includes(label)) || (compact(name).length > 3 && c.includes(compact(name)))
      || (first.length <= 3 && first && t[0] === first) || (t.length && t.every((w) => nameWords.includes(w)));
  };
}

/** Where a page's text talks about the query: "exact" phrase, "words" (every core word, any order, within a few words
 *  of each other: scattered words across a long page are not a mention) or null. */
export function mention(text, query, core, phrases = []) {
  const t = ` ${norm(text)} `;
  for (const q of [norm(query), ...phrases.map(norm)]) if (q && t.includes(` ${q} `)) return { match: "exact", at: t.indexOf(` ${q} `) };
  if (!core.length) return null;
  const toks = [...t.matchAll(/[a-z0-9&]+/g)].map((m) => [stem(m[0]), m.index]);
  const need = new Set(core), span = need.size + 6;
  for (let i = 0; i < toks.length; i++) {
    if (!need.has(toks[i][0])) continue;
    const seen = new Set();
    for (let j = i; j < toks.length && j < i + span; j++) {
      if (need.has(toks[j][0])) seen.add(toks[j][0]);
      if (seen.size === need.size) return { match: "words", at: toks[i][1] };
    }
  }
  return null;
}

export function page2Opportunities(auditId, { min = 8, max = 20, minImpressions = 5, targets = 20, sources = 8 } = {}) {
  const a = get("SELECT id, project_id FROM audits WHERE id=?", Number(auditId)) || fail(404, "Audit not found");
  const project = get("SELECT name, start_url FROM projects WHERE id=?", a.project_id);
  // gsc_queries is created by gsc.mjs; without it Search Console was never connected on this install.
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return { range: null, targets: [], connected: false };
  const range = get("SELECT start_date, end_date FROM gsc WHERE project_id=? LIMIT 1", a.project_id);
  const rows = all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=? AND position BETWEEN ? AND ? AND impressions>=? ORDER BY impressions DESC",
    a.project_id, min, max, minImpressions);
  if (!rows.length) return { range, targets: [], connected: !!range };
  const isBrand = brandTest(project.name, project.start_url);
  const pages = all("SELECT url, final_url, title, inlinks, indexable, status, data FROM pages WHERE audit_id=? AND content_type LIKE '%html%'", a.id);
  const byUrl = new Map();
  for (const p of pages) for (const u of [p.url, p.final_url]) if (u) byUrl.set(u.replace(/\/$/, ""), p);
  const usable = pages.filter((p) => p.status === 200 && p.indexable && (JSON.parse(p.data || "{}").formShare || 0) < 0.4);
  // Words in 40%+ of titles (town, brand) are everywhere, so they can't pick out a topic page.
  const df = new Map();
  for (const p of usable) for (const w of new Set(words(p.title))) df.set(w, (df.get(w) || 0) + 1);
  const siteWide = new Set([...df].filter(([, n]) => usable.length >= 5 && n / usable.length >= 0.4).map(([w]) => w));
  const texts = new Map(all("SELECT url, text FROM page_text WHERE audit_id=?", a.id).map((r) => [r.url, r.text]));
  const links = all("SELECT from_url, to_url, anchor, placement FROM links WHERE audit_id=? AND kind='a' AND internal=1", a.id);

  const home = project.start_url.replace(/\/$/, ""), nameWords = new Set(norm(project.name).split(" "));
  const groups = new Map();
  for (const r of rows) {
    if (isBrand(r.query)) continue;
    // On the home page, a query with a word of the business name ("acmee plumbing") is a misspelt brand search.
    if (r.page.replace(/\/$/, "") === home && norm(r.query).split(" ").some((w) => nameWords.has(w))) continue;
    const p = byUrl.get(r.page.replace(/\/$/, "")); if (!p || p.status !== 200) continue;
    const key = p.final_url || p.url;
    if (!groups.has(key)) groups.set(key, { page: p, queries: [] });
    groups.get(key).queries.push({ query: r.query, impressions: r.impressions, clicks: r.clicks, position: Math.round(r.position * 10) / 10 });
  }
  const out = [];
  for (const [target, g] of [...groups].sort((x, y) => sum(y[1].queries) - sum(x[1].queries)).slice(0, targets)) {
    // The page's own keyword: the query whose words its title already has most of (ties: most impressions). A suburb
    // query on a make page ("vw service riverside") is listed but not the one to build links for.
    const titleWords = new Set(words(g.page.title));
    const missing = (query) => words(query).filter((w) => !titleWords.has(w)).length;
    const q = g.queries.slice().sort((x, y) => missing(x.query) - missing(y.query) || y.impressions - x.impressions)[0].query;
    const all_ = words(q), core = all_.filter((w) => !siteWide.has(w));
    const coreWords = core.length ? core : all_;
    // "car accident repairs" counts as the exact search "car accident repairs springfield" when the town is site-wide.
    const shortPhrase = norm(q).split(" ").filter((w) => !siteWide.has(stem(w))).join(" ");
    const phrases = shortPhrase.split(" ").length >= 2 && norm(q).includes(shortPhrase) ? [shortPhrase] : [];
    const ids = new Set([target, g.page.url].map((u) => u.replace(/\/$/, "")));
    const toTarget = links.filter((l) => ids.has(l.to_url.replace(/\/$/, "")));
    const found = [];
    for (const s of usable) {
      const src = s.final_url || s.url;
      if (ids.has(src.replace(/\/$/, ""))) continue;
      const text = texts.get(src) || texts.get(s.url); if (!text) continue;
      const m = mention(text, q, coreWords, phrases); if (!m) continue;
      const own = toTarget.filter((l) => l.from_url === src || l.from_url === s.url);
      const linked = own.some((l) => l.placement === "content") ? "body" : own.some((l) => l.placement === null) ? "yes" : own.length ? "menu" : null;
      const flat = norm(text);
      found.push({ from: src, match: m.match, linked, inlinks: s.inlinks, context: "…" + flat.slice(Math.max(0, m.at - 80), m.at + 100).trim() + "…" });
    }
    found.sort((x, y) => (x.linked === "body") - (y.linked === "body") || (x.match === "exact" ? 0 : 1) - (y.match === "exact" ? 0 : 1) || y.inlinks - x.inlinks);
    const anchors = new Map();
    for (const l of toTarget) if (l.placement !== "nav" && l.anchor) anchors.set(l.anchor.toLowerCase(), (anchors.get(l.anchor.toLowerCase()) || 0) + 1);
    const anchorList = [...anchors].sort((x, y) => y[1] - x[1]).map(([text, n]) => ({ text, n }));
    out.push({
      target, title: g.page.title || "", inlinks: g.page.inlinks, queries: g.queries.slice(0, 5), query: q,
      titleMissing: [...new Set(norm(q).split(" ").filter((w) => w && !STOP.has(w) && !titleWords.has(stem(w))))],
      anchors: anchorList.slice(0, 8), keyWords: norm(q).split(" ").filter((w) => w && !STOP.has(w) && coreWords.includes(stem(w))),
      anchorGap: !anchorList.some((x) => coreWords.every((w) => words(x.text).includes(w))),
      sources: found.slice(0, sources), toLink: found.filter((f) => f.linked !== "body").length, oldAudit: links.length > 0 && links.every((l) => l.placement === null),
    });
  }
  return { range, targets: out, connected: true };
}
const sum = (qs) => qs.reduce((n, x) => n + x.impressions, 0);

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/page2$/, ([id], q) => page2Opportunities(Number(id), { min: Number(q.min) || 8, max: Number(q.max) || 20 })]);
}
