// Adaptive crawl speed (REQ-055 group 2, Oct 2026): the controller speeds up on fast clean answers, drops back on
// slow-downs, errors and rising response times, respects robots.txt Crawl-delay, and cooperates with the fetch
// ladder's slow-down. fetch is faked, so nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import robotsParser from "robots-parser";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { createSpeed, crawlDelayMs, WINDOW } = await import("../src/crawl-speed.mjs");
const { createLadder } = await import("../src/fetch-ladder.mjs");
const { pool, runAudit } = await import("../src/crawler.mjs");
const { createProject, updateProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");

const fast = (s, n = WINDOW, ms = 100) => { for (let i = 0; i < n; i++) s.record({ ms, status: 200 }); };

test("speeds up one request at a time while answers are fast and clean, up to the maximum", () => {
  const s = createSpeed({ start: 4, max: 6 });
  assert.equal(s.width(), 4);
  fast(s); assert.equal(s.width(), 5);
  fast(s); assert.equal(s.width(), 6);
  fast(s, WINDOW * 3); assert.equal(s.width(), 6);
  assert.deepEqual([s.stats.peak, s.stats.ups], [6, 2]);
  // max below start: no speeding up; fallback timings don't count.
  const fixed = createSpeed({ start: 6, max: 3 });
  fast(fixed, WINDOW * 3); assert.equal(fixed.width(), 6);
  const s2 = createSpeed({ start: 2, max: 8 });
  for (let i = 0; i < WINDOW * 2; i++) s2.record({ ms: null, status: 200, direct: false });
  assert.equal(s2.width(), 2);
});

test("a 429/503 halves the width and stops speeding up; errors drop back to the start; slower answers drop one", () => {
  const s = createSpeed({ start: 4, max: 12 });
  fast(s, WINDOW * 4); assert.equal(s.width(), 8);
  s.record({ status: 429, slowDown: true }); assert.equal(s.width(), 4);
  fast(s, WINDOW * 3); assert.equal(s.width(), 4, "frozen after a slow-down answer");
  assert.equal(s.stats.frozen, true);

  const e = createSpeed({ start: 3, max: 12 });
  fast(e, WINDOW * 3); assert.equal(e.width(), 6);
  e.record({ status: 0, error: "timeout" }); assert.equal(e.width(), 3);
  e.record({ status: 200, ms: 90, retries: 1 }); assert.equal(e.width(), 2);
  e.record({ status: 504 }); assert.equal(e.width(), 1);
  e.record({ status: 500 }); e.record({ status: 404 }); assert.equal(e.width(), 1, "a page's own 500 or 404 isn't the server struggling");
  fast(e); assert.equal(e.width(), 2, "speeds up again after errors (not a slow-down answer)");

  const t = createSpeed({ start: 5, max: 12 });
  fast(t, WINDOW, 200); // baseline 200 ms
  assert.equal(t.width(), 6);
  fast(t, WINDOW, 900); assert.equal(t.width(), 5);
  assert.equal(t.stats.last, "slower answers");
});

test("Crawl-delay: one request at a time, spaced as robots.txt asks, for this tool's agent or *", async () => {
  const star = robotsParser("https://example.com/robots.txt", "User-agent: *\nCrawl-delay: 2\nDisallow: /x\n");
  const ours = robotsParser("https://example.com/robots.txt", "User-agent: SEOAuditor\nCrawl-delay: 0.5\n\nUser-agent: *\nCrawl-delay: 10\n");
  const other = robotsParser("https://example.com/robots.txt", "User-agent: Bingbot\nCrawl-delay: 5\n");
  assert.deepEqual([crawlDelayMs(star), crawlDelayMs(ours), crawlDelayMs(other), crawlDelayMs(null)], [2000, 500, 0, 0]);
  let clock = 1000; const slept = [];
  const s = createSpeed({ start: 6, max: 12, crawlDelay: 2000, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  assert.equal(s.width(), 1);
  fast(s, WINDOW * 3); assert.equal(s.width(), 1);
  await Promise.all([s.gate(), s.gate(), s.gate()]); // parallel callers queue up
  assert.deepEqual(slept, [2000, 2000]);
  assert.equal(s.stats.crawlDelayS, 2);
});

test("pool follows a changing width mid-batch and passes on the first error", async () => {
  let width = 1, active = 0, peak = 0; const order = [];
  await pool(() => width, [1, 2, 3, 4, 5, 6, 7, 8], async (x) => {
    active++; peak = Math.max(peak, active); order.push(x);
    if (x === 2) width = 4; // speeds up: the next starts use the new width
    await new Promise((r) => setTimeout(r, 5));
    active--;
  });
  assert.equal(order.length, 8);
  assert.equal(peak, 4);
  await assert.rejects(pool(3, [1, 2, 3], async (x) => { if (x === 2) throw new Error("boom"); }), /boom/);
  let n = 0;
  await pool(2, [1, 2, 3, 4], async () => { n++; }, () => n >= 2);
  assert.equal(n, 2);
});

test("the ladder halves the width in use, not its starting maximum", async () => {
  let width = 9, n = 0;
  const ladder = createLadder({ concurrency: 12, width: () => width, sleep: async () => {}, fetchPage: async (u) => (++n === 1
    ? { status: 429, headers: new Headers({ "retry-after": "1" }), body: "", finalUrl: u, ms: 50 } : { status: 200, headers: new Headers(), body: "ok", finalUrl: u, ms: 50 }) });
  await ladder.fetch("https://example.com/a");
  assert.equal(ladder.parallel(), 4);
  assert.deepEqual([ladder.stats.from, ladder.stats.parallel], [9, 4]);
});

test("a crawl obeys Crawl-delay end to end and records its speed on the audit", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 4 } });
  updateProject(p.id, { settings: { maxConcurrency: 99 } });
  assert.equal(projectSettings(get("SELECT * FROM projects WHERE id=?", p.id)).maxConcurrency, 20);
  let inFlight = 0, peak = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nCrawl-delay: 3\n", { headers: { "content-type": "text/plain" } });
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (/^\/(|p\d)$/.test(u.pathname)) return new Response(`<html><head><title>Page ${u.pathname}</title></head><body>${[1, 2, 3, 4, 5].map((i) => `<a href="/p${i}">${i}</a>`).join(" ")}</body></html>`, { headers: { "content-type": "text/html" } });
    return new Response("nf", { status: 404, headers: { "content-type": "text/plain" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const slept = [];
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const auditId = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(auditId, project, settings, () => {}, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(all("SELECT url FROM pages WHERE audit_id=?", auditId).length, 6);
  assert.equal(peak, 1, "one page request at a time");
  assert.ok(slept.filter((ms) => ms > 0).length >= 5, "each page waited for its Crawl-delay slot");
  const info = JSON.parse(get("SELECT site_info FROM audits WHERE id=?", auditId).site_info);
  assert.deepEqual([info.speed.crawlDelayS, info.speed.max, info.speed.width], [3, 1, 1]);
});
