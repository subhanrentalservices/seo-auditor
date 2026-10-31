// Lighthouse sampling by URL template, mobile/desktop rows, and the regression alert (group 7). No Chrome is launched:
// pickPages and the alert read fixture rows in a temp database. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
const { templateKey, pickPages, cwvRows, register } = await import("../src/cwv.mjs");
const { perfChanges, regressionItems, perfRegressions } = await import("../src/perf-alerts.mjs");
const A = await import("../src/alerts.mjs");

const S = "https://acme.example";
const page = (aid, p, depth, inlinks) => run("INSERT INTO pages (audit_id, url, final_url, status, depth, content_type, indexable, inlinks) VALUES (?,?,?,200,?,'text/html',1,?)", aid, S + p, S + p, depth, inlinks);
const lab = (aid, p, m, ff = "mobile") => run("INSERT INTO cwv (audit_id, url, form_factor, lcp_ms, cls, tbt_ms, perf, error) VALUES (?,?,?,?,?,?,?,?)",
  aid, S + p, ff, m.lcp ?? null, m.cls ?? null, m.tbt ?? null, m.perf ?? null, m.error ?? null);

test("templateKey groups URLs by pattern", () => {
  assert.equal(templateKey(S + "/"), "/");
  assert.equal(templateKey(S + "/about.html"), "/*");
  assert.equal(templateKey(S + "/blog/"), "/*");
  assert.equal(templateKey(S + "/blog/brakes"), "/blog/*");
  assert.equal(templateKey(S + "/services/smash/bumper"), "/services/*/*");
  assert.equal(templateKey(S + "/shop/item?id=3"), "/shop/*?");
});

test("pickPages: the start page, then the most-linked page of each template, largest template first", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status) VALUES (1, 1, 'done')");
  page(1, "/", 0, 0);
  for (const [i, n] of [[1, 3], [2, 9], [3, 1], [4, 2]]) page(1, `/blog/post-${i}`, 2, n); // 4 posts
  for (const [i, n] of [[1, 5], [2, 4]]) page(1, `/services/s${i}/detail`, 2, n);           // 2 service details
  page(1, "/about.html", 1, 20); page(1, "/contact.html", 1, 30); page(1, "/faq.html", 1, 1); // 3 top-level pages
  run("INSERT INTO pages (audit_id, url, status, content_type, indexable) VALUES (1, ?, 200, 'text/html', 0)", S + "/blog/noindexed"); // not indexable: skipped
  assert.deepEqual(pickPages(1, 4).map((u) => u.slice(S.length)), ["/", "/blog/post-2", "/contact.html", "/services/s1/detail"]);
  assert.deepEqual(pickPages(1, 6).map((u) => u.slice(S.length)), ["/", "/blog/post-2", "/contact.html", "/services/s1/detail", "/blog/post-1", "/about.html"]);
  assert.equal(pickPages(1, 100).length, 10, "a number above the page count measures every indexable page");
  assert.deepEqual(pickPages(1, 0), []);
});

test("cwvRows: mobile by default (older rows without a form factor count as mobile), desktop on request", () => {
  run("INSERT INTO audits (id, project_id, status) VALUES (2, 1, 'done')");
  run("INSERT INTO cwv (audit_id, url, lcp_ms) VALUES (2, ?, 2000)", S + "/old");
  lab(2, "/", { lcp: 1800 }); lab(2, "/", { lcp: 900 }, "desktop");
  assert.deepEqual(cwvRows(2).map((r) => [r.url.slice(S.length), r.form_factor]), [["/old", "mobile"], ["/", "mobile"]]);
  assert.deepEqual(cwvRows(2, "desktop").map((r) => [r.url.slice(S.length), r.lcp_ms]), [["/", 900]]);
});

test("perfChanges pairs pages by url and form factor; only worse values count", () => {
  const prev = [{ url: "/a", lcp_ms: 2000, cls: 0.02, tbt_ms: 100, perf: 95 }, { url: "/a", form_factor: "desktop", lcp_ms: 800, perf: 99 }, { url: "/b", error: "x" }];
  const cur = [{ url: "/a", form_factor: "mobile", lcp_ms: 2800, cls: 0.01, tbt_ms: 450, perf: 80 }, { url: "/a", form_factor: "desktop", lcp_ms: 700, perf: 99 }, { url: "/b", lcp_ms: 9000 }];
  const ch = perfChanges(prev, cur);
  assert.deepEqual(ch.map((c) => [c.formFactor, c.metric, c.change]), [["mobile", "lcp_ms", 800], ["mobile", "tbt_ms", 350], ["mobile", "perf", 15]]);
});

test("regressionItems: over the threshold and outside 'good' only; one alert per page and form factor", () => {
  const feed = { auditId: 12, prevAuditId: 11, changes: [
    { url: S + "/a", formFactor: "mobile", metric: "lcp_ms", from: 2300, to: 3100, change: 800 },
    { url: S + "/a", formFactor: "mobile", metric: "tbt_ms", from: 100, to: 450, change: 350 },
    { url: S + "/b", formFactor: "mobile", metric: "lcp_ms", from: 900, to: 1600, change: 700 },   // still good: no alert
    { url: S + "/c", formFactor: "desktop", metric: "cls", from: 0.08, to: 0.11, change: 0.03 }, // under the 0.05 step
  ] };
  const s = { lcpMs: 500, cls: 0.05, tbtMs: 300, perf: 10 };
  const items = regressionItems(feed, s);
  assert.equal(items.length, 1);
  assert.equal(items[0].fingerprint, `12:mobile:${S}/a`);
  assert.match(items[0].detail, /^LCP 2\.3 s → 3\.1 s; TBT 100 ms → 450 ms \(audit #11 → #12\)\. Lab data/);
  assert.equal(regressionItems(feed, { ...s, lcpMs: 1000, tbtMs: 400 }).length, 0, "thresholds come from the rule settings");
});

test("alert rule: skipped without two Lighthouse audits, then raised from the feed through evaluate()", () => {
  register({ routes: [] }); // cwv.mjs provides the perfRegressions feed
  run("INSERT INTO projects (id, name, start_url) VALUES (5, 'Lab', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status) VALUES (11, 5, 'done')");
  lab(11, "/", { lcp: 2300, cls: 0.02, tbt: 120, perf: 92 });
  let r = A.evaluate(5, { scope: "data" });
  assert.equal(r.skipped.find((x) => x.rule === "perf_regression").reason, "Needs two audits with Lighthouse data");
  run("INSERT INTO audits (id, project_id, status) VALUES (12, 5, 'done')");
  lab(12, "/", { lcp: 3400, cls: 0.02, tbt: 130, perf: 74 });
  lab(12, "/x", { error: "timed out" });
  run("INSERT INTO audits (id, project_id, status) VALUES (13, 5, 'done')"); // no Lighthouse rows: the last two WITH rows are compared
  assert.deepEqual([perfRegressions(5).prevAuditId, perfRegressions(5).auditId], [11, 12]);
  r = A.evaluate(5, { scope: "data" });
  const it = r.items.filter((x) => x.rule === "perf_regression");
  assert.equal(it.length, 1);
  assert.equal(it[0].severity, "warning");
  assert.match(it[0].detail, /LCP 2\.3 s → 3\.4 s; Performance score 92 → 74/);
  A.updateProjectAlerts(5, { rules: { perf_regression: { on: false } } });
  assert.ok(!A.evaluate(5, { scope: "data" }).items.some((x) => x.rule === "perf_regression"));
});
