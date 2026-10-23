// Issue catalog (Semrush-style errors / warnings / notices) and the rules that raise them.
// Page rules run per crawled page; site rules run once the crawl is complete.

export const CHECKS = {
  // ---------------- Errors ----------------
  http_4xx: ["error", "4XX status code", "Visitors and crawlers hit a dead end; link equity pointing here is wasted.", "Restore the page, or 301-redirect it to the closest live page and update internal links."],
  http_5xx: ["error", "5XX server error", "The server failed to return the page; repeated errors can drop pages from the index.", "Check server logs and hosting limits; fix the failing script or resource."],
  broken_internal_link: ["error", "Broken internal links", "Links to pages that return 4XX/5XX hurt UX and waste crawl budget.", "Update or remove the link, or redirect the target."],
  broken_internal_image: ["error", "Broken internal images", "Missing images look broken and lose image-search traffic.", "Fix the image path or upload the missing file."],
  missing_title: ["error", "Missing title tag", "The title is the main signal for what a page is about and the headline in search results.", "Add a unique, descriptive <title> (about 50–60 characters)."],
  dup_title: ["error", "Duplicate title tags", "Search engines can't tell which page to rank; results look identical.", "Give every indexable page a unique title."],
  dup_description: ["error", "Duplicate meta descriptions", "Identical snippets reduce click-through and signal duplicate pages.", "Write a unique description per page."],
  dup_content: ["error", "Duplicate content", "Pages with the same main text compete with each other.", "Merge the pages, make them distinct, or set a canonical."],
  redirect_chain: ["error", "Redirect chains and loops", "Each hop slows the page and loops make it unreachable.", "Redirect straight to the final URL and update links to point at it."],
  canonical_broken: ["error", "Canonical points to a broken or redirected URL", "The preferred version can't be indexed.", "Point the canonical at a live 200 page (usually the page itself)."],
  canonical_multiple: ["error", "Multiple canonical tags", "Conflicting canonicals may be ignored altogether.", "Keep exactly one rel=canonical."],
  invalid_jsonld: ["error", "Invalid structured data (JSON-LD)", "Unparseable markup is ignored, so rich results are lost.", "Fix the JSON syntax (validate with Google's Rich Results Test)."],
  mixed_content: ["error", "Mixed content (HTTP resources on HTTPS)", "Browsers block or warn about insecure resources.", "Load every script, style and image over HTTPS."],
  sitemap_bad_url: ["error", "Sitemap contains non-200 or non-indexable URLs", "Sitemaps should list only pages you want indexed.", "Remove redirected, broken or noindex URLs from the sitemap."],
  http_page: ["error", "Page served over HTTP", "Insecure pages lose trust signals and show 'Not secure'.", "Serve the site over HTTPS and 301-redirect HTTP."],
  very_slow: ["error", "Very slow server response (over 5 s)", "Users leave and crawlers fetch fewer pages.", "Check hosting, caching and heavy server-side code."],

  // ---------------- Warnings ----------------
  missing_description: ["warning", "Missing meta description", "Search engines write their own snippet, often a poor one.", "Add a 120–160 character description that sells the click."],
  title_too_long: ["warning", "Title too long (over 65 characters)", "The end of the title is cut off in results.", "Shorten it and put the main keyword first."],
  title_too_short: ["warning", "Title too short (under 20 characters)", "A short title misses useful keywords and context.", "Expand it to describe the page."],
  desc_length: ["warning", "Meta description too short or too long", "Very short snippets say little; long ones get truncated.", "Aim for about 120–160 characters."],
  missing_h1: ["warning", "Missing H1 heading", "The H1 tells users and crawlers the page topic.", "Add one descriptive H1."],
  multiple_h1: ["warning", "Multiple H1 headings", "Several H1s blur the main topic.", "Use one H1 and H2/H3 for sections."],
  low_word_count: ["warning", "Low word count (under 200 words)", "Thin pages rarely rank or get cited.", "Add useful, original content or merge the page."],
  low_text_ratio: ["notice", "Low text-to-HTML ratio (under 10%)", "Mostly code and little visible text can mean thin or bloated pages.", "Add content or remove unnecessary markup."],
  img_missing_alt: ["warning", "Images without alt text", "Alt text helps accessibility and image search.", "Describe each meaningful image in its alt attribute."],
  temporary_redirect: ["warning", "Temporary redirects (302/307)", "Temporary redirects may not pass signals to the target.", "Use 301 for permanent moves."],
  sitemap_not_in_robots: ["notice", "Sitemap not declared in robots.txt", "Declaring it helps every search and AI crawler find the sitemap.", "Add a line: Sitemap: https://your-site/sitemap.xml"],
  external_link_blocked: ["notice", "External link refused the checker (401/403/429)", "The site blocks automated checks; the link usually works in a browser.", "Open the link manually to confirm it still works."],
  broken_external_link: ["warning", "Broken external links", "Dead outbound links look neglected.", "Update or remove the link."],
  slow_page: ["warning", "Slow server response (over 1.5 s)", "Slow pages hurt users and Core Web Vitals.", "Enable caching/compression and reduce server work."],
  large_html: ["warning", "Large HTML (over 2 MB)", "Heavy pages load slowly on mobile.", "Trim inline code, images or data from the HTML."],
  missing_viewport: ["warning", "Missing viewport meta tag", "Without it, mobile browsers render a desktop layout.", "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."],
  noindex_in_sitemap: ["warning", "Noindex page listed in sitemap", "Conflicting signals: the sitemap asks to index a noindex page.", "Remove it from the sitemap or allow indexing."],
  sitemap_orphan: ["notice", "Orphan pages (in sitemap, no internal links)", "Pages with no internal links are hard to discover and rank.", "Link to them from related pages and navigation."],
  missing_lang: ["warning", "Missing lang attribute", "The page language helps search engines and screen readers.", "Add <html lang=\"en\"> (or the right language)."],
  hreflang_issue: ["warning", "Hreflang issues", "Wrong hreflang can show the wrong language version.", "Use valid language codes and absolute URLs, include a self-reference."],

  // ---------------- Notices ----------------
  noindex_page: ["notice", "Pages blocked from indexing (noindex)", "These pages won't appear in search. Fine if intended.", "Remove noindex from pages you want found."],
  blocked_by_robots: ["notice", "Pages blocked by robots.txt", "Crawlers can't fetch these URLs.", "Allow them in robots.txt if they should rank."],
  permanent_redirect: ["notice", "Permanent redirects (301/308)", "Fine on their own, but internal links should point to the final URL.", "Update internal links to the destination."],
  deep_page: ["notice", "Pages more than 3 clicks from the homepage", "Deep pages get crawled less and look less important.", "Link to them from higher-level pages."],
  single_inlink: ["notice", "Pages with only one incoming internal link", "Weakly linked pages are easy to miss.", "Add contextual links from related pages."],
  nofollow_internal: ["notice", "Nofollow on internal links", "You're telling crawlers not to follow your own pages.", "Remove rel=nofollow from internal links."],
  missing_canonical: ["notice", "No canonical tag", "A self-referencing canonical guards against duplicate URLs (parameters, tracking tags).", "Add <link rel=\"canonical\"> pointing to the page itself."],
  canonical_elsewhere: ["notice", "Canonical points to another page", "This page asks not to be indexed in its own right. Fine if intended.", "Check that the canonical target is the right version."],
  url_too_long: ["notice", "URL too long (over 115 characters)", "Long URLs are harder to share and may be truncated.", "Use shorter, readable URLs."],
  not_in_sitemap: ["notice", "Indexable pages missing from the sitemap", "Sitemaps help discovery of every page you want indexed.", "Add them to the XML sitemap."],
  missing_og: ["notice", "Missing Open Graph tags", "Shared links show a poor preview on social media and chat apps.", "Add og:title, og:description and og:image."],
  missing_jsonld: ["notice", "No structured data", "Structured data can earn rich results and helps AI systems understand the page.", "Add relevant schema.org JSON-LD (Organization, LocalBusiness, Article, FAQ…)."],
  dup_title_h1: ["notice", "Title and H1 are identical", "A missed chance to target a second phrasing.", "Vary the H1 and title slightly."],
  many_links: ["notice", "Too many on-page links (over 300)", "Link equity is spread thin and the page is hard to use.", "Trim navigation and repeated links."],
  external_nofollow_all: ["notice", "All external links are nofollow", "Normal editorial links don't need nofollow.", "Use nofollow only for paid/untrusted links (sponsored/ugc)."],
  no_robots_txt: ["notice", "robots.txt not found", "Crawlers expect /robots.txt; it is also where you point to your sitemap.", "Add a robots.txt with a Sitemap: line."],
  no_sitemap: ["notice", "No XML sitemap found", "Sitemaps speed up discovery of new and deep pages.", "Create /sitemap.xml and reference it in robots.txt."],
  no_llms_txt: ["notice", "No llms.txt", "Optional: some AI tools read /llms.txt. Google says Google Search doesn't use it (AI optimisation guide).", "Only if you want: a short, accurate llms.txt summarising key pages. Not a ranking or citation lever."],
  schema_faq_hidden: ["notice", "FAQ markup for questions not shown on the page", "Google's structured data policies require markup to describe visible content; hidden FAQ markup can lose rich results or earn a manual action.", "Show every marked-up question and answer on the page, or remove them from the FAQPage markup."],
  schema_breadcrumb_hidden: ["notice", "Breadcrumb markup without a visible breadcrumb trail", "Markup should describe content readers can see.", "Add a visible Home › … trail matching the BreadcrumbList, or drop the markup."],
  schema_self_review: ["notice", "Rating or review markup on the business's own entity", "Google ignores self-serving review markup for LocalBusiness and Organization on their own site and may treat it as spam.", "Remove aggregateRating/review from your own business markup; show real reviews as plain content instead."],
  near_duplicate: ["notice", "Near-duplicate page (shares most of its text with another page)", "Pages that differ only by a swapped place or keyword match Google's doorway and scaled-content spam patterns, and near-duplicates get clustered so only one is shown.", "Give each page facts that are only true for it, or merge the pages. Compare with: node src/cli.mjs similar <project>."],
  sitemap_lastmod_uniform: ["notice", "Most sitemap URLs share one lastmod date", "Google and Bing use lastmod only when it is consistently accurate; a bulk date looks like a site-wide reset.", "Set each URL's lastmod to the date its content last really changed."],
};

export const SEVERITY = (id) => CHECKS[id][0];

const W = (p) => p.data || {};

/** Rules that need only the page itself. Returns [[checkId, detail], ...]. */
export function pageIssues(p, ctx) {
  const out = [];
  const d = W(p);
  const add = (id, detail = "") => out.push([id, detail]);
  const isHtml = (p.content_type || "").includes("html");
  if (p.status >= 500) add("http_5xx", `HTTP ${p.status}`);
  else if (p.status >= 400) add("http_4xx", `HTTP ${p.status}`);
  if (d.redirect) {
    if (d.redirect.hops > 1 || d.redirect.loop) add("redirect_chain", d.redirect.loop ? "redirect loop" : `${d.redirect.hops} hops → ${d.redirect.to}`);
    if ([302, 303, 307].includes(d.redirect.firstStatus)) add("temporary_redirect", `${d.redirect.firstStatus} → ${d.redirect.to}`);
    else add("permanent_redirect", `${d.redirect.firstStatus} → ${d.redirect.to}`);
  }
  if (p.url.startsWith("http://") && ctx.siteIsHttps) add("http_page");
  if (p.response_ms > 5000) add("very_slow", `${p.response_ms} ms`);
  else if (p.response_ms > 1500) add("slow_page", `${p.response_ms} ms`);
  if (d.blockedByRobots) add("blocked_by_robots");
  if (p.url.length > 115) add("url_too_long", `${p.url.length} chars`);
  // A ?query variant whose canonical is its own clean URL is set up correctly; its content is checked on that URL.
  if (d.variantOf) return out;
  if (p.status !== 200 || !isHtml) return out;

  if (p.bytes > 2 * 1024 * 1024) add("large_html", `${Math.round(p.bytes / 1024)} KB`);
  if (!p.indexable && d.noindex) add("noindex_page", d.noindexSource || "");
  if (!p.title) add("missing_title");
  else if (p.title.length > 65) add("title_too_long", `${p.title.length} chars`);
  else if (p.title.length < 20) add("title_too_short", `${p.title.length} chars`);
  if (!p.description) add("missing_description");
  else if (p.description.length < 70 || p.description.length > 170) add("desc_length", `${p.description.length} chars`);
  if (!d.h1Count) add("missing_h1");
  else if (d.h1Count > 1) add("multiple_h1", `${d.h1Count} H1s`);
  if (p.title && p.h1 && p.title.trim().toLowerCase() === p.h1.trim().toLowerCase()) add("dup_title_h1");
  if (p.words < 200 && p.indexable) add("low_word_count", `${p.words} words`);
  if (p.text_ratio < 10 && p.indexable && !(d.formShare >= 0.4)) add("low_text_ratio", `${p.text_ratio}%`);
  if (d.imgNoAlt) add("img_missing_alt", `${d.imgNoAlt} image(s)`);
  if (!d.viewport) add("missing_viewport");
  if (!d.lang) add("missing_lang");
  if (d.canonicals > 1) add("canonical_multiple", `${d.canonicals} tags`);
  if (!d.canonicals && p.indexable) add("missing_canonical");
  if (p.canonical && p.canonical !== p.url && p.canonical !== p.final_url) add("canonical_elsewhere", p.canonical);
  if (d.jsonldInvalid) add("invalid_jsonld", `${d.jsonldInvalid} block(s)`);
  if (d.faqHidden) add("schema_faq_hidden", d.faqHidden);
  if (d.crumbHidden) add("schema_breadcrumb_hidden");
  if (d.selfReview) add("schema_self_review");
  if (!d.jsonld && !d.microdata && p.indexable) add("missing_jsonld");
  if (!d.og && p.indexable) add("missing_og");
  if (d.mixed) add("mixed_content", `${d.mixed} resource(s), e.g. ${d.mixedExample}`);
  if (d.hreflangBad) add("hreflang_issue", d.hreflangBad);
  if (p.outlinks > 300) add("many_links", `${p.outlinks} links`);
  if (d.nofollowInternal) add("nofollow_internal", `${d.nofollowInternal} link(s)`);
  if (d.externalLinks > 2 && d.externalLinks === d.externalNofollow) add("external_nofollow_all");
  if (p.depth > 3) add("deep_page", `depth ${p.depth}`);
  if (p.indexable && ctx.sitemapLoaded && !p.in_sitemap) add("not_in_sitemap");
  if (!p.indexable && p.in_sitemap) add("noindex_in_sitemap");
  return out;
}

/** Health score: share of crawled pages free of errors, warnings counting half (documented in the UI). */
export function healthScore(pageCount, pagesWithErrors, pagesWithWarningsOnly) {
  if (!pageCount) return 0;
  return Math.max(0, Math.round(100 * (1 - (pagesWithErrors + 0.5 * pagesWithWarningsOnly) / pageCount)));
}
