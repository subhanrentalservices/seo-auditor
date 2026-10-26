// Internal link graph (REQ-040 gaps #8 and #9, 2026-10-26). Works for any site type (local, SaaS, shop, content).
//  #8 Strongest pages → money pages: internal PageRank (port of backlinks/linkverify/sitegraph.py _pagerank: d = 0.85,
//     40 iterations, dangling pages' rank spread evenly, strongest page = 100), once over every followed internal <a>
//     link and once over links in page text only (menus, header, footer and breadcrumbs don't count). For each money
//     page (conversion.mjs roles: not an article, legal/utility page or the home page) and each page Search Console
//     shows at positions 5–20: does any of the 10 strongest text-PageRank pages link to it from its text, and which of
//     those strong pages already talk about its topic (its title/H1 words, page2.mjs matching) without that link.
//  #9 Hub and spoke: a hub is a page whose folder holds 2+ crawled pages (/guides/ → /guides/x) or a listing page
//     linking 6+ pages below it (data.childLinks). Per hub: children it links to (text or menu), children it doesn't,
//     and children with no link back to it (menus and breadcrumbs count for child → hub). The home page is never a
//     hub, so a flat site has no hubs and no findings.
import { all, get } from "./db.mjs";
import { pageRoles } from "./conversion.mjs";
import { words, stem } from "./page2.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim(); // as page2.mjs
/** One key per page: no #fragment, no trailing slash ("/guides/" and "/guides" are the same page). */
export const key = (u) => {
  try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "") + x.search; } catch { return String(u || "").replace(/#.*$/, "").replace(/\/$/, ""); }
};
const isHtml = (p) => p.status === 200 && /html/i.test(p.content_type || "");
const live = (p) => isHtml(p) && p.indexable && !p.data?.variantOf;

/** Internal PageRank. nodes: [key]; edges: [[from, to]] (duplicates and self-links ignored). Returns Map key → 0–100. */
export function pagerank(nodes, edges, { d = 0.85, iterations = 40 } = {}) {
  const n = nodes.length, scores = new Map();
  if (!n) return scores;
  const idx = new Map(nodes.map((k, i) => [k, i])), outSets = nodes.map(() => new Set());
  for (const [f, t] of edges) { const a = idx.get(f), b = idx.get(t); if (a !== undefined && b !== undefined && a !== b) outSets[a].add(b); }
  const out = outSets.map((s) => [...s]);
  let pr = new Float64Array(n).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    let sink = 0;
    for (let i = 0; i < n; i++) if (!out[i].length) sink += pr[i];
    const next = new Float64Array(n).fill((1 - d) / n + (d * sink) / n);
    for (let i = 0; i < n; i++) if (out[i].length) { const share = (d * pr[i]) / out[i].length; for (const t of out[i]) next[t] += share; }
    pr = next;
  }
  let top = 0; for (const v of pr) if (v > top) top = v;
  nodes.forEach((k, i) => scores.set(k, Math.round((1000 * pr[i]) / top) / 10));
  return scores;
}

/** Pages (rows with data parsed) and internal <a> links → graph of crawled HTML pages. Redirected URLs resolve to the
 *  page they land on; nofollow links pass nothing and are left out. */
export function buildGraph(pages, links) {
  const nodes = new Map(), alias = new Map();
  for (const p of pages) if (isHtml(p)) { const k = key(p.final_url || p.url); if (!nodes.has(k)) nodes.set(k, p); }
  for (const p of pages) { const k = key(p.final_url || p.url); if (nodes.has(k)) for (const u of [p.url, p.final_url]) if (u) alias.set(key(u), k); }
  const memo = new Map(); // URL parsing is the slow part on sites with 100k+ links
  const resolve = (u) => { if (!memo.has(u)) memo.set(u, alias.get(key(u)) || null); return memo.get(u); };
  const placed = links.some((l) => l.placement); // audits before placement existed: every link counts as a text link
  const edges = [];
  for (const l of links) {
    if (l.nofollow) continue;
    const from = resolve(l.from_url), to = resolve(l.to_url);
    if (from && to && from !== to) edges.push({ from, to, text: !placed || l.placement === "content" });
  }
  return { nodes, resolve, edges, oldAudit: links.length > 0 && !placed };
}

/** page2.mjs mention() on a text indexed once (a strong page is checked against every target): the exact phrase, or
 *  every core word within (core words + 6) words of the first. Returns {match, at} (at: offset in " " + norm(text)). */
export function indexText(text) {
  const padded = ` ${norm(text)} `, at = new Map();
  let i = 0;
  for (const m of padded.matchAll(/[a-z0-9&]+/g)) { const s = stem(m[0]); if (!at.has(s)) at.set(s, []); at.get(s).push([i++, m.index]); }
  return { padded, at };
}
export function findMention(ix, phrase, core) {
  const q = norm(phrase), e = q ? ix.padded.indexOf(` ${q} `) : -1;
  if (e >= 0) return { match: "exact", at: e };
  const need = [...new Set(core)], lists = need.map((w) => ix.at.get(w));
  if (!need.length || lists.some((l) => !l)) return null;
  const span = need.length + 6, starts = lists.flat().sort((x, y) => x[0] - y[0]);
  const within = (l, from) => { let lo = 0, hi = l.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid][0] < from) lo = mid + 1; else hi = mid; } return lo < l.length && l[lo][0] < from + span; };
  for (const [pos, off] of starts) if (lists.every((l) => within(l, pos))) return { match: "words", at: off };
  return null;
}

const segment = (s) => String(s || "").split(/\s[|–—-]\s/)[0].trim(); // "Smash Repairs | Acme" → "Smash Repairs"

/** #8. gsc: [{url, position, impressions}]; textOf(page) → its body text or null. */
export function strongPageLinks(graph, { pages, start, brand = "", gsc = [], textOf = () => null, top = 10, candidates = 5, minPos = 5, maxPos = 20 }) {
  const { nodes, edges } = graph;
  const keys = [...nodes.keys()];
  const prText = pagerank(keys, edges.filter((e) => e.text).map((e) => [e.from, e.to]));
  const prAll = pagerank(keys, edges.map((e) => [e.from, e.to]));
  const textIn = new Map(), bodyLink = new Set(), anyLink = new Set();
  for (const e of edges) {
    anyLink.add(e.from + "\u0000" + e.to);
    if (!e.text) continue;
    bodyLink.add(e.from + "\u0000" + e.to);
    if (!textIn.has(e.to)) textIn.set(e.to, new Set());
    textIn.get(e.to).add(e.from);
  }
  const role = pageRoles(pages, start), homeKey = key(start);
  const ranked = keys.filter((k) => live(nodes.get(k))).map((k) => {
    const p = nodes.get(k), u = p.final_url || p.url;
    return { key: k, url: u, title: p.title || "", pr: prText.get(k), prAll: prAll.get(k), textInlinks: textIn.get(k)?.size || 0,
      role: k === homeKey ? "home" : role(p.url) };
  }).sort((x, y) => y.pr - x.pr || y.prAll - x.prAll);
  // Legal and contact/about pages often link only to each other in their text, so rank pools there (a PageRank sink);
  // they are never sensible pages to add a topical link from, nor targets that need one. The home page links everywhere
  // already, so it is not a target either.
  const side = (r) => r.role === "utility" || /\/(contact|about)(-us)?([-_./]|$)/i.test(new URL(r.url).pathname);
  const strong = ranked.filter((r) => !side(r)).slice(0, top), byKey = new Map(ranked.map((r) => [r.key, r]));

  // Words in 40%+ of titles (town, brand) are everywhere, so they can't pick out a topic (as page2.mjs).
  const df = new Map(), usable = ranked.map((r) => nodes.get(r.key));
  for (const p of usable) for (const w of new Set(words(p.title))) df.set(w, (df.get(w) || 0) + 1);
  const skip = new Set([...words(brand), ...[...df].filter(([, n]) => usable.length >= 5 && n / usable.length >= 0.4).map(([w]) => w)]);

  const targets = new Map();
  for (const r of ranked) if (r.role === "money" && !side(r)) targets.set(r.key, { ...r, reasons: ["money"], gsc: null });
  for (const g of gsc) {
    if (!(g.position >= minPos && g.position <= maxPos)) continue;
    const k = graph.resolve(g.url), r = k && byKey.get(k); if (!r || r.role === "home" || side(r)) continue;
    if (!targets.has(k)) targets.set(k, { ...r, reasons: [], gsc: null });
    const t = targets.get(k);
    if (!t.gsc || g.impressions > t.gsc.impressions) t.gsc = { position: Math.round(g.position * 10) / 10, impressions: g.impressions || 0, clicks: g.clicks || 0 };
    if (!t.reasons.includes("gsc")) t.reasons.push("gsc");
  }

  const texts = new Map(); // the strong pages' text, read and indexed once
  const text = (k) => { if (!texts.has(k)) { const t = textOf(nodes.get(k)); texts.set(k, t ? indexText(t) : null); } return texts.get(k); };
  const out = [];
  for (const t of targets.values()) {
    const p = nodes.get(t.key);
    const linkedFromTop = strong.filter((s) => s.key !== t.key && bodyLink.has(s.key + "\u0000" + t.key)).map((s) => s.url);
    // Its topic: the first part of its title and of its H1, without site-wide and brand words. A long H1 ("what to
    // do after ...") is too specific to be "mentioned" anywhere, so topics over 5 core words are skipped.
    const topics = [];
    for (const s of [segment(p.title), segment(p.h1)]) {
      const core = [...new Set(words(s))].filter((w) => !skip.has(w));
      if (s && core.length && core.length <= 5 && !topics.some((x) => norm(x.phrase) === norm(s))) topics.push({ phrase: s, core });
    }
    const cands = [];
    for (const s of strong) {
      if (s.key === t.key || bodyLink.has(s.key + "\u0000" + t.key)) continue;
      const ix = text(s.key); if (!ix) continue;
      let m = null;
      for (const tp of topics) if ((m = findMention(ix, tp.phrase, tp.core))) break;
      if (!m) continue;
      cands.push({ from: s.url, pr: s.pr, match: m.match, linked: anyLink.has(s.key + "\u0000" + t.key) ? "menu" : null,
        context: "…" + ix.padded.slice(Math.max(0, m.at - 80), m.at + 100).trim() + "…" });
    }
    cands.sort((x, y) => (x.match === "exact" ? 0 : 1) - (y.match === "exact" ? 0 : 1) || y.pr - x.pr);
    out.push({ url: t.url, title: t.title, role: t.role, reasons: t.reasons, gsc: t.gsc, pr: t.pr, prAll: t.prAll, textInlinks: t.textInlinks,
      linkedFromTop, flagged: !linkedFromTop.length, topic: topics.map((x) => x.phrase), candidates: cands.slice(0, candidates) });
  }
  out.sort((x, y) => y.flagged - x.flagged || (y.gsc?.impressions || 0) - (x.gsc?.impressions || 0) || x.pr - y.pr);
  return { pages: ranked.map(({ key: _k, ...r }) => ({ ...r, side: side(r) })), strong: strong.map((s) => s.url), targets: out };
}

/** Path a hub's children sit under: "/guides/", "/guides", "/guides.html" and "/guides/index.html" → "/guides". */
const folderOf = (u) => { try { return new URL(u).pathname.replace(/\/index\.(html?|php|aspx?)$/i, "/").replace(/\.(html?|php|aspx?)$/i, "").replace(/\/+$/, ""); } catch { return ""; } };
const PAGED = /\/page\/\d+$/; // /blog/page/2: the hub's own listing, continued

/** #9. Returns [{hub, title, children, linked, notLinked, noLinkBack}] (lists of URLs). */
export function hubAndSpoke(graph, { start, minChildren = 2, minChildLinks = 6, maxList = 50 } = {}) {
  const { nodes, edges } = graph;
  const homeKey = key(start);
  const pages = [...nodes].filter(([k, p]) => k !== homeKey && live(p)).map(([k, p]) => ({ key: k, url: p.final_url || p.url, p, folder: folderOf(p.final_url || p.url) }));
  const byFolder = new Map();
  const hasQuery = (x) => x.key.includes("?");
  const sameFolder = new Map();
  for (const x of pages) { if (!sameFolder.has(x.folder)) sameFolder.set(x.folder, []); sameFolder.get(x.folder).push(x); }
  for (const x of pages) if (x.folder && (!byFolder.has(x.folder) || (hasQuery(byFolder.get(x.folder)) && !hasQuery(x)))) byFolder.set(x.folder, x);
  const links = new Set(edges.map((e) => e.from + "\u0000" + e.to));
  // Each page's parent: its nearest crawled ancestor folder below the home page.
  const kids = new Map();
  for (const x of pages) {
    const seg = x.folder.split("/");
    for (let i = seg.length - 1; i >= 2; i--) {
      const parent = byFolder.get(seg.slice(0, i).join("/"));
      if (parent && parent.key !== x.key) { if (!kids.has(parent.key)) kids.set(parent.key, []); kids.get(parent.key).push(x); break; }
    }
  }
  const out = [];
  for (const h of pages) {
    const all_ = kids.get(h.key) || [];
    if (byFolder.get(h.folder) !== h) continue; // /blog/?page=2 is the hub's listing continued, not a hub of its own
    const paged = [...all_.filter((c) => PAGED.test(c.folder) && c.folder.startsWith(h.folder + "/page/")),
      ...(sameFolder.get(h.folder) || []).filter((x) => x !== h)];
    const pagedSet = new Set(paged);
    let children = all_.filter((c) => !pagedSet.has(c));
    if (children.length < minChildren) {
      if ((h.p.data?.childLinks || 0) < minChildLinks) continue;
      // A listing page whose children aren't in its folder (/services → /services-brakes): the pages below its path it links to.
      const path = (() => { try { return new URL(h.url).pathname; } catch { return ""; } })();
      const extra = pages.filter((c) => c.key !== h.key && !children.includes(c) && links.has(h.key + "\u0000" + c.key) && new URL(c.url).pathname.startsWith(path));
      children = [...children, ...extra];
      if (!children.length) continue;
    }
    const from = [h.key, ...paged.map((x) => x.key)];
    const linked = [], notLinked = [], noLinkBack = [];
    for (const c of children) {
      (from.some((f) => links.has(f + "\u0000" + c.key)) ? linked : notLinked).push(c.url);
      if (!links.has(c.key + "\u0000" + h.key)) noLinkBack.push(c.url);
    }
    out.push({ hub: h.url, title: h.p.title || "", children: children.length, linkedCount: linked.length,
      notLinked: notLinked.slice(0, maxList), notLinkedCount: notLinked.length, noLinkBack: noLinkBack.slice(0, maxList), noLinkBackCount: noLinkBack.length });
  }
  return out.sort((x, y) => (y.notLinkedCount + y.noLinkBackCount) - (x.notLinkedCount + x.noLinkBackCount) || y.children - x.children);
}

/** Both checks on plain data (pages with data parsed, internal <a> links). */
export function analyse({ pages, links, start, brand = "", gsc = [], textOf = () => null }) {
  const graph = buildGraph(pages, links);
  const hubs = hubAndSpoke(graph, { start });
  return { oldAudit: graph.oldAudit, ...strongPageLinks(graph, { pages, start, brand, gsc, textOf }), hubs,
    clusterFindings: hubs.reduce((n, x) => n + x.notLinkedCount + x.noLinkBackCount, 0) };
}

export function linkGraph(auditId) {
  const a = get("SELECT id, project_id FROM audits WHERE id=?", Number(auditId)) || fail(404, "Audit not found");
  const project = get("SELECT name, start_url FROM projects WHERE id=?", a.project_id);
  const pages = all("SELECT url, final_url, status, indexable, content_type, title, h1, data FROM pages WHERE audit_id=?", a.id)
    .map((p) => ({ ...p, data: (() => { try { return JSON.parse(p.data || "{}"); } catch { return {}; } })() }));
  const links = all("SELECT from_url, to_url, nofollow, placement FROM links WHERE audit_id=? AND kind='a' AND internal=1", a.id);
  let gsc = [];
  try { gsc = all("SELECT url, clicks, impressions, position FROM gsc WHERE project_id=?", a.project_id); } catch { /* no Search Console data */ }
  const textOf = (p) => (get("SELECT text FROM page_text WHERE audit_id=? AND url=?", a.id, p.final_url || p.url)
    || (p.final_url && get("SELECT text FROM page_text WHERE audit_id=? AND url=?", a.id, p.url)))?.text || null;
  return { ...analyse({ pages, links, start: project.start_url, brand: project.name, gsc, textOf }), gscConnected: gsc.length > 0 };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/link-graph$/, ([id]) => linkGraph(Number(id))]);
}
