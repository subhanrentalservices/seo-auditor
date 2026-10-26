// Lost-URL reclamation: pages that are gone now (404/410) or redirect from a deep path straight to the home page,
// but had value before: they returned 200 in an earlier audit, Search Console showed them, the sitemap listed them,
// other pages of the site still link to them, or stored backlink data points at them. For each one the closest live
// page (slug + title words) is suggested as the 301 target, with a ready Apache line. Status 0 (not loaded), 429 and
// 5xx answers, and earlier pages the latest crawl never reached, are "could not be checked", never "lost".
import { all, get } from "./db.mjs";
import { words } from "./page2.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hasTable = (name) => Boolean(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name));
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const url = (u) => { try { return new URL(u); } catch { return null; } };

/** One key for the same page however it was written: no www, no index file, no trailing slash, lower case. */
export function key(u) {
  const x = url(u); if (!x) return String(u || "").toLowerCase();
  return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/(.)\/$/, "$1") + x.search).toLowerCase();
}
/** True for the site root (with or without an index file). */
export const isHome = (u) => { const x = url(u); return Boolean(x) && /^\/(index\.(html?|php))?$/i.test(x.pathname) && !x.search; };

/** Words of a URL path: [all words, words of the last segment]. File extensions are not words. */
export function slugWords(u) {
  const x = url(u); if (!x) return [[], []];
  let p; try { p = decodeURIComponent(x.pathname); } catch { p = x.pathname; }
  const segs = p.replace(/\.(html?|php|aspx?|jsp|cfm)$/i, "").split("/").filter(Boolean);
  return [words(segs.join(" ")), words(segs.at(-1) || "")];
}

/** Weighted words of a lost URL: a word of its last path segment counts 2 (it names the page), of a folder 1 (it names
 *  the section), plus 1 when its last known title has it too. /services/brakes.html "Brake services": brake 3, service 2. */
export function lostWords(u, title) {
  const [all_, last] = slugWords(u), lastSet = new Set(last), t = new Set(words(title)), w = new Map();
  for (const x of new Set([...all_, ...t])) w.set(x, (lastSet.has(x) ? 2 : all_.includes(x) ? 1 : 0) + (t.has(x) ? 1 : 0));
  return w;
}

/** Best live page for a lost URL: most shared stemmed words (weighted), ties to more inlinks; null without overlap.
 *  candidates: [{ url, title, inlinks }]; ignore: words that can't pick out a topic (brand, town, site-wide words). */
export function suggestTarget(lostUrl, lastTitle, candidates, ignore = new Set()) {
  const want = lostWords(lostUrl, lastTitle);
  for (const w of ignore) want.delete(w);
  let best = null;
  for (const c of candidates) {
    const have = new Set([...slugWords(c.url)[0], ...words(c.title)]);
    const shared = [...want.keys()].filter((w) => have.has(w));
    const score = shared.reduce((n, w) => n + want.get(w), 0);
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && (c.inlinks || 0) > (best.inlinks || 0))
      || (score === best.score && (c.inlinks || 0) === (best.inlinks || 0) && c.url.length < best.url.length))
      best = { url: c.url, title: c.title, inlinks: c.inlinks || 0, score, words: shared };
  }
  return best;
}

/** Apache (mod_alias) line, or null when the old URL has a query string (Redirect can't match one). */
export function apacheLine(oldUrl, targetUrl) {
  const x = url(oldUrl); if (!x || x.search || !targetUrl) return null;
  return `Redirect 301 ${x.pathname} ${targetUrl}`;
}

/** Search Console clicks and impressions per page key, summed over every stored window (they don't overlap). */
function gscTotals(projectId) {
  const m = new Map();
  const add = (r) => { const k = key(r.url), t = m.get(k) || { clicks: 0, impressions: 0 }; t.clicks += r.clicks || 0; t.impressions += r.impressions || 0; m.set(k, t); };
  for (const r of all("SELECT url, clicks, impressions FROM gsc WHERE project_id=?", projectId)) add(r);
  if (hasTable("gsc_pages_past")) for (const r of all("SELECT url, clicks, impressions FROM gsc_pages_past WHERE project_id=?", projectId)) add(r);
  return m;
}

/** Backlinks per target page from the latest stored backlink snapshot (no new paid calls). The DataForSEO fetch stores
 *  totals, referring domains and anchors; per-page counts are used only when a snapshot holds data.pages [{url, backlinks}]. */
function backlinkTargets(projectId) {
  if (!hasTable("bl_snapshots")) return { fetched: false, perPage: false, brokenBacklinks: null, map: new Map() };
  const s = get("SELECT data, fetched_at FROM bl_snapshots WHERE project_id=? ORDER BY id DESC LIMIT 1", projectId);
  if (!s) return { fetched: false, perPage: false, brokenBacklinks: null, map: new Map() };
  const d = parse(s.data), map = new Map();
  for (const p of Array.isArray(d.pages) ? d.pages : []) {
    const u = p?.url || p?.url_to || p?.page; if (typeof u !== "string") continue;
    map.set(key(u), (map.get(key(u)) || 0) + (Number(p.backlinks) || 0));
  }
  return { fetched: true, fetchedAt: s.fetched_at, perPage: map.size > 0, brokenBacklinks: d.brokenBacklinks ?? null, map };
}

const UNCHECKED = (s) => s === 0 || s === 429 || s >= 500;

export function lostUrls(projectId) {
  const project = get("SELECT id, name, start_url FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const audit = get("SELECT id, started_at, finished_at FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  const bl = backlinkTargets(projectId);
  const backlinks = { fetched: bl.fetched, perPage: bl.perPage, brokenBacklinks: bl.brokenBacklinks };
  if (!audit) return { audit: null, lost: [], unchecked: [], lines: [], backlinks };
  const day = (a) => String(a.finished_at || a.started_at || "").slice(0, 10) || null;
  const pages = all("SELECT url, final_url, status, title, in_sitemap, inlinks, indexable, content_type, data FROM pages WHERE audit_id=?", audit.id)
    .map((p) => ({ ...p, data: parse(p.data) }));
  const gsc = gscTotals(projectId);

  // Live pages a lost URL may be sent to: 200, indexable HTML, not itself a redirect, never the home page.
  const seen = new Set(), candidates = [];
  for (const p of pages) {
    if (p.status !== 200 || !p.indexable || !/html/.test(p.content_type || "") || p.data.redirect || isHome(p.url)) continue;
    const u = p.final_url || p.url; if (seen.has(key(u))) continue;
    seen.add(key(u)); candidates.push({ url: u, title: p.title || "", inlinks: p.inlinks || 0 });
  }
  // Words in 40%+ of live titles (brand, town) and the business name and domain can't pick out a topic page.
  const df = new Map();
  for (const c of candidates) for (const w of new Set(words(c.title))) df.set(w, (df.get(w) || 0) + 1);
  const ignore = new Set([...df].filter(([, n]) => candidates.length >= 5 && n / candidates.length >= 0.4).map(([w]) => w));
  for (const w of words(project.name)) ignore.add(w);
  for (const w of words((url(project.start_url)?.hostname || "").replace(/^www\./, "").split(".")[0])) ignore.add(w);

  // The last earlier finished audit in which the URL returned 200 without redirecting.
  const lastSeenQ = `SELECT x.url, x.title, x.in_sitemap, a.id auditId, a.started_at, a.finished_at FROM pages x JOIN audits a ON a.id=x.audit_id
    WHERE a.project_id=? AND a.status='done' AND a.id<? AND x.url IN (?,?,?,?) AND x.status=200 AND json_extract(x.data,'$.redirect') IS NULL ORDER BY a.id DESC LIMIT 1`;
  const lastSeen = (u) => {
    const slash = u.endsWith("/") ? u.slice(0, -1) : u + "/";
    const flip = (s) => s.replace(/^(https?:\/\/)(www\.)?/i, (m0, sch, w) => sch + (w ? "" : "www."));
    const r = get(lastSeenQ, projectId, audit.id, u, slash, flip(u), flip(slash));
    return r ? { auditId: r.auditId, date: day(r), title: r.title || "", inSitemap: Boolean(r.in_sitemap) } : null;
  };
  // Pages of the site that link to this exact URL. (pages.inlinks also counts links to the final URL, which for a
  // redirect to the home page is every page; pages.in_sitemap likewise, so a redirecting row's own flag is not used.)
  const linksTo = (u) => get("SELECT COUNT(DISTINCT from_url) n FROM links WHERE audit_id=? AND kind='a' AND internal=1 AND to_url=? AND from_url<>?", audit.id, u, u).n;
  const evidence = (u, p, seenRow) => {
    const g = gsc.get(key(u)) || { clicks: 0, impressions: 0 };
    return { lastSeen: seenRow, clicks: g.clicks, impressions: g.impressions, backlinks: bl.map.get(key(u)) || 0,
      inSitemap: Boolean((p && !p.data.redirect && p.in_sitemap) || seenRow?.inSitemap), inlinks: p ? linksTo(u) : 0 };
  };
  const valuable = (e) => Boolean(e.lastSeen || e.clicks || e.impressions || e.backlinks || e.inSitemap || e.inlinks);
  const order = (a, b) => b.evidence.clicks - a.evidence.clicks || b.evidence.impressions - a.evidence.impressions
    || b.evidence.backlinks - a.evidence.backlinks || b.evidence.inlinks - a.evidence.inlinks || a.url.localeCompare(b.url);

  const lost = [], unchecked = [], done = new Set();
  for (const p of pages) {
    const r = p.data.redirect;
    const toHome = r && r.firstStatus >= 300 && r.firstStatus < 400 && !isHome(p.url) && isHome(p.final_url || r.to)
      && key(p.final_url || r.to).split("/")[0] === key(p.url).split("/")[0];
    const gone = p.status === 404 || p.status === 410;
    const notLoaded = !r && UNCHECKED(p.status);
    if (!gone && !toHome && !notLoaded) continue;
    if (isHome(p.url) || done.has(key(p.url))) continue;
    done.add(key(p.url));
    const e = evidence(p.url, p, lastSeen(p.url));
    if (!valuable(e)) continue;
    if (notLoaded) {
      unchecked.push({ url: p.url, status: p.status, reason: p.data.blockedByRobots ? "blocked by robots.txt" : p.status === 0 ? (p.data.error || "did not load") : `HTTP ${p.status}`, evidence: e });
      continue;
    }
    const target = suggestTarget(p.url, e.lastSeen?.title || "", candidates.filter((c) => key(c.url) !== key(p.url)), ignore);
    lost.push({ url: p.url, status: toHome ? r.firstStatus : p.status, kind: toHome ? "home-redirect" : "gone", redirectsTo: toHome ? (p.final_url || r.to) : null,
      evidence: e, target, redirect: target ? apacheLine(p.url, target.url) : null });
  }

  // Pages that returned 200 in the previous finished audit but the latest crawl never reached: status unknown.
  const prev = get("SELECT id FROM audits WHERE project_id=? AND status='done' AND id<? ORDER BY id DESC LIMIT 1", projectId, audit.id);
  if (prev) {
    const now = new Set(pages.flatMap((p) => [key(p.url), key(p.final_url || p.url)]));
    for (const p of all("SELECT url FROM pages WHERE audit_id=? AND status=200 AND json_extract(data,'$.redirect') IS NULL", prev.id)) {
      if (now.has(key(p.url)) || done.has(key(p.url))) continue;
      done.add(key(p.url));
      unchecked.push({ url: p.url, status: null, reason: "not reached by the latest crawl (no link or sitemap entry led to it)", evidence: evidence(p.url, null, lastSeen(p.url)) });
    }
  }
  lost.sort(order); unchecked.sort(order);
  return { audit: { id: audit.id, date: day(audit) }, gscConnected: gsc.size > 0, backlinks,
    lost, unchecked: unchecked.slice(0, 300), lines: lost.map((r) => r.redirect).filter(Boolean) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/lost-urls$/, ([id]) => lostUrls(Number(id))]);
}
