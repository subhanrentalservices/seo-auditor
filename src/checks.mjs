// Issue catalog (Semrush-style errors / warnings / notices) and the rules that raise them.
// Page rules run per crawled page; site rules run once the crawl is complete.
import { isArticle } from "./conversion.mjs";

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
  large_html: ["warning", "Large HTML (over 2 MB uncompressed)", "When crawling for Google Search, Googlebot reads only the first 2 MB of an HTML file (64 MB for a PDF) and ignores the rest, so text, links and structured data past that point aren't indexed (Googlebot docs, file size limits clarified 3 Feb 2026). The limit is on the uncompressed HTML; images, CSS and JS files are fetched separately. Heavy pages also load slowly on mobile.", "Bring the HTML under 2 MB: move inline scripts, styles, SVG sprites, base64 images and embedded JSON data into separate files, and paginate very long lists. Keep the main content, canonical and structured data near the top."],
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
  missing_jsonld: ["notice", "No structured data", "Structured data helps Google understand the page and is required for rich results (only some types still earn one: see Google's search gallery). It is not a ranking factor on its own.", "Add JSON-LD in the server HTML for what the page really is: Organization or LocalBusiness on the home page, Article/BlogPosting, Product, BreadcrumbList, VideoObject. FAQ and HowTo no longer earn rich results (FAQ stopped 7 May 2026, HowTo 2023)."],
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
  no_conversion_path: ["notice", "No way to act on the page", "Visitors who are ready can't take the next step here: no phone or email link, form or call-to-action button.", "Add the action that fits the page: a phone link, a short form, or a button to book, buy, sign up or get a quote."],
  article_no_money_link: ["notice", "Article doesn't link to a money page", "Articles earn most of a site's links and readers; with no link from the text to a service, product or pricing page, neither reaches the pages that convert.", "Add a link in the text to the page that solves the reader's problem (service, product, feature or pricing), with a descriptive anchor."],
  sitemap_lastmod_uniform: ["notice", "Most sitemap URLs share one lastmod date", "Google and Bing use lastmod only when it is consistently accurate; a bulk date looks like a site-wide reset.", "Set each URL's lastmod to the date its content last really changed."],

  // ---------------- Content age, structure and video ----------------
  content_stale: ["notice", "Article not updated in over 12 months", "The newest date this article states is more than a year before the audit. Facts, prices, laws and screenshots go out of date, and readers and AI answers prefer current information. Age alone is not a ranking penalty.", "Review the article: correct what changed, add what's new, then update the visible date and dateModified. Don't change the date without changing the content."],
  title_past_year: ["notice", "Title or H1 mentions a past year", "A past year in the headline (\"… 2024\") makes the page look out of date in search results and lowers clicks.", "If the content is current, update the year or remove it; if the page is about that year on purpose (history, a past event), ignore this notice."],
  heading_skip: ["notice", "Heading levels skipped", "Headings are the page's outline for screen readers and crawlers; jumping from H2 to H4 leaves a gap in it.", "Use the next level down for sub-sections (H2 → H3 → H4). Change the styling with CSS, not the heading level."],
  heading_before_h1: ["notice", "Headings before the H1", "The H1 should open the page's content; headings above it make the outline start with something else.", "Move the H1 above the other content headings, or turn the earlier ones into plain text if they are labels."],
  long_no_toc: ["notice", "Long page without jump links (table of contents)", "On a long page with many sections, links to each section help readers find their answer, and Google can show them as \"jump to\" links in results.", "Add a short contents list near the top linking to each H2 (give each H2 an id, link with href=\"#id\")."],
  long_paragraphs: ["notice", "Very long paragraphs (over 180 words)", "Walls of text are hard to read, especially on phones, and readers leave before reaching the answer.", "Split them into paragraphs of one idea each; use lists or sub-headings where they help."],
  video_no_schema: ["warning", "Video without VideoObject markup", "Google needs VideoObject structured data (or a clear video page) to show the video in video results and key moments.", "Add VideoObject JSON-LD for each main video with at least name, thumbnailUrl and uploadDate (also description, duration, embedUrl or contentUrl)."],
  video_schema_incomplete: ["warning", "VideoObject missing required fields", "Google requires name, thumbnailUrl and uploadDate; without them the video can't get video rich results.", "Fill in the missing fields with the video's real title, thumbnail image URL and upload date."],

  // ---------------- Crawlability (Google Search Central crawling docs) ----------------
  robots_txt_error: ["error", "robots.txt answers with a server error or not at all", "When robots.txt returns 5xx or times out, Google stops crawling the whole site until it can read it again.", "Make /robots.txt return 200 (or 404 if you have none) quickly and reliably."],
  robots_disallow_all: ["error", "robots.txt blocks Googlebot from the site", "Google can't fetch any page, so nothing new gets indexed and existing pages lose their snippets.", "Remove the Disallow: / rule for Googlebot (or *) unless the site really must stay out of Google."],
  robots_txt_large: ["warning", "robots.txt over 500 KiB", "Google ignores everything after the first 500 KiB of robots.txt.", "Shorten it: group rules with wildcards and remove obsolete lines."],
  robots_blocks_resources: ["warning", "robots.txt blocks CSS or JavaScript the page needs", "Google renders pages like a browser; blocked files can make it see a broken or empty page.", "Allow the site's CSS and JS files in robots.txt."],
  soft_404: ["error", "Missing pages answer 200 (soft 404)", "A page that doesn't exist should return 404/410. A 200 makes every mistyped or deleted URL look like a real, empty page, which wastes crawling and gets flagged as soft 404s.", "Return HTTP 404 (or 410 for removed pages) from the not-found page."],
  host_variant_tls: ["error", "Address variant shows a certificate error", "Visitors who type this version (often www) get a browser security warning, and Google can't follow its redirect.", "Get a certificate that covers this host name (e.g. reissue the SSL to include www), then confirm it 301s to the main address."],
  host_variant_missing: ["warning", "Address variant doesn't load", "People type www (or not) out of habit; if that version has no DNS record they get an error page.", "Add the DNS record (e.g. CNAME www → your domain) and 301 it to the main address."],
  host_variant_redirect: ["warning", "Address variant doesn't 301 to the main address", "http/https and www/non-www versions should all permanently redirect to one address so links and signals land on one site.", "Redirect every variant with a 301 straight to the main address."],
  uncrawlable_links: ["warning", "Links Google can't follow", "Google follows only <a> elements with an href URL; javascript: links and clickable elements without href hide the pages behind them.", "Use <a href=\"/page.html\"> for every link to a page."],
  meta_refresh: ["warning", "Meta refresh redirect", "Google treats meta refresh as a redirect but prefers server-side 301s; delays and loops confuse users.", "Replace it with a 301 redirect on the server."],
  nofollow_page: ["warning", "Page tells crawlers not to follow any of its links (meta nofollow)", "Google won't use this page's links to discover or credit the pages they point to.", "Remove nofollow from the robots meta tag unless that's intended."],
  sitemap_blocked: ["error", "Sitemap lists URLs blocked by robots.txt", "The sitemap asks Google to crawl pages robots.txt forbids, so they can't be indexed properly.", "Remove those URLs from the sitemap, or allow them in robots.txt."],
  links_to_redirect: ["notice", "Internal links point at redirecting URLs", "Every redirect is an extra fetch for crawlers and an extra hop for visitors.", "Point the links straight at the final URL."],
  param_trap: ["warning", "Many ?parameter copies of one page", "Crawlers spend their visits on endless variants of the same page instead of real pages.", "Link to the clean URL, give variants a canonical to it, or stop generating crawlable parameter links."],

  // ---------------- Google crawl checks (REQ-046, Google Search Central docs, Oct 2026) ----------------
  head_closed_early: ["warning", "Head closed early: canonical or hreflang ends up in the body", "In the raw HTML an element that isn't allowed in <head> (a div, img, iframe, span, stray text…) comes before the canonical or hreflang links. HTML parsers, Google's included, close the head at that element, so the tags after it land in the body. Google accepts rel=canonical and hreflang only inside a valid <head> (canonical and hreflang docs). A robots meta tag in the body is still honoured by Google (robots meta tag doc, Mar 2026).", "Move the canonical, hreflang and robots tags above the element named in the detail, or move that element into the <body> (often an injected <div>, an <img> or <iframe> tracking pixel, or a stray character). Check with View Source: DevTools shows the repaired DOM, not the source."],
  robots_txt_changed: ["notice", "robots.txt changed since the last audit", "robots.txt controls what every crawler may fetch; an unplanned edit (a CMS or plugin setting, a staging file copied live) can block pages without anyone noticing. Google usually caches robots.txt for up to 24 hours, so a change takes effect within about a day.", "Check that the change in the detail was intended. Search Console's robots.txt report shows the version Google last fetched."],
  robots_disallow_added: ["warning", "New robots.txt rule blocks pages that were indexable", "A Disallow rule added since the last audit stops Googlebot fetching pages that were indexable then, or the whole site. Google can't recrawl blocked pages: their URLs can still show in results but without a description, and updates to them aren't seen (robots.txt introduction).", "If the block wasn't intended, remove or narrow the rule. To keep a page out of Google, leave it crawlable and use noindex instead of Disallow."],
  favicon_issue: ["notice", "Home page favicon problem", "Google shows a site's favicon next to its results only when the home page declares one with <link rel=\"icon\"> (or shortcut icon / apple-touch-icon), Googlebot-Image may crawl the file, and the image is square, at least 8x8 px (over 48x48 recommended), in BMP, GIF, ICO, PNG, JPEG, PPM or TIFF (favicon guidelines). One favicon per host name.", "Add <link rel=\"icon\" href=\"/favicon.ico\"> (or a PNG) to the home page's <head>, serve it with HTTP 200, allow it in robots.txt, and use a square image of 48x48 px or larger (e.g. 96x96 or 192x192). Keep its URL stable."],
  back_button_hijack: ["warning", "Possible back-button hijacking script", "Since 13 April 2026 Google's spam policies (malicious practices) name back-button hijacking: scripts that insert or replace history entries so the back button doesn't return to the previous page. Enforcement began 15 June 2026 with manual actions or automated demotions. Google notes it often comes from an included library or ad platform.", "Open the script named in the detail and remove or disable code that calls history.pushState in a popstate handler, pushes entries in a loop, or redirects when the visitor presses back; for a third-party tag, remove it or ask the vendor. This is a heuristic: confirm by pressing back in a browser."],
  raw_vs_rendered: ["warning", "Raw HTML and rendered page disagree (canonical, robots or main text)", "Google reads the raw HTML first and renders JavaScript later. With noindex in the raw HTML Google may skip rendering, so JavaScript can't remove it; a canonical that JavaScript changes or removes conflicts with the original HTML (JavaScript SEO basics). Text that appears only after rendering is missed by crawlers that don't run JavaScript. Checked only when JavaScript rendering is on.", "Put the final canonical and robots meta in the server's HTML and don't change them with JavaScript; never ship noindex in the raw HTML of a page that should be indexed. Server-render or pre-render the main content."],
};

/** Checks shown under the Crawlability tab: can search engines reach and fetch the pages? */
export const CRAWL = new Set(["http_4xx", "http_5xx", "broken_internal_link", "redirect_chain", "temporary_redirect", "permanent_redirect", "very_slow", "http_page",
  "blocked_by_robots", "no_robots_txt", "no_sitemap", "sitemap_not_in_robots", "sitemap_bad_url", "noindex_in_sitemap", "sitemap_orphan", "not_in_sitemap", "deep_page",
  "single_inlink", "nofollow_internal", "url_too_long", "robots_txt_error", "robots_disallow_all", "robots_txt_large", "robots_blocks_resources", "soft_404",
  "host_variant_tls", "host_variant_missing", "host_variant_redirect", "uncrawlable_links", "meta_refresh", "nofollow_page", "sitemap_blocked", "links_to_redirect", "param_trap",
  "head_closed_early", "robots_txt_changed", "robots_disallow_added", "raw_vs_rendered"]);

export const SEVERITY = (id) => CHECKS[id][0];

const W = (p) => p.data || {};

// Headlines that are about a past year on purpose: history, archives, past events, "since/established/founded".
const ON_PURPOSE = /\b(history|historic(?:al)?|archives?|since|established|est\.|founded|anniversary|events?|recap|in review|annual report|timeline|then and now|copyright)\b|©/i;
const UNIT_AFTER = /^\s?(?:\+|%|km|kg|mm|cm|cc|ml|mg|mah|rpm|w|kw|hp|mb|gb|ft|sq|words|people|users|members|calories)\b|^[+%]/i;

/** First year from 2000 to currentYear-1 in a title or H1, or null. Not flagged: headlines about history, archives,
 *  events or "since/established/founded <year>"; ranges that reach the current year ("2025/26", "2021–present");
 *  numbers that are prices, quantities or units ("$2000", "2,019", "2000 km"); and years glued to a model code
 *  with a hyphen ("XR-2020"). Model years written as words ("2019 Corolla") can't be told apart and are flagged. */
export function pastYear(text, currentYear) {
  if (!text || ON_PURPOSE.test(text)) return null;
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = +m[1], before = text.slice(0, m.index), after = text.slice(m.index + 4);
    if (y >= currentYear || /[$€£¥#]\s*$|[\d.,]$|[a-z]-$/i.test(before) || UNIT_AFTER.test(after) || /^[.,]\d/.test(after)) continue;
    const range = after.match(/^\s*[-–—/]\s*(\d{4}|\d{2}|present|now|today)\b/i);
    if (range && (!/\d/.test(range[1]) || (range[1].length === 2 ? 2000 + +range[1] : +range[1]) >= currentYear)) continue;
    return y;
  }
  return null;
}

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

  if (p.bytes > 2 * 1024 * 1024) add("large_html", `${Math.ceil(p.bytes / 1024)} KB uncompressed; Googlebot reads only the first 2,048 KB`);
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
  if (d.jsLinks) add("uncrawlable_links", `${d.jsLinks} link(s)${d.jsLinkExample ? `, e.g. ${d.jsLinkExample}` : ""}`);
  if (d.metaRefresh) add("meta_refresh", d.metaRefresh);
  if (d.nofollowMeta) add("nofollow_page");
  if (d.headClosedEarly) { const h = d.headClosedEarly; add("head_closed_early", `${h.element} on line ${h.line} closes the head; after it: ${h.tags.join(", ")}${h.robots ? ", robots meta (Google still honours that one)" : ""}`); }
  if (d.rawVsRendered) add("raw_vs_rendered", d.rawVsRendered);
  if (d.backButton) add("back_button_hijack", `possible, in ${d.backButton}`);
  if (d.externalLinks > 2 && d.externalLinks === d.externalNofollow) add("external_nofollow_all");
  if (p.depth > 3) add("deep_page", `depth ${p.depth}`);
  if (p.indexable && ctx.sitemapLoaded && !p.in_sitemap) add("not_in_sitemap");
  if (!p.indexable && p.in_sitemap) add("noindex_in_sitemap");
  if (p.indexable) contentIssues(p, d, ctx, add);
  return out;
}

/** Content age, structure and video rules for an indexable page. The audit date is ctx.auditDate (yyyy-mm-dd, set by
 *  the crawler when the crawl ends), or today when it is missing. */
function contentIssues(p, d, ctx, add) {
  const today = ctx.auditDate || new Date().toISOString().slice(0, 10);
  const types = d.schemaTypes || [];
  const listing = (d.childLinks || 0) >= 5 || types.some((t) => /^(Blog|CollectionPage|ItemList)$/.test(t));
  const newest = [d.dateModified, d.datePublished].filter(Boolean).sort().at(-1);
  const yearBefore = `${+today.slice(0, 4) - 1}${today.slice(4)}`; // same day one year earlier (ISO strings compare by date)
  if (newest && !listing && newest < yearBefore && isArticle(p)) {
    const months = (+today.slice(0, 4) - +newest.slice(0, 4)) * 12 + (+today.slice(5, 7) - +newest.slice(5, 7));
    add("content_stale", `newest date on the page: ${newest} (${months} months before the audit)`);
  }
  // News reports and event pages are about their year by nature.
  if (!types.some((t) => /^(NewsArticle|Event)$|Event$/.test(t))) {
    const year = +today.slice(0, 4);
    const t = pastYear(p.title, year), h = t ? null : pastYear(p.h1, year);
    if (t || h) add("title_past_year", t ? `title mentions ${t}: "${p.title.slice(0, 80)}"` : `H1 mentions ${h}: "${p.h1.slice(0, 80)}"`);
  }
  if (d.headingSkips) add("heading_skip", `${d.headingSkips} skip(s), e.g. ${d.headingSkipExample}`);
  if (d.headingsBeforeH1) add("heading_before_h1", `${d.headingsBeforeH1} heading(s) before the H1`);
  if (p.words >= 1500 && d.h2Count >= 4 && !(d.jumpLinks >= 2)) add("long_no_toc", `${p.words} words, ${d.h2Count} H2s, ${d.jumpLinks || 0} jump link(s) to headings`);
  if (d.longParas) add("long_paragraphs", `${d.longParas} paragraph(s), longest ${d.longParaMax} words`);
  if (d.videos && !d.videoObjects) add("video_no_schema", `${d.videos} video embed(s), no VideoObject`);
  if (d.videoObjectsIncomplete) add("video_schema_incomplete", `${d.videoObjectsIncomplete} VideoObject(s); missing ${d.videoObjectMissing}`);
}

/** Health score: share of crawled pages free of errors, warnings counting half (documented in the UI). */
export function healthScore(pageCount, pagesWithErrors, pagesWithWarningsOnly) {
  if (!pageCount) return 0;
  return Math.max(0, Math.round(100 * (1 - (pagesWithErrors + 0.5 * pagesWithWarningsOnly) / pageCount)));
}
