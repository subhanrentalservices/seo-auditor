// Keyword fit (owner videos 2026-11-11, "How to Never Fail in SEO" and "Instant Google Ranking Process"): two checks.
//
// 1. placement(keyword, page): where a page uses its target keyword. The videos' on-page list is title, meta
//    description, H1, an H2, the first paragraph and an image alt text, plus internal links, an external link, a
//    video and schema. Google reads the whole page and needs none of these slots; they are a quick way to see whether
//    a page says what it is about. A keyword counts in a slot when every core word of it is there (any order, stemmed).
//
// 2. untappedTest(keyword, results, opts): the videos' "untapped keyword" SERP test on the top results:
//      a. allintitle count under a limit (50 in one video, 300 in the other; Google's counts are rough estimates),
//      b. a weak result in the top 5: a forum, social site or directory (serpfeatures DIRECTORY_SITES), or a site
//         whose authority score the caller supplies under opts.authority (0-100) is under 30,
//      c. an irrelevant result in the top 5: its title has half or fewer of the keyword's core words (an RWC page for
//         "logbook service narre warren" shares only the suburb),
//      d. a young site in the top results (only when the caller supplies first-seen years; never guessed).
//    The verdict is "untapped" when at least two signals hold and the allintitle count (if known) is under the limit,
//    "contested" otherwise. A signal without data is "unknown", never a pass. These are heuristics from the videos,
//    not Google measures: they say where competition looks thin, not that a page will rank.
import { words } from "./page2.mjs";
import { siteName, DIRECTORY_SITES } from "./serpfeatures.mjs";

const has = (keyword, text) => {
  const need = [...new Set(words(keyword))];
  if (!need.length || !text) return false;
  const got = new Set(words(text));
  return need.every((w) => got.has(w));
};

/** Where the target keyword appears on a crawled page ({ title, description, h1, data }). */
export function placement(keyword, page) {
  const d = page.data || {};
  const slots = {
    title: has(keyword, page.title),
    metaDescription: has(keyword, page.description),
    h1: has(keyword, page.h1),
    h2: (d.h2s || []).some((h) => has(keyword, h)),
    firstParagraph: d.firstPara === undefined ? null : has(keyword, d.firstPara),
    imageAlt: d.imgAlts === undefined ? null : (d.imgAlts || []).some((a) => has(keyword, a)),
  };
  const extras = {
    internalLinksIn: page.inlinks ?? null,
    externalLinks: d.externalLinks ?? null,
    video: d.videoUrls === undefined && d.videoObjects === undefined ? null : Boolean((d.videoUrls || []).length || d.videoObjects),
    schema: (d.schemaTypes || []).length > 0,
  };
  const known = Object.values(slots).filter((v) => v !== null);
  return { keyword, slots, extras, score: known.length ? Math.round(known.filter(Boolean).length / known.length * 100) : null,
    missing: Object.entries(slots).filter(([, v]) => v === false).map(([k]) => k) };
}

const FORUM_SOCIAL = new Set(["reddit", "quora", "facebook", "instagram", "linkedin", "tiktok", "pinterest", "x", "twitter", "youtube", "whirlpool", "productreview"]);

/** results: top results in rank order, [{ url, title }]. opts: { allintitle, limit = 50, authority: {site: 0-100},
 *  firstSeen: {site: year}, year }. */
export function untappedTest(keyword, results, opts = {}) {
  const limit = opts.limit ?? 50;
  const top5 = (results || []).slice(0, 5);
  const core = [...new Set(words(keyword))];
  const kind = (r) => {
    const s = siteName(r.url);
    if (FORUM_SOCIAL.has(s)) return "forum/social";
    if (DIRECTORY_SITES.includes(s)) return "directory";
    const a = opts.authority?.[s];
    return a !== undefined && a < 30 ? "low authority" : null;
  };
  const weak = top5.map((r, i) => ({ rank: i + 1, url: r.url, why: kind(r) })).filter((x) => x.why);
  const irrelevant = top5.map((r, i) => {
    const t = new Set(words(r.title || ""));
    const share = core.length ? core.filter((w) => t.has(w)).length / core.length : 1;
    return { rank: i + 1, url: r.url, title: r.title, share };
  }).filter((x) => x.share <= 0.5);
  const year = opts.year ?? new Date().getFullYear();
  const young = opts.firstSeen ? (results || []).slice(0, 10).filter((r) => opts.firstSeen[siteName(r.url)] >= year - 1).map((r) => r.url) : null;
  const signals = {
    allintitle: opts.allintitle == null ? "unknown" : opts.allintitle < limit ? "pass" : "fail",
    weakInTop5: weak.length ? "pass" : "fail",
    irrelevantInTop5: irrelevant.length ? "pass" : "fail",
    youngSite: young === null ? "unknown" : young.length ? "pass" : "fail",
  };
  const passes = Object.values(signals).filter((v) => v === "pass").length;
  const verdict = signals.allintitle !== "fail" && passes >= 2 ? "untapped" : "contested";
  return { keyword, verdict, signals, limit, allintitle: opts.allintitle ?? null, weak, irrelevant, young };
}

/** Top results from a saved SERP file: an array of {url,title}, a DataForSEO task result or an OpenSEO result. */
export function resultsFromJson(j) {
  const items = Array.isArray(j) ? j : j?.tasks?.[0]?.result?.[0]?.items || j?.items || j?.results || j?.organic || [];
  return items.filter((x) => x && (x.url || x.link) && (!x.type || x.type === "organic"))
    .map((x) => ({ url: x.url || x.link, title: x.title || "" }));
}
