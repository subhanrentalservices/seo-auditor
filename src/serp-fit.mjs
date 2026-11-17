// SERP fit (owner, 2026-11-17, from a creator's lesson on keyword choice): you don't compete with the internet, only
// with the ten pages Google already shows. Open the top 10 and decide from them, not from a difficulty number:
//   1. Who ranks: mostly weak sites -> the keyword can be won; all big brands -> skip it, no content will get in.
//   2. What ranks: Google has already picked the format (service pages, listicles, articles, the brand's own pages).
//      A page of another format won't rank however good it is.
//   3. Intent: a brand's own pages filling the top 10 means people are looking for that site (navigational).
// Input per keyword: rows [{ url, title, dr }] in rank order (dr may be null when unknown) and the page type we have.
// Works from any source (Ahrefs' free checker, DataForSEO, a manual copy); serpFit() only reads the rows.

const DIRECTORY = /localsearch|yellowpages|truelocal|hipages|oneflare|service\.com\.au|autoguru|dinggo|carsguide|yelp\.|startlocal|hotfrog|whereis|bark\.com|productreview|airtasker|tripadvisor|clutch\.co|g2\.com|capterra/i;
const SOCIAL = /facebook\.com|instagram\.com|youtube\.com|tiktok\.com|linkedin\.com|x\.com\/|twitter\.com/i;
const FORUM = /reddit\.com|whirlpool\.net|quora\.com|stackexchange|forum/i;
const GOV = /\.gov(\.[a-z]{2})?\/|\.gov(\.[a-z]{2})?$|\.gov\b/i;
const ARTICLE_PATH = /\/(blog|news|article|articles|guide|guides|faq|resources|insights|learn|help|advice|tips)\b|\/(how|what|why|when|can|should|do|does|is)-/i;

/** One result's page type from its URL and title. */
export function pageType({ url = "", title = "" }) {
  const u = String(url).replace(/^https?:\/\/(www\.)?/i, "");
  if (SOCIAL.test(u)) return "social";
  if (FORUM.test(u)) return "forum";
  if (GOV.test(u.split("/")[0]) || GOV.test(u)) return "gov";
  if (DIRECTORY.test(u) || /^(the )?(\d+ )?best\b|\btop \d+\b|\b\d+ best\b/i.test(title)) return "directory";
  if (/^\d+\s|\blist of\b/i.test(title)) return "listicle";
  if (/\/(product|products|shop|store|p)\//i.test(u) || /\bbuy\b|\$\d/i.test(title)) return "product";
  if (ARTICLE_PATH.test(u) || /^(how|what|why|when|can|should|do|does|is|are)\b|\?$/i.test(title.trim())) return "article";
  if (/^[^/]+\/?$/.test(u)) return "home";
  return "page";
}

const host = (url) => String(url).replace(/^https?:\/\/(www\.)?/i, "").split("/")[0].toLowerCase();
const registered = (h) => h.split(".").slice(/\.(com|net|org|gov|edu)\.[a-z]{2}$/.test(h) ? -3 : -2).join(".");

/**
 * Decide one keyword. ourDr = our domain's rating; ourType = "service" (home/service page), "article", "listicle" ...
 * weakBelow: a site counts as beatable when its DR is under max(weakBelow, ourDr + 10); giantFrom: DR at which a
 * site counts as a big brand.
 */
export function serpFit({ keyword, rows = [], ourDomain = "", ourDr = 0, ourType = "service", weakBelow = 30, giantFrom = 60 }) {
  const top = rows.slice(0, 10).filter((r) => r && r.url);
  const ours = top.findIndex((r) => ourDomain && registered(host(r.url)) === registered(ourDomain));
  const others = top.filter((_, i) => i !== ours);
  const limit = Math.max(weakBelow, ourDr + 10);
  const rated = others.filter((r) => typeof r.dr === "number");
  const weak = rated.filter((r) => r.dr < limit).length, giants = rated.filter((r) => r.dr >= giantFrom).length;
  const types = {};
  for (const r of others) { const t = pageType(r); types[t] = (types[t] || 0) + 1; }
  // the format Google picked: service pages and homepages are one format for a local or commercial search
  const fam = { home: "service", page: "service", directory: "service", social: "service" };
  const famCount = {};
  for (const [t, n] of Object.entries(types)) { const f = fam[t] || t; famCount[f] = (famCount[f] || 0) + n; }
  const [dominant, dn] = Object.entries(famCount).sort((a, b) => b[1] - a[1])[0] || ["unknown", 0];
  const share = others.length ? dn / others.length : 0;
  // one brand filling most of the top 10 = people want that site
  const byHost = {};
  for (const r of others) { const h = registered(host(r.url)); byHost[h] = (byHost[h] || 0) + 1; }
  const [brand, brandN] = Object.entries(byHost).sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const navigational = brandN >= Math.max(4, Math.ceil(others.length / 2));
  const notes = [];
  let verdict;
  if (navigational) { verdict = "skip"; notes.push(`${brand} holds ${brandN} of the top ${others.length}: people want that site (navigational)`); }
  else if (rated.length && giants >= Math.min(rated.length, 3) && weak === 0) { verdict = "skip"; notes.push(`every rated result is a big site (DR ${giantFrom}+): content alone won't get in`); }
  else if (weak >= 2 || (rated.length && weak / rated.length >= 0.5)) { verdict = "go"; notes.push(`${weak} of ${rated.length} rated results are beatable (DR under ${limit})`); }
  else { verdict = "hard"; notes.push(`${weak} beatable and ${giants} big sites among ${rated.length} rated results`); }
  const match = share < 0.5 ? null : dominant === ourType;
  if (match === false) notes.push(`Google shows ${dominant} pages (${dn} of ${others.length}); ${/^[aeiou]/.test(ourType) ? "an" : "a"} ${ourType} page won't rank here`);
  if (types.directory >= 3) notes.push(`${types.directory} directories: the map pack and listings matter as much as the page`);
  return { keyword, verdict, weak, giants, rated: rated.length, types, dominant, dominantShare: Math.round(share * 100), formatMatch: match, ourRank: ours >= 0 ? ours + 1 : null, notes };
}
