// Link gap (REQ-086, 2026-11-03; from a "free backlinks: list every competitor, find the sites that link to them but
// not to you" video that used Ahrefs Link Intersect). For up to 5 competitors and your own site, one DataForSEO
// referring-domains call each (paid, opt-in, the monthly budget applies) gives the sites that link to them. Listed:
// sites linking to at least `min` competitors and not to you, most competitors first. Each is labelled so the owner
// can act honestly: a business listing or directory you can join yourself; an article or news site (earned with
// something worth citing); or a likely spam / link network (leave alone). Never buy links, swap links ("link to me
// and I'll link to you" in excess) or join link networks: Google's spam policies treat those as link spam.
import { get } from "./db.mjs";
import { dfs } from "./dataforseo.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const MAX_COMPETITORS = 5;
export const PER_SITE = 300; // referring domains read per site (by rank)

/** Bare host: no scheme, www or path; lower case. */
export function cleanDomain(s) {
  let x = String(s || "").trim().toLowerCase();
  if (!x) return "";
  try { if (/^https?:\/\//.test(x)) x = new URL(x).hostname; } catch { return ""; }
  x = x.replace(/^www\./, "").replace(/\/.*$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x) ? x : "";
}

/** The registrable part, good enough for grouping: last two labels, or three for e.g. .com.au / .co.uk; the full host on
 *  free hosting platforms. */
const SHARED_HOSTS = /\.(pages\.dev|web\.app|blogspot\.com|github\.io|wordpress\.com|wixsite\.com|weebly\.com|netlify\.app|vercel\.app|tumblr\.com|medium\.com)$/;
export function rootOf(host) {
  if (SHARED_HOSTS.test(String(host || ""))) return String(host); // each subdomain is a different person's site
  const p = String(host || "").split(".");
  const sld = p.at(-2) || "";
  return p.slice(p.length >= 3 && /^(com|net|org|co|gov|edu|asn|id)$/.test(sld) && p.at(-1).length === 2 ? -3 : -2).join(".");
}

const LISTING = /director|listing|local|yellow|truelocal|hotfrog|startlocal|aussieweb|business|biz|pages|find|search|seek|nearby|postcode|provenexpert|yelp|foursquare|mapquest|cybo|brownbook|womo|wordofmouth|whotohire|starworks|productreview|oneflare|serviceseeking|bark\.|hipages|localsearch|autoguru|ringmy|addify/;
const SPAMMY = /\.pages\.dev$|\.web\.app$|blogspot\.|bookmark|seo|backlink|linkdir|urlm\.|five\.co\.in|domains?\.|whois|statshow|siteprice|websiteoutlook|hypestat/;

/** "listing" (join it yourself), "spam" (leave alone) or "site" (articles, news, associations: earn it). */
export function kindOf(domain, spam) {
  if ((spam ?? 0) >= 30 || SPAMMY.test(domain)) return "spam";
  if (LISTING.test(domain)) return "listing";
  return "site";
}

/**
 * lists: { "rival.com": [{ domain, rank, spam }], ... }; own: domains that already link to you.
 * Returns referring sites linking to >= min competitors and not to you (matched by root domain), most competitors
 * first, then by rank.
 */
export function linkGap(lists, own = [], { min = 2 } = {}) {
  const mine = new Set(own.map((d) => rootOf(cleanDomain(d) || d)));
  const by = new Map();
  for (const [rival, rows] of Object.entries(lists)) {
    const rivalRoot = rootOf(rival);
    for (const r of rows || []) {
      const d = cleanDomain(r.domain) || String(r.domain || "");
      const root = rootOf(d);
      if (!root || root === rivalRoot || mine.has(root)) continue;
      const x = by.get(root) || { domain: root, competitors: new Set(), rank: 0, spam: 0 };
      x.competitors.add(rival);
      x.rank = Math.max(x.rank, Number(r.rank) || 0);
      x.spam = Math.max(x.spam, Number(r.spam) || 0);
      by.set(root, x);
    }
  }
  const rivals = new Set(Object.keys(lists).map(rootOf));
  return [...by.values()]
    .filter((x) => x.competitors.size >= min && !rivals.has(x.domain))
    .map((x) => ({ domain: x.domain, competitors: [...x.competitors].sort(), count: x.competitors.size, rank: x.rank, spam: x.spam, kind: kindOf(x.domain, x.spam) }))
    .sort((a, b) => b.count - a.count || (a.kind === "spam") - (b.kind === "spam") || b.rank - a.rank || a.domain.localeCompare(b.domain));
}

async function referring(target, projectId, send) {
  const r = await send("backlinks/referring_domains/live", { target, include_subdomains: true, limit: PER_SITE, order_by: ["rank,desc"], backlinks_status_type: "live", exclude_internal_backlinks: true }, projectId);
  return (r.items || []).map((x) => ({ domain: x.domain, rank: x.rank, spam: x.backlinks_spam_score }));
}

/** One paid call per competitor plus one for your own site. */
export async function runLinkGap(project, input, { send = dfs, min = 2 } = {}) {
  const own = cleanDomain(project.start_url);
  const domains = [...new Set(String(input || "").split(/[\s,]+/).map(cleanDomain).filter((d) => d && rootOf(d) !== rootOf(own)))].slice(0, MAX_COMPETITORS);
  if (domains.length < min) fail(400, `Add at least ${min} competitor domains (up to ${MAX_COMPETITORS}).`);
  const lists = {}, errors = [];
  for (const d of domains) {
    try { lists[d] = await referring(d, project.id, send); }
    catch (e) { if (e.status === 402 || /Payment Required|budget/i.test(e.message)) throw e; errors.push({ domain: d, error: e.message }); }
  }
  const mine = await referring(own, project.id, send);
  const rows = linkGap(lists, mine.map((x) => x.domain), { min: Math.min(min, Object.keys(lists).length) });
  return { own, competitors: Object.fromEntries(Object.entries(lists).map(([d, l]) => [d, l.length])), ownLinks: mine.length, errors, rows,
    counts: { listing: rows.filter((r) => r.kind === "listing").length, site: rows.filter((r) => r.kind === "site").length, spam: rows.filter((r) => r.kind === "spam").length } };
}

export function register({ routes }) {
  routes.push(["POST", /^\/api\/projects\/(\d+)\/link-gap$/, async ([id], _q, body) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    return runLinkGap(p, (body || {}).domains, { min: Number((body || {}).min) === 1 ? 1 : 2 });
  }]);
}
