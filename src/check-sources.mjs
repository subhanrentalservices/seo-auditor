// Every check the audit can raise, with its severity, why it matters and where Google documents the topic (REQ-055
// group 9). Feeds the in-app "All checks" list (GET /api/checks) and the counts in README.md
// (scripts/readme-numbers.mjs), so the numbers there come from the code. A Google page is given only where one
// covers the topic; tool heuristics, security headers and accessibility checks say so instead of borrowing one.
import { CHECKS, CRAWL } from "./checks.mjs";
import { AI_CHECKS } from "./ai-checks.mjs"; // also adds the AI checks to CHECKS

const G = "https://developers.google.com/search/docs/";
const DOCS = {
  titles: ["Title links", "appearance/title-link"],
  snippets: ["Snippets and meta descriptions", "appearance/snippet"],
  duplicates: ["Canonical URLs and duplicate content", "crawling-indexing/consolidate-duplicate-urls"],
  redirects: ["Redirects and Google Search", "crawling-indexing/301-redirects"],
  http: ["HTTP status codes and network errors", "https://developers.google.com/crawling/docs/troubleshooting/http-status-codes"],
  robots: ["robots.txt introduction", "crawling-indexing/robots/intro"],
  robotsSpec: ["How Google interprets robots.txt", "https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec"],
  robotsMeta: ["Robots meta tag and X-Robots-Tag", "crawling-indexing/robots-meta-tag"],
  noindex: ["Block indexing with noindex", "crawling-indexing/block-indexing"],
  sitemaps: ["Sitemaps overview", "crawling-indexing/sitemaps/overview"],
  links: ["Crawlable links and anchor text", "crawling-indexing/links-crawlable"],
  urls: ["URL structure", "crawling-indexing/url-structure"],
  images: ["Image SEO best practices", "appearance/google-images"],
  structured: ["Structured data introduction", "appearance/structured-data/intro-structured-data"],
  siteNames: ["Site names in Google Search", "appearance/site-names"],
  favicon: ["Favicons in Google Search", "appearance/favicon-in-search"],
  video: ["Video SEO best practices", "appearance/video"],
  hreflang: ["Localized versions of your pages (hreflang)", "specialty/international/localized-versions"],
  multiRegional: ["Managing multi-regional and multilingual sites", "specialty/international/managing-multi-regional-sites"],
  mobile: ["Mobile-first indexing best practices", "crawling-indexing/mobile/mobile-sites-mobile-first-indexing"],
  javascript: ["JavaScript SEO basics", "crawling-indexing/javascript/javascript-seo-basics"],
  googlebot: ["Googlebot (file size limits)", "crawling-indexing/googlebot"],
  cwv: ["Core Web Vitals", "appearance/core-web-vitals"],
  experience: ["Page experience (HTTPS)", "appearance/page-experience"],
  spam: ["Spam policies", "essentials/spam-policies"],
  fileTypes: ["File types Google can index", "crawling-indexing/indexable-file-types"],
  ai: ["AI features and your website", "appearance/ai-features"],
};

// First match wins. Ids are matched whole (^…$) unless the pattern ends with an open prefix.
const RULES = [
  [/^(missing_title|dup_title|title_\w+|dup_title_h1)$/, "titles"],
  [/^(missing_description|dup_description|desc_length)$/, "snippets"],
  [/^(redirect_chain|temporary_redirect|permanent_redirect|meta_refresh|js_redirect|redirect_to_home|links_to_redirect|host_variant_redirect)$/, "redirects"],
  [/^(dup_content|near_duplicate|canonical_\w+|missing_canonical|url_variant_200|links_to_canonicalized|sitemap_non_canonical|internal_link_tracking_params)$/, "duplicates"],
  [/^(http_4xx|http_5xx|soft_404|soft_404_content|sitemap_fetch_error)$/, "http"],
  [/^(robots_txt_syntax|robots_group_override|robots_other_bot|robots_txt_large|robots_txt_error)$/, "robotsSpec"],
  [/^(no_robots_txt|blocked_by_robots|robots_\w+|sitemap_blocked|images_blocked_by_robots)$/, "robots"],
  [/^(nofollow_page|unavailable_after_\w+|ai_snippet_blocked)$/, "robotsMeta"],
  [/^(noindex_page|staging_host_exposed|login_page_indexable)$/, "noindex"],
  [/^(no_sitemap|sitemap_\w+|not_in_sitemap|noindex_in_sitemap)$/, "sitemaps"],
  [/^(broken_internal_link|uncrawlable_links|generic_anchor_text|empty_anchor|nofollow_internal|single_inlink|deep_page|many_links|affiliate_link_unqualified|ugc_link_unqualified|external_nofollow_all)$/, "links"],
  [/^(url_too_long|email_in_url|param_trap|crawl_trap_links)$/, "urls"],
  [/^(broken_internal_image|img_\w+|lcp_image_lazy)$/, "images"],
  [/^(site_name_markup)$/, "siteNames"],
  [/^(invalid_jsonld|missing_jsonld|schema_\w+|merchant_policy_missing|local_nap_missing)$/, "structured"],
  [/^(favicon_issue)$/, "favicon"],
  [/^(video_\w+)$/, "video"],
  [/^(hreflang_\w+|locale_redirect)$/, "hreflang"],
  [/^(missing_lang)$/, "multiRegional"],
  [/^(missing_viewport|mobile_desktop_parity)$/, "mobile"],
  [/^(raw_vs_rendered|render_\w+|js_only_routes|ai_js_dependent)$/, "javascript"],
  [/^(large_html)$/, "googlebot"],
  [/^(cwv_\w+)$/, "cwv"],
  [/^(mixed_content|http_page)$/, "experience"],
  [/^(keyword_stuffing|hacked_spam_signals)$/, "spam"],
  [/^(pdf_unreadable)$/, "fileTypes"],
  [/^(no_llms_txt)$/, "ai"],
];

/** Where the topic is documented: { label, url } for a Google page, or { label, url: null } saying what kind of check it is. */
export function sourceOf(id) {
  for (const [re, key] of RULES) if (re.test(id)) { const [label, rel] = DOCS[key]; return { label: `Google: ${label}`, url: rel.startsWith("https://") ? rel : G + rel }; }
  if (id.startsWith("sec_")) return { label: "Security header: information, not a Google ranking factor", url: null };
  if (id.startsWith("a11y_")) return { label: "Accessibility (WCAG): information, not a Google ranking factor", url: null };
  if (id in AI_CHECKS) return { label: "AI answers: tool heuristic, no Google document", url: null };
  return { label: "Tool heuristic or best practice: no single Google document", url: null };
}

const GROUP = (id) => (id.startsWith("ai_") ? "ai" : CRAWL.has(id) ? "crawl" : id.startsWith("sec_") ? "security" : id.startsWith("a11y_") ? "accessibility" : id.startsWith("cwv_") ? "performance" : "seo");

/** Every check: id, severity, title, why, fix, group, source. */
export const checkCatalog = () => Object.entries(CHECKS).map(([id, [severity, title, why, fix]]) => ({ id, severity, title, why, fix, group: GROUP(id), source: sourceOf(id) }));

/** Totals for README.md and the All checks screen. */
export function checkCounts(list = checkCatalog()) {
  const by = (f) => list.reduce((o, c) => { const k = f(c); o[k] = (o[k] || 0) + 1; return o; }, {});
  return { total: list.length, severity: { error: 0, warning: 0, notice: 0, ...by((c) => c.severity) }, groups: by((c) => c.group),
    ai: list.filter((c) => c.group === "ai").length, withGoogleSource: list.filter((c) => c.source.url).length };
}
