// Pages reachable only through JavaScript navigation (REQ-055 group 2, Oct 2026). Google discovers pages by following
// <a href> links (and sitemaps); a route the site's own JavaScript opens with router.push("/x") or a click handler is
// invisible to it. The site's own scripts are read as text (never run): router configs (path: "/x"), link props
// (href: "/x", to: "/x") and navigation calls (navigate("/x"), push("/x"), replace("/x")) give candidate paths. A
// candidate that looks like a page path, isn't crawled, linked or in the sitemap, and answers 200 with its own page
// (not the site's not-found page or an app shell every path gets) is reported as js_only_routes. Nothing is crawled
// as a normal link. Caps: 30 scripts, 3 MB each, 15 MB in all, 20 candidates checked; robots.txt is obeyed for every
// script and candidate; gate() spaces the requests (Crawl-delay).
import { readBody, decodeBody } from "./body.mjs";

export const MAX_SCRIPTS = 30, MAX_SCRIPT_BYTES = 3 * 1024 * 1024, MAX_TOTAL_BYTES = 15 * 1024 * 1024, MAX_VERIFY = 20, MAX_PER_SCRIPT = 500;
const SOURCES = [
  [/\bpath\s*:\s*(["'`])(\/[^"'`\s]{0,200})\1/g, "path:"],
  [/\bhref\s*:\s*(["'`])(\/[^"'`\s]{0,200})\1/g, "href:"],
  [/\bto\s*:\s*(["'`])(\/[^"'`\s]{0,200})\1/g, "to:"],
  [/\b(navigate|navigateTo|push|replace)\s*\(\s*(["'`])(\/[^"'`\s]{0,200})\2/g, "call"],
];
// Framework and file folders, not pages.
const NOT_PAGES = /^\/(?:api|graphql|_next|_nuxt|__|static|assets|build|dist|chunks?|cdn-cgi|wp-json|wp-admin|wp-content|wp-includes|socket\.io|feed|rss)(?:\/|$)/i;

/** Does a path from a script look like a page of the site? No parameters (:id, [slug], *), files or framework folders. */
export function routeCandidate(p) {
  if (typeof p !== "string" || p === "/" || p.length > 200 || !/^\/[A-Za-z0-9\-._~%/]*$/.test(p) || p.includes("//")) return false;
  if (/\.[a-z0-9]{1,5}$/i.test(p) && !/\.html?$/i.test(p)) return false; // a file
  return !NOT_PAGES.test(p);
}

/** Candidate page paths in a script's source: Map(path → how it was written, e.g. 'path: "/pricing"'). */
export function extractRoutes(js) {
  const out = new Map();
  const src = String(js || "");
  for (const [re, kind] of SOURCES) {
    let n = 0;
    for (const m of src.matchAll(re)) {
      if (++n > MAX_PER_SCRIPT) break;
      const p = kind === "call" ? m[3] : m[2], clean = p.split(/[?#]/)[0];
      if (routeCandidate(clean) && !out.has(clean)) out.set(clean, kind === "call" ? `${m[1]}("${p}")` : `${kind} "${p}"`);
    }
  }
  return out;
}

/** The page's own inline scripts (not JSON data or templates), as one source: [{ label, text }]. */
export function inlineScripts(html, label = "an inline script on the home page") {
  const text = [...String(html || "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((m) => !/\bsrc\s*=/i.test(m[1]) && !/application\/(?:ld\+)?json|text\/(?!javascript)/i.test(m[1])).map((m) => m[2]).join("\n");
  return text.trim() ? [{ label, text: text.slice(0, MAX_SCRIPT_BYTES) }] : [];
}

const keyOf = (u) => { try { const x = new URL(u); return x.origin + (x.pathname.replace(/\/+$/, "") || "/"); } catch { return u; } };

/** GET a script as text, at most max bytes; obeys nothing itself (the caller checks robots.txt). */
async function getScript(url, { ua, headers = null, max = MAX_SCRIPT_BYTES, fetchFn = fetch } = {}) {
  try {
    const res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": ua, Accept: "*/*", ...headers } });
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); return { status: res.status, text: "", size: 0 }; }
    const b = await readBody(res, max);
    return { status: 200, text: decodeBody(b.buf, res.headers.get("content-type") || "text/javascript").text, size: b.buf.length };
  } catch (e) { return { status: 0, text: "", size: 0, error: e.cause?.code || e.name }; }
}

/** scripts: same-site script URLs; inline: [{ label, text }] (the home page's inline scripts); known: URLs crawled,
 *  linked or listed in the sitemap; blocked(url): robots.txt disallows it; fetchPage(url) → the crawler's fetchFollow
 *  result; parse(html, url) → parseHtml; fingerprint(text); notFound: the 404 probe's text fingerprint (an app that
 *  answers every path with the same shell can't be checked from outside). Returns { issues: [[id, url, detail]], stats }. */
export async function jsOnlyRouteIssues({ origin, scripts = [], inline = [], known = new Set(), blocked = () => false, ua, headersFor = () => null,
  fetchPage, parse, fingerprint, notFound = null, rendered = false, gate = async () => {}, stop = () => false, fetchFn = fetch } = {}) {
  const stats = { scripts: 0, bytes: 0, candidates: 0, checked: 0, found: 0, catchAll: 0, blocked: 0 };
  const knownKeys = new Set([...known].map(keyOf));
  const found = new Map(); // path → { from, how }
  const add = (routes, from) => { for (const [p, how] of routes) if (!found.has(p) && !knownKeys.has(keyOf(origin + p))) found.set(p, { from, how }); };
  for (const s of inline) add(extractRoutes(s.text), s.label);
  for (const u of [...new Set(scripts)].slice(0, MAX_SCRIPTS)) {
    if (stop() || stats.bytes >= MAX_TOTAL_BYTES) break;
    if (blocked(u)) { stats.blocked++; continue; }
    await gate();
    const r = await getScript(u, { ua, headers: headersFor(u), max: Math.min(MAX_SCRIPT_BYTES, MAX_TOTAL_BYTES - stats.bytes), fetchFn });
    if (r.status !== 200) continue;
    stats.scripts++; stats.bytes += r.size;
    add(extractRoutes(r.text), u);
  }
  stats.candidates = found.size;
  const issues = [];
  for (const [p, src] of [...found].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_VERIFY)) {
    if (stop()) break;
    const url = new URL(p, origin).href;
    if (blocked(url)) { stats.blocked++; continue; }
    await gate();
    const r = await fetchPage(url);
    stats.checked++;
    const final = r.finalUrl || url;
    if (r.status !== 200 || !/html/.test(r.type || "") || knownKeys.has(keyOf(final)) || (final !== url && blocked(final))) continue;
    const page = parse(r.body, final);
    if (page.data.noindex || (page.canonical && knownKeys.has(keyOf(page.canonical)))) continue; // not meant to be indexed on its own
    if (notFound && page.text && fingerprint(page.text) === notFound) { stats.catchAll++; continue; } // the same shell as a missing page
    stats.found++;
    issues.push(["js_only_routes", final, `found in ${src.from} as ${src.how}; HTTP 200${page.title ? `, "${page.title.slice(0, 60)}"` : ""}; `
      + (rendered ? "no <a href> to it on the crawled pages, rendered or not" : "no <a href> to it in the crawled pages' HTML (rendering was off: a link added by JavaScript wouldn't show)")]);
  }
  return { issues, stats };
}
