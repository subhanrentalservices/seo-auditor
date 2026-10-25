// Index status (REQ-020, 2026-10-25): URL Inspection results classified by Google's reason, only pages the site
// wants indexed are inspected, and the daily quota stops a run without losing results. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
const { classify, parseInspection, targets, startIndexRun, indexData } = await import("../src/indexing.mjs");

const S = "https://acmemotors.com.au";
run("INSERT INTO projects (id, name, start_url) VALUES (980, 'Acme Motors', 'https://acmemotors.com.au/')");
run("INSERT INTO audits (id, project_id, status) VALUES (981, 980, 'done')");
const page = (p, status, indexable, type = "text/html; charset=utf-8") =>
  run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, depth) VALUES (981,?,?,?,?,?,1)", S + p, S + p, status, indexable, type);
page("/", 200, 1); page("/smash.html", 200, 1); page("/blog/new-post.html", 200, 1); page("/old.html", 301, 0); page("/thanks.html", 200, 0); page("/logo.png", 200, 1, "image/png");

const answer = (coverageState, verdict = "NEUTRAL", extra = {}) => ({ inspectionResult: { indexStatusResult: { coverageState, verdict, ...extra } } });

test("Google's reasons map to a kind and a fix; 'Soft 404' is not a plain 404", () => {
  assert.equal(classify("Submitted and indexed", "PASS").kind, "indexed");
  assert.equal(classify("Indexed, not submitted in sitemap", "PASS").kind, "indexed");
  assert.equal(classify("Crawled - currently not indexed").kind, "crawled");
  assert.equal(classify("Discovered - currently not indexed").kind, "discovered");
  assert.equal(classify("URL is unknown to Google").kind, "unknown");
  assert.equal(classify("Duplicate, Google chose different canonical than user").kind, "duplicate");
  assert.equal(classify("Alternate page with proper canonical tag").kind, "alternate");
  assert.equal(classify("Soft 404").kind, "soft404");
  assert.equal(classify("Not found (404)").kind, "notfound");
  assert.equal(classify("Excluded by ‘noindex’ tag").kind, "noindex");
  assert.equal(classify("Something new").kind, "other");
});

test("an inspection response keeps verdict, reason, last crawl and both canonicals", () => {
  const x = parseInspection(answer("Duplicate, Google chose different canonical than user", "NEUTRAL",
    { lastCrawlTime: "2026-10-20T01:02:03Z", googleCanonical: S + "/", userCanonical: S + "/smash.html", sitemap: [S + "/sitemap.xml"] }));
  assert.deepEqual([x.coverage, x.last_crawl, x.google_canonical, x.user_canonical, x.sitemap], ["Duplicate, Google chose different canonical than user", "2026-10-20T01:02:03Z", S + "/", S + "/smash.html", 1]);
});

test("HTML pages are inspected: indexable ones as wanted (first), the rest as expected; images are skipped", () => {
  const t = targets(980);
  assert.deepEqual(t.filter((x) => x.wanted).map((x) => x.url).sort(), [S + "/", S + "/blog/new-post.html", S + "/smash.html"]);
  assert.deepEqual(t.filter((x) => !x.wanted).map((x) => x.url).sort(), [S + "/old.html", S + "/thanks.html"]);
  assert.ok(t.slice(0, 3).every((x) => x.wanted), "wanted pages come first so a capped run keeps them");
});

test("a run stores each page and groups the not-indexed ones", async () => {
  const replies = { [S + "/"]: answer("Submitted and indexed", "PASS"), [S + "/smash.html"]: answer("Crawled - currently not indexed"), [S + "/blog/new-post.html"]: answer("URL is unknown to Google"),
    [S + "/old.html"]: answer("Page with redirect"), [S + "/thanks.html"]: answer("Submitted and indexed", "PASS") };
  const r = await startIndexRun({ id: 980, start_url: S + "/", settings: "{}" }, { inspect: async (u) => replies[u] });
  await r.done;
  const d = indexData(980);
  assert.deepEqual([d.total, d.indexed, d.notIndexed, d.errors], [3, 1, 2, 0]);
  assert.deepEqual(d.groups, { indexed: 1, crawled: 1, unknown: 1 });
  assert.equal(d.expected, 1, "the redirect is expected out of Google");
  assert.equal(d.strayIndexed, 1, "the noindex thank-you page got indexed anyway");
  assert.equal(d.lastRun.status, "done");
});

test("hitting the daily quota stops the run and keeps earlier results", async () => {
  const quota = Object.assign(new Error("Quota exceeded"), { response: { status: 429, data: { error: { message: "Quota exceeded for quota metric" } } } });
  const r = await startIndexRun({ id: 980, start_url: S + "/", settings: "{}" }, { inspect: async () => { throw quota; } });
  await r.done;
  const d = indexData(980);
  assert.equal(d.lastRun.status, "stopped");
  assert.match(d.lastRun.message, /Quota/);
  assert.deepEqual([d.total, d.indexed, d.errors, d.expected], [3, 1, 0, 1], "the previous results are untouched");
});

test("other API errors are recorded per page", async () => {
  const r = await startIndexRun({ id: 980, start_url: S + "/", settings: "{}" }, { inspect: async (u) => { if (u.endsWith("/smash.html")) throw new Error("URL not in property"); return answer("Submitted and indexed", "PASS"); } });
  await r.done;
  const d = indexData(980);
  assert.deepEqual([d.indexed, d.errors, d.strayIndexed], [2, 1, 2]);
  assert.equal(d.rows.find((x) => x.error).url, S + "/smash.html");
});
