// Content decay and invisible pages, from Search Console (taught across the Ahrefs and Brian Dean videos as the
// first refresh list): pages whose clicks fell against the 28 days before and against the same 28 days last year,
// with the likely cause, and indexable pages Google shows for nothing at all.
import { all, get } from "./db.mjs";

const norm = (u) => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/index\.html?$/, "/").replace(/(.)\/$/, "$1")).toLowerCase(); } catch { return String(u); } };
// Pages that are meant to get no search traffic.
const UTILITY = /\/(privacy|terms|legal|cookie|contact|thank|thanks|login|logout|signin|signup|register|account|cart|checkout|basket|search|404|sitemap|unsubscribe)([-_./]|$)/i;

const MIN_CLICKS = 5;
/** One page against one earlier window: null when it held up, else the loss and its likely cause. */
export function compare(cur, base) {
  if (!base || base.clicks < MIN_CLICKS) return null;
  const lost = base.clicks - (cur?.clicks || 0);
  if (lost < Math.max(MIN_CLICKS, 0.3 * base.clicks)) return null;
  const imp = cur?.impressions || 0, posNow = cur?.position ?? null, posThen = base.position;
  let cause, advice;
  if (!imp) { cause = "gone"; advice = "No longer shown in Google at all. Check it still returns 200, is indexable and is in the sitemap; then inspect the URL in Search Console."; }
  else if (posNow - posThen >= 2) { cause = "rank"; advice = "It ranks lower than before. Compare it with the pages now above it: update facts and sections they cover, fix the intent if they are a different page type, and link to it from strong pages."; }
  else if (imp < 0.7 * base.impressions) { cause = "demand"; advice = "Shown less often at a similar position: fewer people search for this now (season or trend). Check the same period last year before rewriting."; }
  else { cause = "ctr"; advice = "Shown as often at a similar position but clicked less. Look at the results page (AI Overview, ads, map pack, competitors' titles) and rewrite the title and description to answer the search better."; }
  return { lost, pct: lost / base.clicks, clicksThen: base.clicks, impressionsThen: base.impressions, positionThen: posThen, cause, advice };
}

export function decayReport(projectId) {
  const cur = new Map(all("SELECT url, clicks, impressions, position FROM gsc WHERE project_id=?", projectId).map((r) => [norm(r.url), r]));
  const past = { prev: new Map(), yoy: new Map() };
  for (const r of all("SELECT * FROM gsc_pages_past WHERE project_id=?", projectId)) past[r.period]?.set(norm(r.url), r);
  const window = (p) => { const r = get("SELECT start_date s, end_date e FROM gsc_pages_past WHERE project_id=? AND period=? LIMIT 1", projectId, p); return r ? `${r.s} → ${r.e}` : null; };
  const urls = new Set([...cur.keys(), ...past.prev.keys(), ...past.yoy.keys()]);
  const decaying = [];
  for (const k of urls) {
    const c = cur.get(k), vsPrev = compare(c, past.prev.get(k)), vsYear = compare(c, past.yoy.get(k));
    if (!vsPrev && !vsYear) continue;
    const url = (c || past.prev.get(k) || past.yoy.get(k)).url;
    const y = past.yoy.get(k);
    // Down on last month but level with (or above) last year: most likely seasonal, not decay.
    const seasonal = Boolean(vsPrev && !vsYear && y && y.clicks >= MIN_CLICKS && (c?.clicks || 0) >= 0.9 * y.clicks);
    const main = vsYear || vsPrev;
    decaying.push({ url, clicks: c?.clicks || 0, impressions: c?.impressions || 0, position: c?.position ?? null, vsPrev, vsYear, seasonal,
      lost: Math.max(vsPrev?.lost || 0, vsYear?.lost || 0), cause: seasonal ? "seasonal" : main.cause,
      advice: seasonal ? "Lower than last month but level with the same weeks last year: probably seasonal. Refresh it before its season starts rather than now." : main.advice });
  }
  decaying.sort((a, b) => (a.seasonal - b.seasonal) || b.lost - a.lost);

  // Indexable pages from the latest audit that Google showed for nothing in either 28-day window.
  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  const shown = new Set([...cur.keys(), ...past.prev.keys()]);
  const invisible = [], expected = [];
  if (audit && cur.size) {
    for (const p of all(`SELECT url, title, words, inlinks FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE 'text/html%' ORDER BY inlinks DESC, url`, audit.id)) {
      if (shown.has(norm(p.url))) continue;
      const first = get(`SELECT MIN(a.started_at) t FROM pages x JOIN audits a ON a.id=x.audit_id WHERE a.project_id=? AND x.url=?`, projectId, p.url)?.t;
      const ageDays = first ? (Date.now() - Date.parse(first.replace(" ", "T") + "Z")) / 864e5 : null;
      const row = { ...p, firstSeen: first, isNew: ageDays !== null && ageDays < 30 };
      (UTILITY.test(new URL(p.url).pathname) ? expected : invisible).push(row);
    }
  }
  return { connected: cur.size > 0, prevWindow: window("prev"), yoyWindow: window("yoy"), hasYoy: past.yoy.size > 0,
    decaying: decaying.slice(0, 100), invisible, expected };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/decay$/, ([id]) => {
    if (!get("SELECT id FROM projects WHERE id=?", Number(id))) throw Object.assign(new Error("Project not found"), { status: 404 });
    return decayReport(Number(id));
  }]);
}
