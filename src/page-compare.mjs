// Page vs page for one search (REQ-062, 2026-10-31; from a "compare your page with the page that ranks first, then ask
// AI what to change" video). Fetches the two pages once each (the owner asks for it; no crawling), reads them with the
// crawler's parser and lines up what a reader and Google see for the search: title, description, H1, headings, the
// first 100 words, length, images, links, structured data, FAQ, dates and author. The gaps are things the other page
// does for this search that yours doesn't. Copy nothing: answer the search better in your own words, and add a
// claim, a date or markup only when it is true for your page (Google's spam and structured data policies).
import { get, projectSettings } from "./db.mjs";
import { fetchFollow } from "./page-fetch.mjs";
import { parseHtml } from "./crawler.mjs";
import { mention, words } from "./page2.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const norm = (s) => ` ${String(s || "").toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9&]+/g, " ").trim()} `;

/** How a piece of text uses the search: "exact" phrase, "words" (all core words close together), or null. */
export function uses(text, keyword) {
  const core = [...new Set(words(keyword))];
  const m = mention(text || "", keyword, core);
  return m ? m.match : null;
}

/** The signals for one parsed page (parseHtml output) and one search. */
export function signals(parsed, url, keyword) {
  const d = parsed.data || {};
  const text = parsed.text || "";
  const first100 = text.split(/\s+/).slice(0, 100).join(" ");
  const headings = Array.isArray(d.h2s) ? d.h2s : [];
  const kw = norm(keyword).trim();
  const exactCount = kw ? (norm(text).split(` ${kw} `).length - 1) : 0;
  let host = "";
  try { host = new URL(url).host; } catch { /* bad url */ }
  const links = parsed.links || [];
  const isInternal = (to) => { try { return new URL(to).host === host; } catch { return false; } };
  const content = links.filter((l) => l.placement === "content");
  return {
    url,
    title: parsed.title || "", titleLength: (parsed.title || "").length, titleUses: uses(parsed.title, keyword),
    description: parsed.description || "", descriptionLength: (parsed.description || "").length, descriptionUses: uses(parsed.description, keyword),
    h1: parsed.h1 || "", h1Uses: uses(parsed.h1, keyword),
    headings: headings.length, headingsUsing: headings.filter((x) => uses(x, keyword)).length, questionHeadings: d.questionHeadings || 0,
    first100Uses: uses(first100, keyword),
    words: parsed.words || 0, exactCount,
    images: (parsed.imgs || []).length, imagesNoAlt: d.imgNoAlt || 0,
    contentLinksInternal: content.filter((l) => isInternal(l.to)).length, contentLinksExternal: content.filter((l) => !isInternal(l.to)).length,
    schemaTypes: [...new Set(d.schemaTypes || [])].sort(),
    faq: (d.schemaTypes || []).includes("FAQPage") || (d.questionHeadings || 0) >= 3,
    dated: Boolean(d.dated), author: Boolean(d.author),
  };
}

/** What the other page does for the search that yours doesn't, in priority order. Each item: [id, text]. */
export function gaps(mine, theirs) {
  const out = [];
  const has = (u) => u === "exact" || u === "words";
  if (!has(mine.titleUses) && has(theirs.titleUses)) out.push(["title", "Their title uses the search's words; yours doesn't. Add them if your page really is about this search, within about 60 characters."]);
  if (!has(mine.h1Uses) && has(theirs.h1Uses)) out.push(["h1", "Their H1 uses the search's words; yours doesn't."]);
  if (!has(mine.first100Uses) && has(theirs.first100Uses)) out.push(["first100", "They answer or name the search in the first 100 words; you don't. Put a direct answer at the top."]);
  if (theirs.headingsUsing > mine.headingsUsing) out.push(["headings", `${theirs.headingsUsing} of their headings use the search's words (yours: ${mine.headingsUsing}). Cover the parts of the topic they give a section to, in your own words.`]);
  if (theirs.questionHeadings >= 3 && mine.questionHeadings < 3) out.push(["questions", `They answer ${theirs.questionHeadings} questions in headings (yours: ${mine.questionHeadings}). Add the questions your customers really ask, each with a short direct answer.`]);
  if (theirs.words >= mine.words * 1.3 && theirs.words - mine.words >= 200) out.push(["length", `Their page is longer (${theirs.words} words vs ${mine.words}). Length alone doesn't rank; check what they cover that you don't.`]);
  if (!has(mine.descriptionUses) && has(theirs.descriptionUses)) out.push(["description", "Their meta description uses the search's words; yours doesn't (it can make the snippet bold those words)."]);
  const missingTypes = theirs.schemaTypes.filter((t) => !mine.schemaTypes.includes(t) && !/^(WebSite|WebPage|ImageObject|SiteNavigationElement|ListItem|Person|Organization|PostalAddress|GeoCoordinates|OpeningHoursSpecification|Offer|AggregateRating|Rating|Review|Answer|Question|EntryPoint|SearchAction|ReadAction)$/.test(t));
  if (missingTypes.length) out.push(["schema", `They mark up ${missingTypes.join(", ")}; you don't. Add markup only for content your page actually shows.`]);
  if (theirs.dated && !mine.dated) out.push(["dated", "They show when the page was published or updated; you don't. Show a real date."]);
  if (theirs.author && !mine.author) out.push(["author", "They name an author or reviewer; you don't. Name the real person responsible for the content."]);
  if (theirs.contentLinksExternal > 0 && mine.contentLinksExternal === 0) out.push(["sources", `They link to ${theirs.contentLinksExternal} outside source${theirs.contentLinksExternal === 1 ? "" : "s"} from their text; you link to none. Cite the original sources of any facts or figures.`]);
  if (mine.imagesNoAlt > theirs.imagesNoAlt) out.push(["alt", `${mine.imagesNoAlt} of your images have no alt text.`]);
  return out;
}

export async function comparePages({ mine, theirs, keyword }, { ua = "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)", fetchPage = (u) => fetchFollow(u, ua) } = {}) {
  const urls = [mine, theirs].map((u) => String(u || "").trim());
  for (const u of urls) if (!/^https?:\/\/[^\s/]+/i.test(u)) fail(400, "Enter two full page addresses (https://…)");
  if (!String(keyword || "").trim()) fail(400, "Enter the search to compare the pages for");
  const read = async (u) => {
    const r = await fetchPage(u);
    if (r.status !== 200 || (!/html/i.test(r.type || "") && !/<html|<body/i.test(r.body || ""))) return { url: u, error: r.error || `HTTP ${r.status || "error"}` };
    return signals(parseHtml(r.body, r.finalUrl || u), r.finalUrl || u, keyword);
  };
  const [a, b] = [await read(urls[0]), await read(urls[1])];
  return { keyword: String(keyword).trim(), mine: a, theirs: b, gaps: a.error || b.error ? [] : gaps(a, b) };
}

export function register({ routes }) {
  routes.push(["POST", /^\/api\/projects\/(\d+)\/page-compare$/, async ([id], _q, body) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    return comparePages(body || {}, { ua: projectSettings(p).userAgent });
  }]);
}
