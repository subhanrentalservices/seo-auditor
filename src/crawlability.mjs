// Crawlability: can Google reach and fetch the site the way it is meant to be fetched? Site-level checks from
// Google Search Central's crawling docs (robots.txt handling, soft 404s, host variants, blocked resources) plus the
// helpers the crawler uses for page-level ones. Read-only: a few extra requests per audit.

/** One request without following redirects; network errors keep their code (ENOTFOUND, ERR_TLS_CERT_ALTNAME_INVALID, …). */
export async function probe(url, ua, timeout = 15000) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeout), headers: { "User-Agent": ua, Accept: "text/html,*/*;q=0.8" } });
    const type = res.headers.get("content-type") || "";
    const body = res.status === 200 && /html/.test(type) ? (await res.text()).slice(0, 2_000_000) : "";
    return { status: res.status, location: res.headers.get("location"), body };
  } catch (e) {
    const code = e.cause?.code || e.code || (e.name === "TimeoutError" ? "TIMEOUT" : "ERROR");
    return { status: 0, error: code, detail: e.cause?.message || e.message };
  }
}

const TLS = /TLS|CERT|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME/i;
const DNS = /ENOTFOUND|EAI_AGAIN|ENODATA/;

/** Follows a host variant to where it ends up: [{url, status}] hops, or the network error that stopped it. */
async function follow(url, ua, get, max = 5) {
  const hops = [];
  let cur = url;
  for (let i = 0; i <= max; i++) {
    const r = await get(cur, ua);
    hops.push({ url: cur, status: r.status, error: r.error });
    if (r.status >= 300 && r.status < 400 && r.location) { cur = new URL(r.location, cur).href; continue; }
    return hops;
  }
  return hops;
}

/** http://, https://, with and without www: every variant should 301 to the site's own address over valid TLS. */
export async function hostVariants(start, ua, get = probe) {
  const u = new URL(start);
  const bare = u.hostname.replace(/^www\./, ""), canonical = u.origin;
  const out = [];
  for (const proto of ["https:", "http:"]) for (const host of [bare, "www." + bare]) {
    const origin = `${proto}//${host}`;
    if (origin === canonical) continue;
    const hops = await follow(origin + "/", ua, get);
    const last = hops.at(-1);
    if (last.error && DNS.test(last.error) && hops.length === 1) { out.push(["host_variant_missing", origin + "/", `${host} has no DNS record: typing it gives a "site can't be reached" error`]); continue; }
    const bad = hops.find((h) => h.error && TLS.test(h.error));
    if (bad) { out.push(["host_variant_tls", origin + "/", `${new URL(bad.url).host}: certificate doesn't cover this name (${bad.error})${hops.length > 1 ? ` after ${hops.slice(0, -1).map((h) => h.status).join(" → ")}` : ""}`]); continue; }
    if (last.error) { out.push(["host_variant_missing", origin + "/", `${last.error} at ${last.url}`]); continue; }
    const end = new URL(last.url).origin;
    if (end !== canonical || last.status !== 200) out.push(["host_variant_redirect", origin + "/", `ends at ${last.url} (HTTP ${last.status}), not ${canonical}/`]);
    else if (![301, 308].includes(hops[0].status)) out.push(["host_variant_redirect", origin + "/", `first redirect is ${hops[0].status}, use 301`]);
  }
  return out;
}

const assetUrls = (html, base) => {
  const out = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) out.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/rel=["']?stylesheet/i.test(m[0])) { const h = m[0].match(/href=["']([^"']+)["']/i); if (h) out.add(h[1]); }
  return [...out].map((x) => { try { return new URL(x, base).href; } catch { return null; } }).filter((x) => x && new URL(x).origin === new URL(base).origin);
};

/** Site checks: robots.txt errors, size and blanket disallow, blocked CSS/JS, soft 404s, host variants. Returns [[id, url, detail]]. */
export async function crawlabilitySiteIssues({ start, robotsRes, robotsTxt, robots, ua, get = probe }) {
  const origin = new URL(start).origin, out = [];
  if (robotsRes.status >= 500 || robotsRes.status === 0 || robotsRes.error)
    out.push(["robots_txt_error", origin + "/robots.txt", robotsRes.error ? `no response (${robotsRes.error})` : `HTTP ${robotsRes.status}`]);
  if (robotsTxt.length > 500 * 1024) out.push(["robots_txt_large", origin + "/robots.txt", `${Math.round(robotsTxt.length / 1024)} KiB`]);
  if (robotsTxt && robots.isAllowed(start, "Googlebot") === false) out.push(["robots_disallow_all", origin + "/robots.txt", "Googlebot may not fetch the start page"]);
  else if (robotsTxt) {
    const home = await get(start, ua);
    const blocked = home.body ? assetUrls(home.body, start).filter((x) => robots.isAllowed(x, "Googlebot") === false) : [];
    if (blocked.length) out.push(["robots_blocks_resources", start, `${blocked.length} file(s), e.g. ${blocked.slice(0, 3).join(", ")}`]);
  }
  const missing = `${origin}/seo-auditor-missing-page-${Date.now().toString(36)}.html`;
  const r404 = await get(missing, ua);
  if (r404.status === 200) out.push(["soft_404", missing, "a page that doesn't exist answers HTTP 200"]);
  out.push(...(await hostVariants(start, ua, get)));
  return out;
}

/** URL parameter traps: one path crawled under many ?query variants. */
export function paramTraps(urls, min = 30) {
  const byPath = new Map();
  for (const u of urls) { const x = new URL(u); if (!x.search) continue; const k = x.origin + x.pathname; byPath.set(k, (byPath.get(k) || 0) + 1); }
  return [...byPath].filter(([, n]) => n >= min).map(([path, n]) => [path, n]);
}
