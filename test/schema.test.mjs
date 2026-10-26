// Structured data checks (REQ-044 build rows 11, 12, 22, 23, 42-45, 2026-10-27): required/recommended properties
// per Google's structured data docs, marked-up values the page doesn't show, retired rich-result types, dates,
// conflicting entities, the site name, local NAP and merchant policies. No network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { pageIssues, CHECKS, CRAWL } = await import("../src/checks.mjs");
const { ldGraph, missingProps, amounts, retiredFeatures } = await import("../src/schema.mjs");
const { siteNameIssues, merchantPolicyIssues, localNapIssues, titleBrand, textHours, markupHours } = await import("../src/schema-site.mjs");

const S = "https://example.com";
const ctx = { siteIsHttps: true, auditDate: "2026-10-27", renderJs: false };
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const doc = (head, body = "<p>text</p>") => `<!doctype html><html lang="en"><head><title>A page title for the tests here</title>${head}</head><body>${body}</body></html>`;
/** Parse a page the way the crawler does and run the page rules: { data, issues: {id: detail} }. */
const audit = (head, body, over = {}, url = S + "/page.html") => {
  const p = parseHtml(doc(head, body), url);
  const page = { url, final_url: url, status: 200, content_type: "text/html", indexable: 1, title: p.title, description: "x".repeat(130), h1: p.h1,
    words: 400, text_ratio: 20, depth: 1, outlinks: 1, inlinks: 2, canonical: url, data: p.data, ...over };
  return { data: p.data, issues: Object.fromEntries(pageIssues(page, ctx)) };
};
const missing = (...nodes) => missingProps(ldGraph(nodes));

test("the structured data checks are catalogued with Google's severities and stay out of Crawlability", () => {
  const sev = { schema_required_missing: "warning", schema_recommended_missing: "notice", schema_value_not_visible: "warning", site_name_markup: "notice",
    local_nap_missing: "notice", schema_retired_type: "notice", schema_date_issue: "notice", schema_conflicting_entities: "notice", merchant_policy_missing: "notice" };
  for (const [id, s] of Object.entries(sev)) { assert.equal(CHECKS[id]?.[0], s, id); assert.equal(CHECKS[id].length, 4, id); assert.ok(!CRAWL.has(id), id); }
});

// ---- Row 11: required and recommended properties ----
test("Product needs a name and one of offers, review or aggregateRating; an Offer needs a price", () => {
  assert.deepEqual(missing({ "@type": "Product", name: "Widget", image: S + "/w.jpg" }).req, ["Product: offers or review or aggregateRating"]);
  assert.deepEqual(missing({ "@type": "Product", name: "Widget" }), { req: [], rec: [] }, "a node with only a name points to an entity described elsewhere");
  const m = missing({ "@type": "Product", name: "Widget", offers: { "@type": "Offer", availability: "https://schema.org/InStock" } });
  assert.deepEqual(m.req, ["Offer: price or priceSpecification.price"]);
  assert.ok(m.rec.includes("Offer: priceCurrency (required for merchant listings)") && m.rec.includes("Product: image (required for merchant listings)"));
  const ok = missing({ "@type": "Product", name: "Widget", image: S + "/w.jpg", offers: { "@type": "Offer", priceSpecification: { "@type": "UnitPriceSpecification", price: 10, priceCurrency: "AUD" }, availability: "InStock" } });
  assert.deepEqual(ok, { req: [], rec: [] }, "price may sit in priceSpecification");
  assert.deepEqual(missing({ "@type": "Product", name: "Widget", image: "x", offers: { "@type": "AggregateOffer", lowPrice: 5, priceCurrency: "AUD", highPrice: 9, offerCount: 3 } }), { req: [], rec: [] });
  const rated = missing({ "@type": "Product", name: "Widget", image: "x", aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 }, review: { "@type": "Review", reviewRating: { ratingValue: 5 } } });
  assert.deepEqual(rated.req.sort(), ["AggregateRating: ratingCount or reviewCount", "Review: author"], "nested ratings don't need itemReviewed");
});

test("nested nodes are checked only for their slot; @id references and nodes sharing an @id count once", () => {
  const article = { "@type": "BlogPosting", headline: "H", image: S + "/i.jpg", datePublished: "2026-01-01", author: { "@type": "Person", name: "A Writer" },
    publisher: { "@id": S + "/#org" } };
  const org = { "@type": "Organization", "@id": S + "/#org", name: "Example Shop", logo: S + "/logo.png" };
  assert.deepEqual(missing({ "@graph": [article, org] }), { req: [], rec: [] });
  assert.deepEqual(missing({ ...article, publisher: { "@type": "Organization", name: "Example Shop" } }), { req: [], rec: [] }, "a nested publisher isn't checked as an Organization");
  assert.deepEqual(missing({ "@type": "Organization", name: "Example Shop", logo: "/logo.png" }).rec, ["Organization: logo as an absolute image URL"]);
  assert.deepEqual(missing({ "@type": "BlogPosting", headline: "H" }).rec, ["BlogPosting: image", "BlogPosting: datePublished", "BlogPosting: author"]);
  // Two blocks describe one business by @id: name in one, address in the other.
  assert.deepEqual(missing({ "@type": "LocalBusiness", "@id": S + "/#biz", name: "Example Shop", url: S }, { "@type": "LocalBusiness", "@id": S + "/#biz",
    address: { "@type": "PostalAddress", streetAddress: "1 Example Street" }, telephone: "+1 555 0100", openingHours: "Mo-Fr 09:00-17:00" }), { req: [], rec: [] });
  assert.deepEqual(missing({ "@type": "Thing", "@id": S + "/#x" }), { req: [], rec: [] }, "a bare reference isn't validated");
});

test("LocalBusiness, BreadcrumbList, Event, JobPosting, Review and Recipe rules follow Google's tables", () => {
  const biz = missing({ "@type": "AutoRepair", name: "Example Garage", address: { "@type": "PostalAddress", addressLocality: "Exampletown" } });
  assert.deepEqual(biz.req, []);
  assert.deepEqual(biz.rec, ["AutoRepair: telephone", "AutoRepair: url", "AutoRepair: openingHoursSpecification or openingHours", "AutoRepair: address.streetAddress"]);
  assert.deepEqual(missing({ "@type": "Store", name: "Example Store", telephone: "1" }).req, ["Store: address"]);
  assert.deepEqual(missing({ "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: S + "/" }] }).req,
    ["BreadcrumbList: at least two ListItems in itemListElement (has 1)"]);
  const crumbs = (items) => missing({ "@type": "BreadcrumbList", itemListElement: items }).req;
  assert.deepEqual(crumbs([{ "@type": "ListItem", position: 1, name: "Home", item: S + "/" }, { "@type": "ListItem", position: 2, name: "Here" }]), [], "the last crumb may leave out item");
  assert.deepEqual(crumbs([{ "@type": "ListItem", position: 1, item: { "@id": S + "/", name: "Home" } }, { "@type": "ListItem", name: "Here" }]), ["ListItem 2: position"]);
  assert.deepEqual(crumbs([{ "@type": "ListItem", position: 1, name: "Home" }, { "@type": "ListItem", position: 2, name: "Here" }]), ["ListItem 1: item"]);
  const ev = missing({ "@type": "MusicEvent", name: "Gig", startDate: "2026-12-01T19:00", location: { "@type": "Place", name: "Hall" } });
  assert.deepEqual(ev.req, ["Event: location.address"]);
  const remote = missing({ "@type": "JobPosting", title: "Dev", description: "d", datePosted: "2026-10-01", hiringOrganization: { name: "Example Shop" },
    applicantLocationRequirements: { "@type": "Country", name: "AU" }, jobLocationType: "TELECOMMUTE" });
  assert.deepEqual(remote.req, [], "remote jobs may use applicantLocationRequirements instead of jobLocation");
  assert.deepEqual(missing({ "@type": "Review", reviewRating: { ratingValue: 4 }, author: { name: "A" } }).req, ["Review: itemReviewed.name"]);
  assert.deepEqual(missing({ "@type": "Recipe", name: "Soup", description: "d" }).req, ["Recipe: image"]);
});

test("missing properties become page issues on indexable pages only", () => {
  const head = ld({ "@type": "Product", name: "Widget", sku: "W1" });
  const r = audit(head, "<p>Widget</p>");
  assert.match(r.issues.schema_required_missing, /Product: offers or review or aggregateRating/);
  assert.match(r.issues.schema_recommended_missing, /Product: image/);
  assert.equal(audit(head, "<p>Widget</p>", { indexable: 0 }).issues.schema_required_missing, undefined);
  const services = audit(ld({ "@type": "LocalBusiness", name: "Example Shop", address: { streetAddress: "1 Example Street" }, telephone: "555 0100", url: S, openingHours: "Mo-Fr 09:00-17:00",
    hasOfferCatalog: { "@type": "OfferCatalog", itemListElement: [{ "@type": "Offer", itemOffered: { "@type": "Service", name: "Repairs" } }] } }), "<p>Call 555 0100</p>");
  assert.equal(services.issues.schema_required_missing, undefined, "a service Offer outside a Product needs no price");
  assert.equal(services.data.productOffers, undefined);
});

// ---- Row 12: values the page doesn't show ----
test("numbers are read in both decimal styles", () => {
  for (const s of ["$1,299", "1.299,00 €", "1299.00", "AUD 1299"]) assert.ok(amounts(s).includes(1299), s);
});

test("price, availability, rating count, phone and template values must match the page", () => {
  const product = (offer, extra = {}) => ld({ "@type": "Product", name: "Widget", image: "x", offers: { "@type": "Offer", priceCurrency: "EUR", availability: "https://schema.org/InStock", ...offer }, ...extra });
  assert.equal(audit(product({ price: "1299.00" }), "<p>Now 1.299,00 €</p>").issues.schema_value_not_visible, undefined);
  const hidden = audit(product({ price: "1299.00" }), "<p>Now 999 €</p>").issues.schema_value_not_visible;
  assert.match(hidden, /Offer price 1299.00 isn't in the page text/);
  assert.match(hidden, /raw HTML only/, "rendering off: the price may come from JavaScript");
  assert.match(audit(product({ price: 20 }), "<p>20.00 - Sold out</p>").issues.schema_value_not_visible, /availability InStock, but the page says sold out/);
  assert.match(audit(product({ price: 20, availability: "https://schema.org/OutOfStock" }), "<p>$20 In stock now</p>").issues.schema_value_not_visible, /OutOfStock, but the page says in stock/);
  assert.equal(audit(product({ price: 20, availability: "https://schema.org/OutOfStock" }), "<p>$20 Out of stock</p>").issues.schema_value_not_visible, undefined);
  assert.match(audit(product({ price: 20 }, { aggregateRating: { "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 1234 } }), "<p>$20, 4.6 stars</p>").issues.schema_value_not_visible,
    /reviewCount 1234 isn't in the page text/);
  assert.equal(audit(product({ price: 20 }, { aggregateRating: { ratingValue: 4.6, reviewCount: 1234 } }), "<p>$20, 4.6 stars from 1,234 reviews</p>").issues.schema_value_not_visible, undefined);
  const biz = (tel) => ld({ "@type": "LocalBusiness", name: "Example Shop", address: { streetAddress: "1 Example Street" }, telephone: tel });
  assert.equal(audit(biz("+61 3 9000 0000"), "<p>Call (03) 9000 0000</p>").issues.schema_value_not_visible, undefined, "another written form of the same number");
  assert.match(audit(biz("+1 555 010 0199"), "<p>Call us</p>").issues.schema_value_not_visible, /telephone \+1 555 010 0199/);
  assert.match(audit(ld({ "@type": "Product", name: "{{ product.title }}", offers: { price: "10" } }), "<p>10</p>").issues.schema_value_not_visible, /unfilled template value name/);
  assert.equal(audit(ld({ "@type": "Product", name: "W", offers: { "@type": "AggregateOffer", lowPrice: 5, highPrice: 9, priceCurrency: "AUD" } }), "<p>From $6</p>").issues.schema_value_not_visible,
    undefined, "AggregateOffer ranges aren't checked");
});

// ---- Row 42: retired rich-result types ----
test("retired types are information; Book actions, plain VideoObject and Course lists are not retired", () => {
  const r = audit(ld({ "@type": "HowTo", name: "x", step: [] }) + ld({ "@type": "WebSite", name: "Example", url: S + "/", potentialAction: { "@type": "SearchAction", target: S + "/?q={q}" } }), "<p>x</p>");
  assert.match(r.issues.schema_retired_type, /HowTo rich result \(since 2023-09-14\)/);
  assert.match(r.issues.schema_retired_type, /Sitelinks search box/);
  assert.match(audit(ld({ "@type": "FAQPage", mainEntity: [] }), "<p>x</p>").issues.schema_retired_type, /FAQ rich result \(since 2026-05-07\)/);
  assert.match(audit("", '<div itemscope itemtype="http://data-vocabulary.org/Breadcrumb">x</div>').issues.schema_retired_type, /data-vocabulary\.org/);
  assert.match(audit("", '<div itemscope itemtype="https://schema.org/HowTo">x</div>').issues.schema_retired_type, /HowTo rich result \(microdata/);
  assert.match(audit(ld({ "@type": "Event", name: "Talk", startDate: "2026-12-01", location: { "@type": "VirtualLocation", url: S + "/live" } }), "<p>x</p>").issues.schema_retired_type, /VirtualLocation/);
  const g = (o) => retiredFeatures(ldGraph([o]), [o]);
  assert.deepEqual(g({ "@type": "Book", name: "B", potentialAction: { "@type": "ReadAction", target: S } }), []);
  assert.deepEqual(g({ "@type": "VideoObject", name: "V", thumbnailUrl: "x", uploadDate: "2026-01-01" }), []);
  assert.deepEqual(g({ "@type": "Course", name: "C", description: "d", provider: { name: "P" } }), []);
  assert.equal(g({ "@type": ["VideoObject", "LearningResource"], name: "V" }).length, 1);
  assert.equal(g({ "@type": "Car", name: "Hatch", offers: { price: 1 } }).length, 1);
  assert.deepEqual(g({ "@type": ["Product", "Car"], name: "Hatch", offers: { price: 1 } }), []);
});

// ---- Row 43: dates ----
test("dates: a time without a zone, modified before published, future dates and a visible date that disagrees", () => {
  const post = (o, body = "<p>x</p>") => audit(ld({ "@type": "BlogPosting", headline: "H", image: "x", author: { name: "A" }, ...o }), body).issues.schema_date_issue;
  assert.match(post({ datePublished: "2026-01-05T09:00:00" }), /datePublished "2026-01-05T09:00:00" has a time but no time zone/);
  assert.equal(post({ datePublished: "2026-01-05T09:00:00+11:00", dateModified: "2026-02-01" }), undefined);
  assert.equal(post({ datePublished: "2026-01-05" }), undefined, "date-only is fine");
  assert.match(post({ datePublished: "2026-03-01", dateModified: "2026-02-01" }), /dateModified 2026-02-01 is before datePublished 2026-03-01/);
  assert.match(post({ datePublished: "2026-12-01" }), /2026-12-01 is after the audit date 2026-10-27/);
  assert.equal(post({ datePublished: "2026-10-28T08:00:00+11:00" }), undefined, "one day ahead is a time-zone difference, not a future date");
  assert.match(post({ datePublished: "2024-03-01" }, "<p>Published 5 January 2024</p>"), /the page shows published 2024-01-05, the markup says 2024-03-01/);
  assert.equal(post({ datePublished: "2024-01-05" }, "<p>Published 5 January 2024</p>"), undefined);
  assert.equal(audit(ld({ "@type": "Event", name: "E", startDate: "2027-05-01T19:00", location: { "@type": "Place", address: "1 Example Street" } }), "<p>x</p>").issues.schema_date_issue,
    undefined, "event start dates are read in the event's time zone and may be in the future");
});

// ---- Row 44: conflicting entities ----
test("two business nodes that disagree are flagged; one @id, linked branches and legal-form words are not", () => {
  const org = { "@type": "Organization", name: "Example Shop Pty Ltd", telephone: "+61 3 9000 0000" };
  const biz = { "@type": "LocalBusiness", name: "Example Shop", telephone: "(03) 9000 1111", address: { streetAddress: "1 Example Street" } };
  assert.match(audit(ld({ "@graph": [org, biz] }), "<p>(03) 9000 1111</p>").issues.schema_conflicting_entities, /telephone "\+61 3 9000 0000" vs LocalBusiness telephone "\(03\) 9000 1111"/);
  assert.equal(audit(ld({ "@graph": [org, { ...biz, telephone: "03 9000 0000" }] }), "<p>03 9000 0000</p>").issues.schema_conflicting_entities, undefined, "Pty Ltd is ignored; same number");
  assert.equal(audit(ld({ "@graph": [{ ...org, "@id": S + "/#o" }, { ...biz, parentOrganization: { "@id": S + "/#o" } }] }), "<p>x</p>").issues.schema_conflicting_entities, undefined);
  assert.equal(audit(ld({ ...biz, "@id": S + "/#b" }) + ld({ "@type": "LocalBusiness", "@id": S + "/#b", telephone: "(03) 9000 2222" }), "<p>(03) 9000 1111</p>").issues.schema_conflicting_entities,
    undefined, "one @id is one entity");
  const p = (price) => ({ "@type": "Product", name: "Widget", sku: "W1", offers: { price } });
  assert.match(audit(ld(p(10)) + ld(p(12)), "<p>10 12</p>").issues.schema_conflicting_entities, /two Product nodes for "Widget" with prices 10 and 12/);
  assert.equal(audit(ld(p(10)) + ld({ ...p(12), name: "Gadget", sku: "G1" }), "<p>10 12</p>").issues.schema_conflicting_entities, undefined, "different products");
});

// ---- Row 22: site name ----
const sitePage = (url, title, data = {}) => ({ url: S + url, final_url: S + url, status: 200, content_type: "text/html", indexable: 1, title, data });
test("site name: WebSite markup on the home page, matching og:site_name and the title brand; subdirectory markup is ignored", () => {
  const titles = ["Brakes | Example Shop", "Tyres | Example Shop", "Contact | Example Shop"].map((t, i) => sitePage(`/p${i}.html`, t));
  const home = (data) => sitePage("/", "Example Shop | Repairs", data);
  assert.equal(titleBrand(titles.map((p) => p.title)), "Example Shop");
  assert.equal(titleBrand(["A | X", "B | Y", "C | Z"]), null, "no consistent brand");
  assert.match(siteNameIssues([home({}), ...titles], S + "/")[0][2], /no WebSite structured data with a name/);
  assert.deepEqual(siteNameIssues([home({ website: { name: "Example Shop", alt: [], url: S + "/" }, ogSiteName: "Example Shop" }), ...titles], S + "/"), []);
  const off = siteNameIssues([home({ website: { name: "ES", alt: [], url: "" }, ogSiteName: "Example Shop" }), ...titles], S + "/")[0][2];
  assert.match(off, /no url \(required\)/); assert.match(off, /differs from og:site_name/); assert.match(off, /the brand most page titles end with/);
  assert.deepEqual(siteNameIssues([home({ website: { name: "ES", alt: ["Example Shop"], url: S + "/" }, ogSiteName: "Example Shop" }), ...titles], S + "/"), [], "alternateName counts");
  const sub = siteNameIssues([home({ website: { name: "Example Shop", alt: [], url: S + "/" } }), ...titles,
    sitePage("/news/", "News | Example Shop", { website: { name: "Example News", alt: [], url: S + "/news/" } })], S + "/");
  assert.deepEqual(sub.map((x) => x[1]), [S + "/news/"]);
  assert.match(sub[0][2], /not subdirectories/);
});

// ---- Row 23: local NAP on the home page ----
test("opening hours are read from markup and from page text", () => {
  assert.equal(textHours("Open Mon–Fri 9:00–6:00; Sat 10:00–3:00 by appointment").get(0), "540-1080");
  assert.equal(textHours("Saturday: 10am - 3pm").get(5), "600-900");
  assert.equal(textHours("Mon 5 - 10 March").size, 0, "dates aren't hours");
  assert.equal(textHours("Mon 9:00-5:00pm ... Mon 8:00-4:00pm").has(0), false, "two different times for a day: ambiguous");
  const m = markupHours({ openingHoursSpecification: [{ dayOfWeek: ["https://schema.org/Monday", "Tuesday"], opens: "09:00", closes: "17:00:00" }, { dayOfWeek: "Sunday", opens: "00:00", closes: "00:00" }] });
  assert.deepEqual([...m], [[0, "540-1020"], [1, "540-1020"]]);
  assert.deepEqual([...markupHours({ openingHours: ["Mo-Fr 09:00-17:00", "Sa,Su 10:00-12:00"] }).keys()], [0, 1, 2, 3, 4, 5, 6]);
});

test("local NAP: markup gaps, a SAB without address, hours that disagree, Settings details not on the page", async () => {
  const page = (o, body) => doc(ld({ "@type": "AutoRepair", name: "Example Garage", ...o }), body);
  const home = (o, body = "<p>Example Garage, 1 Example Street. Call (03) 9000 0000.</p>") => ({ url: S + "/", html: page(o, body) });
  const full = { telephone: "+61 3 9000 0000", address: { "@type": "PostalAddress", streetAddress: "1 Example St" }, openingHours: "Mo-Fr 09:00-18:00" };
  assert.deepEqual(await localNapIssues(home(full)), []);
  assert.match((await localNapIssues(home({ ...full, openingHours: undefined })))[0][2], /AutoRepair markup has no openingHoursSpecification/);
  assert.deepEqual(await localNapIssues(home({ ...full, address: undefined, areaServed: "Exampletown" }, "<p>Call (03) 9000 0000</p>")), [], "service-area business");
  assert.match((await localNapIssues(home(full, "<p>1 Example Street. Hours: Mon–Fri 9:00–5:00</p>")))[0][2], /hours differ: mo page 09:00–17:00, markup 09:00–18:00/);
  assert.deepEqual(await localNapIssues(home(full, "<p>1 Example Street. Hours: Mon–Fri 9:00am–6:00pm</p>")), []);
  assert.match((await localNapIssues(home(full, "<p>Call us</p>")))[0][2], /street address "1 example street" isn't in the home page text/);
  assert.deepEqual(await localNapIssues({ url: S + "/", html: doc("", "<p>A blog</p>") }), [], "not a local business");
  const settings = { napName: "Example Garage", napAddress: "1 Example Street, Exampletown VIC 3000", napPhone: "03 9000 5555" };
  assert.match((await localNapIssues({ url: S + "/", html: doc("", "<p>1 Example Street</p>") }, settings))[0][2], /phone 03 9000 5555 \(Settings\) isn't in the home page text/);
});

// ---- Row 45: merchant policies ----
test("merchant policies: needed once 3+ pages sell priced products; Organization-level policies count", () => {
  const sell = [1, 2, 3].map((i) => sitePage(`/p${i}.html`, "P", { productOffers: true }));
  assert.deepEqual(merchantPolicyIssues(sell, S + "/"), [["merchant_policy_missing", S + "/", "3 pages mark up products with prices; no return policy or shipping policy markup on any crawled page"]]);
  assert.deepEqual(merchantPolicyIssues(sell.slice(0, 2), S + "/"), []);
  const home = parseHtml(doc(ld({ "@type": "Organization", name: "Example Shop", hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy", applicableCountry: "AU", returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow" } })), S + "/").data;
  assert.equal(home.merchantReturn, true);
  assert.match(merchantPolicyIssues([...sell, sitePage("/", "Home", home)], S + "/")[0][2], /no shipping policy markup/);
  const product = parseHtml(doc(ld({ "@type": "Product", name: "W", offers: { price: "9.95", priceCurrency: "AUD", shippingDetails: { "@type": "OfferShippingDetails" } } })), S + "/p.html").data;
  assert.equal(product.productOffers, true); assert.equal(product.merchantShipping, true);
});
