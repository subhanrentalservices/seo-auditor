// Structured data as Google reads it (REQ-044 build rows 11, 12, 42, 43, 44; Google's structured data docs, fetched
// 2026-10-26): required and recommended properties per rich-result type, marked-up values the page doesn't show,
// retired rich-result types, date problems and conflicting entities on one page. Pure functions: parseHtml passes in
// the parsed JSON-LD blocks and the page's visible text; the page rules turn the findings into issues.
// Site-level rules (site name, local NAP, merchant policies) are in schema-site.mjs.
import { readFileSync } from "node:fs";

const RETIRED = (() => { try { return JSON.parse(readFileSync(new URL("./retired-schema.json", import.meta.url), "utf8")); } catch { return { features: [], contexts: [] }; } })();

// ---- the JSON-LD graph ----
export const typesOf = (o) => [].concat(o?.["@type"] || []).map((t) => String(t).replace(/^(https?:\/\/schema\.org\/|schema:)/i, ""));
const own = (o) => Object.keys(o).filter((k) => !k.startsWith("@"));
const filled = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.some(filled));

/** JSON-LD blocks → { entities: [{ node, top, slots }], resolve }. Nodes sharing an @id are one entity (properties
 *  combined); a bare {"@id"} reference resolves to the node it names. top = a block's root, an @graph member or a
 *  top node's mainEntity; nested nodes (publisher, author, offers…) keep the property names they sit under (slots). */
export function ldGraph(docs) {
  const occ = [];
  const walk = (o, slot, top) => {
    if (Array.isArray(o)) return o.forEach((x) => walk(x, slot, top));
    if (!o || typeof o !== "object") return;
    if (o["@type"] || o["@id"]) occ.push([o, slot, top]);
    for (const [k, v] of Object.entries(o)) {
      if (k === "@graph") walk(v, null, true);
      else if (!k.startsWith("@")) walk(v, k, top && k === "mainEntity" && Boolean(o["@type"] || o["@id"]));
    }
  };
  for (const d of docs) walk(d, null, true);
  const byId = new Map();
  for (const [o] of occ) {
    const id = o["@id"];
    if (!id || !own(o).length) continue;
    const prev = byId.get(id);
    byId.set(id, prev ? { ...o, ...prev, "@type": [...new Set([...typesOf(prev), ...typesOf(o)])] } : { ...o });
  }
  const resolve = (v) => (v && typeof v === "object" && !Array.isArray(v) && v["@id"] && byId.has(v["@id"]) ? byId.get(v["@id"]) : v);
  const ents = new Map();
  for (const [o, slot, top] of occ) {
    const node = resolve(o);
    if (!own(node).length) continue; // a reference to something not described on this page
    const e = ents.get(node) || { node, top: false, slots: new Set() };
    e.top ||= top;
    if (slot) e.slots.add(slot);
    ents.set(node, e);
  }
  return { entities: [...ents.values()], resolve };
}

/** Values at a dotted path ("author.name"), through arrays and @id references; empty values left out. */
export function pick(o, path, resolve = (x) => x) {
  let cur = [resolve(o)];
  for (const k of path.split(".")) cur = cur.flatMap((x) => (x && typeof x === "object" ? [].concat(x[k] ?? []) : [])).map(resolve);
  return cur.filter(filled);
}

// ---- type families ----
export const LOCAL_BUSINESS = /^(LocalBusiness|[A-Za-z]*(Store|Restaurant|Contractor|Salon|Dealer|Repair|Clinic|Shop|Agency)|[A-Za-z]+Business|FoodEstablishment|AutoRental|AutoWash|GasStation|Dentist|Physician|Pharmacy|Optician|Plumber|Electrician|Locksmith|MovingCompany|Attorney|Notary|Bakery|BarOrPub|Winery|Brewery|Distillery|Hotel|Motel|Hostel|Resort|BedAndBreakfast|Campground|DaySpa|HealthClub|ExerciseGym|ChildCare|DryCleaningOrLaundry|RealEstateAgent|AccountingService|LegalService|FinancialService|ProfessionalService|EmergencyService|HousePainter|TattooParlor|SelfStorage|ShoppingCenter|Bank|CreditUnion)$/;
const isLocal = (types) => types.some((t) => LOCAL_BUSINESS.test(t) && !/^Online(Business|Store)$/.test(t));
const isOrg = (types) => types.some((t) => /^([A-Za-z]*Organization|Corporation|NGO|Airline|Consortium|OnlineBusiness|OnlineStore)$/.test(t));
const ARTICLE = /^(Article|BlogPosting|LiveBlogPosting|[A-Za-z]*NewsArticle|TechArticle|ScholarlyArticle|Report|SatiricalArticle)$/;
const EVENT = /^(?!(Broadcast|Publication|OnDemand)Event$)[A-Za-z]*Event$|^(Festival|EventSeries)$/;

/** Price written in markup → number ("1299.00", 1299, "$1,299") or NaN. */
const num = (v) => parseFloat(String(v ?? "").replace(/[^\d.,-]/g, "").replace(/,/g, ""));

/** Missing required ("req") and recommended ("rec") properties per Google's structured data docs, for the rich-result
 *  types Google documents. Only top-level nodes with at least two properties are checked by type; nested nodes are
 *  checked only for what Google lists for that slot (a Product's offers, reviews and rating). VideoObject is checked
 *  separately (video_schema_incomplete). JobPosting and Recipe follow Google's pages for those types. */
export function missingProps({ entities, resolve }) {
  const req = new Set(), rec = new Set();
  const has = (o, path) => pick(o, path, resolve).length > 0;
  const need = (set, label, o, paths) => { for (const p of paths) if (!p.split("|").some((x) => has(o, x))) set.add(`${label}: ${p.replace(/\|/g, " or ")}`); };
  const offer = (o) => {
    const t = typesOf(o);
    if (t.includes("AggregateOffer")) { need(req, "AggregateOffer", o, ["lowPrice", "priceCurrency"]); need(rec, "AggregateOffer", o, ["highPrice", "offerCount"]); return; }
    need(req, "Offer", o, ["price|priceSpecification.price"]);
    if (!has(o, "priceCurrency") && !has(o, "priceSpecification.priceCurrency")) rec.add("Offer: priceCurrency (required for merchant listings)");
    need(rec, "Offer", o, ["availability"]);
  };
  const review = (o, nested) => need(req, "Review", o, nested ? ["author", "reviewRating.ratingValue"] : ["author", "itemReviewed.name", "reviewRating.ratingValue"]);
  const rating = (o, nested) => need(req, "AggregateRating", o, nested ? ["ratingValue", "ratingCount|reviewCount"] : ["itemReviewed.name", "ratingValue", "ratingCount|reviewCount"]);
  for (const { node: o, top } of entities) {
    // A node with a single name, url or sameAs is a pointer to an entity described elsewhere, not one to validate.
    if (!top || (own(o).length < 2 && ["name", "url", "sameAs"].includes(own(o)[0]))) continue;
    const t = typesOf(o);
    if (t.includes("Product")) {
      need(req, "Product", o, ["name", "offers|review|aggregateRating"]);
      if (!has(o, "image")) rec.add("Product: image (required for merchant listings)");
      pick(o, "offers", resolve).forEach(offer);
      pick(o, "review", resolve).forEach((r) => review(r, true));
      pick(o, "aggregateRating", resolve).forEach((r) => rating(r, true));
    } else if (isLocal(t)) {
      need(req, t[0], o, ["name", "address"]);
      need(rec, t[0], o, ["telephone", "url", "openingHoursSpecification|openingHours"]);
      if (pick(o, "address", resolve).some((a) => typeof a === "object") && !has(o, "address.streetAddress")) rec.add(`${t[0]}: address.streetAddress`);
    } else if (isOrg(t)) {
      need(rec, t[0], o, ["name"]);
      const logo = pick(o, "logo", resolve)[0];
      const logoUrl = typeof logo === "string" ? logo : logo && (logo.url || logo.contentUrl || logo["@id"]);
      if (logo && !/^https?:\/\//i.test(String(logoUrl || ""))) rec.add(`${t[0]}: logo as an absolute image URL`);
    } else if (t.some((x) => ARTICLE.test(x))) {
      need(rec, t.find((x) => ARTICLE.test(x)), o, ["headline", "image", "datePublished", "author"]);
      if (pick(o, "author", resolve).some((a) => typeof a === "object" && !a.name)) rec.add(`${t.find((x) => ARTICLE.test(x))}: author.name`);
    } else if (t.includes("BreadcrumbList")) {
      const items = pick(o, "itemListElement", resolve);
      if (items.length < 2) req.add(`BreadcrumbList: at least two ListItems in itemListElement (has ${items.length})`);
      items.forEach((li, i) => {
        if (typeof li !== "object") return;
        const item = resolve(li.item), miss = [];
        if (!filled(li.position)) miss.push("position");
        if (!filled(li.name) && !(item && typeof item === "object" && item.name)) miss.push("name");
        // item may be left out of the last crumb only (Google uses the page's own URL).
        if (i < items.length - 1 && !(typeof item === "string" ? item : item?.["@id"] || item?.url)) miss.push("item");
        if (miss.length) req.add(`ListItem ${i + 1}: ${miss.join(", ")}`);
      });
    } else if (t.some((x) => EVENT.test(x))) {
      need(req, "Event", o, ["name", "startDate", "location"]);
      if (pick(o, "location", resolve).some((l) => typeof l === "object" && typesOf(l).includes("Place") && !filled(l.address))) req.add("Event: location.address");
      need(rec, "Event", o, ["description", "endDate", "eventStatus", "image", "offers", "organizer", "performer"]);
    } else if (t.includes("JobPosting")) {
      need(req, "JobPosting", o, ["datePosted", "description", "hiringOrganization", "jobLocation|applicantLocationRequirements", "title"]);
      need(rec, "JobPosting", o, ["baseSalary", "employmentType", "identifier", "validThrough"]);
    } else if (t.includes("Recipe")) {
      need(req, "Recipe", o, ["name", "image"]);
      need(rec, "Recipe", o, ["author", "datePublished", "description", "recipeIngredient", "recipeInstructions"]);
    } else if (t.includes("Review")) review(o, false);
    else if (t.includes("AggregateRating")) rating(o, false);
  }
  return { req: [...req], rec: [...rec] };
}

// ---- values the page doesn't show (row 12) ----
/** Every number written in the text, read both ways ("1,299.00" and "1.299,00" → 1299). */
export function amounts(text) {
  const out = new Set();
  for (const [s] of String(text).matchAll(/\d[\d.,]*\d|\d/g)) { out.add(+s.replace(/,/g, "")); out.add(+s.replace(/\./g, "").replace(",", ".")); }
  return [...out].filter(Number.isFinite);
}
const PLACEHOLDER = /\{\{[^}]*\}\}|\$\{[^}]*\}|\[(?:price|name|title|phone|telephone|address|city|date|url|image|description|brand|sku|currency)\]|^(?:undefined|NaN|null|\[object Object\])$/i;
/** Last 8 digits of a phone number: the part every written form shares (+61 3 9000 1234 / (03) 9000 1234). */
export const phoneKey = (s) => String(s || "").replace(/\D/g, "").slice(-8);

/** Marked-up values the visible text doesn't contain: Offer price (±1%), availability against "sold out" / "in stock"
 *  wording (one product only), rating/review counts, LocalBusiness telephone digits; and unfilled template values. */
export function hiddenValues({ entities, resolve }, docs, text) {
  const out = []; let price = false;
  const nums = amounts(text), digits = String(text).replace(/\D/g, "");
  const products = entities.filter((e) => e.top && typesOf(e.node).includes("Product"));
  const offers = products.flatMap((e) => pick(e.node, "offers", resolve)).filter((o) => typeof o === "object" && !typesOf(o).includes("AggregateOffer"));
  for (const o of offers) {
    const p = num(o.price ?? resolve(o.priceSpecification)?.price);
    if (!(p > 0) || nums.some((v) => Math.abs(v - p) <= p * 0.01)) continue;
    out.push(`Offer price ${o.price ?? o.priceSpecification?.price} isn't in the page text`); price = true; break;
  }
  if (products.length === 1 && offers.length === 1) {
    const av = String(offers[0].availability || "");
    if (/InStock$/i.test(av) && /sold out|out of stock|unavailable/i.test(text)) out.push("availability InStock, but the page says sold out / out of stock / unavailable");
    else if (/(OutOfStock|SoldOut|Discontinued)$/i.test(av) && /(?<!out of |not |no longer )\bin stock\b/i.test(text)) out.push(`availability ${av.split("/").pop()}, but the page says in stock`);
  }
  for (const { node } of entities.filter((e) => typesOf(e.node).includes("AggregateRating"))) {
    const n = num(node.ratingCount ?? node.reviewCount);
    if (n > 0 && !nums.includes(n)) { out.push(`${node.ratingCount !== undefined ? "ratingCount" : "reviewCount"} ${n} isn't in the page text`); break; }
  }
  for (const { node } of entities.filter((e) => e.top && isLocal(typesOf(e.node)))) {
    const k = phoneKey(pick(node, "telephone", resolve)[0]);
    if (k.length >= 6 && !digits.includes(k)) { out.push(`telephone ${pick(node, "telephone", resolve)[0]} isn't in the page text`); break; }
  }
  const strings = (o, path) => {
    if (typeof o === "string") return PLACEHOLDER.test(o) ? [`${path}: "${o.slice(0, 40)}"`] : [];
    if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => strings(v, Array.isArray(o) ? path : k));
    return [];
  };
  const ph = docs.flatMap((d) => strings(d, ""));
  if (ph.length) out.push(`unfilled template value ${ph[0]}`);
  return { hidden: out, price };
}

// ---- retired rich-result types (row 42) ----
/** Features in retired-schema.json found in the JSON-LD graph, the @context values or microdata itemtypes. */
export function retiredFeatures({ entities, resolve }, docs, itemtypes = [], list = RETIRED) {
  const found = new Set();
  for (const { node } of entities) {
    const t = typesOf(node);
    for (const f of list.features || []) {
      if (f.types && !f.types.some((x) => t.includes(x))) continue;
      if (f.allTypes && !f.allTypes.every((x) => t.includes(x))) continue;
      if (f.typePattern && !t.some((x) => new RegExp(f.typePattern).test(x))) continue;
      if (f.unlessTypes?.some((x) => t.includes(x))) continue;
      if (f.property) {
        const v = pick(node, f.property, resolve);
        if (!v.length || (f.valueTypes && !v.some((x) => typesOf(x).some((y) => f.valueTypes.includes(y))))) continue;
      }
      found.add(`${f.name} (since ${f.since})`);
    }
  }
  const micro = itemtypes.flatMap((s) => String(s).split(/\s+/)).filter(Boolean);
  for (const f of list.features || []) {
    if (f.property || f.allTypes || f.typePattern) continue; // microdata: whole types only
    if (micro.some((u) => f.types.includes(u.split("/").pop()))) found.add(`${f.name} (microdata, since ${f.since})`);
  }
  const ctx = JSON.stringify(docs.map((d) => [].concat(d).map((x) => x?.["@context"]))) + " " + micro.join(" ");
  for (const c of list.contexts || []) if (ctx.includes(c.match)) found.add(`${c.name} (since ${c.since})`);
  return [...found];
}

// ---- dates (row 43) ----
const DATE_PROPS = ["datePublished", "dateModified", "uploadDate"];
const day = (s) => (String(s).match(/^\d{4}-\d{2}-\d{2}/) || [null])[0];
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
/** Date problems Google's docs name: a time without a time zone (Google then assumes Googlebot's), dateModified
 *  before datePublished, and a JSON-LD date that disagrees with the single visible "Published / Updated" date.
 *  Future dates need the audit date and are checked in the page rule (latest). startDate is left out: Google reads an
 *  event's time in the event location's zone. */
export function dateProblems({ entities }, stated = { p: [], m: [] }) {
  const out = []; let latest = null;
  const ld = { p: new Set(), m: new Set() };
  for (const { node } of entities) {
    const t = typesOf(node)[0] || "node";
    for (const k of DATE_PROPS) {
      const v = typeof node[k] === "string" ? node[k].trim() : null;
      if (!v) continue;
      if (/T\d\d:\d\d/.test(v) && !/(Z|[+-]\d\d:?\d\d)$/i.test(v)) out.push(`${t}.${k} "${v}" has a time but no time zone`);
      if (day(v) && (!latest || day(v) > latest.day)) latest = { day: day(v), prop: `${t}.${k}`, value: v };
      if (k !== "uploadDate" && day(v)) ld[k === "dateModified" ? "m" : "p"].add(day(v));
    }
    const p = node.datePublished, m = node.dateModified;
    if (typeof p === "string" && typeof m === "string" && day(p) && day(m)) {
      const full = (s) => /T\d\d:\d\d.*(Z|[+-]\d\d:?\d\d)$/i.test(s);
      if (full(p) && full(m) ? Date.parse(m) < Date.parse(p) : day(m) < day(p)) out.push(`${t}.dateModified ${m} is before datePublished ${p}`);
    }
  }
  for (const k of ["p", "m"]) {
    const shown = [...new Set(stated[k] || [])], marked = [...ld[k]];
    if (shown.length === 1 && marked.length === 1 && dayDiff(shown[0], marked[0]) > 1)
      out.push(`the page shows ${k === "p" ? "published" : "updated"} ${shown[0]}, the markup says ${marked[0]}`);
  }
  return { problems: out, latest };
}

// ---- conflicting entities (row 44) ----
const nameKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ")
  .replace(/\b(pty|ltd|limited|inc|llc|gmbh|co|corp|corporation|plc)\b/g, " ").replace(/\s+/g, " ").trim();
const LINKS = ["parentOrganization", "subOrganization", "department", "branchOf", "memberOf", "member", "brand", "owns"];
/** Two top-level business nodes (Organization or LocalBusiness family) on one page that disagree on name, telephone
 *  or street address, or two Product nodes with the same name or sku and different prices. Nodes with the same @id
 *  are one entity already; nodes linked as parent/branch/department are separate on purpose and not compared. */
export function conflictingEntities({ entities, resolve }) {
  const biz = entities.filter((e) => e.top && (isLocal(typesOf(e.node)) || isOrg(typesOf(e.node)))).map((e) => e.node);
  const linked = (a, b) => LINKS.some((k) => pick(a, k, resolve).includes(b) || pick(b, k, resolve).includes(a));
  for (let i = 0; i < biz.length; i++) for (let j = i + 1; j < biz.length; j++) {
    const [a, b] = [biz[i], biz[j]];
    if (linked(a, b)) continue;
    const first = (o, p) => pick(o, p, resolve)[0];
    const checks = [["name", nameKey], ["telephone", phoneKey], ["address.streetAddress", nameKey]];
    for (const [p, key] of checks) {
      const x = first(a, p), y = first(b, p);
      if (typeof x === "string" && typeof y === "string" && key(x) && key(y) && key(x) !== key(y))
        return `${typesOf(a)[0]} ${p} "${String(x).slice(0, 50)}" vs ${typesOf(b)[0]} ${p} "${String(y).slice(0, 50)}"`;
    }
  }
  const prods = entities.filter((e) => e.top && typesOf(e.node).includes("Product")).map((e) => e.node);
  for (let i = 0; i < prods.length; i++) for (let j = i + 1; j < prods.length; j++) {
    const [a, b] = [prods[i], prods[j]];
    const same = (a.sku && a.sku === b.sku) || (nameKey(a.name) && nameKey(a.name) === nameKey(b.name));
    const pa = num(pick(a, "offers.price", resolve)[0]), pb = num(pick(b, "offers.price", resolve)[0]);
    if (same && pa > 0 && pb > 0 && pa !== pb) return `two Product nodes for "${String(a.name || a.sku).slice(0, 50)}" with prices ${pa} and ${pb}`;
  }
  return null;
}

/** Everything parseHtml stores about a page's structured data. docs = the parsed JSON-LD blocks; text = the page's
 *  visible text; stated = visible "Published / Updated" dates as yyyy-mm-dd; ogSiteName; itemtypes = microdata. */
export function schemaFindings(docs, { text = "", stated, ogSiteName, itemtypes = [] } = {}) {
  const d = {};
  const g = ldGraph(docs);
  const miss = missingProps(g);
  if (miss.req.length || miss.rec.length) d.schemaMissing = { req: miss.req.slice(0, 8), rec: miss.rec.slice(0, 8) };
  const h = hiddenValues(g, docs, text);
  if (h.hidden.length) { d.schemaHidden = h.hidden.slice(0, 4); if (h.price) d.schemaHiddenPrice = true; }
  const retired = retiredFeatures(g, docs, itemtypes);
  if (retired.length) d.schemaRetired = retired;
  const dates = dateProblems(g, stated);
  if (dates.problems.length) d.schemaDates = dates.problems.slice(0, 4);
  if (dates.latest) d.schemaLatestDate = dates.latest;
  const conflict = conflictingEntities(g);
  if (conflict) d.schemaConflict = conflict;
  // Site-level facts (schema-site.mjs): the WebSite name, og:site_name, products with prices, merchant policies.
  const site = g.entities.find((e) => e.top && typesOf(e.node).includes("WebSite"))?.node;
  if (site) d.website = { name: String(site.name || "").slice(0, 120), alt: [].concat(site.alternateName || []).map(String).slice(0, 6), url: typeof site.url === "string" ? site.url : "" };
  if (ogSiteName) d.ogSiteName = String(ogSiteName).slice(0, 120);
  const priced = g.entities.filter((e) => typesOf(e.node).includes("Product")).flatMap((e) => pick(e.node, "offers", g.resolve))
    .some((o) => num(o.price ?? o.lowPrice ?? g.resolve(o.priceSpecification)?.price) > 0);
  if (priced) d.productOffers = true;
  // Policies anywhere in the markup (Organization or Offer level; nested objects often have no @type).
  const found = (keys, types) => { const seen = (o) => Array.isArray(o) ? o.some(seen) : Boolean(o && typeof o === "object"
    && (Object.keys(o).some((k) => keys.includes(k) && filled(o[k])) || typesOf(o).some((t) => types.includes(t)) || Object.values(o).some(seen))); return docs.some(seen); };
  if (found(["hasMerchantReturnPolicy"], ["MerchantReturnPolicy"])) d.merchantReturn = true;
  if (found(["shippingDetails", "hasShippingService"], ["OfferShippingDetails", "ShippingService"])) d.merchantShipping = true;
  return d;
}

/** Page rules for the findings above (indexable pages). ctx.auditDate = yyyy-mm-dd; ctx.renderJs = false | "auto" | true (render-mode.mjs). */
export function schemaPageIssues(d, ctx = {}) {
  const out = [];
  if (d.schemaMissing?.req.length) out.push(["schema_required_missing", d.schemaMissing.req.join("; ")]);
  if (d.schemaMissing?.rec.length) out.push(["schema_recommended_missing", d.schemaMissing.rec.join("; ")]);
  if (d.schemaHidden?.length) out.push(["schema_value_not_visible", d.schemaHidden.join("; ") + (d.schemaHiddenPrice && (ctx.renderJs === false || (ctx.renderJs === "auto" && !d.rendered)) ? " (raw HTML only; enable rendering if the price is added by JavaScript)" : "")]);
  if (d.schemaRetired?.length) out.push(["schema_retired_type", d.schemaRetired.join("; ")]);
  const dates = [...(d.schemaDates || [])];
  const today = ctx.auditDate || new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(today) + 864e5).toISOString().slice(0, 10);
  if (d.schemaLatestDate && d.schemaLatestDate.day > tomorrow) dates.unshift(`${d.schemaLatestDate.prop} ${d.schemaLatestDate.value} is after the audit date ${today}`);
  if (dates.length) out.push(["schema_date_issue", dates.join("; ")]);
  if (d.schemaConflict) out.push(["schema_conflicting_entities", d.schemaConflict]);
  return out;
}
