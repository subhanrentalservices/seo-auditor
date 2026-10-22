---
name: ai-search-visibility
description: Check and measure a site's visibility in AI search (Google AI Overviews and AI Mode, ChatGPT search, Perplexity, Bing Copilot) honestly - crawler access, official controls, a fixed prompt set, mentions/citations/recommendations, and which page fixes follow. Use for "AI SEO", "GEO", "AEO", "are we cited by ChatGPT", llms.txt questions, or AI visibility reports.
---

# AI search visibility

Google's AI optimisation guide (developers.google.com/search/docs/fundamentals/ai-optimization-guide) says optimising
for its AI features is ordinary SEO: crawlable, indexable, helpful pages. It says Google Search does not use
`llms.txt` or other "AI files", and that chunking content, rewriting for AI, AI-only schema and chasing mentions are
not needed. Other platforms have their own crawlers and controls. Treat every platform separately and measure, never
assume.

## 1. Crawler access (do this first)

| Platform | Search/answer crawler | User-triggered fetch | Training crawler (separate control) |
|---|---|---|---|
| OpenAI | OAI-SearchBot (needed to appear in ChatGPT search) | ChatGPT-User (may not follow robots.txt) | GPTBot |
| Perplexity | PerplexityBot (search, not training) | Perplexity-User (generally ignores robots.txt) | — |
| Google | Googlebot (AI Overviews/AI Mode use the normal index) | Google-Agent etc. | Google-Extended (Gemini training/grounding opt-out) |
| Microsoft | Bingbot (Copilot uses the Bing index) | — | — |

Checks:
1. robots.txt allows the search crawlers you want (blocking GPTBot does not remove you from ChatGPT search).
2. Fetch the home page and robots.txt with each documented user-agent string: same status and bytes as a browser.
   (SEO Auditor: AI audit → crawler access.) This can't show IP-based blocking; check server logs for real bot hits.
3. No `noindex`, `nosnippet`, `noarchive`/`nocache` on pages you want cited (Bing documents these as limiting Copilot use).
4. Google Search Console → Settings → "Search generative AI" is set to Include (owner must check; API can't see it).

## 2. Content that earns citations (ordinary SEO, done well)

- Self-contained answers to real questions near the top of the relevant page, with sources.
- Consistent business facts (name, address, phone, hours, services) on the site, Google Business Profile and listings.
- Clear authorship and real evidence (photos, process, credentials only if true).
- Don't add "AI blocks", keyword-stuffed FAQs or prompt-steering text (Bing lists prompt injection/AI manipulation as abuse).
- `llms.txt` is optional: keep it an accurate copy of facts already on the site, nothing more.

## 3. Measure with a fixed prompt set

1. Keep ≥ 30 fixed prompts that real customers would ask (service + place, problem questions, comparisons), stored in
   a CSV with an ID. Don't change them between runs, or the trend means nothing.
2. Per platform and prompt, record: mentioned (name appears), recommended (suggested as a choice), cited (URL linked),
   position, competitors named, date, method (API/scraper/manual) and cost.
3. Official reports where they exist: Google Search Console (AI features are included in Performance), Bing Webmaster
   Tools **AI Performance** (Copilot citations). OpenAI and Perplexity publish no site reports.
4. Show missing data as **NOT MEASURED**. Never estimate or invent results. A Google ranking is not proof of a ChatGPT
   or Gemini recommendation.

## 4. Turn gaps into fixes

For each prompt where a competitor is cited and you are not: open the cited page, note what it answers that yours
doesn't, and fix the matching page (facts, clarity, structure, evidence). Re-measure monthly; judge trends over ≥ 2 months.

## 5. Report

Per platform: mention rate, recommendation rate, citation rate, top cited competitor pages, changes since last run,
method and limits. Separate official requirements from hypotheses.
