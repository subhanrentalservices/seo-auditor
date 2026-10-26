// Conversion path (taught across the Ahrefs and Brian Dean videos: every page should lead somewhere, and articles
// should pass readers and link value to the pages that make money). Two site checks, any kind of site:
//  - no_conversion_path: an indexable page with no phone or email link, no form (other than site search) and no
//    call-to-action button or link.
//  - article_no_money_link: an article that never links, from its own text, to a non-article page
//    (service, product, pricing, feature, category...).

// Pages that are meant to have no call to action.
export const UTILITY = /\/(privacy|terms|legal|cookie|disclaimer|accessibility|sitemap|404|thank|thanks|login|logout|signin|unsubscribe)([-_./]|$)/i;
const ARTICLE_PATH = /\/(blog|news|articles?|guides?|resources|learn|insights|posts?|stories|tips|academy)\//i;
const ARTICLE_TYPES = /^(BlogPosting|Article|NewsArticle|TechArticle|Report)$/;

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
  }
  return out;
}
