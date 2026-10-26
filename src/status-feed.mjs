// Google Search Status Dashboard feed (REQ-044 build row 49). On a Search Console refresh, one public GET of
// status.search.google.com/incidents.json (timeout, at most every 12 hours, never throws) is cached in the meta table.
// Ranking updates from it are merged with the hand-curated src/google-updates.json at read time (that file is never
// written, and an update already on it is never duplicated); crawling, indexing and serving incidents are kept so the
// Search trend card can label a drop "during a Google incident". Every merged entry keeps its incident URL and the day
// it was fetched. If the fetch fails, the shipped list (plus the last good copy of the feed) is used.
// Sources: Gary Illyes, "Cosmic Rays & Crawlers", Search Off the Record (2024): check the dashboard before debugging
// your own site, an incident there means "probably not your fault"; Danny Sullivan, "Let's talk ranking updates" (2023).
import { get, run } from "./db.mjs";

export const FEED_URL = "https://status.search.google.com/incidents.json";
const SITE = "https://status.search.google.com/";
const KEY = "google-status-feed";
const MAX_AGE = 12 * 3600e3; // the GSC refresh after an audit is throttled to 12 hours too
const TIMEOUT = 10000;
const SERVICES = { ranking: "ranking", crawling: "crawling", indexing: "indexing", serving: "serving" };

const day = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const typeOf = (name) => (/\bcore update\b/i.test(name) ? "core" : /\bspam update\b/i.test(name) ? "spam" : /\bhelpful content\b/i.test(name) ? "helpful" : "other");

/** incidents.json → { updates: ranking updates [{name, type, start, end, source}], incidents: crawling, indexing and
 *  serving incidents [{name, service, start, end, impact, source}] }. Rows without a name or a start day are skipped. */
export function parseFeed(json) {
  const updates = [], incidents = [];
  for (const i of Array.isArray(json) ? json : []) {
    const name = String(i?.external_desc || "").replace(/\s+/g, " ").trim().slice(0, 200), start = day(i?.begin);
    const service = SERVICES[String(i?.service_name || "").toLowerCase()];
    if (!name || !start || !service) continue;
    const source = SITE + (/^incidents\/[\w-]+$/.test(i.uri || "") ? i.uri : `incidents/${String(i.id || "").replace(/[^\w-]/g, "")}`);
    const end = day(i.end);
    if (service === "ranking") updates.push({ name, type: typeOf(name), start, end, source });
    else incidents.push({ name, service, start, end, impact: String(i.status_impact || "").toLowerCase() || null, source });
  }
  return { updates, incidents };
}

/** The shipped list plus feed updates it doesn't already have: the same start day and type, or the same name, is the
 *  same update. Shipped entries are returned untouched; added ones carry fromFeed, source and fetched. */
export function mergeUpdates(shipped, feed = [], fetched = null) {
  const key = (u) => String(u.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const names = new Set(shipped.map(key)), dayType = new Set(shipped.map((u) => `${u.start} ${u.type}`));
  const added = feed.filter((u) => !names.has(key(u)) && !dayType.has(`${u.start} ${u.type}`))
    .map((u) => ({ ...u, fromFeed: true, fetched }));
  return [...shipped, ...added].sort((a, b) => a.start.localeCompare(b.start));
}

/** The cached feed: { fetchedAt, checkedAt, error, updates, incidents } or null before the first fetch. */
export function cachedFeed() {
  const r = get("SELECT value FROM meta WHERE key=?", KEY);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
}

/** Fetches the feed unless it was checked in the last 12 hours. Never throws: a failure is recorded next to the last
 *  good copy. fetchFn is injectable for tests. Returns the cache. */
export async function refreshFeed({ fetchFn = globalThis.fetch, now = Date.now(), force = false } = {}) {
  const prev = cachedFeed();
  if (!force && prev?.checkedAt && now - Date.parse(prev.checkedAt) < MAX_AGE) return prev;
  const checkedAt = new Date(now).toISOString();
  let next;
  try {
    const res = await fetchFn(FEED_URL, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseFeed(await res.json());
    if (!parsed.updates.length && !parsed.incidents.length) throw new Error("no incidents in the feed");
    next = { fetchedAt: checkedAt, checkedAt, error: null, source: FEED_URL, ...parsed };
  } catch (e) {
    next = { ...(prev || { fetchedAt: null, updates: [], incidents: [] }), checkedAt, source: FEED_URL, error: String(e.message || e).slice(0, 200) };
  }
  run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", KEY, JSON.stringify(next));
  return next;
}
