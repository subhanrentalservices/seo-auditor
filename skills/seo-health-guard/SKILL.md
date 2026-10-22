---
name: seo-health-guard
description: Protect a site's verified health baseline (site health %, crawl readiness, zero critical errors, no broken links, valid schema, working forms) around every change - capture a baseline, compare after the change, block or roll back regressions. Use before and after deploys, bulk edits, programmatic pages, schema changes or any "make SEO changes" request.
---

# SEO health guard

Never trade a healthy site for a higher page count or link count. Every change is checked against the same baseline,
measured the same way.

## 1. Know the baseline and its method

Record once, and re-check that it is still reproducible:
- Tool and version, settings (JS rendering on/off, page limit, user agent), URL set (sitemap vs crawl), date.
- The formula. SEO Auditor: Site Health = 100 × (1 − (pages with errors + ½ × pages with only warnings) ÷ pages crawled).
- Crawl readiness: share of intended indexable URLs that return 200, are self-canonical, indexable, robots-allowed and
  linked from at least one other page.
If the owner's number comes from a tool you can't run, say so and keep a documented replacement baseline. Never imply
two different tools' scores are comparable.

## 2. Before a change

1. Run the audit (SEO Auditor: Run audit; or the project's audit script). Save the result ID.
2. Note per-page values you might affect: status, canonical, indexability, inbound links, word count,
   HTML-to-visible-text ratio, JSON-LD validity, Core Web Vitals (lab) for key pages.
3. For risky or bulk changes, make a full backup first.

## 3. After the change (before calling it done)

Run the same audit and compare (SEO Auditor: History & compare). Block or roll back if any of these happen:
- Site health or crawl readiness drops below the baseline.
- New errors, new broken or redirecting internal links, new orphan pages.
- A page becomes noindex, non-canonical, blocked, or stops returning 200 by accident.
- JSON-LD stops parsing, or schema no longer matches the visible page.
- HTML-to-text ratio on a page drops by more than 20% without a reason.
- Forms (enquiry, booking, claim) stop submitting, or console errors appear.
- Lab LCP/CLS/INP on key pages get materially worse.
Also check the real page in a browser on a phone-sized viewport and a desktop, including interactive parts
(click through every step of forms and widgets).

## 4. Deploy rules

- Deploy only changed files, with a backup and an integrity check, then a smoke test of key pages and forms.
- Bust caches for changed CSS/JS (versioned URLs) so users don't get a mix of old and new.
- Submit genuinely changed URLs to IndexNow (not for asset-only edits); include removed/redirected URLs.
- Keep `lastmod` honest: change it only when the page content really changed.

## 5. Never

Change audit settings, the URL set or the formula to make a score look better; hide pages from the audit; fill pages
with text to raise a ratio; remove working features for a score. If a score can't be reproduced, report that plainly.

## 6. Record

Each change: baseline ID, after ID, the comparison, deploy reference, rollback reference, and anything that needs
watching (re-check after 7 days for indexing, 28 days for search performance).
