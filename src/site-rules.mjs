// Site rules over the crawled pages, no extra requests (REQ-044 build rows 35 and 46, Oct 2026):
// - login_redirect_hub: many URLs redirect to one login page (John Mueller, "Optimizing login-page content for
//   Google Search", 2025),
// - email_in_url: an email address in a crawled URL (privacy),
// - sitemap_lastmod_inaccurate: <lastmod> moved without a content change, or content changed without a new lastmod
//   (Google sitemap docs: lastmod is used only when it is consistently and verifiably accurate).
import { db, all, get } from "./db.mjs";

const LOGIN = /\/(?:[\w-]*[-_])?(?:log-?in|sign-?in|account|my-?account)(?:[-_.][\w-]*)?(?:\/|$|\?)/i;
// An address in a path or query (raw or %40-encoded). Retina file names (logo@2x.png) end in a file extension.
const EMAIL = /[^/?&=#]+(?:@|%40)[^/?&=#]+\.[a-z]{2,}/i;
const FILE_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|pdf|txt|html?|php|aspx?)$/i;

/** Email-looking text in a URL's path or query, or null. */
export function emailInUrl(url) {
  let x; try { x = new URL(url); } catch { return null; }
  const m = (x.pathname + x.search).match(EMAIL);
  return m && !FILE_EXT.test(m[0]) ? m[0] : null;
}

/** [[id, url, detail]] for login_redirect_hub (5 or more crawled URLs redirect to one login/account URL) and
 *  email_in_url (one per crawled URL, max 20). */
export function siteRuleIssues(pages) {
  const out = [], hubs = new Map();
  for (const p of pages) {
    const to = p.data?.redirect?.to;
    if (to && to !== p.url && LOGIN.test(new URL(to).pathname + "/")) hubs.set(to, [...(hubs.get(to) || []), p.url]);
  }
  for (const [to, from] of hubs) if (from.length >= 5)
    out.push(["login_redirect_hub", to, `${from.length} crawled URLs redirect to this login page, e.g. ${from.slice(0, 2).join(", ")}`]);
  let n = 0;
  for (const p of pages) {
    const e = emailInUrl(p.url);
    if (e && n++ < 20) out.push(["email_in_url", p.url, `contains "${e.slice(0, 60)}"`]);
  }
  return out;
}

// Each audit's sitemap <lastmod> values (yyyy-mm-dd), so the next audit can compare them with the page text.
db.exec("CREATE TABLE IF NOT EXISTS audit_lastmod (audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, url TEXT NOT NULL, lastmod TEXT, PRIMARY KEY (audit_id, url))");
export function saveLastmods(auditId, lastmodOf) {
  const ins = db.prepare("INSERT OR REPLACE INTO audit_lastmod (audit_id, url, lastmod) VALUES (?,?,?)");
  db.exec("BEGIN");
  try { for (const [u, d] of lastmodOf || []) ins.run(auditId, u, String(d).slice(0, 10)); db.exec("COMMIT"); }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

/** Compares lastmod and main-text hash per URL with the previous audit: { bumped, stale, compared } where
 *  bumped = lastmod moved forward, text unchanged; stale = text changed, lastmod unchanged and older than the previous
 *  audit. Both maps: url → { lastmod, hash }. prevDate: when the previous audit finished (yyyy-mm-dd). */
export function lastmodDrift(prev, cur, prevDate) {
  const bumped = [], stale = [];
  let compared = 0;
  for (const [u, c] of cur) {
    const p = prev.get(u);
    if (!p || !p.hash || !c.hash || !p.lastmod || !c.lastmod) continue;
    compared++;
    if (c.lastmod > p.lastmod && c.hash === p.hash) bumped.push(u);
    else if (c.hash !== p.hash && c.lastmod === p.lastmod && c.lastmod < prevDate) stale.push(u);
  }
  return { bumped, stale, compared };
}

/** sitemap_lastmod_inaccurate: reported when 5 or more URLs, or 20% of the compared sitemap URLs, are affected.
 *  Uses the newest earlier finished audit of the project that stored lastmods. pages: this audit's pages (with data). */
export function lastmodAccuracyIssues(projectId, auditId, lastmodOf, pages, sitemapUrl) {
  const base = get(`SELECT id, substr(finished_at, 1, 10) day FROM audits WHERE project_id=? AND id<? AND status='done'
    AND EXISTS (SELECT 1 FROM audit_lastmod l WHERE l.audit_id=audits.id) ORDER BY id DESC LIMIT 1`, projectId, auditId);
  if (!base || !lastmodOf?.size) return [];
  const hashes = (rows) => { const m = new Map(); for (const r of rows) if (r.h) { m.set(r.url, r.h); if (r.final_url) m.set(r.final_url, r.h); } return m; };
  const prevHash = hashes(all("SELECT url, final_url, json_extract(data, '$.textHash') h FROM pages WHERE audit_id=? AND status=200", base.id));
  const curHash = hashes(pages.filter((p) => p.status === 200).map((p) => ({ url: p.url, final_url: p.final_url, h: p.data?.textHash })));
  const prev = new Map(all("SELECT url, lastmod FROM audit_lastmod WHERE audit_id=?", base.id).map((r) => [r.url, { lastmod: r.lastmod, hash: prevHash.get(r.url) }]));
  const cur = new Map([...lastmodOf].map(([u, d]) => [u, { lastmod: String(d).slice(0, 10), hash: curHash.get(u) }]));
  const { bumped, stale, compared } = lastmodDrift(prev, cur, base.day);
  const n = bumped.length + stale.length;
  if (!n || !(n >= 5 || n >= 0.2 * compared)) return [];
  const out = [];
  if (bumped.length) out.push(["sitemap_lastmod_inaccurate", sitemapUrl, `${bumped.length} of ${compared} URLs: lastmod moved forward since audit #${base.id} but the main text is unchanged, e.g. ${bumped.slice(0, 2).join(", ")}`]);
  if (stale.length) out.push(["sitemap_lastmod_inaccurate", sitemapUrl, `${stale.length} of ${compared} URLs: main text changed since audit #${base.id} but lastmod still says ${cur.get(stale[0]).lastmod}, e.g. ${stale.slice(0, 2).join(", ")}`]);
  return out;
}
