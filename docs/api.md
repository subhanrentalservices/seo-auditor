# SEO Auditor API

The web app talks to a local JSON API. Generated from the routes the server registers by
`node scripts/api-docs.mjs` (a test checks it is current); the parameter notes live in that script.

## Basics

- Base URL: `http://localhost:4560` (`SEO_AUDITOR_PORT` changes the port). The server listens on 127.0.0.1 only.
- Requests must use the host `localhost:<port>` or `127.0.0.1:<port>`, and a browser `Origin` header, when sent,
  must be the same host (DNS-rebinding and cross-site protection). Other hosts get 421 or 403.
- POST and PUT bodies are JSON (`Content-Type: application/json`, at most 1 MB); otherwise 415.
- Answers are JSON unless noted (CSV, HTML, PDF, Markdown, JSONL downloads). Errors are `{ "error": "message" }`
  with a 4xx status, or 500 with `Internal error: …`.
- Secrets (passwords, API keys, OAuth secrets, request header values) are write-only: no GET returns them.
- Paid routes (DataForSEO) are marked *Paid*; each call is checked against the monthly budget (402 when reached).
- `:projectId`, `:auditId` and other ids are numbers.

## Not JSON routes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/events` | Server-Sent Events: audit progress (`started`, `progress`, `phase`, `crawled`, `done`, `failed`) and `visibility` run updates. |
| GET | `/api/audits/:auditId/export/issues.csv` | Issues CSV (also `pages.csv` with custom extraction columns, and `links.csv`). |
| any | `/lv/…`, `/api/s/…`, `/s/…`, `/fonts/…` | Link building: passed to the link engine on 127.0.0.1:4561. |

## Routes (129)

### core (server.mjs, api.mjs)

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects` | All projects with their latest finished audit and Site Health change. |
| POST | `/api/projects` | body: `start_url` (required), `name`, `settings` (see Audit settings; request header values are stored apart and never returned). |
| GET | `/api/projects/:projectId` | One project with its settings and the last 60 audits. |
| PUT | `/api/projects/:projectId` | body: `name`, `start_url`, `settings` (partial; unknown keys ignored, values clamped). |
| DELETE | `/api/projects/:projectId` | Deletes the project and everything stored for it (stops a running audit). |
| POST | `/api/projects/:projectId/audits` | Starts an audit (or returns the running one): `{ auditId }`. Progress arrives on `/api/events`. |
| GET | `/api/audits/:auditId` | Audit, previous audit, issue groups (new/fixed counts), crawlability checks, depth and status counts. `site_info.skipped` lists check groups that failed to run. |
| POST | `/api/audits/:auditId/stop` | Stops a running audit. |
| POST | `/api/audits/:auditId/resume` | Continues the project's newest stopped or interrupted audit. |
| GET | `/api/audits/:auditId/issues/:checkId` | Affected URLs of one check. q: `limit` (≤ 5000, default 500), `offset`. |
| GET | `/api/audits/:auditId/pages` | q: `q` (URL/title contains), `status` (ok, redirect, error), `indexable` (1/0), `issue` (check id), `x`/`xop`/`xv` (custom extraction filter), `sort`, `dir` (asc/desc), `limit` (≤ 5000), `offset`. |
| GET | `/api/audits/:auditId/page` | q: `url`. The page with its issues, links in and out, Search Console and Lighthouse data. |
| GET | `/api/compare/:a/:b` | Issues added and fixed, pages new and lost, between two audits of one project. |
| GET | `/api/checks` | Every check: id, severity, title, why, fix, group, source (Google page or label). q: `counts=1` returns `{ counts, checks }`. |
| GET | `/api/modules` | How many modules the server loads and those that failed to load, with the reason. |

### cwv.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/cwv` | Lighthouse rows (mobile and desktop) and thresholds. |
| POST | `/api/audits/:auditId/cwv` | Runs Lighthouse again. body: `pages` (1–10000, default 5). |
| GET | `/api/projects/:projectId/crux` | Chrome UX Report field data stored for the project. |
| POST | `/api/projects/:projectId/crux` | Fetches field data (needs the CrUX API key). body: `auditId` (optional). |
| GET | `/api/projects/:projectId/crux-history` | 25-week CrUX History stored for the project. |
| POST | `/api/projects/:projectId/crux-history` | Fetches the CrUX History (needs the CrUX API key). |

### gsc.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/gsc/sites` | Search Console properties the signed-in account or service account can read. |
| GET | `/api/projects/:projectId/gsc` | Search Console summary: totals, pages, queries, quick wins, CTR report. |
| POST | `/api/projects/:projectId/gsc` | Refreshes Search Console data now. |

### dataforseo.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/dfs/status` | DataForSEO login present, money spent this month and the monthly budget. |
| PUT | `/api/config` | body: `dfsMonthlyBudget` (0–1000), `dfsLogin`, `dfsPassword` (write-only), `dfsConfigPath`, `gscKeyFile`, `cruxApiKey` (write-only), `clearCruxKey`. |
| GET | `/api/config` | App settings without secrets (`hasPassword`, `hasCruxKey` flags only). |
| GET | `/api/projects/:projectId/keywords` | Stored ranked-keyword snapshots. |
| POST | `/api/projects/:projectId/keywords` | Paid (DataForSEO): fetches the keywords the domain ranks for. |
| GET | `/api/projects/:projectId/backlinks` | Stored backlink snapshots with the spam review. |
| POST | `/api/projects/:projectId/backlinks` | Paid (DataForSEO): fetches the backlink summary, referring domains and anchors. |
| GET | `/api/projects/:projectId/disavow.txt` | A disavow file draft from the spam review (plain text). |

### visibility.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/visibility` | Prompts, runs with per-platform rates, the last run's results and share of voice. |
| POST | `/api/projects/:projectId/visibility/prompts` | body: `prompts` (one per line, up to 200, 300 characters each). |
| DELETE | `/api/projects/:projectId/visibility/prompts/:promptId` | Removes a prompt. |
| POST | `/api/projects/:projectId/visibility/run` | Paid (DataForSEO): runs every prompt. body: `platforms` (chatgpt, google, ai_mode, perplexity, gemini; default all). `{ runId, calls }`. |
| POST | `/api/projects/:projectId/visibility/runs/:runId/resume` | Paid: finishes a stopped or failed run (only the checks it has no answer for). |

### visibility-plus.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/visibility/suggestions` | Free: question searches from Search Console (5+ impressions) that aren't prompts yet. |
| GET | `/api/projects/:projectId/visibility/trends` | Per prompt per run: answered, mentioned, cited, best rank; share of voice per run. |
| GET | `/api/projects/:projectId/visibility/sources` | Last run: own pages AI cites, and the closest own page for prompts where only others are cited. |
| GET | `/api/projects/:projectId/visibility/listing-targets` | Last run: other sites' pages AI cited or ChatGPT read for prompts that don't name you (list and directory pages flagged), and ChatGPT's own searches per prompt. |
| GET | `/api/projects/:projectId/visibility/schedule` | The opt-in scheduled run: enabled, everyDays, platforms, maxCost, estimate per run, last result. |
| PUT | `/api/projects/:projectId/visibility/schedule` | body: `enabled` (only `true` turns paid runs on), `everyDays` (7, 14 or 30), `platforms`, `maxCost` (dollars per run or null). |

### report.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/report.html` | The report as HTML. |
| GET | `/api/audits/:auditId/report.pdf` | The report as PDF (needs Chrome or Edge). |

### extras.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/priorities` | Fix first: issues ranked by severity, pages and Search Console impressions. |
| GET | `/api/audits/:auditId/changes` | Pages whose title, description, H1, words or status changed since the previous audit. |
| GET | `/api/audits/:auditId/source` | q: `url`. File and line hints in the local site folder (setting `localFolder`). |
| GET | `/api/audits/:auditId/link-opportunities` | Internal link ideas: pages that mention another page's topic without linking to it. |
| POST | `/api/audits/:auditId/ask-claude` | body: `url`. A prompt describing the page's issues, to paste into an AI assistant. |
| POST | `/api/projects/:projectId/robots-test` | body: `url` (path or URL). Whether robots.txt allows it, for each crawler. |

### desktop.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/autostart` | Desktop: whether the app starts with Windows. |
| PUT | `/api/autostart` | Desktop: body `enabled`. |

### quality.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/similar` | Near-duplicate page pairs. q: `min` (share of shared phrases, default 0.2). |

### page2.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/page2` | Pages ranking just off page 1. q: `min` (default 8), `max` (default 20) position. |

### indexing.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/indexing` | URL Inspection runs and results. |
| POST | `/api/projects/:projectId/indexing` | Inspects the site's URLs with the URL Inspection API now. |

### topics.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/topics` | Topic clusters (hub and spoke) from the site's folders and links. |
| GET | `/api/audits/:auditId/zero-click` | Searches with impressions and no clicks. q: `min` (default 5), `max` (default 20) position. |

### citations.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/citations` | Business listing pages and their name/address/phone checks. |
| POST | `/api/projects/:projectId/citations` | body: `url` of a listing page to track. |
| DELETE | `/api/projects/:projectId/citations` | q: `url` of the listing to remove. |
| POST | `/api/projects/:projectId/citations/check` | Fetches every listing page and checks name, address and phone. |

### decay.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/decay` | Pages losing clicks or impressions (Search Console history). |

### queries.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/query-alignment` | Title/H1 gaps, unanswered question searches, intent mix, merge candidates. q: `min` question impressions (default 10). |

### reclaim.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/lost-urls` | Gone or wrongly redirected URLs that had value, with a 301 target for each. |

### linkgraph.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/link-graph` | Internal link graph: nodes, edges, orphans, depth. |

### trends.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/trends` | Search Console trend findings (rising and falling searches and pages). |

### serpfeatures.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/serp-features` | Search results features from the last AI visibility run's Google searches, and opportunities. |

### changes.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/changes` | The change log with each change's before/after impact. |
| POST | `/api/projects/:projectId/changes` | body: `date` (yyyy-mm-dd), `kind` (title, content, links, technical, schema, new-page, redirect, other), `summary`, `urls`, `ref`. |
| DELETE | `/api/projects/:projectId/changes/:changeId` | Removes a change log entry. |

### rank.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/rank` | Rank tracker: target keywords with position, clicks, impressions, best page and changes. |
| GET | `/api/projects/:projectId/rank/keyword` | q: `k` (keyword). Day-by-day history, devices and pages for one keyword. |
| PUT | `/api/projects/:projectId/rank/tags` | body: `keyword`, `tags` (list). |
| GET | `/api/projects/:projectId/rank/alerts` | Rank drops, new top 3 and lost top 10. |

### gsc-sitemaps.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/gsc/sitemaps` | Submitted sitemaps from the Search Console Sitemaps API. |

### gsc-discover.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/gsc/types` | Discover and Google News performance, when the property has data. |

### index-rotation.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/index-rotation` | Scheduled URL Inspection: per-day number, quota use, next URLs. |
| PUT | `/api/projects/:projectId/index-rotation` | body: `perDay` (0 = off, capped below Google's 2,000 a day). |
| GET | `/api/projects/:projectId/index-history` | q: `url`. Index-status history of one URL. |

### gsc-explorer.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| POST | `/api/projects/:projectId/gsc/explore` | Live Search Console query. body: `startDate`, `endDate`, `type` (web, image, video, news, discover, googleNews), `dimensions` (query, page, country, device, date), `query`/`page` (`{ operator, value }`: contains, notContains, equals, notEquals, includingRegex, excludingRegex), `country` (ISO-3), `device`, `limit`. |
| POST | `/api/projects/:projectId/gsc/explore.csv` | The same as CSV. |

### issue-trends.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/issue-trends` | Each issue's page count per audit, Site Health and AI Readiness. q: `limit` (audits). |

### alert-channels.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/alerts/config` | Alert channels without secrets, and recent sends. |
| PUT | `/api/alerts/config` | body: `email` (`on`, `host`, `port`, `security`, `user`, `password`, `from`, `to`), `webhook` / `slack` (`on`, `url`, `clear`), `toast`, `maxPerHour`, `dedupHours`. |
| POST | `/api/alerts/test` | body: `channel` (email, webhook, slack, toast). Sends a test message. |

### task-schedule.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/alerts/task` | The optional scheduled task (Windows Task Scheduler) status, or the crontab line. |
| PUT | `/api/alerts/task` | body: `install` (true installs at `time`, e.g. 06:00; false removes). |

### report-delivery.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/report-delivery` | Scheduled report settings and the project's branding. |
| PUT | `/api/projects/:projectId/report-delivery` | body: `report` (`schedule` off/weekly/monthly, `delivery` email/folder, `format` pdf/html, `to`, `folder`), `branding` (`name`, `logo` data URI, `primary`, `accent` #rrggbb, `whiteLabel`). |
| POST | `/api/projects/:projectId/report-delivery/send` | Sends or saves the report now. |
| GET | `/api/branding` | App-wide report branding. |
| PUT | `/api/branding` | body: `name`, `logo` (data URI), `primary`, `accent` (#rrggbb), `whiteLabel`. |

### page-compare.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| POST | `/api/projects/:projectId/page-compare` | body: `mine`, `theirs` (URLs), `keyword`. Fetches the two pages once and compares them. |

### aio-gap.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/aio-gap/searches` | Searches with a stored Google AI Overview (from AI visibility runs), newest first. |
| POST | `/api/projects/:projectId/aio-gap` | body: `mine` (URL), `keyword`, optional `sources` (cited URLs) and `answer`. Without sources, uses the stored AI Overview for the search. Reads up to 8 cited pages once and lists what the answer and the cited pages cover that your page doesn't. |

### competitor-pages.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| POST | `/api/projects/:projectId/competitor-pages` | body: `domains` (list). Pages in a competitor's sitemap that your site doesn't have. |

### link-gap.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| POST | `/api/projects/:projectId/link-gap` | body: `domains` (2-5 competitor domains), optional `min` (1 or 2). Paid: one DataForSEO referring-domains call per competitor plus one for your site. Returns sites linking to 2+ competitors but not to you, labelled listing / site / spam. |

### kw-ideas.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/keyword-ideas` | Stored keyword ideas (Google Autocomplete) and job status. |
| POST | `/api/projects/:projectId/keyword-ideas` | Starts collecting ideas from Autocomplete. body: `az` (also a–z modifiers). |
| POST | `/api/projects/:projectId/keyword-ideas/volumes` | Paid (DataForSEO): search volumes. body: `keywords` (optional list). |

### clusters.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/clusters` | Search clusters from Search Console (shared pages and words) with gaps. |

### competitor-gap.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/competitor-gap` | Topics competitors cover that the site doesn't, and job status. |
| POST | `/api/projects/:projectId/competitor-gap` | Starts reading the competitors' sitemaps and titles (setting `competitorDomains`). |

### content-inventory.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/inventory` | Content inventory: every indexable page with a suggested action. |
| GET | `/api/projects/:projectId/inventory.csv` | The same as CSV. |

### content-brief.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/briefs` | Saved content briefs. |
| GET | `/api/projects/:projectId/briefs/:briefId` | One brief. |
| POST | `/api/projects/:projectId/briefs` | Paid (DataForSEO): body `topic`. Builds an outline from the top 10 results and your searches. |
| DELETE | `/api/projects/:projectId/briefs/:briefId` | Removes a brief. |

### page-content.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/audits/:auditId/export/markdown` | Main content of every indexable page as Markdown (streamed). |
| GET | `/api/audits/:auditId/export/jsonl` | One JSON object per crawled page (streamed). |

### google-auth.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/google/oauth` | Google sign-in status (no secrets). |
| PUT | `/api/google/oauth` | body: `clientId`, `clientSecret` (write-only). |
| POST | `/api/google/oauth/start` | Starts the sign-in: returns the URL to open; the answer comes back to a one-off 127.0.0.1 listener. |
| POST | `/api/google/oauth/disconnect` | Signs out (revokes and forgets the token). |

### ga4.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/ga4` | Stored GA4 data: organic landing pages, key events, AI referrals, trend. |
| POST | `/api/projects/:projectId/ga4` | Refreshes GA4 data (property ID in the project settings). |

### bing.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/bing/config` | Whether a Bing Webmaster Tools API key is saved. |
| PUT | `/api/bing/config` | body: `apiKey` (write-only; empty removes it). |
| GET | `/api/projects/:projectId/bing` | Stored Bing Webmaster Tools data. |
| POST | `/api/projects/:projectId/bing` | Refreshes Bing Webmaster Tools data. |

### indexnow.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/indexnow/changed` | Pages new or changed since the previous audit (to submit). |
| POST | `/api/projects/:projectId/indexnow` | body: `urls` (the site's own host only). Submits them to IndexNow. |
| POST | `/api/projects/:projectId/indexnow/check-key` | Checks that `<key>.txt` is live on the site. |

### alerts.mjs

| Method | Path | Parameters and notes |
|---|---|---|
| GET | `/api/projects/:projectId/alerts` | Alert rules for the project and recent alerts. |
| PUT | `/api/projects/:projectId/alerts` | body: `rules` (`{ ruleId: { on, …its number fields } }`), `emailTo`, `mute`. |
| POST | `/api/projects/:projectId/alerts/run` | Checks the data alert rules now. |
