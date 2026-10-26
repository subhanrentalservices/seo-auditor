// What Googlebot gets vs what people get (REQ-044 build rows 17 and 18, Oct 2026). The home page and the most-linked
// pages are fetched (raw HTML, no rendering) as Googlebot Smartphone, as Chrome on a phone and as Chrome on a desktop:
// - mobile_desktop_parity: Googlebot Smartphone vs desktop Chrome. Google indexes what its smartphone crawler gets
//   (mobile-first indexing; John Mueller, Google Search News July 2024: all sites are crawled with it).
// - googlebot_ua_diff: Googlebot Smartphone vs Chrome on a phone (same device, only the bot differs): cloaking or a
//   bot wall (Google spam policies; Martin Splitt and John Mueller, "How to read the Indexing Report", 2026).
// - search_referrer_redirect: a redirect to another host only when the visitor comes from Google (sneaky redirect or
//   hack; Google, "Security issues explained", 2020).
// Requests go through the site-probes budget (req). The 70% / 50% thresholds are this tool's heuristics.

export const GOOGLEBOT_SMARTPHONE_UA = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
export const MOBILE_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
export const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHALLENGE = /just a moment|attention required|captcha|access denied|are you a robot|request blocked/i;

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** One fetch → what the checks compare. parse: parseHtml. */
export function snapshot(r, parse) {
  const s = { status: r.status, finalHost: host(r.url), error: r.error };
  if (r.status !== 200 || !/html/.test(r.type || "") || !r.body) return s;
  const p = parse(r.body, r.url), site = host(r.url);
  const linkHosts = p.links.map((l) => host(l.to));
  return { ...s, html: true, title: p.title, description: p.description, canonical: p.canonical || "", words: p.words,
    robots: [p.robotsMeta, norm(r.headers?.get?.("x-robots-tag"))].filter(Boolean).join(" | "),
    hreflang: [...(p.data.hreflangAlts || [])].sort().join(" "), types: new Set(p.data.schemaTypes || []),
    internal: linkHosts.filter((h) => h === site).length, external: new Set(linkHosts.filter((h) => h && h !== site)),
    challenge: CHALLENGE.test(p.title || "") };
}

/** Differences that matter for mobile-first indexing (smartphone crawler vs desktop browser). */
export function parityDiffs(m, d) {
  const out = [];
  if (m.finalHost && d.finalHost && m.finalHost !== d.finalHost) out.push(`the smartphone crawler is sent to ${m.finalHost} (desktop stays on ${d.finalHost})`);
  if (!m.html || !d.html) return out;
  if (d.words >= 50 && m.words < 0.7 * d.words) out.push(`${m.words} words vs ${d.words} on desktop`);
  if (d.internal >= 10 && m.internal < 0.7 * d.internal) out.push(`${m.internal} internal links vs ${d.internal} on desktop`);
  const lost = [...d.types].filter((t) => !m.types.has(t));
  if (lost.length) out.push(`structured data missing on mobile: ${lost.slice(0, 4).join(", ")}`);
  for (const [k, label] of [["title", "title"], ["description", "meta description"], ["canonical", "canonical"], ["robots", "robots directives"], ["hreflang", "hreflang links"]])
    if (norm(m[k]) !== norm(d[k])) out.push(`${label} differs ("${String(m[k] || "none").slice(0, 50)}" vs "${String(d[k] || "none").slice(0, 50)}")`);
  return out;
}

/** Differences between Googlebot and a browser on the same device. */
export function cloakDiffs(g, b) {
  const out = [];
  if (g.status !== b.status) out.push(`Googlebot gets HTTP ${g.status || g.error || "no response"}, a browser HTTP ${b.status || b.error || "no response"}`);
  else if (g.challenge && !b.challenge) out.push(`Googlebot gets a bot challenge page ("${g.title.slice(0, 50)}")`);
  if (!g.html || !b.html || g.challenge) return out;
  for (const k of ["title", "canonical", "robots"]) if (norm(g[k]) !== norm(b[k])) out.push(`${k} differs ("${String(g[k] || "none").slice(0, 50)}" for Googlebot, "${String(b[k] || "none").slice(0, 50)}" for a browser)`);
  if (b.words >= 50 && g.words < 0.5 * b.words) out.push(`Googlebot gets ${g.words} words, a browser ${b.words}`);
  const only = [...g.external].filter((h) => !b.external.has(h));
  if (only.length) out.push(`links to ${only.slice(0, 3).join(", ")} only for Googlebot`);
  return out;
}

/** Fetches each URL three times (Googlebot Smartphone, phone Chrome, desktop Chrome). keep.browserHost gets
 *  url → the host a phone browser ends up on. Returns [[id, url, detail]]. */
export async function parityIssues({ urls, req, parse, keep = {} }) {
  const out = [];
  keep.browserHost = new Map();
  for (const u of urls) {
    const g = snapshot(await req(u, { ua: GOOGLEBOT_SMARTPHONE_UA }), parse);
    const b = snapshot(await req(u, { ua: MOBILE_UA }), parse);
    const d = snapshot(await req(u, { ua: DESKTOP_UA }), parse);
    if ([g, b, d].some((x) => x.error === "BUDGET")) break;
    if (b.finalHost) keep.browserHost.set(u, b.finalHost);
    const cloak = b.status ? cloakDiffs(g, b) : [];
    if (cloak.length) out.push(["googlebot_ua_diff", u, cloak.join("; ") + ". A firewall may block a request that only claims to be Googlebot, so confirm with the URL Inspection live test in Search Console"]);
    if (cloak.length && (g.status !== b.status || g.challenge)) continue; // already explained: the parity numbers would repeat it
    const par = d.status ? parityDiffs(g, d) : [];
    if (par.length) out.push(["mobile_desktop_parity", u, par.join("; ")]);
  }
  return out;
}

/** A phone browser arriving from Google: redirected to another host than without the referrer → error. */
export async function referrerIssues({ urls, req, browserHost = new Map() }) {
  const out = [];
  for (const u of urls) {
    const plain = browserHost.get(u);
    if (!plain) continue;
    const r = await req(u, { ua: MOBILE_UA, headers: { Referer: "https://www.google.com/" }, maxBody: 0 });
    if (r.status && host(r.url) && host(r.url) !== plain)
      out.push(["search_referrer_redirect", u, `with Referer: https://www.google.com/ the page sends a phone browser to ${host(r.url)}; without it, it stays on ${plain}`]);
  }
  return out;
}
