// Site-level structured data rules (REQ-044 build rows 22, 23, 45; Google Search Central docs, fetched 2026-10-26):
// the site name Google takes from the home page's WebSite markup, the local business name/address/phone/hours on
// the home page, and merchant return and shipping policies for sites that sell products. The crawler passes in the
// stored pages (their data comes from schema.mjs) and the home page's HTML.
import * as cheerio from "cheerio";
import { ldGraph, typesOf, pick, phoneKey, LOCAL_BUSINESS } from "./schema.mjs";

const key = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const isRoot = (u) => { try { return new URL(u).pathname.replace(/\/(index\.(html?|php))?$/i, "") === ""; } catch { return false; } };

/** The brand suffix most titles end with ("Page | Brand", "Page - Brand"), when at least half of the titles (and 3 or
 *  more) share it; else null. */
export function titleBrand(titles) {
  const ends = titles.map((t) => String(t || "").split(/\s+[|\-–—·•»:]\s+/)).filter((s) => s.length > 1).map((s) => s.at(-1).trim());
  const count = new Map();
  for (const e of ends) if (key(e)) count.set(key(e), { n: (count.get(key(e))?.n || 0) + 1, text: e });
  const best = [...count.values()].sort((a, b) => b.n - a.n)[0];
  return best && best.n >= 3 && best.n >= titles.filter(Boolean).length / 2 ? best.text : null;
}

/** site_name_markup: the home page's WebSite name (Google's preferred site-name source) is missing or disagrees with
 *  og:site_name or the brand most titles end with (alternateName counts as a match); WebSite markup on a
 *  subdirectory page, which Google ignores. Returns [[id, url, detail]]. */
export function siteNameIssues(pages, start) {
  const out = [];
  const home = pages.find((p) => p.url === start || p.final_url === start);
  if (home && home.status === 200 && (home.content_type || "").includes("html")) {
    const w = home.data.website, problems = [];
    const names = w ? [w.name, ...w.alt].map(key).filter(Boolean) : [];
    if (!w || !key(w.name)) problems.push("the home page has no WebSite structured data with a name");
    else {
      if (!w.url) problems.push("the WebSite markup has no url (required)");
      if (home.data.ogSiteName && !names.includes(key(home.data.ogSiteName))) problems.push(`WebSite name "${w.name}" differs from og:site_name "${home.data.ogSiteName}"`);
      const brand = titleBrand(pages.filter((p) => p.indexable).map((p) => p.title));
      if (brand && !names.includes(key(brand))) problems.push(`WebSite name "${w.name}" differs from "${brand}", the brand most page titles end with`);
    }
    if (problems.length) out.push(["site_name_markup", home.url, problems.join("; ")]);
  }
  const homeName = key(home?.data.website?.name);
  for (const p of pages.filter((x) => x !== home && x.data.website?.name).slice(0, 500)) {
    const w = p.data.website;
    if (w.url && !isRoot(w.url)) out.push(["site_name_markup", p.url, `WebSite markup with url ${w.url} is ignored: Google supports site names per domain or subdomain, not subdirectories`]);
    else if (homeName && key(w.name) !== homeName && ![...w.alt].map(key).includes(homeName)) out.push(["site_name_markup", p.url, `WebSite name "${w.name}" differs from the home page's "${home.data.website.name}"`]);
    if (out.length >= 11) break;
  }
  return out;
}

/** merchant_policy_missing: products with prices are marked up on 3 or more pages, but no crawled page has a return
 *  policy (hasMerchantReturnPolicy / MerchantReturnPolicy) or no shipping policy (shippingDetails, hasShippingService). */
export function merchantPolicyIssues(pages, start) {
  const selling = pages.filter((p) => p.data.productOffers).length;
  if (selling < 3) return [];
  const miss = [!pages.some((p) => p.data.merchantReturn) && "return policy", !pages.some((p) => p.data.merchantShipping) && "shipping policy"].filter(Boolean);
  return miss.length ? [["merchant_policy_missing", start, `${selling} pages mark up products with prices; no ${miss.join(" or ")} markup on any crawled page`]] : [];
}

// ---- opening hours ----
const DAYS = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const dayIdx = (s) => DAYS.indexOf(String(s).replace(/^https?:\/\/schema\.org\//i, "").slice(0, 2).toLowerCase());
const span = (a, b) => { const out = []; for (let i = a; ; i = (i + 1) % 7) { out.push(i); if (i === b || out.length > 7) return out; } };
const hm = (s) => { const m = String(s || "").match(/^(\d{1,2}):(\d{2})/); return m ? +m[1] * 60 + +m[2] : null; };

/** Opening hours in LocalBusiness markup (openingHoursSpecification or openingHours "Mo-Fr 09:00-17:00") → Map day → "HH:MM-HH:MM".
 *  Days marked closed (00:00-00:00) are left out. */
export function markupHours(node, resolve = (x) => x) {
  const out = new Map();
  const put = (days, o, c) => { if (o === null || c === null || (o === 0 && c === 0)) return; for (const i of days) if (i >= 0) out.set(i, `${o}-${c}`); };
  for (const s of pick(node, "openingHoursSpecification", resolve)) {
    if (typeof s !== "object") continue;
    put([].concat(s.dayOfWeek || []).map(dayIdx), hm(s.opens), hm(s.closes));
  }
  for (const line of pick(node, "openingHours", resolve).flatMap((x) => String(x).split(/[;\n]|(?<=\d{2}:\d{2})\s*,\s*/))) {
    const m = line.trim().match(/^([A-Za-z,\- ]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (!m) continue;
    const days = m[1].split(",").flatMap((part) => { const [a, b] = part.trim().split("-").map(dayIdx); return b === undefined ? [a] : a >= 0 && b >= 0 ? span(a, b) : []; });
    put(days, hm(m[2]), hm(m[3]));
  }
  return out;
}

const D = "(mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?";
const T = "(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?";
const HOURS = new RegExp(`\\b${D}(?:\\s*(?:-|–|—|to)\\s*${D})?\\s*:?\\s*${T}\\s*(?:-|–|—|to)\\s*${T}`, "gi");
/** Opening hours written in page text ("Mon–Fri 9:00–6:00", "Saturday: 10am - 3pm") → Map day → "open-close" minutes.
 *  A time needs minutes or am/pm (so "Mon 5 - 10 March" isn't read as hours); a close time without am/pm that is
 *  not after the opening time is read as pm. Days written with two different times are left out (ambiguous). */
export function textHours(text) {
  const seen = new Map();
  for (const m of String(text).matchAll(HOURS)) {
    const [, d1, d2, oh, om, oap, ch, cm, cap] = m;
    if (!(om || oap) || !(cm || cap)) continue;
    const to24 = (h, min, ap) => { h = +h % (ap ? 12 : 24); if (ap && /p/i.test(ap)) h += 12; return h * 60 + (+min || 0); };
    const open = to24(oh, om, oap);
    let close = to24(ch, cm, cap);
    if (!cap && close <= open && close < 720) close += 720;
    const a = dayIdx(d1), b = d2 ? dayIdx(d2) : a;
    for (const i of span(a, b)) seen.set(i, [...(seen.get(i) || []), `${open}-${close}`]);
  }
  return new Map([...seen].filter(([, v]) => new Set(v).size === 1).map(([k, v]) => [k, v[0]]));
}
const fmt = (v) => v.split("-").map((x) => `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`).join("–");

/** local_nap_missing: for a local business (LocalBusiness-family markup on the home page, or name/address/phone in
 *  Settings), the home page's markup lacks telephone, street address or opening hours, the Settings phone or the
 *  street line isn't in the home page text, or the marked-up hours disagree with hours written on the page. A
 *  service-area business (areaServed, no street address) passes the address part. The marked-up phone not being on
 *  the page is reported by schema_value_not_visible. home = { url, html } (rendered HTML when rendering is on). */
export async function localNapIssues(home, settings = {}) {
  if (!home?.html) return [];
  const $ = cheerio.load(home.html);
  const docs = [];
  $('script[type="application/ld+json"]').each((_, el) => { try { docs.push(JSON.parse($(el).contents().text())); } catch { /* invalid_jsonld */ } });
  const g = ldGraph(docs);
  const biz = g.entities.find((e) => e.top && typesOf(e.node).some((t) => LOCAL_BUSINESS.test(t) && !/^Online/.test(t)))?.node;
  if (!biz && !settings.napPhone && !settings.napAddress) return [];
  const { normText, addressParts } = await import("./citations.mjs"); // loaded on demand: citations.mjs imports the runner
  $("script,style,noscript,template,svg").remove();
  const text = $("body").text().replace(/\s+/g, " ");
  const problems = [];
  let street = settings.napAddress ? addressParts(settings.napAddress).street : "";
  if (biz) {
    const has = (p) => pick(biz, p, g.resolve).length > 0;
    const sab = has("areaServed") && !has("address.streetAddress") && !pick(biz, "address", g.resolve).some((a) => typeof a === "string");
    const missing = [!has("telephone") && "telephone", !sab && !has("address.streetAddress") && !pick(biz, "address", g.resolve).some((a) => typeof a === "string") && "address.streetAddress",
      !has("openingHoursSpecification") && !has("openingHours") && "openingHoursSpecification"].filter(Boolean);
    if (missing.length) problems.push(`${typesOf(biz)[0]} markup has no ${missing.join(", ")}`);
    if (!street && !sab) street = normText(pick(biz, "address.streetAddress", g.resolve)[0] || "");
    const mh = markupHours(biz, g.resolve), th = textHours(text);
    const diff = [...mh].filter(([d, v]) => th.has(d) && th.get(d) !== v).slice(0, 2);
    if (diff.length) problems.push(`hours differ: ${diff.map(([d, v]) => `${DAYS[d]} page ${fmt(th.get(d))}, markup ${fmt(v)}`).join("; ")}`);
  }
  if (settings.napPhone && !text.replace(/\D/g, "").includes(phoneKey(settings.napPhone))) problems.push(`phone ${settings.napPhone} (Settings) isn't in the home page text`);
  if (street && !normText(text).includes(street)) problems.push(`street address "${street}" isn't in the home page text`);
  return problems.length ? [["local_nap_missing", home.url, problems.join("; ")]] : [];
}
