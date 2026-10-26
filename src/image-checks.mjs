// Image checks (REQ-044 build rows 36-38, Oct 2026), from Google Search Central docs and videos:
// - lcp_image_lazy: the first content image above the first H2 has loading="lazy" (Martin Splitt, "Lazy loading
//   demystified", 2025: lazy-loading an above-the-fold image delays it and hurts LCP),
// - img_src_placeholder: the real image URL is only in data-src / data-srcset (Google Images indexes the URL in the
//   img src attribute: images best practices; lazy-loading guidance),
// - img_alt_generic: alt text that says nothing (a file name, "image", "picture of …"), one alt reused for many
//   different images, or camera/screenshot file names (images best practices: descriptive alt text and file names;
//   John Mueller, "Let's talk image SEO", SOTR 2022),
// - images_blocked_by_robots: image or video thumbnail URLs robots.txt disallows for Googlebot-Image.
// Parse-time functions take a cheerio document; the site functions are pure.

const CHROME = "nav, aside, [role=navigation], [role=banner], [role=contentinfo]";
const inChrome = ($, el) => $(el).closest(CHROME).length > 0 || $(el).closest("header, footer").filter((_, e) => !$(e).closest("article, section").length).length > 0;
const px = (v) => (/^\s*\d+(?:px)?\s*$/.test(v || "") ? parseInt(v, 10) : null); // "100%" or "auto" aren't pixel sizes
const SMALL = /logo|icon|avatar|badge|sprite|emoji|flag|spinner|loader/i;
const PLACEHOLDER = /(?:^|[/_-])(?:blank|placeholder|spacer|pixel|transparent|lazy|loading|loader|grey|gray|empty|1x1|dummy)[^/]*\.(?:gif|png|svg|jpe?g|webp)(?:[?#]|$)/i;
const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-srcset", "data-lazy-srcset"];
const GENERIC_ALT = /^(?:image|images|img|photo|photos|picture|pictures|pic|banner|graphic|untitled|placeholder|thumbnail|thumb|default|figure|alt|alt text)[\s_-]*\d*$/i;
const ALT_OF = /^(?:an? )?(?:image|picture|photo|photograph) of\b/i;
const CAMERA_NAME = /^(?:IMG|DSC|DSCN|DCIM|PXL|Screenshot|Screen Shot|image|photo|pic|WhatsApp Image)[-_ ]?\d+|^\d+$/i;

const fileOf = (u) => { try { return decodeURIComponent(new URL(u, "https://x.invalid/").pathname.split("/").pop() || ""); } catch { return ""; } };
const words = (s) => String(s || "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "").replace(/[-_+.%\s]+/g, " ").trim();
const firstUrl = (srcset) => String(srcset || "").trim().split(/\s+/)[0] || "";
const realUrl = (u) => Boolean(u) && !/^data:/i.test(u) && !PLACEHOLDER.test(u);

/** Why an alt text is generic, or null. src: the image URL. */
export function genericAlt(alt, src) {
  const a = String(alt || "").replace(/\s+/g, " ").trim();
  if (!a) return null; // alt="" marks a decorative image: fine
  const file = fileOf(src);
  if (file && (a.toLowerCase() === file.toLowerCase() || words(a) === words(file))) return "the file name";
  if (GENERIC_ALT.test(a)) return `"${a}"`;
  if (ALT_OF.test(a)) return `starts with "${a.split(" ").slice(0, 3).join(" ")}"`;
  return null;
}

/** Page fields: lcpLazy, imgPlaceholder (+Example), imgAltGeneric (+Example), imgGenericName (+Example), imgAltPairs
 *  ([alt, image URL] of content images, for the site-wide alt reuse rule). $c: the page's main content (or body). */
export function imageFindings($, url, $c) {
  const d = {};
  const abs = (u) => { try { return new URL(u, url).href; } catch { return null; } };
  // (a) The first content image before the first H2, skipping logos, icons and the site header/menus.
  for (const el of $c.find("img, h2").toArray()) {
    if (el.name === "h2") break;
    const i = $(el), w = px(i.attr("width")), h = px(i.attr("height"));
    if (inChrome($, el) || (w !== null && w < 100) || (h !== null && h < 100) || SMALL.test(`${i.attr("src") || ""} ${i.attr("class") || ""} ${i.attr("id") || ""}`)) continue;
    if ((i.attr("loading") || "").toLowerCase() === "lazy" && (w === null || w >= 200)) d.lcpLazy = (i.attr("src") || i.attr("data-src") || "").slice(0, 120);
    break;
  }
  // (b) Real URL only in a data- attribute, with a placeholder (or nothing) in src and no <noscript> fallback.
  const noscript = $("noscript").map((_, n) => $(n).html() || $(n).text()).get().join(" ");
  const alts = new Map();
  let placeholder = 0, generic = 0, cameraNames = 0;
  $("img").each((_, el) => {
    const i = $(el), src = (i.attr("src") || "").trim(), srcset = i.attr("srcset");
    const lazy = LAZY_ATTRS.map((a) => (a.endsWith("srcset") ? firstUrl(i.attr(a)) : (i.attr(a) || "").trim())).find(realUrl);
    if (lazy && !realUrl(src) && !realUrl(firstUrl(srcset)) && !noscript.includes(fileOf(lazy) || lazy)) {
      if (!placeholder++) d.imgPlaceholderExample = `${lazy.slice(0, 100)} (src: ${src ? src.slice(0, 40) : "none"})`;
    }
    const real = realUrl(src) ? src : lazy || firstUrl(srcset);
    if (!real || /^data:/i.test(real)) return;
    const alt = i.attr("alt");
    const g = genericAlt(alt, real);
    if (g && !generic++) d.imgAltGenericExample = `alt ${g === "the file name" ? `"${alt.trim().slice(0, 60)}" is the file name` : g} on ${fileOf(real).slice(0, 60)}`;
    if (CAMERA_NAME.test(fileOf(real).replace(/\.[a-z0-9]+$/i, "")) && !cameraNames++) d.imgGenericNameExample = fileOf(real).slice(0, 60);
    const a = String(alt || "").replace(/\s+/g, " ").trim();
    if (a.length >= 3 && !inChrome($, el) && alts.size < 40) { const u = abs(real); if (u) alts.set(`${a}\n${u}`, [a.slice(0, 120), u]); }
  });
  if (placeholder) d.imgPlaceholder = placeholder;
  if (generic) d.imgAltGeneric = generic;
  if (cameraNames) d.imgGenericName = cameraNames;
  if (alts.size) d.imgAltPairs = [...alts.values()];
  return d;
}

/** img_alt_generic for one alt text used on 5 or more different image URLs across the site (content images only;
 *  brand names are ignored). Reported once per alt text, on the first page that uses it. */
export function altReuseIssues(pages, { brandTerms = [] } = {}) {
  const by = new Map(); // alt (lower case) → { alt, urls: Set, pages: [] }
  const brands = new Set(brandTerms.map((b) => b.toLowerCase()));
  for (const p of pages) for (const [alt, u] of p.data?.imgAltPairs || []) {
    const k = alt.toLowerCase();
    if (brands.has(k)) continue;
    if (!by.has(k)) by.set(k, { alt, urls: new Set(), pages: [] });
    const x = by.get(k);
    x.urls.add(u);
    if (!x.pages.includes(p.url)) x.pages.push(p.url);
  }
  return [...by.values()].filter((x) => x.urls.size >= 5)
    .map((x) => ["img_alt_generic", x.pages[0], `alt "${x.alt.slice(0, 60)}" is used for ${x.urls.size} different images on ${x.pages.length} page(s)`]);
}

/** The robots.txt user agent Google's image crawler obeys here: its own group when robots.txt has one, else the
 *  Googlebot group (Google follows the most specific matching group; robots-parser matches names exactly). */
export const imageAgent = (robotsTxt) => (/^\s*user-agent\s*:\s*googlebot-image\s*$/im.test(robotsTxt || "") ? "Googlebot-Image"
  : /^\s*user-agent\s*:\s*googlebot\s*$/im.test(robotsTxt || "") ? "Googlebot" : "Googlebot-Image");

/** images_blocked_by_robots: images: [[image URL, page URL]] on the robots.txt's origin (img tags and VideoObject
 *  thumbnails). One finding per folder, so a deliberately blocked icon folder is one line, not hundreds. */
export function imagesBlockedIssues(images, { robots, robotsTxt, origin }) {
  if (!robots) return [];
  const ua = imageAgent(robotsTxt), folders = new Map();
  for (const [img, page] of images) {
    let x; try { x = new URL(img); } catch { continue; }
    if (x.origin !== origin || robots.isAllowed(img, ua) !== false) continue;
    const dir = x.origin + x.pathname.replace(/[^/]*$/, "");
    if (!folders.has(dir)) folders.set(dir, { n: new Set(), img, page });
    folders.get(dir).n.add(img);
  }
  return [...folders].map(([dir, f]) => ["images_blocked_by_robots", dir, `${f.n.size} image(s) disallowed for ${ua}, e.g. ${f.img} on ${f.page}`]);
}
