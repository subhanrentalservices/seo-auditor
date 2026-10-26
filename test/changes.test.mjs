// Change log and impact: changes are validated, stored and deleted; each one's Search Console before/after is set
// against the rest of the site (difference in differences), "too early" until 7 days of data exist; CLI add/list.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = DATA; // keep the real database untouched
const { run, get } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates gsc_page_daily
const { addChange, deleteChange, changeLog, validateChange, KINDS } = await import("../src/changes.mjs");

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");
const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const FROM = "2026-01-01", DAYS = 90, LAST = add(FROM, DAYS - 1); // 2026-03-31
const CHANGE = "2026-02-15";

/** Daily page rows for a project: value(date) → [clicks, impressions, position]. */
function pageDays(pid, url, value) {
  const ins = "INSERT INTO gsc_page_daily (project_id,url,date,clicks,impressions,position) VALUES (?,?,?,?,?,?)";
  for (let i = 0; i < DAYS; i++) { const d = add(FROM, i), [c, imp, pos] = value(d); run(ins, pid, url, d, c, imp, pos); }
}
const after = (d) => d > CHANGE;

// Project 801: the changed page doubles its clicks while the rest of the site stays flat.
run("INSERT INTO projects (id, name, start_url) VALUES (801, 'Acme', 'https://acme.example/')");
pageDays(801, "https://acme.example/pricing", (d) => (after(d) ? [10, 150, 6] : [5, 100, 8]));
for (const p of ["/", "/about", "/blog/guide"]) pageDays(801, "https://acme.example" + p, () => [10, 200, 5]);
// Project 802: the changed page rises exactly as much as the rest of the site.
run("INSERT INTO projects (id, name, start_url) VALUES (802, 'Widgets', 'https://widgets.example/')");
pageDays(802, "https://widgets.example/guide/", (d) => (after(d) ? [10, 200, 7] : [5, 100, 7]));
for (const p of ["/", "/shop"]) pageDays(802, "https://widgets.example" + p, (d) => (after(d) ? [20, 400, 4] : [10, 200, 4]));
// Project 803: no Search Console data at all.
run("INSERT INTO projects (id, name, start_url) VALUES (803, 'Empty', 'https://empty.example/')");

const window = (c, name) => c.impact.windows.find((w) => w.window === name);

test("a change needs a real past day, a known kind, a short summary and pages of the project's own site", () => {
  const p = get("SELECT * FROM projects WHERE id=801");
  const ok = { date: CHANGE, kind: "content", summary: "Rewrote the intro", urls: ["https://acme.example/pricing"] };
  assert.deepEqual(validateChange(p, ok).urls, ["https://acme.example/pricing"]);
  const err = (patch) => assert.throws(() => validateChange(p, { ...ok, ...patch }), (e) => e.status === 400);
  err({ date: "2026-02-30" }); err({ date: "15/02/2026" }); err({ date: "2999-01-01" });
  err({ kind: "seo" }); err({ summary: "  " }); err({ summary: "x".repeat(501) }); err({ ref: "r".repeat(201) });
  err({ urls: [] }); err({ urls: ["https://other.example/pricing"] }); err({ urls: ["javascript:alert(1)"] });
  assert.equal(validateChange(p, { ...ok, summary: "x".repeat(500) }).summary.length, 500);
  // Paths resolve against the start URL, www is the same site, duplicates and #fragments collapse, text splits on lines.
  assert.deepEqual(validateChange(p, { ...ok, urls: "/pricing\nhttps://www.acme.example/about#team\n/pricing" }).urls,
    ["https://acme.example/pricing", "https://www.acme.example/about"]);
  assert.deepEqual(KINDS, ["title", "content", "links", "technical", "schema", "new-page", "redirect", "other"]);
});

test("changes are stored, listed newest first and deleted only from their own project", () => {
  const a = addChange(803, { date: "2026-01-10", kind: "title", summary: "Shorter title", urls: ["/"], ref: "abc1234" });
  const b = addChange(803, { date: "2026-01-20", kind: "schema", summary: "Added FAQ schema", urls: ["/faq"] });
  assert.equal(a.ref, "abc1234");
  assert.equal(a.impact.status, "no-data");
  const log = changeLog(803);
  assert.equal(log.connected, false);
  assert.deepEqual(log.changes.map((c) => c.id), [b.id, a.id]);
  assert.throws(() => deleteChange(801, a.id), (e) => e.status === 404, "another project's change");
  assert.deepEqual(deleteChange(803, a.id), { deleted: a.id });
  assert.throws(() => deleteChange(803, a.id), (e) => e.status === 404, "already gone");
  assert.throws(() => addChange(9999, { date: CHANGE, kind: "other", summary: "x", urls: ["/"] }), (e) => e.status === 404);
  assert.deepEqual(changeLog(803).changes.map((c) => c.id), [b.id]);
});

test("a page that doubles while the rest of the site is flat is well ahead of the rest of the site", () => {
  const c = addChange(801, { date: CHANGE, kind: "content", summary: "Rewrote pricing", urls: ["https://acme.example/pricing/"] });
  assert.equal(c.impact.status, "ok");
  const w = window(c, "14 days");
  assert.deepEqual([w.before, w.after], [{ from: "2026-02-01", to: "2026-02-14" }, { from: "2026-02-16", to: "2026-03-01" }]);
  assert.deepEqual([w.changed.before.clicks, w.changed.after.clicks], [70, 140]);
  assert.equal(w.changed.change.clicks, 1);
  assert.equal(w.changed.change.impressions, 0.5);
  assert.equal(w.changed.change.position, -2, "position 8 → 6");
  assert.equal(w.control.before.clicks, 420, "three other pages × 10 clicks × 14 days");
  assert.equal(w.control.change.clicks, 0);
  assert.equal(w.vsControl.clicks, 1);
  assert.equal(w.vsControl.basis, "clicks");
  assert.equal(w.vsControl.label, "ahead");
  assert.equal(w.pages.length, 1, "trailing slash matches the stored URL");
  assert.equal(window(c, "28 days").vsControl.label, "ahead");
  const since = window(c, "since");
  assert.equal(since.days, 44, "2026-02-16 → 2026-03-31, against the 44 days before");
  assert.equal(since.vsControl.label, "ahead");
});

test("a page that rises exactly like the rest of the site is in line with it (about zero)", () => {
  const c = addChange(802, { date: CHANGE, kind: "links", summary: "Linked the guide from the home page", urls: ["https://widgets.example/guide"] });
  for (const name of ["14 days", "28 days", "since"]) {
    const w = window(c, name);
    assert.equal(w.changed.change.clicks, 1, `${name}: the page doubled`);
    assert.equal(w.control.change.clicks, 1, `${name}: so did the rest of the site`);
    assert.ok(Math.abs(w.vsControl.clicks) < 1e-9);
    assert.equal(w.vsControl.label, "in line");
  }
});

test("too early until 7 days of data exist after the change; longer windows wait until they are complete", () => {
  const early = addChange(801, { date: add(LAST, -4), kind: "technical", summary: "Fixed redirects", urls: ["/about"] });
  assert.equal(early.impact.status, "too-early");
  assert.equal(early.impact.afterDays, 4);
  assert.equal(early.impact.readyAround, add(LAST, 6), "change day + 7 days + 3 days' lag");
  const week = addChange(801, { date: add(LAST, -7), kind: "title", summary: "New about title", urls: ["/about"] });
  assert.equal(week.impact.status, "ok");
  assert.deepEqual(week.impact.windows.map((w) => [w.window, Boolean(w.pending), w.days]), [["14 days", true, 14], ["28 days", true, 28], ["since", false, 7]]);
  assert.equal(window(week, "since").vsControl.label, "in line", "flat page on a flat site");
  // A change from before the data starts has no "before" to compare with.
  const old = addChange(801, { date: "2025-12-20", kind: "redirect", summary: "Old redirect", urls: ["/"] });
  assert.equal(window(old, "14 days").noBefore, true);
  assert.equal(window(old, "since").noBefore, true);
});

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, SEO_AUDITOR_DATA: DATA }, encoding: "utf8" });

test("the CLI logs a change and prints the impact table", () => {
  const r = cli("change", "802", CHANGE, "title", "Matched the title to the main search", "https://widgets.example/shop", "--ref", "commit 1a2b3c");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^change \d+ logged for project 802: 2026-02-15 title, 1 page\(s\)/);
  const row = get("SELECT * FROM seo_changes WHERE project_id=802 AND kind='title'");
  assert.equal(row.ref, "commit 1a2b3c");
  assert.deepEqual(JSON.parse(row.urls), ["https://widgets.example/shop"]);
  const list = cli("changes", "802");
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /Matched the title to the main search \(ref commit 1a2b3c\)/);
  assert.match(list.stdout, /vs rest of site/);
  assert.match(list.stdout, /in line/);
  const badKind = cli("change", "802", CHANGE, "seo", "x", "/shop");
  assert.equal(badKind.status, 1);
  assert.match(badKind.stderr, /Kind must be one of/);
  const offSite = cli("change", "802", CHANGE, "links", "x", "https://other.example/");
  assert.equal(offSite.status, 1);
  assert.match(offSite.stderr, /is not on widgets\.example/);
});
