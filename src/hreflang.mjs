// hreflang across the crawl (REQ-044 build row 7, Oct 2026): return links, bad targets and conflicting x-default
// URLs inside one cluster of language versions. Google's localized-versions docs: "If page X links to page Y, page Y
// must link back to page X", otherwise the annotations may be ignored or misread. Each hreflang URL should be the
// version's own indexable, canonical URL (Gary Illyes, "Internationalization & hreflang", SOTR 2024). Language and
// region codes are checked per page in crawler.mjs (hreflangCodeProblem). Pure function over the crawled pages.

const MAX_LISTED = 3;

/** Why an hreflang target can't take part in the cluster, or null. t: the crawled page record for the target URL. */
function targetProblem(t, target) {
  const d = t.data || {};
  if (d.blockedByRobots) return "blocked by robots.txt";
  if (d.redirect) return `redirects to ${d.redirect.to}`;
  if (t.status !== 200) return `HTTP ${t.status || "no response"}`;
  if (d.noindex) return "noindex";
  if (t.canonical && t.canonical !== target && t.canonical !== t.final_url) return `canonical points to ${t.canonical}`;
  return null;
}

/** [[id, url, detail]]: hreflang_bad_target (a target is non-200, redirects, noindex, robots-blocked or canonicalises
 *  elsewhere), hreflang_no_return (a crawled, valid target doesn't list this page back) and hreflang_xdefault_conflict
 *  (pages of one cluster name different x-default URLs). Only targets that were crawled are checked; the others are
 *  counted as "not checked" in the detail. pages: crawled pages with data.hreflangAlts / data.hreflangXDefault. */
export function hreflangClusterIssues(pages) {
  const byUrl = new Map();
  for (const p of pages) byUrl.set(p.url, p);
  for (const p of pages) if (p.final_url && !byUrl.has(p.final_url)) byUrl.set(p.final_url, p);
  const out = [], seen = new Set();
  const sources = pages.filter((p) => p.status === 200 && p.data?.hreflangAlts?.length && !seen.has(p.final_url || p.url) && seen.add(p.final_url || p.url));
  // Clusters (union-find over every hreflang link) for the x-default comparison.
  const parent = new Map();
  const find = (u) => { while (parent.has(u)) u = parent.get(u); return u; };
  for (const s of sources) for (const alt of s.data.hreflangAlts) { const a = find(s.final_url || s.url), b = find(alt); if (a !== b) parent.set(a, b); }

  for (const s of sources) {
    const self = s.final_url || s.url;
    const bad = [], noReturn = [];
    let unchecked = 0;
    for (const alt of s.data.hreflangAlts) {
      if (alt === self || alt === s.url) continue;
      const t = byUrl.get(alt);
      if (!t) { unchecked++; continue; }
      const why = targetProblem(t, alt);
      if (why) { bad.push(`${alt} (${why})`); continue; }
      const back = t.data?.hreflangAlts || [];
      if (!back.includes(self) && !back.includes(s.url)) noReturn.push(alt);
    }
    const note = unchecked ? `; ${unchecked} target(s) not crawled, not checked` : "";
    if (bad.length) out.push(["hreflang_bad_target", s.url, `${bad.length} target(s): ${bad.slice(0, MAX_LISTED).join(", ")}${note}`]);
    if (noReturn.length) out.push(["hreflang_no_return", s.url, `${noReturn.length} alternate(s) don't link back: ${noReturn.slice(0, MAX_LISTED).join(", ")}${bad.length ? "" : note}`]);
  }

  // x-default: the most common value in a cluster is taken as intended; pages naming another URL are reported.
  const xd = new Map(); // cluster root → Map(x-default URL → [page URLs])
  for (const s of sources) {
    const x = s.data.hreflangXDefault;
    if (!x) continue;
    const root = find(s.final_url || s.url);
    if (!xd.has(root)) xd.set(root, new Map());
    const m = xd.get(root);
    m.set(x, [...(m.get(x) || []), s.url]);
  }
  for (const m of xd.values()) {
    if (m.size < 2) continue;
    const [main, mainPages] = [...m].sort((a, b) => b[1].length - a[1].length)[0];
    for (const [x, us] of m) if (x !== main)
      for (const u of us) out.push(["hreflang_xdefault_conflict", u, `x-default is ${x} here, ${main} on ${mainPages.length} other page(s) of the same cluster`]);
  }
  return out;
}
