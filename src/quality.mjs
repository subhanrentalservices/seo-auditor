// Quality checks based on Google's spam policies and sitemap/crawler documentation (researched 2026-10-22):
// - near-duplicate / "swap" pages (Google spam policies: doorway and scaled content abuse),
// - crawler access by user agent (a host can block bots that robots.txt allows),
// - honest sitemap lastmod (Google and Bing ignore lastmod that isn't verifiably accurate).
// All new site-quality checks are notices so Site Health stays comparable with earlier audits.
import { all } from "./db.mjs";

const STOP = new Set("the a an and or of to in on for with at by from is are be it this that your you we our as".split(" "));
const words = (t) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Words from a URL's last path segment ("mechanic-berwick.html" → ["berwick"]) to mask place/topic names. */
export function slugWords(url) {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    return seg.replace(/\.[a-z]+$/, "").split(/[-_]+/).filter((w) => w.length >= 4 && !STOP.has(w));
  } catch { return []; }
}

function shingles(text, mask) {
  const w = words(text).map((x) => (mask.has(x) ? "§" : x)), out = new Set();
  for (let i = 0; i + 5 <= w.length; i++) out.add(w.slice(i, i + 5).join(" "));
  return out;
}

/**
 * Pairs of pages sharing many 5-word phrases. score = shared ÷ smaller page's phrases (containment), with both
 * pages' slug words masked so "Berwick" vs "Pakenham" doesn't hide a swap page. Returns pairs ≥ min, best first.
 */
export function similarPairs(pages, { min = 0.2, limit = 200 } = {}) {
  const capped = pages.slice(0, 3000); // O(n²); large sites: the first 3,000 indexable pages
  const slugs = capped.map((p) => slugWords(p.url));
  // Site-wide boilerplate (a shared "related links" or footer-like block inside <main>) is not what makes a page a
  // swap page: drop phrases that appear on more than 30% of pages (min 4) before comparing.
  const df = new Map();
  for (let i = 0; i < capped.length; i++) for (const s of shingles(capped[i].text, new Set(slugs[i]))) df.set(s, (df.get(s) || 0) + 1);
  const common = Math.max(4, Math.ceil(capped.length * 0.3));
  const strip = (set) => { for (const s of set) if ((df.get(s) || 0) > common) set.delete(s); return set; };
  const out = [];
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      const mask = new Set([...slugs[i], ...slugs[j]]);
      const a = strip(shingles(capped[i].text, mask)), b = strip(shingles(capped[j].text, mask));
      if (a.size < 20 || b.size < 20) continue;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let shared = 0; for (const s of small) if (big.has(s)) shared++;
      const score = shared / small.size;
      if (score >= min) out.push({ a: capped[i].url, b: capped[j].url, score: +score.toFixed(3), shared });
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

export function similarForAudit(auditId, opts) {
  return similarPairs(all("SELECT url, text FROM page_text WHERE audit_id=?", auditId), opts);
}

// Documented user-agent tokens (vendor docs, checked 2026-10-22). The full strings vary by version; hosts and
// firewalls usually match on the token.
export const CRAWLER_UAS = {
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
  "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  PerplexityBot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Perplexity-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
};

/** Fetch the home page as each crawler; a different status than a normal browser means the host treats bots differently. */
export async function crawlerAccess(url, browserUa) {
  const get = async (ua) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      const body = await r.text();
      return { status: r.status, bytes: Buffer.byteLength(body) };
    } catch (e) { return { status: 0, bytes: 0, error: e.message }; }
  };
  const base = await get(browserUa);
  const rows = [];
  for (const [bot, ua] of Object.entries(CRAWLER_UAS)) rows.push({ bot, ...(await get(ua)) });
  return { base, rows, blocked: rows.filter((r) => r.status !== base.status || (base.bytes > 2000 && r.bytes < base.bytes * 0.5)) };
}

/** Share of sitemap URLs sharing the most common <lastmod>; ≥ 60% of 10+ URLs looks like a bulk date, not real edits. */
export function lastmodUniformity(lastmods) {
  const vals = lastmods.filter(Boolean).map((v) => v.slice(0, 10));
  if (vals.length < 10) return null;
  const counts = new Map(); for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const [date, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  return { date, n, total: vals.length, share: n / vals.length };
}

/** Did the pages carrying the shared lastmod really change on or after that date? Compares their main text with the
 *  last audit of this project finished before the date (one that stored page text). Null when there is no such audit. */
export function lastmodChanged(projectId, auditId, date, lastmodOf) {
  const base = all(`SELECT id FROM audits WHERE project_id=? AND id<>? AND status='done' AND finished_at < ?
    AND EXISTS (SELECT 1 FROM page_text t WHERE t.audit_id=audits.id) ORDER BY id DESC LIMIT 1`, projectId, auditId, date)[0];
  if (!base) return null;
  const textOf = (id) => new Map(all("SELECT url, text FROM page_text WHERE audit_id=?", id).map((r) => [r.url, r.text]));
  const now = textOf(auditId), before = textOf(base.id);
  let n = 0, changed = 0;
  for (const [url, d] of lastmodOf || []) {
    if (d !== date || !now.has(url)) continue;
    n++; if (before.get(url) !== now.get(url)) changed++;
  }
  return n ? { baseAudit: base.id, n, changed, share: changed / n } : null;
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/similar$/, ([id], q) => ({ pairs: similarForAudit(Number(id), { min: Number(q.min) || 0.2 }) })]);
}
