# SEO Auditor

An SEO audit and link-building app that runs on your own computer. It crawls a website with no page limit, raises
errors, warnings and notices per page with why each matters and how to fix it, and adds Lighthouse, Chrome UX
Report, Google Search Console, Google Analytics 4, Bing Webmaster Tools, paid DataForSEO data (keywords, backlinks,
AI visibility) and a link-building workspace. Everything is stored locally in a SQLite database; the web app is
served on `127.0.0.1` only.

## Requirements

- **Node.js 24 or newer** (`package.json` engines; the app uses `node:sqlite`).
- **Google Chrome or Microsoft Edge** for JavaScript rendering, Lighthouse and PDF reports (or Playwright's Chromium:
  `npx playwright install chromium`). Without a browser those parts are skipped and listed as not checked.
- **Python 3.12+** only for the link-building engine (`backlinks/`).

## Install and run

```
npm install
npm start                      # http://localhost:4560 (SEO_AUDITOR_PORT changes the port)
```

- `node src/cli.mjs install [--autostart]` adds a desktop shortcut (and starts the app with Windows).
- `scripts/stop.ps1` stops a background instance on Windows.
- Data lives in `data/` (database, `config.json`, logs), or in the folder named by `SEO_AUDITOR_DATA`.

### Desktop app (Windows and macOS)

The desktop build opens in its own window, runs the server and the link engine inside itself (no Node.js, Python or
terminal needed) and keeps data in the user's app-data folder (Windows `%APPDATA%\SEO Auditor`, macOS
`~/Library/Application Support/SEO Auditor`).

| Build | Command | Output | Runs on |
|---|---|---|---|
| Windows installer | `npm run dist:win` | `release\SEO Auditor Setup <version>.exe` | Windows |
| macOS disk image (Intel + Apple silicon) | `npm run dist:mac` | `release/SEO Auditor-<version>-*.dmg` | a Mac |

First-time setup on a build machine: `npm install`, then `backlinks/setup.bat` (Windows) or create `backlinks/.venv`
with Python 3.12+ and `pip install -r backlinks/requirements.txt pyinstaller` (macOS). Builds are unsigned: Windows
SmartScreen shows "More info → Run anyway"; on macOS right-click → Open the first time.

## Checks

<!-- generated:numbers (node scripts/readme-numbers.mjs) -->
**191 checks**: 32 errors, 59 warnings, 100 notices.

| Group | Checks |
|---|---|
| SEO (on-page, content, links, structured data, sitemaps, hreflang…) | 89 |
| Crawlability (status codes, redirects, robots.txt, canonicals, rendering…) | 74 |
| AI search (AI crawlers, answer-ready content; scored as AI Readiness) | 15 |
| Core Web Vitals (field data first, Lighthouse as fallback) | 6 |
| Security headers (information, not a Google ranking factor) | 4 |
| Accessibility (information, not a Google ranking factor) | 3 |

132 checks link to the Google Search Central page on their topic; the rest are labelled in the app as tool heuristics, security or accessibility information.

AI visibility costs about $0.024 per prompt with all 5 platforms (ChatGPT (web search) $0.004, Google: AI Overview + rankings $0.006, Google AI Mode $0.004, Perplexity (Sonar, web search) $0.006, Gemini $0.004). The default monthly DataForSEO budget is $2.00.
<!-- /generated:numbers -->

The **All checks** screen lists every check with its severity, why it matters, how to fix it and its source, with
search and filters (also `GET /api/checks`). A check group that fails to run during an audit (no browser, a network
error) raises nothing and is listed on the Overview under **Not checked in this audit** with the reason, so "not
checked" is never shown as "passed".

### Scores (this tool's scores, not Google metrics)

- **Site Health** = 100 × (1 − (pages with errors + ½ × pages with only warnings) ÷ pages crawled).
- **AI Readiness**: each indexable page starts at 100 and loses points for AI-search issues (errors 10, warnings 4,
  notices 1, ×3, capped). Each AI search crawler blocked in robots.txt costs 15 points; training opt-outs cost nothing.
- **Fix first** = severity × (1 + log₂(1 + pages affected)) × (1 + log₁₀(1 + Google impressions of those pages)); AI
  issues count half.

## Screens

Add a website under **All websites**, check its **Audit settings**, then press **Run audit**.

| Screen | What it shows | Cost |
|---|---|---|
| Overview | Site Health, AI Readiness, errors/warnings/notices with change since the last audit, Fix first, checks not run, trend, crawl depth, HTTP statuses, site files, cards from connected data | Free |
| Issues | Every issue with why, fix, affected URLs, new and fixed since the last audit; Crawlability tab with passed checks; CSV, Markdown and JSONL exports | Free |
| All checks | Every check the audit can raise, with severity, why, fix and Google source | Free |
| Pages | Every URL with status, depth, links, words, issues, Search Console numbers and custom extraction columns; click one for a Google preview and all details | Free |
| Link ideas | Internal link ideas, pages close to page 1, topic clusters (hub and spoke) | Free |
| Competitors | Pages a competitor has that you don't (from their sitemap), and your page vs theirs for one search | Free |
| Research | Keyword ideas from Google Autocomplete, search clusters from Search Console, topics up to 5 competitors cover that you don't; content briefs | Free; brief ≈ $0.002, volumes ≈ $0.01 + $0.0001 per idea |
| Content inventory | Every indexable page with words, last modified, clicks and impressions trend, links in, decay and a suggested action (keep, refresh, merge, prune or noindex) | Free |
| AI audit | AI crawler access in robots.txt and at the server, llms.txt, AI-search page issues, robots.txt tester | Free |
| Performance | Lighthouse (mobile, optionally desktop) on `cwvPages` pages per audit (default 5); Chrome UX Report field data and its 25-week history with a free CrUX API key | Free |
| AI visibility | Your prompts on ChatGPT, Google AI Overviews, Google AI Mode, Perplexity and Gemini: mentioned, cited, rank, cited sources, share of voice; a trend per prompt and share of voice over time; your pages AI cites, and your closest page for prompts others win; prompt ideas from Search Console question searches (free); optional scheduled runs every 7, 14 or 30 days (off by default, each checked against the budget first, only while the app runs) | Paid per run (see Checks above) |
| Search Console | Clicks, impressions, queries, quick wins, pages competing for one query, sitemaps, Discover and News, scheduled URL Inspection (within Google's 2,000 a day) with index-status history | Free |
| Rank tracker | Target keywords (Audit settings, up to 200) with tags: position, clicks, impressions per day, best page, mobile vs desktop, change vs 7 and 28 days; 16 months of history | Free |
| GSC explorer | Search Console performance filtered by query or page (contains or regex), country, device, type and dates, with CSV export | Free |
| Analytics | GA4: organic sessions and key events by landing page, 90-day organic trend, visits referred by AI assistants | Free |
| Bing | Bing Webmaster Tools: traffic, top searches and pages, crawl stats and issues, inbound links; IndexNow submit | Free |
| Lost pages | Gone or wrongly redirected URLs that had value, each with the closest live page as a 301 target | Free |
| Keywords | Every keyword the domain ranks for in Google (DataForSEO) | ≈ $0.03 per refresh |
| Backlinks | Backlinks, referring domains, anchors, spam review and a disavow file (DataForSEO) | ≈ $0.08 per refresh |
| Business listings | Directory pages that list the business, checked against the site's name, address and phone | Free |
| History & compare | Every audit; compare two audits (issues added and fixed, pages new and lost) | Free |
| Issue trends | Each issue's page count across audits; Site Health and AI Readiness over time | Free |
| Report | One-page HTML report or PDF, with optional branding | Free |
| Alerts | Alert rules per website, scheduled report delivery, report branding | Free |
| Audit settings | Crawl limits, speed, robots.txt, rendering, fallbacks, request headers, custom extraction, schedule, Search Console property, brand terms, target keywords, competitors | – |
| App settings | Accounts and keys, DataForSEO budget, alert channels, scheduled task, run in the background | – |

Paid requests run only when you press their button (or turn on a paid schedule yourself), and stop at the monthly
DataForSEO budget in **App settings**. Prices are DataForSEO's at the time of writing; the app logs the real cost
of every call.

### Link building

The **Link building** section of the sidebar is a separate engine (Python, `backlinks/`) that the app starts on
`127.0.0.1:4561` and reaches through `/lv/`.

| Screen | What it does |
|---|---|
| Today | Where your links stand in one line, then what to do next |
| Links | Every page that links to you, verified (counts, weak, pending, not counted), re-checked over time with history and a screenshot |
| Opportunities | Places that could link to you, best first, with an outreach draft for each that you send yourself |
| Campaigns | Who writes about a data study you published, and whether they link |
| Site health | Whether your own site passes links on (noindex, canonicals, duplicates, thin pages) |
| Link settings | Brand, competitors, topics, sources, notifications, daily run |

It never posts, comments, signs up or sends email anywhere. One-time setup: `backlinks\setup.bat` (Python 3.12+).
Engine tests: `.venv\Scripts\python -m pytest` inside `backlinks/`.

## Accounts

All optional. Keys and passwords are stored only in `data/config.json`, never shown again by the app, and removed
from error messages.

- **Google Search Console**: either a service-account key file (path in App settings or `GSC_KEY_FILE`; add the
  service account's email as a user on each property), or **Google sign-in**: create an OAuth client of type
  "Desktop app" in Google Cloud console (enable the Search Console API and the Google Analytics Data API; add yourself
  as a test user or publish the app, since Google ends test-mode sign-ins after 7 days), paste its ID and secret in
  App settings and press "Sign in with Google". Read-only scopes; the sign-in returns to a one-off listener on
  127.0.0.1 (state check, PKCE, 5 minutes).
- **Google Analytics 4**: the same key file (or `ga4KeyFile` in config.json) or the same Google sign-in; add the
  account as a Viewer on the GA4 property and set the Property ID on the Analytics screen. AI visits without a
  referrer show as Direct in GA4, so the AI referral numbers are a lower bound.
- **Bing Webmaster Tools**: an API key (Bing Webmaster Tools → Settings → API access) in App settings. **IndexNow**
  needs a key you choose and a `<key>.txt` file in the site's root holding it; uploading it is your job.
- **Chrome UX Report**: a free Google API key in App settings, for field data and its history.
- **DataForSEO** (paid): the login in App settings, or an `.mcp.json` file whose `dataforseo` server holds it (App
  settings or `DATAFORSEO_MCP_CONFIG`). Every call's real cost is logged; nothing paid runs past the monthly budget.

## Alerts, schedules and reports

- **Channels** (App settings → Alerts): email over your SMTP server, a webhook (JSON POST), a Slack-compatible
  incoming webhook and the Windows desktop alert, each with **Send test**; rate-limited and deduplicated.
- **Rules** (each website → Alerts, each on/off): new errors, Site Health drop, robots.txt changed, pages turned
  non-indexable, new 5xx, Search Console clicks or impressions down week on week, more pages not indexed, rank drops.
- **Scheduled audits** (Audit settings → schedule: daily or weekly) and **scheduled reports** (emailed as PDF or HTML,
  or saved to a folder) run while the app runs. App settings → *Scheduled task* (or
  `node src/cli.mjs schedule install --time 06:00`) adds an optional daily Windows task that runs due audits, alerts
  and reports when the app is closed; on Mac/Linux it prints a crontab line. Log: `data/scheduled-run.log`.

## How pages are fetched

- **Crawl**: robots.txt obeyed (`respectRobots`), the audit's own user agent, adaptive speed from `concurrency` up to
  `maxConcurrency` while the site answers fast, `Crawl-delay` respected, transient errors retried, bodies capped at
  15 MB, encodings decoded like browsers, no cookies kept between requests (like Googlebot).
- **Pages that refuse the crawler** (`blockedFallback`): 401/403/503, no answer or a bot challenge are read again with
  curl, then in Chrome (at most 50 pages); a 429 is waited out, never escalated. Nothing is disguised and no challenge
  is solved.
- **JavaScript rendering** (`renderJs`: off, *auto* or every page): headless Chrome as a 412 px wide phone; *auto*
  renders a sample and decides. Routes only the site's own scripts navigate to are reported.
- **Incremental re-crawl** (`incremental`) sends the last audit's ETag / Last-Modified; **Resume audit** continues a
  stopped or interrupted audit without fetching its stored pages again.
- **Request headers** (`requestHeaders`, own hosts only) for staging sites or firewall bypass cookies; values are kept
  out of settings, audits, logs and exports.
- **PDFs** (`maxPdfs`, `maxPdfMb`): the site's own PDFs are read in-process with unpdf and checked like pages.
- **Custom extraction** (`extract`, up to 20 CSS or regex rules) adds columns to Pages and the exports.
- **Exports**: issues, pages and links CSV; each indexable page's main content as Markdown; one JSON object per page
  (JSONL). Exports never contain request headers, cookies or keys.

## Command line

```
node src/cli.mjs add https://example.com "Example"   # add a project
node src/cli.mjs list                                # projects and latest health
node src/cli.mjs audit 1 [--max 200] [--js]          # crawl project 1 without the app
node src/cli.mjs install [--autostart]               # desktop shortcut (and start with Windows)
node src/cli.mjs schedule install [--time 06:00]     # optional daily task: audits, alerts, reports (schedule remove / status)
node src/scheduled-run.mjs [--data <folder>]         # what that task runs (does nothing while the app is open)
```

## Development

```
npm test                              # node:test suite: local test servers only, no paid calls
npm run lint                          # node --check on every JavaScript file
node scripts/readme-numbers.mjs       # refresh the numbers in this README from the code (the tests check them)
node scripts/api-docs.mjs             # regenerate docs/api.md from the registered routes (the tests check it)
```

The local JSON API (every route with its parameters) is documented in [docs/api.md](docs/api.md).

GitHub Actions (`.github/workflows/ci.yml`) runs the lint and the tests on Node.js 24 and 26 for every push and pull
request. The end-to-end test audits a small fixture website served on 127.0.0.1; its JavaScript-rendering part is
skipped when no browser can start. Layout: `src/` server and modules, `public/` the web app (plain DOM, no build
step), `test/` tests, `desktop/` the Electron shell, `backlinks/` the link engine, `scripts/` helpers.

## Licence

MIT. See [LICENSE](LICENSE).
