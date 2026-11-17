// Conversion path (taught across the Ahrefs and Brian Dean videos: every page should lead somewhere, and articles
// should pass readers and link value to the pages that make money). Two site checks, any kind of site:
//  - no_conversion_path: an indexable page with no phone or email link, no form (other than site search) and no
//    call-to-action button or link.
//  - article_no_money_link: an article that never links, from its own text, to a non-article page
//    (service, product, pricing, feature, category...).
//  - article_no_first_hand: an article of 300+ words with no line from the business's own work.

// Pages that are meant to have no call to action.
export const UTILITY = /\/(privacy|terms|legal|cookie|disclaimer|accessibility|sitemap|404|thank|thanks|login|logout|signin|unsubscribe)([-_./]|$)/i;
const ARTICLE_PATH = /\/(blog|news|articles?|guides?|resources|learn|insights|posts?|stories|tips|academy)\//i;
const ARTICLE_TYPES = /^(BlogPosting|Article|NewsArticle|TechArticle|Report)$/;

// First-hand experience lines (Google's helpful-content questions: "Does the content clearly demonstrate first-hand
// expertise ... e.g. from having actually used a product or service, or visiting a place?"; a Nov 2026 core-update
// video: "AI content in bulk without originality and useful information" can affect site quality). Counts sentences
// where the author or business speaks from its own work, in any industry: "we often see", "in our clinic", "I tested".
const FIRST_HAND = /\b(?:in|at) our (?:workshop|clinic|shop|store|kitchen|office|studio|lab|warehouse|practice|garage|salon|restaurant|booth|yard|experience|tests?)\b|\bwe(?:'ve| have)? (?:often |usually |regularly |recently |always |also )?(?:see|saw|seen|tested|test|tried|found|find|noticed|measured|fixed|repaired|helped|handled|recommend|tell|ask|check|checked)\b|\bwhen we\b|\bour (?:mechanics|technicians|engineers|editors|testers|staff)\b|\b(?:a|one|many|most) (?:of our )?(?:customers?|clients?|patients?) (?:told|tell|ask|asked|come|came|bring|brought)\b|\bI(?:'ve| have)? (?:tested|tried|used|found|seen|noticed|measured)\b/gi;
export const firstHandCount = (text) => (String(text || "").match(FIRST_HAND) || []).length;

export const isArticle = (p) => ARTICLE_PATH.test(new URL(p.url).pathname + "/") && !/\/(blog|news|articles?|guides?|resources|learn|insights|posts?)\/?$/i.test(new URL(p.url).pathname)
  || (p.data?.schemaTypes || []).some((t) => ARTICLE_TYPES.test(t));

/** A URL's role on the site: "utility", "home", "article" or "money" (service, product, pricing, category...).
 *  A link target is judged by its URL (and its page when crawled), so a money page that failed to load in this
 *  crawl still counts as one. Also used by linkgraph.mjs. */
export function pageRoles(pages, start) {
  const home = new URL(start).pathname, byUrl = new Map(pages.map((p) => [p.url, p]));
  return (u) => {
    let path; try { path = new URL(u).pathname; } catch { return "other"; }
    if (UTILITY.test(path)) return "utility";
    if (path === home) return "home";
    const p = byUrl.get(u) || { url: u, data: {} };
    if (isArticle(p) || /\/(blog|news|articles?|guides?|resources|learn|insights|posts?)\/?$/i.test(path)) return "article";
    return "money";
  };
}

/** pages: crawled pages ({url, status, indexable, content_type, data}); contentLinks: Map from_url → [to_url] of
 *  internal links placed in the page's own text. Returns [[checkId, url, detail], ...]. */
export function conversionIssues(pages, contentLinks, start) {
  const out = [];
  const live = pages.filter((p) => p.status === 200 && p.indexable && (p.content_type || "").includes("html") && !p.data?.variantOf);
  const kindOf = pageRoles(pages, start);
  for (const p of live) {
    const d = p.data || {}, k = kindOf(p.url);
    if (k === "utility" || (d.childLinks || 0) >= 5) continue; // legal pages and listing pages
    if (!d.convTel && !d.convMail && !d.convForm && !d.convCta)
      out.push(["no_conversion_path", p.url, "no phone or email link, form or call-to-action button"]);
    if (k === "article" && !(contentLinks.get(p.url) || []).some((to) => kindOf(to) === "money"))
      out.push(["article_no_money_link", p.url, `${(contentLinks.get(p.url) || []).length} links in the text, none to a service, product or pricing page`]);
    if (k === "article" && d.firstHand === 0 && (p.words || 0) >= 300)
      out.push(["article_no_first_hand", p.url, `${p.words} words, no line from the business's own work ("we often see", "in our workshop", "I tested")`]);
  }
  return out;
}
