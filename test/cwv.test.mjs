// Lighthouse re-checks (REQ-013, 2026-10-23): a page whose blocking time spikes in one run is re-run, and the median
// run tells a slow page from a busy computer. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { recheckTargets, medianRun, RECHECK_RUNS } = await import("../src/cwv.mjs");

const row = (url, tbt_ms, extra = {}) => ({ url, tbt_ms, fcp_ms: 1000, perf: 95, lcp_ms: 2500, details: { benchmark: 2000 }, ...extra });

test("only blocking-time outliers are re-run (audit #39: 3 of 40 pages)", () => {
  const healthy = [87, 100, 73, 72, 47, 75, 85, 83, 56, 139, 85, 80, 66, 74, 77, 91, 93, 85, 66, 108, 82, 64, 66, 97, 68, 76, 103, 191, 112, 137, 106, 130, 90, 106, 116, 124, 74]
    .map((t, i) => row(`https://x.com/p${i}`, t));
  const rows = [...healthy, row("https://x.com/about", 613), row("https://x.com/lossy", 1533), row("https://x.com/cookies", 1208)];
  assert.deepEqual(recheckTargets(rows), ["https://x.com/lossy", "https://x.com/cookies", "https://x.com/about"]);
});

test("a site slow everywhere is not re-run page by page", () => {
  assert.deepEqual(recheckTargets([700, 800, 900, 750, 820].map((t, i) => row(`https://x.com/${i}`, t))), []);
});

test("with fewer than 3 pages, any blocking time worse than good is re-run", () => {
  assert.deepEqual(recheckTargets([row("https://x.com/", 450), row("https://x.com/a", 90)]), ["https://x.com/"]);
});

test("one slow run of five = busy computer; the median run is kept", () => {
  const runs = [1533, 88, 120, 95, 101].map((t) => row("https://x.com/lossy", t));
  const m = medianRun(runs);
  assert.equal(RECHECK_RUNS, 5);
  assert.equal(m.tbt_ms, 101);
  assert.equal(m.details.verdict, "noise");
  assert.equal(m.details.slowRuns, 1);
  assert.deepEqual(m.details.runs.map((r) => r.tbt_ms), [1533, 88, 120, 95, 101]);
});

test("slow in most runs = the page itself is slow", () => {
  const m = medianRun([1208, 950, 130, 1100, 990].map((t) => row("https://x.com/cookies", t)));
  assert.equal(m.tbt_ms, 990);
  assert.equal(m.details.verdict, "page");
  assert.equal(m.details.slowRuns, 4);
});

test("long Lighthouse runs: Chrome is restarted every RESTART_EVERY pages and after a broken-Chrome error, retrying the page once", async () => {
  const { chromeSession, RESTART_EVERY } = await import("../src/cwv.mjs");
  let launches = 0, killed = 0, broken = new Set(["https://example.com/p3"]);
  const launch = async () => ({ port: ++launches, kill: async () => { killed++; } });
  const run = async (port, url) => {
    if (broken.has(url)) { broken.delete(url); throw new Error("An internal Chrome error occurred. Please restart Chrome and try re-running Lighthouse."); }
    return { port, url };
  };
  const s = chromeSession(launch, run, 4);
  const got = [];
  for (let i = 1; i <= 9; i++) got.push(await s.measure(`https://example.com/p${i}`));
  await s.close();
  assert.equal(got.length, 9, "every page measured, including the one that hit the broken Chrome");
  assert.equal(got[2].port, 2, "p3 retried in a fresh Chrome");
  assert.ok(launches >= 3, "periodic restarts too");
  assert.equal(killed, launches, "every Chrome is closed");
  const other = chromeSession(launch, async () => { throw new Error("page returned 404"); });
  await assert.rejects(other.measure("https://example.com/x"), /404/, "ordinary errors are not retried");
  await other.close();
  assert.equal(RESTART_EVERY, 15);
});
