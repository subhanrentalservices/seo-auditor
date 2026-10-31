// Competitor content gap (REQ-055 group 6, item 3): topics the saved competitors (up to 5, project setting
// competitorDomains) cover that this site doesn't. For each competitor: robots.txt and its XML sitemaps through the
// polite reader, up to 300 of its addresses (sections that are one template with a place, brand or insurer swapped in
// are set aside, as in competitor-pages.mjs: copying them is the doorway pattern), and the <title> and <h1> of up to
// 50 of those pages that robots.txt allows (never the body text). Addresses not read give their topic from the address.
// Topics are grouped across competitors (leaderClusters, stemmed words; the competitor's brand and words in 40%+ of its
// titles left out), and a topic counts as covered when one of our pages' title/H1, one of its H2/H3 sections or one of
// our Search Console searches contains its core words. Shows their titles as evidence only: write your own page, and
// only for things you genuinely offer.
import * as cheerio from "cheerio";
import { db, all, get, run, projectSettings } from "./db.mjs";
import { words } from "./page2.mjs";
import { siteWideWords } from "./queries.mjs";
import { loadSitemaps } from "./sitemaps.mjs";
import { topicOf, templatedSections } from "./competitor-pages.mjs";
import { leaderClusters } from "./clusters.mjs";
import { createPolite, startJob, jobStatus, pruneCache } from "./polite-fetch.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS comp_sites (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, origin TEXT NOT NULL,
  fetched_at TEXT, sitemap_urls INTEGER, kept INTEGER, templated TEXT, read INTEGER, blocked INTEGER, error TEXT, PRIMARY KEY (project_id, origin));
CREATE TABLE IF NOT EXISTS comp_pages (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, origin TEXT NOT NULL,
  url TEXT NOT NULL, title TEXT, h1 TEXT, status INTEGER, PRIMARY KEY (project_id, url));
`);

export const CAPS = { domains: 5, urls: 300, pages: 50 };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const bare = (h) => h.replace(/^www\./, "").toLowerCase();

/** The competitorDomains setting (newline / comma / space separated) as up to 5 https origins; invalid entries dropped. */
export function parseDomains(text, own = "") {
  const out = [];
  for (const d of String(text || "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) {
    let u; try { u = new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`); } catch { continue; }
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) || (own && bare(u.hostname) === bare(own))) continue;
    if (!out.some((o) => bare(new URL(o).hostname) === bare(u.hostname))) out.push(u.origin);
  }
  return out.slice(0, CAPS.domains);
}

/** Title and first H1 of an HTML page (text only, trimmed, 200 characters at most). */
export function titleAndH1(html) {
  const $ = cheerio.load(String(html || ""));
  const clean = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
  return { title: clean($("title").first().text()), h1: clean($("h1").first().text()) };
}

/** Up to n addresses spread across sections (round-robin), so one big folder doesn't take every read. */
export function spread(urls, n) {
  const by = new Map();
  for (const u of urls) { const s = topicOf(u).section || "/"; if (!by.has(s)) by.set(s, []); by.get(s).push(u); }
  const lists = [...by.values()], out = [];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  return out;
}

/** Reads one competitor politely and stores what was read. */
async function readSite(projectId, origin, polite, progress) {
  const robots = await polite.get(origin + "/robots.txt", { accept: "text/plain,*/*;q=0.5", ttlHours: 24 });
  const getSitemap = async (u) => {
    if (!(await polite.allowed(u))) return { status: 0, type: "", bytes: Buffer.alloc(0), error: "disallowed by robots.txt" };
    const r = await polite.get(u, { binary: true, accept: "application/xml,text/xml,*/*;q=0.5" });
    return { status: r.status, type: r.type, bytes: r.bytes || Buffer.alloc(0), error: r.error };
  };
  const sm = await loadSitemaps(origin, robots.status === 200 ? robots.body : "", polite.ua, { get: getSitemap }).catch((e) => ({ urls: new Set(), error: e.message }));
  const host = bare(new URL(origin).hostname);
  const all_ = [...(sm.urls || [])].filter((u) => { try { return bare(new URL(u).hostname) === host; } catch { return false; } });
  const templated = templatedSections(all_);
  const kept = spread(all_.filter((u) => !templated.has(topicOf(u).section)), CAPS.urls);
  run("DELETE FROM comp_pages WHERE project_id=? AND origin=?", projectId, origin);
  const ins = db.prepare("INSERT OR REPLACE INTO comp_pages (project_id, origin, url, title, h1, status) VALUES (?,?,?,?,?,?)");
  let read = 0, blocked = 0;
  for (const u of kept) {
    if (!(await polite.allowed(u))) { blocked++; continue; } // robots.txt says no: not read, not listed
    let t = { title: "", h1: "" }, status = null;
    if (read < CAPS.pages) {
      progress(`${host}: ${read + 1} of ${Math.min(CAPS.pages, kept.length)}`);
      const r = await polite.page(u, { maxBytes: 512 * 1024 }); // the title and H1 are near the top; keeps the cache small
      read++; status = r.status;
      if (r.status === 200 && /html/i.test(r.type || "text/html")) t = titleAndH1(r.body);
    }
    ins.run(projectId, origin, u, t.title, t.h1, status);
  }
  const error = !all_.length ? (sm.error || "No XML sitemap found (robots.txt Sitemap: lines or /sitemap.xml)") : null;
  run("INSERT OR REPLACE INTO comp_sites (project_id, origin, fetched_at, sitemap_urls, kept, templated, read, blocked, error) VALUES (?,?,?,?,?,?,?,?,?)",
    projectId, origin, new Date().toISOString(), all_.length, kept.length, JSON.stringify([...templated]), read, blocked, error);
}

/** Background job body: every saved competitor, one after another. opts: fetchFn/sleep/now for tests. */
export async function runGap(project, { progress = () => {}, ...pol } = {}) {
  const domains = parseDomains(projectSettings(project).competitorDomains, new URL(project.start_url).hostname);
  if (!domains.length) fail(400, "Add competitor websites first");
  const polite = createPolite(pol);
  for (const [i, origin] of domains.entries()) await readSite(project.id, origin, polite, (note) => progress(i, domains.length, note));
  progress(domains.length, domains.length, "done");
  pruneCache(30, (pol.now || Date.now)());
  return { domains: domains.length, ...polite.stats };
}

/** A title without its "| Brand" / "- Brand" suffix (the last part after a separator), when it has one. */
export const titleCore = (t) => String(t || "").replace(/\s+[|\-–—:·•]+\s+[^|\-–—:·•]+$/, "").trim();
// Words of a competitor page's topic: its H1 (else its title without the brand suffix, else its address), minus its
// brand and the words in most of its titles.
function topicWords(p, siteWide, brand) {
  const w = words(p.h1 || titleCore(p.title)).filter((x) => !siteWide.has(x) && !brand.has(x));
  return new Set(w.length ? w : topicOf(p.url).words.filter((x) => !brand.has(x)));
}

/** Topics the competitors cover that this site doesn't (computed from what was stored; no requests). */
export function gapReport(project) {
  const domains = parseDomains(projectSettings(project).competitorDomains, new URL(project.start_url).hostname);
  const sites = domains.map((o) => {
    const s = get("SELECT * FROM comp_sites WHERE project_id=? AND origin=?", project.id, o);
    return s ? { origin: o, fetchedAt: s.fetched_at, sitemapUrls: s.sitemap_urls, kept: s.kept, templated: JSON.parse(s.templated || "[]"), read: s.read, blocked: s.blocked, error: s.error } : { origin: o, fetchedAt: null };
  });
  const items = [];
  for (const o of domains) {
    const ps = all("SELECT url, title, h1 FROM comp_pages WHERE project_id=? AND origin=?", project.id, o);
    const siteWide = siteWideWords(ps.filter((p) => p.title || p.h1).map((p) => ({ title: p.h1 || titleCore(p.title) })));
    const brand = new Set(words(bare(new URL(o).hostname).split(".")[0].replace(/-/g, " ")));
    for (const p of ps) {
      const ws = topicWords(p, siteWide, brand);
      if (ws.size < 1 || (ws.size < 2 && !p.title)) continue;
      items.push({ key: p.url, origin: o, title: p.h1 || titleCore(p.title) || topicOf(p.url).label, fromAddress: !p.title && !p.h1, pages: new Set(), words: ws, weight: ws.size });
    }
  }
  // Our side: pages (title + H1, and each H2/H3 on its own) and Search Console searches.
  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  const ours = [];
  if (a) for (const p of all("SELECT url, title, h1, data FROM pages WHERE audit_id=? AND status=200 AND indexable=1", a.id)) {
    ours.push(new Set([...words(`${p.title || ""} ${p.h1 || ""}`), ...topicOf(p.url).words]));
    let d = {}; try { d = JSON.parse(p.data || "{}"); } catch { /* old row */ }
    for (const hd of Array.isArray(d.h2s) ? d.h2s : []) ours.push(new Set(words(hd)));
  }
  if (get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'"))
    for (const r of all("SELECT DISTINCT query FROM gsc_queries WHERE project_id=?", project.id)) ours.push(new Set(words(r.query)));

  const topics = leaderClusters(items, { wordJ: 0.5 }).map((c) => {
    const ms = c.members.map((m) => m.item);
    const freq = new Map();
    for (const it of ms) for (const w of it.words) freq.set(w, (freq.get(w) || 0) + 1);
    const core = [...freq].filter(([w, n]) => n >= Math.ceil(ms.length / 2) && c.leader.words.has(w)).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([w]) => w);
    const need = core.length ? core : [...c.leader.words].slice(0, 3);
    const coveredBy = ours.some((s) => need.every((w) => s.has(w)));
    return { core: need, coveredBy, competitors: [...new Set(ms.map((it) => it.origin))], pages: ms.length,
      examples: ms.slice(0, 3).map((it) => ({ url: it.key, title: it.title, fromAddress: it.fromAddress })) };
  });
  const gaps = topics.filter((t) => !t.coveredBy).sort((x, y) => y.competitors.length - x.competitors.length || y.pages - x.pages);
  return { domains, sites, audited: Boolean(a), job: jobStatus("compgap", project.id), caps: CAPS, topics: topics.length, covered: topics.length - gaps.length, gaps: gaps.slice(0, 200), gapCount: gaps.length };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/competitor-gap$/, ([id]) => gapReport(project(id))]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/competitor-gap$/, ([id]) => {
    const p = project(id);
    if (!parseDomains(projectSettings(p).competitorDomains, new URL(p.start_url).hostname).length) fail(400, "Add competitor websites first");
    startJob("compgap", p.id, (progress) => runGap(p, { progress }));
    return { started: true, job: jobStatus("compgap", p.id) };
  }]);
}
