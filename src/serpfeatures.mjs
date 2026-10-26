// SERP features from the Google searches AI visibility already pays for (REQ-040 #11, 2026-10-26). checkGoogle() keeps a
// small snapshot of each serp/google/organic/live/advanced response (serpSnapshot below, stored in ai_results.serp);
// this module reads the latest run with Google rows and finds, per prompt:
//   a. a featured snippet held by another site while we rank 1-10,
//   b. People Also Ask questions no H2/H3 on our ranking page answers (same matcher as the Search Console questions),
//   c. a video result while our ranking page has no video embed,
//   d. a page-type mismatch: most of the top 10 are directories/marketplaces or articles and our page is not that kind,
//   e. title_rewritten (REQ-044 row 41): the title Google showed for our URL against the page's <title> in the latest
//      audit, after dropping a trailing "…", case and a brand segment; truncation (a prefix) is not a rewrite, and the
//      rewrite needs a word overlap (Jaccard) under 0.6. Older snapshots have no own.title: the top-10 entry is used.
// No new paid calls. Runs made before this version have no snapshot: the screen says so.
import { all, get, projectSettings } from "./db.mjs";
import { answeredBy, siteWideWords, urlKey } from "./queries.mjs";
import { pageRoles } from "./conversion.mjs";
import { words } from "./page2.mjs";
import { brandTerms } from "./trends.mjs";

// Directories, marketplaces, review sites, forums and video/encyclopedia sites, by the site's registrable name
// ("yelp" matches yelp.com, m.yelp.com.au). Add more per project in settings.serpDirectories (comma list).
export const DIRECTORY_SITES = ["yelp", "yellowpages", "yell", "whitepages", "truelocal", "hotfrog", "startlocal", "localsearch", "hipages",
  "oneflare", "airtasker", "serviceseeking", "productreview", "trustpilot", "bbb", "angi", "angieslist", "thumbtack", "houzz", "tripadvisor",
  "foursquare", "mapquest", "facebook", "instagram", "linkedin", "tiktok", "pinterest", "x", "twitter", "amazon", "ebay", "etsy", "walmart",
  "gumtree", "craigslist", "carsales", "g2", "capterra", "getapp", "softwareadvice", "reddit", "quora", "youtube", "wikipedia", "indeed",
  "glassdoor", "seek", "booking", "expedia", "airbnb", "zomato", "doordash", "ubereats", "menulog"];
const ARTICLE_PATH = /\/(blog|news|articles?|guides?|how-to|resources|learn|insights|posts?|tips|advice|knowledge|faq|questions)\/|\/20\d\d\/\d\d?\//i;
const ARTICLE_TITLE = /^(how|what|why|when|where|which|who|can|should|is|are|do|does)\b|\b(guide|how to|tips|explained|checklist|ways to|things to|reasons|vs\.?|versus|review|reviews|best|top \d+|\d+ best)\b/i;

export const FEATURE_LABELS = { featured_snippet: "Featured snippet", people_also_ask: "People Also Ask", ai_overview: "AI Overview", local_pack: "Local pack",
  paid: "Ads", video: "Videos", short_videos: "Short videos", images: "Images", top_stories: "Top stories", discussions_and_forums: "Discussions and forums",
  knowledge_graph: "Knowledge panel", shopping: "Shopping", popular_products: "Popular products", perspectives: "Perspectives", twitter: "X posts",
  related_searches: "Related searches", people_also_search: "People also search", map: "Map", jobs: "Jobs", events: "Events", hotels_pack: "Hotels" };
export const TYPE_LABELS = { directory: "directories or marketplaces", article: "articles or guides", business: "business pages" };

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return String(u || "").replace(/^www\./, "").toLowerCase(); } };
// The registrable name of a host: "yelp" for m.yelp.com.au, "acme" for booking.acme.com (a subdomain never decides).
const SLD = new Set(["com", "co", "net", "org", "gov", "edu", "ac", "asn", "id", "ne", "or", "gen", "biz", "info"]);
export function siteName(u) {
  const l = host(u).split(".");
  if (l.length > 1) l.pop();
  if (l.length > 1 && SLD.has(l.at(-1))) l.pop();
  return l.at(-1) || "";
}
const ownTest = (start) => { const d = host(start); return (x) => { const h = host(x); return Boolean(d) && (h === d || h.endsWith("." + d)); }; };

/** Coarse kind of a search result: "directory" (by the site list), "article" (path or title reads like a blog post or
 *  guide) or "business" (any other page: service, product, home). */
export function resultType({ domain, url, title }, extra = []) {
  if (new Set([...DIRECTORY_SITES, ...extra]).has(siteName(domain || url))) return "directory";
  let path = ""; try { path = new URL(url).pathname; } catch { /* no URL */ }
  if (ARTICLE_PATH.test(path + "/") || ARTICLE_TITLE.test(String(title || "").trim())) return "article";
  return "business";
}

/** What checkGoogle keeps from one SERP response: item types with counts, the featured snippet, PAA questions, our
 *  first organic result and the top-10 organic results with a coarse type. isOwn(domain) marks our site. */
export function serpSnapshot(items, isOwn = () => false) {
  const types = {};
  for (const i of items || []) if (i?.type) types[i.type] = (types[i.type] || 0) + 1;
  const fs = (items || []).find((i) => i.type === "featured_snippet");
  const paa = (items || []).filter((i) => i.type === "people_also_ask").flatMap((i) => i.items || []).map((x) => String(x.title || "").trim()).filter(Boolean);
  const organic = (items || []).filter((i) => i.type === "organic");
  const own = organic.find((i) => isOwn(i.domain || i.url));
  return { v: 1, types,
    snippet: fs ? { domain: host(fs.domain || fs.url), url: fs.url || null, title: fs.title || "" } : null,
    paa: [...new Set(paa)].slice(0, 12),
    own: own ? { pos: own.rank_group ?? null, url: own.url || null, title: String(own.title || "").slice(0, 200) } : null,
    top: organic.filter((i) => !i.rank_group || i.rank_group <= 10).slice(0, 10).map((i) => ({ pos: i.rank_group ?? null, domain: host(i.domain || i.url),
      url: i.url || null, title: String(i.title || "").slice(0, 200), type: resultType(i) })) };
}

// ---- e. Title rewritten by Google ----
const ELLIPSIS = /\s*(…|\.\.\.)\s*$/;
const SEP = /\s+[|\-–—:·•»]\s+|\s*\|\s*|:\s+/; // "Title | Brand", "Brand - Title", "Brand: Title"
const compactT = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** A title as comparable words: trailing ellipsis gone, brand segments ("… | Acme Motors", "Acme Motors - …") dropped
 *  from either end (a segment that is the brand, or the brand plus a few characters such as a town). */
export function titleCore(t, brand = []) {
  const keys = brand.map(compactT).filter((k) => k.length >= 3);
  const parts = String(t || "").replace(ELLIPSIS, "").split(SEP).map((x) => x.trim()).filter(Boolean);
  const isBrand = (p) => { const c = compactT(p); return keys.some((k) => c.includes(k) && c.length <= k.length + 12); };
  while (parts.length > 1 && isBrand(parts.at(-1))) parts.pop();
  while (parts.length > 1 && isBrand(parts[0])) parts.shift();
  return parts.join(" ").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim();
}
/** null when Google's title is the page title, a cut-off start of it, or close to it; else the rewrite and the word
 *  overlap (Jaccard of stemmed non-stop words; under 0.6 counts as a rewrite). */
export function titleRewrite(shown, pageTitle, brand = []) {
  if (!shown || !pageTitle) return null;
  const s = titleCore(shown, brand), p = titleCore(pageTitle, brand);
  if (!s || !p || s === p) return null;
  // Truncation: the shown words are the page title's first words (the last shown word may be cut mid-word).
  const sw = s.split(" "), pw = p.split(" "), cut = ELLIPSIS.test(String(shown));
  const head = cut ? sw.slice(0, -1) : sw;
  if (head.length && head.every((w, i) => pw[i] === w) && (!cut || pw[head.length]?.startsWith(sw.at(-1)))) return null;
  if (!cut && pw.slice(0, sw.length).join(" ") === s) return null;
  const a = new Set(words(s)), b = new Set(words(p));
  const inter = [...a].filter((w) => b.has(w)).length, union = new Set([...a, ...b]).size;
  const similarity = union ? inter / union : 1;
  return similarity < 0.6 ? { shown: String(shown).trim(), pageTitle: String(pageTitle).trim(), similarity } : null;
}

/** Per prompt flags, opportunities and site-wide feature counts. rows: [{prompt, organic_pos, serp}] (serp parsed, or
 *  null for a run made before snapshots were stored); pages: the latest audit's pages ({url, final_url, status, data})
 *  or []; start: the project's start URL; brand: brand names to strip from titles before comparing. */
export function serpOpportunities(rows, pages, start, { majority = 6, directories = [], brand = [] } = {}) {
  const isOwn = ownTest(start), withData = rows.filter((r) => r.serp && r.serp.types);
  const byKey = new Map();
  for (const p of pages) for (const u of [p.url, p.final_url]) if (u && (!byKey.has(urlKey(u)) || p.status === 200)) byKey.set(urlKey(u), p);
  const role = pageRoles(pages, start);
  const siteWide = siteWideWords(pages.filter((p) => p.status === 200 && p.indexable));
  const counts = new Map(), prompts = [], opportunities = [];
  for (const r of withData) {
    const s = r.serp, types = s.types || {};
    for (const t of Object.keys(types)) if (t !== "organic") counts.set(t, (counts.get(t) || 0) + 1);
    const pos = s.own?.pos ?? r.organic_pos ?? null, ownUrl = s.own?.url || null;
    const page = ownUrl ? byKey.get(urlKey(ownUrl)) : null, data = page?.data || {};
    const top = (s.top || []).map((x) => ({ ...x, type: resultType(x, directories) }));
    const mix = { directory: 0, article: 0, business: 0 };
    for (const x of top) if (!isOwn(x.domain)) mix[x.type]++;
    const add = (kind, label, detail, extra = {}) => opportunities.push({ prompt: r.prompt, kind, label, detail, url: ownUrl, position: pos, ...extra });

    // a. Featured snippet held by another site while we're on page one.
    if (s.snippet && !isOwn(s.snippet.domain) && pos && pos <= 10)
      add("snippet", "Featured snippet held by another site", `${s.snippet.domain} holds the snippet; you rank #${pos}. A short, direct answer under a heading that matches the search can win it.`, { other: s.snippet.url });
    // b. People Also Ask questions our ranking page doesn't answer under a heading.
    let unanswered = null;
    if (s.paa?.length && ownUrl) {
      if (Array.isArray(data.h2s)) {
        unanswered = s.paa.filter((q) => !answeredBy(q, data.h2s, siteWide));
        if (unanswered.length) add("paa", "People Also Ask not answered", `${unanswered.length} of ${s.paa.length} questions have no H2/H3 on your page: ${unanswered.join(" · ")}`, { questions: unanswered });
      } else add("paa", "People Also Ask: page headings unknown", `${s.paa.length} questions shown; ${page ? "this audit didn't store headings" : "your page isn't in the latest audit"}. Run a new audit to compare.`, { questions: s.paa, unknown: true });
    }
    // c. Videos in the results while our page has none (data.videos is set when there is one; jumpLinks came with that check).
    const videoShown = (types.video || 0) + (types.short_videos || 0) > 0;
    const hasVideo = data.videos > 0 ? true : page && typeof data.jumpLinks === "number" ? false : null;
    if (videoShown && ownUrl && hasVideo === false)
      add("video", "Video results, no video on your page", "Google shows videos for this search; a useful video on the page (with VideoObject markup) can earn a place there.");
    else if (videoShown && ownUrl && hasVideo === null)
      add("video", "Video results: page video unknown", `Google shows videos for this search; ${page ? "this audit didn't record video embeds" : "your page isn't in the latest audit"}.`, { unknown: true });
    // d. Page-type mismatch: what Google ranks vs what our page is.
    const ours = ownUrl ? (role(ownUrl) === "article" ? "article" : "business") : null;
    const [lead, n] = Object.entries(mix).sort((a, b) => b[1] - a[1])[0];
    let mismatch = null;
    if (ours && n >= majority && lead !== ours) {
      mismatch = lead;
      add("type", "Page-type mismatch", lead === "directory"
        ? `${n} of the top 10 are ${TYPE_LABELS.directory}; your ${ours === "article" ? "article" : "page"} competes with listings. Being listed (and reviewed) on those sites is the realistic way into this result.`
        : `${n} of the top 10 are ${TYPE_LABELS[lead]}; your page is ${ours === "article" ? "an article" : "a service or product page"}. Google wants ${lead === "article" ? "a guide that answers the search" : "a page that sells the service"} here.`, { mix });
    }
    // e. The title Google showed for our page against the page's <title> (older snapshots: our entry in the top 10).
    const shown = s.own?.title || (ownUrl && top.find((x) => x.url && urlKey(x.url) === urlKey(ownUrl))?.title) || null;
    const rewrite = page?.title ? titleRewrite(shown, page.title, brand) : null;
    if (rewrite)
      add("title_rewritten", "Google rewrote the title", `Google showed "${rewrite.shown}"; the page's <title> is "${rewrite.pageTitle}" (${Math.round(rewrite.similarity * 100)}% of words shared). `
        + "Title links usually come from the <title>, but Google can use the page's headings or links to it instead (Gary Illyes, \"Anatomy of a Search Result\", 2024). Make the <title> a short, accurate description of this page that agrees with its main heading.", rewrite);
    prompts.push({ prompt: r.prompt, position: pos, url: ownUrl, features: Object.keys(types).filter((t) => t !== "organic"), paid: types.paid || 0,
      snippet: s.snippet, paa: s.paa || [], unanswered, video: videoShown ? hasVideo : undefined, mix, mismatch, shownTitle: shown, titleRewritten: Boolean(rewrite) });
  }
  const features = [...counts].sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, label: FEATURE_LABELS[type] || type.replace(/_/g, " "), prompts: n }));
  return { prompts, opportunities, features };
}

/** The latest finished run with Google rows, read against the latest audit. */
export function serpFeatures(projectId, opts = {}) {
  const project = get("SELECT * FROM projects WHERE id=?", Number(projectId));
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
  const empty = { run: null, googleRows: 0, withData: 0, auditId: null, features: [], prompts: [], opportunities: [] };
  const cols = get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='ai_results'") ? all("PRAGMA table_info(ai_results)").map((c) => c.name) : [];
  if (!cols.length) return empty;
  const r = get(`SELECT id, started_at FROM ai_runs r WHERE project_id=? AND status!='running'
    AND EXISTS (SELECT 1 FROM ai_results WHERE run_id=r.id AND platform='google' AND error IS NULL) ORDER BY id DESC LIMIT 1`, project.id);
  if (!r) return empty;
  const rows = all(`SELECT prompt, organic_pos, ${cols.includes("serp") ? "serp" : "NULL serp"} FROM ai_results WHERE run_id=? AND platform='google' AND error IS NULL ORDER BY prompt`, r.id)
    .map((x) => { let serp = null; try { serp = x.serp ? JSON.parse(x.serp) : null; } catch { /* bad row */ } return { ...x, serp }; });
  const audit = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id);
  const pages = audit ? all("SELECT url, final_url, status, indexable, title, h1, data FROM pages WHERE audit_id=? AND content_type LIKE '%html%'", audit.id)
    .map((p) => { let data = {}; try { data = JSON.parse(p.data || "{}"); } catch { /* old row */ } return { ...p, data }; }) : [];
  const settings = projectSettings(project);
  const directories = String(settings.serpDirectories || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  let host = ""; try { host = new URL(project.start_url).hostname.replace(/^www\./, ""); } catch { /* bad URL */ }
  const out = serpOpportunities(rows, pages, project.start_url, { directories, brand: [...brandTerms(project, settings), host], ...opts });
  return { run: r, googleRows: rows.length, withData: rows.filter((x) => x.serp?.types).length, auditId: audit?.id || null, ...out };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/serp-features$/, ([id]) => serpFeatures(Number(id))]);
}
