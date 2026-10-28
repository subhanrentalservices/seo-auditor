# SEO Auditor

A Semrush-style SEO dashboard that runs on this PC. It crawls any website with no page limit, lists errors,
warnings and notices per page, and adds Lighthouse speed tests, Google Search Console data, keywords,
backlinks, an AI-search audit and AI visibility checks. Everything is stored locally in `data/`.

## Desktop app (Windows and macOS)

SEO Auditor and the Backlink Verifier are one app in the Backlink Verifier design (sidebar: **SEO audit** screens
and **Link building** screens). The desktop version opens in its own window, runs the server and the link engine
inside itself (no Node.js, Python or terminal needed) and keeps data in the user's app-data folder:
Windows `%APPDATA%\SEO Auditor`, macOS `~/Library/Application Support/SEO Auditor`.

| Build | Command (in this folder) | Output | Where it must run |
|---|---|---|---|
| Windows installer | `npm run dist:win` | `release\SEO Auditor Setup <version>.exe` | Windows |
| macOS disk image (Intel + Apple silicon) | `npm run dist:mac` | `release/SEO Auditor-<version>-*.dmg` | a Mac (PyInstaller and Apple's tools only build Mac apps on macOS) |

First-time setup on a build machine: `npm install`, then `backlinks/setup.bat` (Windows) or create
`backlinks/.venv` with Python 3.12+ and `pip install -r backlinks/requirements.txt pyinstaller` (macOS).
`npm run dist:*` builds the standalone link engine first (`backlinks/build-engine.py`).
Builds are unsigned: Windows SmartScreen shows "More info → Run anyway"; on macOS right-click → Open the first time.
Signing needs a code-signing certificate (Windows) or an Apple Developer ID (macOS).
Lighthouse, JavaScript rendering and PDF reports use Google Chrome or Edge installed on the computer.

## Open it (developer setup)

Double-click **SEO Auditor** on the desktop. It starts in the background and opens http://localhost:4560.
Only this computer can reach it.

- To start it with Windows (needed for scheduled audits), tick **App settings → Run in the background**.
- To stop it, run `scripts\stop.ps1` (right-click → Run with PowerShell).
- If the shortcut is missing: `node src/cli.mjs install` in this folder.

Needs Node.js 22 or newer. After copying the folder to another PC, run `npm install` and
`npx playwright install chromium` once.

## Using it

1. **All projects → Add website.** Check the project's Settings, then press **Run audit**.
2. **Overview** shows Site Health, AI Readiness, the *Fix first* list and cards for every connected data source.
3. **Issues** lists every check with why it matters, how to fix it, the affected URLs, and what is new or
   fixed since the last audit. **Pages** lists every URL; click one for a Google preview and all details.
4. **Report** gives a one-page HTML report or a PDF to share.

| Screen | What it does | Cost |
|---|---|---|
| Issues, Pages, AI audit | Full crawl, 63 checks (18 errors, 21 warnings, 24 notices), Site Health and AI Readiness | Free |
| Performance | Lighthouse (the PageSpeed Insights engine), mobile, on 5 pages after each audit | Free |
| Search Console | Clicks, impressions, keywords, quick wins, pages competing for one query; submitted sitemaps (errors, last read); Discover and Google News; scheduled URL Inspection within Google's 2,000-a-day limit (Search Console screen, off until you set a daily number) with a history of index-status changes | Free |
| Rank tracker | Target keywords (Settings, up to 200) with tags: Search Console average position, clicks and impressions per day, best page, mobile vs desktop, change vs 7 and 28 days; rank drops, lost top 10 and new top 3. Day-by-day history kept for 16 months; each refresh fetches only new days | Free |
| GSC explorer | Search Console performance live, filtered by search or page (contains or RE2 regex), country, device, type and dates, with CSV export | Free |
| Keywords | Every keyword the domain ranks for in Google (DataForSEO) | ≈ $0.03 per refresh |
| Backlinks | Backlinks, referring domains, anchors, spam review and a disavow file | ≈ $0.08 per refresh |
| AI visibility | Your prompts on ChatGPT, Google AI Overviews, Google AI Mode, Perplexity and Gemini: are you mentioned, cited, and where do you rank? | ≈ $0.024 per prompt (all five) |

Paid requests run only when you press their button, and stop at the monthly budget in **App settings**
(default $2).

### Pages that refuse the crawler, and your own site's access

- **Pages that refuse the crawler** (project setting `blockedFallback`, default *curl, then a real browser*): a page
  that answers 401/403/503, no answer, or a bot challenge (Cloudflare, Akamai, captcha…) is read again with curl,
  then in Chrome (at most 50 pages per audit). A 429, or a 503 with Retry-After, is waited out instead (up to 60 s,
  3 minutes per audit), retried once, and the crawl drops to fewer parallel requests; it is never escalated. robots.txt
  is obeyed by every step; nothing is disguised beyond a normal browser user agent, and no challenge is solved. *Off*
  keeps the plain fetch only. Checks: `bot_wall_blocked`, `fetched_via_fallback`, `crawl_rate_limited`. Pages read
  through a fallback have no response time (speed checks skip them) and aren't JavaScript-rendered.
- **Request headers (own site)** (`requestHeaders`, up to 10): e.g. `Authorization: Basic …` for a staging site or a
  bypass cookie (`Cookie: name=value`) your firewall issued. Sent only to the project's own hosts (never to external
  links or other hosts, also not after a redirect) on page, robots.txt and own-file requests. The browser fallback
  sends cookies and Basic authentication only. Values are stored in the local database, outside the settings; the
  app never shows them again, never logs them, and keeps them out of audits and exports. Host, Content-Length,
  Connection, User-Agent, Sec-*, Proxy-* and forwarding headers can't be set.

## Link building (merged Backlink Verifier, 2026-10-22)

The sidebar section **Link building** is the former Backlink Verifier app, now inside SEO Auditor:

| Screen | What it does |
|---|---|
| Today | Where your links stand in one line, then what to do next, most urgent first |
| Won links | Every page that links to you, verified with 15 checks (Counts / Weak / Pending / Not counted), re-checked weekly then monthly, with history and a screenshot |
| Opportunities | Free listings, competitor partners, unlinked mentions, journalist requests, scored best first; writes outreach drafts you send yourself |
| Data studies | Who quotes a data study you published, and whether they link to it |
| Link map | Your own site's internal link graph: broken links, orphan pages, address problems |
| Link settings | Brand, competitors, topics, free sources, notifications, daily run |

It never posts, comments, signs up or sends email anywhere: you do the outreach, it finds and proves.

How it runs: the engine is Python (`backlinks/`). SEO Auditor starts it in the background on 127.0.0.1:4561 and the
screens reach it through `/lv/` on port 4560. One-time setup on a new PC: run `backlinks\setup.bat` (needs Python
3.12+). Its data (links, opportunities, settings) lives in `backlinks/config.toml` and `backlinks/sites/` (not in git).
The optional daily re-check is the Windows task "BacklinkVerifier Monitor" (Link settings → Daily run). Engine log:
`data/backlinks.log`. Engine tests: `.venv\Scripts\python -m pytest` inside `backlinks/`.

## Scores

- **Site Health** = 100 × (1 − (pages with errors + ½ × pages with only warnings) ÷ pages crawled).
- **AI Readiness**: each indexable page starts at 100 and loses points for AI-search issues (errors 10,
  warnings 4, notices 1, ×3, capped). Each AI crawler blocked in robots.txt costs 15 points.
- **Fix first** = severity × (1 + log₂(1 + pages affected)) × (1 + log₁₀(1 + Google impressions of those pages)); AI issues count half.

## Accounts

- **Search Console** uses a Google service-account key file: set its path in App settings (default
  `~/.config/claude-seo/gsc-service-account.json`, or the `GSC_KEY_FILE` environment variable). Add the
  service account's email as a user on each property in Search Console.
- **DataForSEO** uses the login entered in App settings, or an `.mcp.json` file whose `dataforseo` server holds
  the login (App settings, or `DATAFORSEO_MCP_CONFIG`). Keys are read where they are and never copied.

## Licence

MIT. See [LICENSE](LICENSE).

## Command line

```
node src/cli.mjs add https://example.com "Example"   # add a project
node src/cli.mjs list                                # projects and latest health
node src/cli.mjs audit 1 [--max 200] [--js]          # crawl project 1 without the app
node src/cli.mjs install [--autostart]               # desktop shortcut (and start with Windows)
```

## Files

`src/` server and modules (crawler, checks, AI checks, Lighthouse, Search Console, DataForSEO, AI visibility,
report, scheduler) · `public/` the web app (no build step) · `scripts/` launch, stop, icon ·
`data/` database, settings and logs (not in git) · `PLAN.md` design and task log.
