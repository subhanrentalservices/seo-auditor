---
name: schema-audit
description: Audit and fix JSON-LD structured data across a whole site - parse, schema.org vocabulary, Google-supported properties and policies, one stable business entity (@id), visible-content match, breadcrumbs, articles, FAQ and review rules. Use for "schema", "structured data", "JSON-LD", "rich results", entity/@graph work, or after any template or business-info change.
---

# Schema audit

Two different questions, never mix them up:
- **Is it valid schema.org?** (vocabulary: types and properties exist and fit) - what validator.schema.org checks.
- **Is it eligible for a Google feature, and within Google's policies?** - what the Rich Results Test and
  Google's structured data docs cover. Valid markup can still earn nothing.

Google's structured data policies (developers.google.com/search/docs/appearance/structured-data/sd-policies):
markup must describe content **visible on the page**, be accurate and current, not mislead, and follow each feature's
own guidelines. Violations can lose rich results or earn a manual action.

## Project inputs

- The verified business facts (name, address, phone, email, hours, services, areas). Schema may only state these.
- The canonical entity id for the business, e.g. `https://example.com/#business`.
- The page templates or generator that emit JSON-LD (fix the source, not each page by hand, where possible).

## 1. Collect

Fetch every URL in the sitemap politely (sequential, small delay). Extract every
`<script type="application/ld+json">`. Record per page: blocks, types, @ids, parse errors.
(A re-runnable audit script should check vocabulary against the official schema.org vocabulary file,
https://schema.org/version/latest/schemaorg-current-https.jsonld, rather than a hand-made list.)

## 2. Check (error = invalid, misleading or policy risk · warning = missing recommended / inconsistency)

1. **Parses** as JSON. One broken block hides everything in it.
2. **Vocabulary**: every @type and property exists in schema.org and is used on a type that allows it.
3. **One business entity**: the business @id is declared with the same values everywhere (or referenced with name +
   url). No conflicting name, address, phone, hours or types across pages. Use the most specific accurate types
   (e.g. AutoRepair + AutoBodyShop), never a type for a service the business doesn't offer.
4. **Facts match** the verified list and the visible page: address, phone, hours (note "by appointment" in visible
   text; opening hours can't express it), services, areas served. No invented branches.
5. **LocalBusiness types need an address** wherever they're declared (including as an article publisher).
6. **Reviews and ratings**: no self-serving Review/AggregateRating about the business on its own site (Google ignores
   it for LocalBusiness/Organization and it risks a manual action). Never invent ratings.
7. **FAQPage**: every question and answer is visible on the page, word for word in meaning. Google stopped showing
   FAQ rich results in 2026, so add FAQ markup only for other consumers, never for "stars" in Google.
8. **BreadcrumbList**: positions 1..n, valid canonical URLs, last item = this page, and a visible breadcrumb trail
   exists (Google: don't mark up content readers can't see).
9. **Article/BlogPosting**: headline, image (≥1,200 px wide; 16:9, 4:3 or 1:1 preferred), datePublished and
   dateModified with time zone, a real author Person with url/sameAs, publisher with name and logo.
10. **Service**: provider references the business @id; description matches the page; areaServed only real areas.
11. **No prices, availability, credentials, awards or guarantees** unless verified and visible.
12. **Canonical consistency**: `url`/`@id` use the canonical URL.

## 3. Fix safely

- Fix the template or generator; keep @ids stable (changing them breaks entity continuity).
- Keep visible text and JSON-LD text identical when both state the same thing (FAQ answers, service descriptions).
- Validate after the change: re-run the audit, then spot-check key pages in the Rich Results Test.
- Wording that isn't a verified fact goes to the owner; don't "fix" it by inventing a fact.

## 4. Report

Summary table (pages, blocks, types, errors, warnings), each issue with pages, evidence, severity and the exact fix,
and what could not be checked (interactive validators, Search Console enhancement reports, JS-injected markup).
Never promise rich results.
