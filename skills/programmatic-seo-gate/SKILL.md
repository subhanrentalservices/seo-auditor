---
name: programmatic-seo-gate
description: Decide whether a template-based page (location, repair type, product, vehicle make, insurer guide) should exist, and run the 15-point publish gate before it goes live. Use when planning programmatic SEO, suburb/location pages, "pages at scale", or before publishing any page built from a template. Blocks doorway pages, scaled content abuse and invented facts.
---

# Programmatic SEO gate

Programmatic SEO is allowed when each page solves a distinct problem with page-specific facts. It is spam when pages
differ only by a swapped place or keyword. Google's spam policies name both directly:

- **Doorway abuse** includes "pages targeted at specific regions or cities that funnel users to one page" and
  "substantially similar pages that are closer to search results than a clearly defined, browseable hierarchy".
  (developers.google.com/search/docs/essentials/spam-policies)
- **Scaled content abuse** is "generating many pages for the primary purpose of manipulating search rankings and not
  helping users ... no matter how it's created". (same page)
- Listing many place names to rank is **keyword stuffing**. Presenting false business information (a branch that
  doesn't exist, a service not offered) falls under the **scam and fraud** policy.

## Project inputs (read these first)

- The project's **verified facts** list (e.g. the "Verified business facts" section of CLAUDE.md). It is the only
  source for business claims. Anything else is a question for the owner.
- The **page inventory** (URL, type, intent, inbound links, words) and Search Console query data, if present.
- The project's deploy, smoke-test and audit commands.

## Step 1 — should this page exist?

Answer all four with evidence. Any "no" means: improve an existing page instead.

1. **Distinct intent.** No existing page already serves this query. Check the inventory and search the site.
2. **Real offering.** The business really provides this service here (owner-confirmed, not inferred).
3. **Demand.** Search Console queries or keyword data show people search for it.
4. **Enough unique substance.** At least three checkable facts true only for this page's subject
   (route and distance from the workshop, the specific repair process, local rules), not filler.

## Step 2 — the 15-point publish gate

Every point must pass. Record the result per point in the task log.

1. **One location only.** Say plainly where the work happens. No wording, map pin or schema implies a branch,
   office or mobile base that doesn't exist.
2. **No swap pages.** Mask the place/topic name and compare the `<main>` text with every sibling page: shared
   5-word phrases under 20% (a working limit, not a Google number). Rewrite any paragraph that stays true with
   another name dropped in. Tool: `node src/cli.mjs similar <dir-or-urls>` in SEO Auditor.
3. **Three page-specific facts**, each checkable. No invented local stories.
4. **Verified business facts only.** Every claim matches the facts list. Never invent prices, free quotes,
   turnaround times, approvals, panel status, licences, credentials or memberships.
5. **No promised outcomes.** Use "usually", "depends on your policy", "subject to assessment" where a third party
   decides. Never "guaranteed", "no cost", "always covered".
6. **Capability and gap check.** The page doesn't duplicate an existing service page; link to it instead.
7. **Search demand and intent** confirmed (Step 1.3).
8. **Useful on its own.** A reader can act without visiting another page (phone, address, what happens next).
9. **Unique, honest title and H1** that don't compete with another page's main query.
10. **No keyword or place lists.** No paragraph names 5+ places; no repeated phrase variants.
11. **Genuine media.** Own photos (with consent where people or customer cars appear) or clearly generic images.
    Never an AI image presented as a real job. Alt text describes the image.
12. **Human review and byline** by a real, named person. AI drafts are fact-checked line by line
    (see the `ai-content-gate` skill).
13. **Technical basics.** HTTP 200, absolute self-canonical, indexable, in the sitemap with an honest `lastmod`,
    and at least one in-content link from a related page (not only footer/nav).
14. **Reversible and measured.** Deployed with a backup; Search Console baseline recorded; review after ≥4 weeks.
    No impressions after 3 months → improve, merge or noindex (deletions need owner approval).
15. **Batch limit.** At most 2 new template pages per month (a working limit) so a scaled pattern never builds up.

## Step 3 — pilot, then decide

- Pilot 3–5 pages at most. Compare against similar existing pages at 7, 28 and 56 days (impressions, clicks,
  indexing, enquiries). Expand only on evidence; a large page count is not a success metric.
- Never claim a page "caused" a ranking change without a comparison period and a control.

## Red flags — stop and ask the owner

- The page needs a fact that isn't on the verified list.
- The only difference from a sibling page is a name, a distance or a list.
- Someone asks for "hundreds of pages", "every suburb", or pages for services the business doesn't offer.
