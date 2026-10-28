// Alert rules (REQ-055 group 5 item 2): audit rules on fixture audits, Search Console week-on-week drop, URL Inspection
// rises, the rank tracker feed (absent → skipped; fixture → alerts), dedup, mute and per-rule switches/thresholds.
// Senders are injected (fake fetch, fake toast). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { db, run } = await import("../src/db.mjs");
await import("../src/indexing.mjs"); // creates index_runs
const A = await import("../src/alerts.mjs");
const { updateConfig } = await import("../src/alert-channels.mjs");
db.exec("CREATE TABLE IF NOT EXISTS audit_robots (audit_id INTEGER PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE, status INTEGER, body TEXT)"); // as crawler.mjs

const sent = [];
const deps = { fetchFn: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }, toast: () => {} };
updateConfig({ webhook: { on: true, url: "https://alerts.example.com/hook" }, toast: { on: false } });

const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
function audit(id, pid, health, { pages = [], issues = [], robots } = {}) {
  run("INSERT INTO audits (id, project_id, status, health, finished_at) VALUES (?,?,?,?,datetime('now'))", id, pid, "done", health);
  for (const [url, indexable] of pages) run("INSERT INTO pages (audit_id, url, status, indexable) VALUES (?,?,200,?)", id, url, indexable);
  for (const [check, sev, url] of issues) run("INSERT INTO issues (audit_id, check_id, severity, url) VALUES (?,?,?,?)", id, check, sev, url);
  if (robots !== undefined) run("INSERT INTO audit_robots (audit_id, status, body) VALUES (?,?,?)", id, 200, robots);
}

// Project 1: the second audit got worse in every audit rule's way.
run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme', 'https://acme.example/')");
audit(10, 1, 90, { pages: [["https://acme.example/a", 1], ["https://acme.example/b", 1]], issues: [["missing_title", "error", "https://acme.example/a"]], robots: "User-agent: *\nDisallow: /tmp # temp" });
audit(11, 1, 85, { pages: [["https://acme.example/a", 1], ["https://acme.example/b", 0]],
  issues: [["missing_title", "error", "https://acme.example/a"], ["http_5xx", "error", "https://acme.example/c"]], robots: "User-agent: *\nDisallow: /tmp\nDisallow: /" });

test("audit rules: new errors, Site Health drop, robots.txt change, non-indexable pages and new 5xx", () => {
  const r = A.evaluate(1, { auditId: 11, scope: "audit" });
  const by = Object.fromEntries(r.items.map((i) => [i.rule, i]));
  assert.deepEqual(Object.keys(by).sort(), ["health_drop", "new_5xx", "new_errors", "noindex", "robots_changed"]);
  assert.match(by.new_errors.title, /^1 new error since/);
  assert.equal(by.health_drop.title, "Site Health 90 → 85");
  assert.equal(by.robots_changed.severity, "error"); // a Disallow was added
  assert.deepEqual(by.robots_changed.urls, ["+ Disallow: /"]); // the comment-only difference is ignored
  assert.deepEqual(by.noindex.urls, ["https://acme.example/b"]);
  assert.deepEqual(by.new_5xx.urls, ["https://acme.example/c"]);
  assert.ok(r.items.every((i) => i.fingerprint === "audit:11"));
});

test("an audit's alerts are sent once: one message for all of them, and a second run sends nothing", async () => {
  sent.length = 0;
  const first = await A.runAlerts(1, { auditId: 11, scope: "audit", deps });
  assert.equal(first.sent, 5);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].alerts.length, 5);
  const again = await A.runAlerts(1, { auditId: 11, scope: "audit", deps });
  assert.equal(again.sent, 0);
  assert.equal(again.duplicates, 5);
  assert.equal(sent.length, 1);
  assert.equal(A.alertLog(1).length, 5);
  assert.equal(A.alertLog(1)[0].delivery.webhook.ok, true);
});

test("each rule can be switched off, and thresholds are respected", () => {
  A.updateProjectAlerts(1, { rules: { health_drop: { min: 10 }, robots_changed: { on: false }, noindex: { min: 2 } } });
  const rules = A.evaluate(1, { auditId: 11, scope: "audit" }).items.map((i) => i.rule).sort();
  assert.deepEqual(rules, ["new_5xx", "new_errors"]);
  assert.throws(() => A.updateProjectAlerts(1, { rules: { health_drop: { min: "lots" } } }), /number/);
  A.updateProjectAlerts(1, { rules: { health_drop: { min: 3 }, robots_changed: { on: true }, noindex: { min: 1 } } });
});

test("the first audit has nothing to compare with: audit rules are skipped with that reason", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (2, 'Solo', 'https://solo.example/')");
  audit(20, 2, 70);
  const r = A.evaluate(2, { scope: "audit" });
  assert.equal(r.items.length, 0);
  assert.ok(r.skipped.every((s) => /First audit/.test(s.reason)));
});

test("muted project: alerts are logged but not sent", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (3, 'Quiet', 'https://quiet.example/')");
  audit(30, 3, 95); audit(31, 3, 80);
  A.updateProjectAlerts(3, { mute: true });
  sent.length = 0;
  const r = await A.runAlerts(3, { auditId: 31, scope: "audit", deps });
  assert.equal(r.sent, 1);
  assert.equal(r.muted, true);
  assert.equal(sent.length, 0);
  assert.equal(A.alertLog(3)[0].delivery.muted, true);
});

test("weekOverWeek: last 7 days vs the 7 before; missing days count as 0; needs 14 days", () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({ date: add("2026-10-01", i), clicks: i < 7 ? 10 : 5, impressions: 100 })).filter((r) => r.date !== "2026-10-12");
  const w = A.weekOverWeek(rows);
  assert.equal(w.start, "2026-10-08"); assert.equal(w.end, "2026-10-14"); assert.equal(w.prevStart, "2026-10-01");
  assert.deepEqual(w.clicks, { from: 70, to: 30, change: -40 / 70 });
  assert.equal(w.impressions.to, 600);
  assert.equal(A.weekOverWeek(rows.slice(2)), null);
});

test("Search Console drop: fires on clicks and impressions above the minimums, once per week", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (4, 'Shop', 'https://shop.example/')");
  for (let i = 0; i < 28; i++) run("INSERT INTO gsc_daily (project_id, date, clicks, impressions) VALUES (4,?,?,?)", add("2026-09-20", i), i < 21 ? 20 : 8, i < 21 ? 1000 : 500);
  const r = A.evaluate(4, { scope: "data" });
  const drops = r.items.filter((i) => i.rule === "gsc_drop");
  assert.deepEqual(drops.map((d) => d.fingerprint), ["clicks", "impressions"]);
  assert.match(drops[0].title, /clicks down 60% week on week/);
  assert.match(drops[0].detail, /140 \(2026-10-04 to 2026-10-10\) → 56 \(2026-10-11 to 2026-10-17\)/);
  sent.length = 0;
  assert.equal((await A.runAlerts(4, { scope: "data", deps })).sent, 2);
  assert.equal((await A.runAlerts(4, { scope: "data", deps })).sent, 0, "same drop stays quiet for a week");
  A.updateProjectAlerts(4, { rules: { gsc_drop: { minClicks: 1000, minImpressions: 1e6 } } });
  assert.equal(A.evaluate(4, { scope: "data" }).items.filter((i) => i.rule === "gsc_drop").length, 0, "small sites: below the minimums");
});

test("Search Console drop: no data or too little data is skipped with a reason; a provided feed is used instead", () => {
  const reason = (pid) => A.evaluate(pid, { scope: "data" }).skipped.find((s) => s.rule === "gsc_drop")?.reason;
  assert.equal(reason(2), "No Search Console data yet");
  run("INSERT INTO gsc_daily (project_id, date, clicks, impressions) VALUES (2,'2026-10-01',5,50)");
  assert.equal(reason(2), "Needs 14 days of Search Console data");
  A.provideFeed("gscDaily", (pid) => (pid === 2 ? Array.from({ length: 14 }, (_, i) => ({ date: add("2026-10-01", i), clicks: i < 7 ? 100 : 10, impressions: 0 })) : null));
  try { assert.equal(A.evaluate(2, { scope: "data" }).items.filter((i) => i.rule === "gsc_drop").length, 1); }
  finally { A.provideFeed("gscDaily", A.storedGscDaily); }
});

test("rank alerts: skipped while the rank tracker isn't there; a provided feed gives drop and top-10 alerts", () => {
  const skip = A.evaluate(1, { scope: "data" }).skipped.find((s) => s.rule === "rank_drop");
  assert.equal(skip.reason, "Rank tracker data not available");
  A.provideFeed("rankEvents", (pid) => (pid === 1 ? [
    { type: "drop", query: "acme widgets", from: 3.2, to: 7.9, impressions: 1200, page: "https://acme.example/widgets" },
    { type: "lost_top10", query: "cheap widgets", from: 8, to: 14 },
    { type: "new_top3", query: "acme", from: 5, to: 2 }] : null));
  try {
    let items = A.evaluate(1, { scope: "data" }).items.filter((i) => i.rule.startsWith("rank"));
    assert.deepEqual(items.map((i) => i.title), ['"acme widgets" dropped 3.2 → 7.9', '"cheap widgets" left the top 10']);
    A.updateProjectAlerts(1, { rules: { rank_gain: { on: true } } });
    items = A.evaluate(1, { scope: "data" }).items.filter((i) => i.rule === "rank_gain");
    assert.equal(items[0].title, '"acme" reached the top 3');
    assert.equal(A.evaluate(2, { scope: "data" }).skipped.find((s) => s.rule === "rank_drop").reason, "No rank tracker data yet");
  } finally { A.provideFeed("rankEvents", null); }
  assert.throws(() => A.provideFeed("nope", () => []), /Unknown feed/);
});

test("a feed that throws is treated as no data, not as an error", () => {
  A.provideFeed("rankEvents", () => { throw new Error("no such table: rank_daily"); });
  try { assert.equal(A.evaluate(1, { scope: "data" }).skipped.find((s) => s.rule === "rank_drop").reason, "No rank tracker data yet"); }
  finally { A.provideFeed("rankEvents", null); }
});

test("URL Inspection: a rise in wanted pages not indexed between the last two runs fires once per run", async () => {
  const runRow = (counts) => Number(run("INSERT INTO index_runs (project_id, status, counts, finished_at) VALUES (1, 'done', ?, datetime('now'))", JSON.stringify(counts)).lastInsertRowid);
  assert.equal(A.evaluate(1, { scope: "data" }).skipped.find((s) => s.rule === "index_rise").reason, "Needs two Index status runs");
  runRow({ indexed: 90, crawled: 5, discovered: 5 });
  const id = runRow({ indexed: 70, crawled: 20, discovered: 8, indexed_blocked: 2 });
  const it = A.evaluate(1, { scope: "data" }).items.find((i) => i.rule === "index_rise");
  assert.equal(it.title, "18 more pages not indexed");
  assert.equal(it.fingerprint, `run:${id}`);
  assert.equal(A.notIndexed({ indexed: 1, indexed_no_content: 2, soft404: 3 }), 3);
});

test("routes: settings with the rule catalogue, feed availability and the log", () => {
  const routes = [];
  A.register({ routes, cli: true });
  const get = routes.find(([m, re]) => m === "GET" && re.test("/api/projects/1/alerts"))[2];
  const out = get(["1"]);
  assert.ok(out.catalog.find((c) => c.id === "gsc_drop").help.includes("2–3 days behind"));
  assert.deepEqual(out.feeds, { gscDaily: false, indexRuns: true, rankEvents: false });
  assert.ok(out.log.length >= 5);
  assert.throws(() => get(["999"]), /Project not found/);
});

test("robotsDiff ignores comments, blank lines and order", () => {
  assert.deepEqual(A.robotsDiff("User-agent: *\n# x\nDisallow: /a\n\nAllow: /b", "Allow: /b\nUser-agent: *\nDisallow: /a # same"), { added: [], removed: [] });
});
