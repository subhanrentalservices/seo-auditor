// Title and H1 checks across pages (REQ-044 build rows 39 and 40, Oct 2026), from Google's title links doc: "there's
// no reason to have the same words or phrases appear multiple times", avoid "repeated or boilerplate text in <title>
// elements", brand titles "concisely", and Google builds title links from headings too (Gary Illyes, "Anatomy of a
// Search Result", 2024). Thresholds are this tool's heuristics. Pure functions over the crawled pages.

const STOP = new Set("a an and or of to in on for with at by from is are be it this that your you we our as the near me my".split(" "));
const SEGMENTS = /\s+[|–—-]\s+|\s*[|]\s*|,\s+/;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
const compact = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const stem = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/([^s])s$/, "$1") : w); // brakes → brake, batteries → battery
const PAGED = /[?&](?:page|p|pg|paged)=\d+|\/page\/\d+\/?$/i;

/** How many times the brand appears in a title (the best-matching brand term; spacing and case ignored). */
export function brandCount(title, brandTerms = []) {
  const t = compact(title);
  return Math.max(0, ...brandTerms.map((b) => compact(b)).filter((b) => b.length >= 3).map((b) => t.split(b).length - 1));
}

/** Why a title reads like a keyword list, or null: the brand twice or more, 4 or more segments, or one word stem
 *  3 or more times. */
export function titleProblem(title, brandTerms = []) {
  const t = String(title || "").trim();
  if (!t) return null;
  const b = brandCount(t, brandTerms);
  if (b >= 2) return `the brand appears ${b} times`;
  const segs = t.split(SEGMENTS).map((s) => s.trim()).filter(Boolean);
  if (segs.length >= 4) return `${segs.length} segments: ${segs.slice(0, 5).join(" / ")}`;
  const counts = new Map();
  for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) counts.set(stem(w), (counts.get(stem(w)) || 0) + 1);
  const [w, n] = [...counts].sort((x, y) => y[1] - x[1])[0] || ["", 0];
  return n >= 3 ? `"${w}" ${n} times` : null;
}

/** title_quality: per page (keyword-list titles) and site-wide boilerplate: 10 or more indexable pages whose titles
 *  share the same leading or trailing segment that is over 60% of each title's length. */
export function titleQualityIssues(pages, { brandTerms = [] } = {}) {
  const live = pages.filter((p) => p.status === 200 && p.indexable && p.title);
  const out = [];
  const flagged = new Set();
  for (const p of live) {
    const why = titleProblem(p.title, brandTerms);
    if (why) { out.push(["title_quality", p.url, `${why}: "${p.title.slice(0, 90)}"`]); flagged.add(p.url); }
  }
  const groups = new Map();
  for (const p of live) {
    const segs = p.title.split(SEGMENTS).map((s) => s.trim()).filter(Boolean);
    if (segs.length < 2) continue;
    for (const [end, seg] of [["leading", segs[0]], ["trailing", segs.at(-1)]]) {
      if (seg.length <= p.title.length * 0.6) continue;
      const k = end + "\n" + norm(seg);
      groups.set(k, [...(groups.get(k) || []), p]);
    }
  }
  for (const [k, ps] of groups) {
    if (ps.length < 10) continue;
    const [end, seg] = k.split("\n");
    for (const p of ps) if (!flagged.has(p.url)) {
      flagged.add(p.url);
      out.push(["title_quality", p.url, `boilerplate: the ${end} part "${seg.slice(0, 70)}" is over 60% of the title and shared by ${ps.length} pages`]);
    }
  }
  return out;
}

/** dup_h1: the same H1 (case and spacing ignored, 3+ characters) on 2 or more indexable pages from different hreflang
 *  clusters. ?page= / /page/N series and pages whose title is also shared (already dup_title) are left out.
 *  cluster(url) → cluster key (the URL itself when hreflang isn't used). */
export function dupH1Issues(pages, cluster = (u) => u) {
  const live = pages.filter((p) => p.status === 200 && p.indexable && p.h1 && norm(p.h1).length >= 3 && !PAGED.test(p.url) && !p.data?.variantOf);
  const titles = new Map();
  for (const p of live) if (p.title) titles.set(p.title, (titles.get(p.title) || 0) + 1);
  const by = new Map();
  for (const p of live) by.set(norm(p.h1), [...(by.get(norm(p.h1)) || []), p]);
  const out = [];
  for (const ps of by.values()) {
    const keep = ps.filter((p) => !(titles.get(p.title) > 1));
    if (keep.length < 2 || new Set(keep.map((p) => cluster(p.url))).size < 2) continue;
    for (const p of keep) out.push(["dup_h1", p.url, `"${p.h1.slice(0, 80)}" is the H1 of ${keep.length} pages, e.g. ${keep.find((x) => x !== p).url}`]);
  }
  return out;
}
