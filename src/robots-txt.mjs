// robots.txt as Google's parser reads it (REQ-044 build row 21, Oct 2026): lines Google skips or ignores, and a
// Googlebot group that silently overrides the rules written for every crawler. Sources: Google's robots.txt docs;
// "Analysing Robots.txt at scale" (2026); "Is a crawl-delay rule ignored by Googlebot?" (2017); Gary Illyes (2019,
// 2022): noindex in robots.txt is not supported; "The past, present, and future of robots.txt" (2021). Pure: no fetches.

// The only fields Google uses. Everything else (crawl-delay, noindex, host, clean-param, request-rate…) is ignored.
const GOOGLE_FIELDS = new Set(["user-agent", "allow", "disallow", "sitemap"]);
// Misspellings Google's open-source parser (github.com/google/robotstxt) accepts anyway.
const TYPOS = { useragent: "user-agent", "user agent": "user-agent", dissallow: "disallow", dissalow: "disallow", disalow: "disallow", diasllow: "disallow", disallaw: "disallow", "site-map": "sitemap" };

/** robots.txt text → [{ n, key, value }] (n = line number; comments and blank lines dropped). key is lower case and
 *  null for a line Google can't read as "field: value"; typo is set when Google accepts a misspelt field name. */
export function robotsLines(text) {
  const out = [];
  String(text || "").replace(/^﻿/, "").split(/\r\n|\r|\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) return;
    let m = line.match(/^([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/);
    if (!m) { // Google also accepts a space in place of a missing colon ("Disallow /x")
      const w = line.match(/^([A-Za-z-]+)\s+(\S+)$/), k = w?.[1].toLowerCase();
      if (w && (GOOGLE_FIELDS.has(k) || TYPOS[k])) return out.push({ n: i + 1, key: TYPOS[k] || k, value: w[2], typo: `"${w[1]}" without a colon`, raw: line });
      return out.push({ n: i + 1, key: null, value: "", raw: line });
    }
    const k = m[1].toLowerCase().replace(/\s+/g, " ");
    if (TYPOS[k]) return out.push({ n: i + 1, key: TYPOS[k], value: m[2].trim(), typo: `"${m[1]}"`, raw: line });
    out.push({ n: i + 1, key: /\s/.test(k) ? null : k, value: m[2].trim(), raw: line });
  });
  return out;
}

/** Groups as Google forms them: consecutive user-agent lines share the rules that follow; rules for the same user
 *  agent in several groups are combined. Returns Map(lower-case agent → [{ type: "allow"|"disallow", path }]). */
export function robotsGroups(text) {
  const groups = new Map();
  let agents = [], inRules = false;
  for (const l of robotsLines(text)) {
    if (l.key === "user-agent") {
      if (inRules) { agents = []; inRules = false; }
      const a = l.value.toLowerCase().split("/")[0].trim();
      agents.push(a);
      if (!groups.has(a)) groups.set(a, []);
    } else if ((l.key === "allow" || l.key === "disallow") && agents.length) {
      inRules = true;
      for (const a of agents) groups.get(a).push({ type: l.key, path: l.value });
    }
  }
  return groups;
}

const clip = (s) => (s.length > 60 ? s.slice(0, 57) + "…" : s);

/** robots_txt_syntax (notice): HTML or a non-text/plain Content-Type, lines Google skips, fields Google ignores,
 *  accepted misspellings, unencoded non-ASCII paths, relative Sitemap URLs, rule paths that can never match.
 *  robots_group_override (notice): a Googlebot group exists and Googlebot ignores the "*" group's Disallow rules it
 *  doesn't repeat. Returns [[id, url, detail]]. status/type: the robots.txt response (only a 200 is checked). */
export function robotsTxtIssues({ origin, status, type = "", text }) {
  const url = origin + "/robots.txt", out = [];
  if (status !== 200 || !String(text || "").trim()) return out;
  const found = [];
  const body = String(text).replace(/^﻿/, "").trimStart();
  if (/^</.test(body)) found.push("the file is HTML, not a robots.txt (Google may find no rules in it)");
  else if (type && !/^text\/plain\b/i.test(type)) found.push(`served as ${type.split(";")[0]}, not text/plain`);
  if (!/^</.test(body)) {
    const ignored = new Map(), bad = [], typos = [], nonAscii = [], relSitemap = [], noSlash = [];
    for (const l of robotsLines(text)) {
      if (!l.key) { bad.push(`line ${l.n} "${clip(l.raw)}"`); continue; }
      if (l.typo) typos.push(`line ${l.n} ${l.typo}`);
      if (!GOOGLE_FIELDS.has(l.key)) { if (!ignored.has(l.key)) ignored.set(l.key, l.n); continue; }
      if (l.key === "sitemap" && l.value && !/^https?:\/\//i.test(l.value)) relSitemap.push(`line ${l.n} "${clip(l.value)}"`);
      if (l.key === "allow" || l.key === "disallow") {
        if (/[^\x00-\x7f]/.test(l.value)) nonAscii.push(`line ${l.n} "${clip(l.value)}"`);
        if (l.value && !/^[/*]/.test(l.value)) noSlash.push(`line ${l.n} "${clip(l.value)}"`);
      }
    }
    const few = (xs) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? ` and ${xs.length - 3} more` : "");
    if (bad.length) found.push(`${bad.length} line(s) Google can't read as "field: value" and skips: ${few(bad)}`);
    if (ignored.size) found.push(`field(s) Google ignores: ${[...ignored].map(([k, n]) => `${k} (line ${n})`).slice(0, 5).join(", ")}`);
    if (typos.length) found.push(`misspelt field name(s), accepted by Google but maybe not by other crawlers: ${few(typos)}`);
    if (nonAscii.length) found.push(`non-ASCII characters in rule paths (percent-encode them as UTF-8): ${few(nonAscii)}`);
    if (relSitemap.length) found.push(`relative Sitemap URL(s); Google needs a full URL: ${few(relSitemap)}`);
    if (noSlash.length) found.push(`rule path(s) not starting with / or * never match anything: ${few(noSlash)}`);
  }
  if (found.length) out.push(["robots_txt_syntax", url, found.join("; ")]);
  const groups = robotsGroups(text), own = groups.get("googlebot"), all = groups.get("*");
  if (own && all) {
    const repeated = new Set(own.map((r) => `${r.type}:${r.path}`));
    const missed = [...new Set(all.filter((r) => r.type === "disallow" && r.path && !repeated.has(`disallow:${r.path}`)).map((r) => r.path))];
    if (missed.length) out.push(["robots_group_override", url, `Googlebot follows only its own "User-agent: Googlebot" group, so it ignores ${missed.length} Disallow rule(s) of the "*" group: ${missed.slice(0, 4).map(clip).join(", ")}${missed.length > 4 ? " …" : ""} (fine if deliberate)`]);
  }
  return out;
}
