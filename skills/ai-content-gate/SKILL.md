---
name: ai-content-gate
description: Quality and fact-check gate for AI-assisted articles and page copy before publishing, with extra rules for insurance, legal, money and safety topics. Use when writing, rewriting or reviewing blog posts or service-page copy, when a scheduled post is about to publish, or when someone asks "is this content good enough / safe to publish".
---

# AI content gate

Google allows AI-assisted content; it penalises content made mainly to rank, and it expects people to check it.
From Google's guidance on generative AI content (developers.google.com/search/docs/fundamentals/using-gen-ai-content):
using automation "with the primary purpose of manipulating ranking" is spam; review AI content for accuracy,
including **metadata** (titles, descriptions, alt text, structured data); disclose how content was made where readers
would reasonably wonder. Helpful-content guidance asks for original information, first-hand expertise and a clear
"who" behind the page.

## Project inputs

- The verified business **facts list** (only source for claims about the business).
- The named **author/reviewer** (a real person; never invent one).
- The existing content map (titles, target questions) to avoid duplicates.

## 1. Research before writing

1. Write down the customer's real question and where it sits in their journey.
2. Check existing coverage on the site: if a page already answers it, improve that page instead.
3. Read the current top results and note what they miss (do not copy them).
4. Find primary sources (government, regulator, legislation, official industry codes) for every rule or number.
5. Note what only this business can add (its real process, its owner-confirmed experience).

## 2. Quality model (score 0/1/2 each; publish only if Q1, Q3 and Q4 are 2 and the total ≥ 15/20)

| # | Dimension | Scores 2 when |
|---|---|---|
| Q1 | People-first purpose | Answers a real question the audience has |
| Q2 | Business-specific value | ≥2 points from the business's real process or confirmed experience |
| Q3 | Accuracy | Every fact passes the checklist below, sources logged |
| Q4 | Safe claims | No promised outcomes, no unverified business claims, correct hedging |
| Q5 | Completeness | The reader knows their next step |
| Q6 | Authorship | Real byline, link to an about page, reviewed date |
| Q7 | Readable | Short paragraphs, plain headings, correct regional spelling |
| Q8 | Honest title/description | Match the content, no exaggeration |
| Q9 | Useful links | Primary sources cited; 2–6 in-context links to related pages |
| Q10 | Not duplicative | Doesn't repeat an existing page; overlaps are merged |

(This scoring is a working model built from Google's guidance, not a Google formula.)

## 3. Fact-check checklist (mandatory for insurance, legal, finance, safety)

- **F1** Classify every factual sentence: business fact · law/regulation · third-party practice (insurer, bank) · general fact.
- **F2** Business facts match the facts list in meaning. Anything not on it is removed or sent to the owner.
- **F3** Law and regulation need a primary official source; no source → delete the claim.
- **F4** Every number (days, dollars, percentages, limits) has a source and a "checked on" date.
- **F5** Third-party practice is always qualified ("depends on your policy", "check the PDS"). No universal statements.
- **F6** Eligibility is "subject to assessment". Never promise acceptance or "no cost".
- **F7** Name the jurisdiction when a rule is local; don't apply another region's rules.
- **F8** No personal legal or financial advice; point to the right body for individual cases.
- **F9** Don't copy competitors or insurers; don't name partners without owner approval.
- **F10** Repeat F2–F6 on title, meta description, alt text and JSON-LD.
- **F11** A named human reviews the final rendered page and signs off.
- **F12** Set a re-review date (6 months for insurance/legal). Change `dateModified` only after a substantive edit.

## 4. Never

Invented customer cases, testimonials, statistics, prices, credentials, approvals or outcomes; fake authors; date
bumps to look fresh; word-count padding; keyword repetition; publishing a post that failed the gate just to keep a
schedule (hold it and log why).

## 5. Log

For each post: gate scores, every claim → source URL → date checked → result, reviewer and date. Keep it next to the
post's queue entry so the next run can see why it passed or was held.
