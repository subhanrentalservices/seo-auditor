// Search clusters without paid data (REQ-055 group 6, item 2). Searches Google answers with the same pages belong to
// one topic (co-ranking, from Search Console's query x page rows), and so do searches made of the same words. Leader
// clustering, biggest search first: a search joins the cluster whose leader shares most of its ranking pages
// (Jaccard >= 0.5 over the pages that get 10%+ of each search's impressions), else most of its words (stemmed, Jaccard
// >= 0.6), else it leads a new cluster. A "hub" page such as the home page ranks for a large share of all searches, so
// sharing only hubs also needs a shared word. Per cluster: total impressions and clicks, the best page, and a gap
// when no page's title or H1 covers the main search, or when the best page is the home page (no dedicated page).
// Heuristic grouping, labelled as such; it tells you where a page or a section may be missing, not what to write.
import { all, get } from "./db.mjs";
import { brandTest, words } from "./page2.mjs";
import { titleGap, urlKey } from "./queries.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const LIMITS = { queries: 2000, pageShare: 0.1, pageJ: 0.5, wordJ: 0.6, hubShare: 0.3, clusters: 150 };

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

/** Groups items [{ key, pages: Set, words: Set, weight }] (sorted by weight, biggest first) into clusters
 *  [{ leader, members: [{ item, how }] }]; how = "leader" | "pages" | "words". hubs: pages too common to count alone.
 *  Shared by competitor-gap.mjs (titles: words only). */
export function leaderClusters(items, { pageJ = LIMITS.pageJ, wordJ = LIMITS.wordJ, hubs = new Set() } = {}) {
  const clusters = [];
  for (const it of [...items].sort((a, b) => (b.weight || 0) - (a.weight || 0))) {
    let best = null, bestScore = 0, bestHow = "";
    for (const c of clusters) {
      const L = c.leader;
      const pj = jaccard(it.pages, L.pages);
      if (pj >= pageJ) {
        const onlyHubs = [...it.pages].filter((p) => L.pages.has(p)).every((p) => hubs.has(p));
        const sharedWord = [...it.words].some((w) => L.words.has(w));
        if ((!onlyHubs || sharedWord) && pj + 1 > bestScore) { best = c; bestScore = pj + 1; bestHow = "pages"; continue; } // pages beat words
      }
      const wj = jaccard(it.words, L.words);
      if (wj >= wordJ && wj > bestScore) { best = c; bestScore = wj; bestHow = "words"; }
    }
    if (best) best.members.push({ item: it, how: bestHow });
    else clusters.push({ leader: it, members: [{ item: it, how: "leader" }] });
  }
  return clusters;
}

/** Clusters of the project's non-brand searches (28-day query x page rows) with the latest audit's pages. */
export function clusterReport(projectId, opts = {}) {
  const o = { ...LIMITS, ...opts };
  const project = get("SELECT * FROM projects WHERE id=?", Number(projectId)) || fail(404, "Project not found");
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return { connected: false, clusters: [] };
  const isBrand = brandTest(project.name, project.start_url);
  const byQuery = new Map();
  for (const r of all("SELECT query, page, clicks, impressions, position FROM gsc_queries WHERE project_id=?", project.id)) {
    if (isBrand(r.query)) continue;
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  }
  if (!byQuery.size) return { connected: true, queries: 0, clusters: [] };
  const items = [...byQuery].map(([query, rows]) => {
    const impressions = rows.reduce((n, r) => n + (r.impressions || 0), 0);
    const pages = new Set(rows.filter((r) => impressions && r.impressions / impressions >= o.pageShare).map((r) => urlKey(r.page)));
    return { key: query, rows, weight: impressions, impressions, clicks: rows.reduce((n, r) => n + (r.clicks || 0), 0), pages, words: new Set(words(query)) };
  }).sort((a, b) => b.weight - a.weight).slice(0, o.queries);
  const freq = new Map();
  for (const it of items) for (const p of it.pages) freq.set(p, (freq.get(p) || 0) + 1);
  const hubs = new Set(items.length >= 20 ? [...freq].filter(([, n]) => n / items.length > o.hubShare).map(([p]) => p) : []);

  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  const pages = a ? all("SELECT url, final_url, title, h1 FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE '%html%'", a.id) : [];
  const home = urlKey(project.start_url);
  const out = leaderClusters(items, { pageJ: o.pageJ, wordJ: o.wordJ, hubs }).map((c) => {
    const ms = c.members.map((m) => m.item);
    const perPage = new Map();
    for (const it of ms) for (const r of it.rows) {
      const k = urlKey(r.page), x = perPage.get(k) || { url: r.page, clicks: 0, impressions: 0 };
      x.clicks += r.clicks || 0; x.impressions += r.impressions || 0; perPage.set(k, x);
    }
    const best = [...perPage.values()].sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions)[0];
    const head = c.leader.key;
    const covering = pages.filter((p) => !titleGap(head, p.title, p.h1).length);
    const dedicated = covering.find((p) => urlKey(p.url) === urlKey(best.url)) || covering.find((p) => urlKey(p.url) !== home) || null;
    const bestIsHome = urlKey(best.url) === home;
    const gap = !pages.length ? null : !dedicated ? "no page's title or H1 covers the main search" : bestIsHome && urlKey(dedicated.url) === home ? "only the home page covers it" : null;
    const imp = ms.reduce((n, it) => n + it.impressions, 0);
    const posW = ms.reduce((n, it) => n + it.rows.reduce((m, r) => m + (r.position || 0) * (r.impressions || 0), 0), 0);
    return {
      head, size: ms.length, impressions: imp, clicks: ms.reduce((n, it) => n + it.clicks, 0), position: imp ? Math.round((posW / imp) * 10) / 10 : null,
      bestPage: best.url, bestIsHome, dedicatedPage: dedicated ? dedicated.url : null, gap,
      joined: { pages: c.members.filter((m) => m.how === "pages").length, words: c.members.filter((m) => m.how === "words").length },
      queries: c.members.slice(0, 25).map((m) => ({ query: m.item.key, impressions: m.item.impressions, clicks: m.item.clicks, how: m.how })),
    };
  }).sort((x, y) => y.impressions - x.impressions);
  return { connected: true, audited: Boolean(a), queries: items.length, hubs: [...hubs], total: out.length, multi: out.filter((c) => c.size > 1).length,
    gaps: out.filter((c) => c.gap).length, clusters: out.slice(0, o.clusters) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/clusters$/, ([id]) => clusterReport(Number(id))]);
}
