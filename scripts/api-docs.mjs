// docs/api.md from the code (REQ-055 group 9): every route the server and its modules register (method and path),
// with the parameters written below in NOTES. A test fails when a route has no note or docs/api.md is out of date.
//   node scripts/api-docs.mjs          write docs/api.md
//   node scripts/api-docs.mjs --check  exit 1 when it is out of date
// The link engine (backlinks.mjs, which would start the engine) and the in-app audit timer aren't loaded; their
// prefixes are listed by hand.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DOC = path.join(ROOT, "docs", "api.md");
const SKIP = new Set(["./backlinks.mjs", "./scheduler.mjs"]);

const P = ":projectId", A = ":auditId";
/** Parameters and notes per route ("METHOD /path"). q = query string, body = JSON body. */
export const NOTES = {
  "GET /api/projects": "All projects with their latest finished audit and Site Health change.",
  "POST /api/projects": "body: `start_url` (required), `name`, `settings` (see Audit settings; request header values are stored apart and never returned).",
  [`GET /api/projects/${P}`]: "One project with its settings and the last 60 audits.",
  [`PUT /api/projects/${P}`]: "body: `name`, `start_url`, `settings` (partial; unknown keys ignored, values clamped).",
  [`DELETE /api/projects/${P}`]: "Deletes the project and everything stored for it (stops a running audit).",
  [`POST /api/projects/${P}/audits`]: "Starts an audit (or returns the running one): `{ auditId }`. Progress arrives on `/api/events`.",
  [`GET /api/audits/${A}`]: "Audit, previous audit, issue groups (new/fixed counts), crawlability checks, depth and status counts. `site_info.skipped` lists check groups that failed to run.",
  [`POST /api/audits/${A}/stop`]: "Stops a running audit.",
  [`POST /api/audits/${A}/resume`]: "Continues the project's newest stopped or interrupted audit.",
  [`GET /api/audits/${A}/issues/:checkId`]: "Affected URLs of one check. q: `limit` (≤ 5000, default 500), `offset`.",
  [`GET /api/audits/${A}/pages`]: "q: `q` (URL/title contains), `status` (ok, redirect, error), `indexable` (1/0), `issue` (check id), `x`/`xop`/`xv` (custom extraction filter), `sort`, `dir` (asc/desc), `limit` (≤ 5000), `offset`.",
  [`GET /api/audits/${A}/page`]: "q: `url`. The page with its issues, links in and out, Search Console and Lighthouse data.",
  "GET /api/compare/:a/:b": "Issues added and fixed, pages new and lost, between two audits of one project.",
  "GET /api/checks": "Every check: id, severity, title, why, fix, group, source (Google page or label). q: `counts=1` returns `{ counts, checks }`.",
  "GET /api/modules": "How many modules the server loads and those that failed to load, with the reason.",
  [`GET /api/audits/${A}/cwv`]: "Lighthouse rows (mobile and desktop) and thresholds.",
  [`POST /api/audits/${A}/cwv`]: "Runs Lighthouse again. body: `pages` (1–10000, default 5).",
  [`GET /api/projects/${P}/crux`]: "Chrome UX Report field data stored for the project.",
  [`POST /api/projects/${P}/crux`]: "Fetches field data (needs the CrUX API key). body: `auditId` (optional).",
  [`GET /api/projects/${P}/crux-history`]: "25-week CrUX History stored for the project.",
  [`POST /api/projects/${P}/crux-history`]: "Fetches the CrUX History (needs the CrUX API key).",
  "GET /api/gsc/sites": "Search Console properties the signed-in account or service account can read.",
  [`GET /api/projects/${P}/gsc`]: "Search Console summary: totals, pages, queries, quick wins, CTR report.",
  [`POST /api/projects/${P}/gsc`]: "Refreshes Search Console data now.",
  "GET /api/dfs/status": "DataForSEO login present, money spent this month and the monthly budget.",
  "GET /api/config": "App settings without secrets (`hasPassword`, `hasCruxKey` flags only).",
  "PUT /api/config": "body: `dfsMonthlyBudget` (0–1000), `dfsLogin`, `dfsPassword` (write-only), `dfsConfigPath`, `gscKeyFile`, `cruxApiKey` (write-only), `clearCruxKey`.",
  [`GET /api/projects/${P}/keywords`]: "Stored ranked-keyword snapshots.",
  [`POST /api/projects/${P}/keywords`]: "Paid (DataForSEO): fetches the keywords the domain ranks for.",
  [`GET /api/projects/${P}/backlinks`]: "Stored backlink snapshots with the spam review.",
  [`POST /api/projects/${P}/backlinks`]: "Paid (DataForSEO): fetches the backlink summary, referring domains and anchors.",
  [`GET /api/projects/${P}/disavow.txt`]: "A disavow file draft from the spam review (plain text).",
  [`GET /api/projects/${P}/visibility`]: "Prompts, runs with per-platform rates, the last run's results and share of voice.",
  [`POST /api/projects/${P}/visibility/prompts`]: "body: `prompts` (one per line, up to 200, 300 characters each).",
  [`DELETE /api/projects/${P}/visibility/prompts/:promptId`]: "Removes a prompt.",
  [`POST /api/projects/${P}/visibility/run`]: "Paid (DataForSEO): runs every prompt. body: `platforms` (chatgpt, google, ai_mode, perplexity, gemini; default all). `{ runId, calls }`.",
  [`POST /api/projects/${P}/visibility/runs/:runId/resume`]: "Paid: finishes a stopped or failed run (only the checks it has no answer for).",
  [`GET /api/projects/${P}/visibility/suggestions`]: "Free: question searches from Search Console (5+ impressions) that aren't prompts yet.",
  [`GET /api/projects/${P}/visibility/trends`]: "Per prompt per run: answered, mentioned, cited, best rank; share of voice per run.",
  [`GET /api/projects/${P}/visibility/sources`]: "Last run: own pages AI cites, and the closest own page for prompts where only others are cited.",
  [`GET /api/projects/${P}/visibility/listing-targets`]: "Last run: other sites' pages AI cited or ChatGPT read for prompts that don't name you (list and directory pages flagged), and ChatGPT's own searches per prompt.",
  [`GET /api/projects/${P}/visibility/schedule`]: "The opt-in scheduled run: enabled, everyDays, platforms, maxCost, estimate per run, last result.",
  [`PUT /api/projects/${P}/visibility/schedule`]: "body: `enabled` (only `true` turns paid runs on), `everyDays` (7, 14 or 30), `platforms`, `maxCost` (dollars per run or null).",
  [`GET /api/audits/${A}/report.html`]: "The report as HTML.",
  [`GET /api/audits/${A}/report.pdf`]: "The report as PDF (needs Chrome or Edge).",
  [`GET /api/audits/${A}/priorities`]: "Fix first: issues ranked by severity, pages and Search Console impressions.",
  [`GET /api/audits/${A}/changes`]: "Pages whose title, description, H1, words or status changed since the previous audit.",
  [`GET /api/audits/${A}/source`]: "q: `url`. File and line hints in the local site folder (setting `localFolder`).",
  [`GET /api/audits/${A}/link-opportunities`]: "Internal link ideas: pages that mention another page's topic without linking to it.",
  [`POST /api/audits/${A}/ask-claude`]: "body: `url`. A prompt describing the page's issues, to paste into an AI assistant.",
  [`POST /api/projects/${P}/robots-test`]: "body: `url` (path or URL). Whether robots.txt allows it, for each crawler.",
  "GET /api/autostart": "Desktop: whether the app starts with Windows.",
  "PUT /api/autostart": "Desktop: body `enabled`.",
  [`GET /api/audits/${A}/similar`]: "Near-duplicate page pairs. q: `min` (share of shared phrases, default 0.2).",
  [`GET /api/audits/${A}/page2`]: "Pages ranking just off page 1. q: `min` (default 8), `max` (default 20) position.",
  [`GET /api/projects/${P}/indexing`]: "URL Inspection runs and results.",
  [`POST /api/projects/${P}/indexing`]: "Inspects the site's URLs with the URL Inspection API now.",
  [`GET /api/audits/${A}/topics`]: "Topic clusters (hub and spoke) from the site's folders and links.",
  [`GET /api/audits/${A}/zero-click`]: "Searches with impressions and no clicks. q: `min` (default 5), `max` (default 20) position.",
  [`GET /api/projects/${P}/citations`]: "Business listing pages and their name/address/phone checks.",
  [`POST /api/projects/${P}/citations`]: "body: `url` of a listing page to track.",
  [`DELETE /api/projects/${P}/citations`]: "q: `url` of the listing to remove.",
  [`POST /api/projects/${P}/citations/check`]: "Fetches every listing page and checks name, address and phone.",
  [`GET /api/projects/${P}/decay`]: "Pages losing clicks or impressions (Search Console history).",
  [`GET /api/projects/${P}/query-alignment`]: "Title/H1 gaps, unanswered question searches, intent mix, merge candidates. q: `min` question impressions (default 10).",
  [`GET /api/projects/${P}/lost-urls`]: "Gone or wrongly redirected URLs that had value, with a 301 target for each.",
  [`GET /api/audits/${A}/link-graph`]: "Internal link graph: nodes, edges, orphans, depth.",
  [`GET /api/projects/${P}/trends`]: "Search Console trend findings (rising and falling searches and pages).",
  [`GET /api/projects/${P}/serp-features`]: "Search results features from the last AI visibility run's Google searches, and opportunities.",
  [`GET /api/projects/${P}/changes`]: "The change log with each change's before/after impact.",
  [`POST /api/projects/${P}/changes`]: "body: `date` (yyyy-mm-dd), `kind` (title, content, links, technical, schema, new-page, redirect, other), `summary`, `urls`, `ref`.",
  [`DELETE /api/projects/${P}/changes/:changeId`]: "Removes a change log entry.",
  [`GET /api/projects/${P}/rank`]: "Rank tracker: target keywords with position, clicks, impressions, best page and changes.",
  [`GET /api/projects/${P}/rank/keyword`]: "q: `k` (keyword). Day-by-day history, devices and pages for one keyword.",
  [`PUT /api/projects/${P}/rank/tags`]: "body: `keyword`, `tags` (list).",
  [`GET /api/projects/${P}/rank/alerts`]: "Rank drops, new top 3 and lost top 10.",
  [`GET /api/projects/${P}/gsc/sitemaps`]: "Submitted sitemaps from the Search Console Sitemaps API.",
  [`GET /api/projects/${P}/gsc/types`]: "Discover and Google News performance, when the property has data.",
  [`GET /api/projects/${P}/index-rotation`]: "Scheduled URL Inspection: per-day number, quota use, next URLs.",
  [`PUT /api/projects/${P}/index-rotation`]: "body: `perDay` (0 = off, capped below Google's 2,000 a day).",
  [`GET /api/projects/${P}/index-history`]: "q: `url`. Index-status history of one URL.",
  [`POST /api/projects/${P}/gsc/explore`]: "Live Search Console query. body: `startDate`, `endDate`, `type` (web, image, video, news, discover, googleNews), `dimensions` (query, page, country, device, date), `query`/`page` (`{ operator, value }`: contains, notContains, equals, notEquals, includingRegex, excludingRegex), `country` (ISO-3), `device`, `limit`.",
  [`POST /api/projects/${P}/gsc/explore.csv`]: "The same as CSV.",
  [`GET /api/projects/${P}/issue-trends`]: "Each issue's page count per audit, Site Health and AI Readiness. q: `limit` (audits).",
  "GET /api/alerts/config": "Alert channels without secrets, and recent sends.",
  "PUT /api/alerts/config": "body: `email` (`on`, `host`, `port`, `security`, `user`, `password`, `from`, `to`), `webhook` / `slack` (`on`, `url`, `clear`), `toast`, `maxPerHour`, `dedupHours`.",
  "POST /api/alerts/test": "body: `channel` (email, webhook, slack, toast). Sends a test message.",
  "GET /api/alerts/task": "The optional scheduled task (Windows Task Scheduler) status, or the crontab line.",
  "PUT /api/alerts/task": "body: `install` (true installs at `time`, e.g. 06:00; false removes).",
  [`GET /api/projects/${P}/report-delivery`]: "Scheduled report settings and the project's branding.",
  [`PUT /api/projects/${P}/report-delivery`]: "body: `report` (`schedule` off/weekly/monthly, `delivery` email/folder, `format` pdf/html, `to`, `folder`), `branding` (`name`, `logo` data URI, `primary`, `accent` #rrggbb, `whiteLabel`).",
  [`POST /api/projects/${P}/report-delivery/send`]: "Sends or saves the report now.",
  "GET /api/branding": "App-wide report branding.",
  "PUT /api/branding": "body: `name`, `logo` (data URI), `primary`, `accent` (#rrggbb), `whiteLabel`.",
  [`POST /api/projects/${P}/page-compare`]: "body: `mine`, `theirs` (URLs), `keyword`. Fetches the two pages once and compares them.",
  [`GET /api/projects/${P}/aio-gap/searches`]: "Searches with a stored Google AI Overview (from AI visibility runs), newest first.",
  [`POST /api/projects/${P}/aio-gap`]: "body: `mine` (URL), `keyword`, optional `sources` (cited URLs) and `answer`. Without sources, uses the stored AI Overview for the search. Reads up to 8 cited pages once and lists what the answer and the cited pages cover that your page doesn't.",
  [`POST /api/projects/${P}/link-gap`]: "body: `domains` (2-5 competitor domains), optional `min` (1 or 2). Paid: one DataForSEO referring-domains call per competitor plus one for your site. Returns sites linking to 2+ competitors but not to you, labelled listing / site / spam.",
  [`POST /api/projects/${P}/competitor-pages`]: "body: `domains` (list). Pages in a competitor's sitemap that your site doesn't have.",
  [`GET /api/projects/${P}/keyword-ideas`]: "Stored keyword ideas (Google Autocomplete) and job status.",
  [`POST /api/projects/${P}/keyword-ideas`]: "Starts collecting ideas from Autocomplete. body: `az` (also a–z modifiers).",
  [`POST /api/projects/${P}/keyword-ideas/volumes`]: "Paid (DataForSEO): search volumes. body: `keywords` (optional list).",
  [`GET /api/projects/${P}/clusters`]: "Search clusters from Search Console (shared pages and words) with gaps.",
  [`GET /api/projects/${P}/competitor-gap`]: "Topics competitors cover that the site doesn't, and job status.",
  [`POST /api/projects/${P}/competitor-gap`]: "Starts reading the competitors' sitemaps and titles (setting `competitorDomains`).",
  [`GET /api/projects/${P}/inventory`]: "Content inventory: every indexable page with a suggested action.",
  [`GET /api/projects/${P}/inventory.csv`]: "The same as CSV.",
  [`GET /api/projects/${P}/briefs`]: "Saved content briefs.",
  [`GET /api/projects/${P}/briefs/:briefId`]: "One brief.",
  [`POST /api/projects/${P}/briefs`]: "Paid (DataForSEO): body `topic`. Builds an outline from the top 10 results and your searches.",
  [`DELETE /api/projects/${P}/briefs/:briefId`]: "Removes a brief.",
  [`GET /api/audits/${A}/export/markdown`]: "Main content of every indexable page as Markdown (streamed).",
  [`GET /api/audits/${A}/export/jsonl`]: "One JSON object per crawled page (streamed).",
  "GET /api/google/oauth": "Google sign-in status (no secrets).",
  "PUT /api/google/oauth": "body: `clientId`, `clientSecret` (write-only).",
  "POST /api/google/oauth/start": "Starts the sign-in: returns the URL to open; the answer comes back to a one-off 127.0.0.1 listener.",
  "POST /api/google/oauth/disconnect": "Signs out (revokes and forgets the token).",
  [`GET /api/projects/${P}/ga4`]: "Stored GA4 data: organic landing pages, key events, AI referrals, trend.",
  [`POST /api/projects/${P}/ga4`]: "Refreshes GA4 data (property ID in the project settings).",
  "GET /api/bing/config": "Whether a Bing Webmaster Tools API key is saved.",
  "PUT /api/bing/config": "body: `apiKey` (write-only; empty removes it).",
  [`GET /api/projects/${P}/bing`]: "Stored Bing Webmaster Tools data.",
  [`POST /api/projects/${P}/bing`]: "Refreshes Bing Webmaster Tools data.",
  [`GET /api/projects/${P}/indexnow/changed`]: "Pages new or changed since the previous audit (to submit).",
  [`POST /api/projects/${P}/indexnow`]: "body: `urls` (the site's own host only). Submits them to IndexNow.",
  [`POST /api/projects/${P}/indexnow/check-key`]: "Checks that `<key>.txt` is live on the site.",
  [`GET /api/projects/${P}/alerts`]: "Alert rules for the project and recent alerts.",
  [`PUT /api/projects/${P}/alerts`]: "body: `rules` (`{ ruleId: { on, …its number fields } }`), `emailTo`, `mute`.",
  [`POST /api/projects/${P}/alerts/run`]: "Checks the data alert rules now.",
};

const NAMES = { projects: P, audits: A, prompts: ":promptId", runs: ":runId", changes: ":changeId", briefs: ":briefId", issues: ":checkId" };
/** "^\/api\/projects\/(\d+)\/x$" → "/api/projects/:projectId/x" */
export function pathOf(re) {
  let s = (re.source || String(re)).replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replace(/\\\./g, ".");
  const ab = [":a", ":b"];
  s = s.replace(/\/([a-z0-9-]+)\/\((?:\\d\+|\[a-z0-9_\]\+)\)(?:\/\((?:\\d\+)\))?/g, (m, seg) => {
    if (seg === "compare") return `/compare/${ab[0]}/${ab[1]}`;
    return `/${seg}/${NAMES[seg] || ":param"}`;
  });
  return s;
}

/** [{ module, method, path }] for the core routes and every module (minus the link engine and audit timer). */
export async function collectRoutes() {
  process.env.SEO_AUDITOR_DATA ||= mkdtempSync(path.join(tmpdir(), "seo-auditor-apidocs-")); // never the real data folder
  const server = await import("../src/server.mjs");
  const out = server.routes.map(([method, re]) => ({ module: "core (server.mjs, api.mjs)", method, path: pathOf(re) }));
  for (const m of server.MODULES.filter((x) => !SKIP.has(x))) {
    const routes = [];
    await (await import(new URL("../src/" + m.slice(2), import.meta.url))).register?.({ routes, prefixes: [], cli: true });
    for (const [method, re] of routes) out.push({ module: m.slice(2), method, path: pathOf(re) });
  }
  return out;
}

const INTRO = `# SEO Auditor API

The web app talks to a local JSON API. Generated from the routes the server registers by
\`node scripts/api-docs.mjs\` (a test checks it is current); the parameter notes live in that script.

## Basics

- Base URL: \`http://localhost:4560\` (\`SEO_AUDITOR_PORT\` changes the port). The server listens on 127.0.0.1 only.
- Requests must use the host \`localhost:<port>\` or \`127.0.0.1:<port>\`, and a browser \`Origin\` header, when sent,
  must be the same host (DNS-rebinding and cross-site protection). Other hosts get 421 or 403.
- POST and PUT bodies are JSON (\`Content-Type: application/json\`, at most 1 MB); otherwise 415.
- Answers are JSON unless noted (CSV, HTML, PDF, Markdown, JSONL downloads). Errors are \`{ "error": "message" }\`
  with a 4xx status, or 500 with \`Internal error: …\`.
- Secrets (passwords, API keys, OAuth secrets, request header values) are write-only: no GET returns them.
- Paid routes (DataForSEO) are marked *Paid*; each call is checked against the monthly budget (402 when reached).
- \`:projectId\`, \`:auditId\` and other ids are numbers.

## Not JSON routes

| Method | Path | Notes |
|---|---|---|
| GET | \`/api/events\` | Server-Sent Events: audit progress (\`started\`, \`progress\`, \`phase\`, \`crawled\`, \`done\`, \`failed\`) and \`visibility\` run updates. |
| GET | \`/api/audits/:auditId/export/issues.csv\` | Issues CSV (also \`pages.csv\` with custom extraction columns, and \`links.csv\`). |
| any | \`/lv/…\`, \`/api/s/…\`, \`/s/…\`, \`/fonts/…\` | Link building: passed to the link engine on 127.0.0.1:4561. |
`;

export async function apiDoc() {
  const routes = await collectRoutes();
  const missing = routes.filter((r) => !NOTES[`${r.method} ${r.path}`]).map((r) => `${r.method} ${r.path}`);
  const by = new Map();
  for (const r of routes) { if (!by.has(r.module)) by.set(r.module, []); by.get(r.module).push(r); }
  const parts = [INTRO, `## Routes (${routes.length})`, ""];
  for (const [mod, list] of by) {
    parts.push(`### ${mod}`, "", "| Method | Path | Parameters and notes |", "|---|---|---|");
    for (const r of list) parts.push(`| ${r.method} | \`${r.path}\` | ${(NOTES[`${r.method} ${r.path}`] || "").replace(/\|/g, "\\|")} |`);
    parts.push("");
  }
  return { text: parts.join("\n"), missing, routes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, missing } = await apiDoc();
  if (missing.length) { console.error(`Routes without a note in scripts/api-docs.mjs NOTES:\n  ${missing.join("\n  ")}`); process.exitCode = 1; }
  else if (process.argv.includes("--check")) {
    let cur = ""; try { cur = readFileSync(DOC, "utf8").replace(/\r\n/g, "\n"); } catch {}
    if (cur !== text) { console.error("docs/api.md is out of date: run node scripts/api-docs.mjs"); process.exitCode = 1; } else console.log("docs/api.md is current");
  } else { mkdirSync(path.dirname(DOC), { recursive: true }); writeFileSync(DOC, text); console.log(`docs/api.md written`); }
  process.exit();
}
