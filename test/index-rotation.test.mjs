// Scheduled URL Inspection (REQ-055 group 4, item 6): batches within the daily quota, oldest-inspected first, and a
// history of index-status changes (manual runs included). URL Inspection is mocked: no Google API call is made.
// Fixtures use example.com only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, get, all } = await import("../src/db.mjs");
const { rotate, pickUrls, usedLast24h, urlHistory, indexChanges, rotationStatus, setPerDay, perDayOf, MAX_PER_DAY } = await import("../src/index-rotation.mjs");
const { startIndexRun, indexRunning, MAX_PER_RUN } = await import("../src/indexing.mjs");

const S = "https://example.com";
const answer = (coverageState, verdict = "NEUTRAL", extra = {}) => ({ inspectionResult: { indexStatusResult: { coverageState, verdict, ...extra } } });
const indexed = answer("Submitted and indexed", "PASS");
run("INSERT INTO projects (id, name, start_url, settings) VALUES (601, 'Example', ?, ?)", S + "/", JSON.stringify({ inspectPerDay: 3 }));
run("INSERT INTO audits (id, project_id, status) VALUES (6010, 601, 'done')");
for (let i = 0; i < 6; i++) run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, depth) VALUES (6010, ?, ?, 200, 1, 'text/html', ?)", `${S}/p${i}`, `${S}/p${i}`, i);
run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, depth) VALUES (6010, ?, ?, 200, 0, 'text/html', 1)", `${S}/noindex`, `${S}/noindex`);
const p601 = () => get("SELECT * FROM projects WHERE id=601");

test("per-day setting: off by default, capped at 1,800 (10% of Google's 2,000 kept back)", () => {
  assert.equal(perDayOf({ settings: "{}" }), 0);
  assert.equal(perDayOf({ settings: JSON.stringify({ inspectPerDay: 5000 }) }), MAX_PER_DAY);
  assert.equal(MAX_PER_DAY, 1800);
});

test("a batch inspects indexable pages only, never-inspected first, within the 24-hour budget", async () => {
  assert.deepEqual(pickUrls(601, 10).map((u) => u.url), [0, 1, 2, 3, 4, 5].map((i) => `${S}/p${i}`), "the noindex page is not rotated");
  const seen = [];
  const r = await rotate(p601(), { inspect: async (u) => { seen.push(u); return indexed; } });
  assert.equal(r.inspected, 3);
  assert.deepEqual(seen.sort(), [`${S}/p0`, `${S}/p1`, `${S}/p2`]);
  assert.equal(usedLast24h(601), 3);
  assert.deepEqual(await rotate(p601(), { inspect: async () => indexed }), { skipped: "quota", used: 3 }, "today's budget is spent");
  const lastRun = get("SELECT * FROM index_runs WHERE project_id=601 ORDER BY id DESC LIMIT 1");
  assert.equal(lastRun.status, "done");
  assert.match(lastRun.message, /Scheduled/);
  assert.deepEqual(JSON.parse(lastRun.counts), { indexed: 3 });
});

test("the next batch takes the pages never inspected, then the longest-unchecked", async () => {
  run("UPDATE index_status SET inspected_at='2026-01-01 00:00:00' WHERE project_id=601"); // a day later, in effect
  assert.deepEqual(pickUrls(601, 4).map((u) => u.url), [`${S}/p3`, `${S}/p4`, `${S}/p5`, `${S}/p0`]);
  run("UPDATE index_status SET inspected_at='2025-12-01 00:00:00' WHERE project_id=601 AND url=?", `${S}/p2`);
  assert.equal(pickUrls(601, 4)[3].url, `${S}/p2`, "the oldest inspection comes first among inspected pages");
  const r = await rotate(p601(), { inspect: async (u) => (u.endsWith("p4") ? answer("Crawled - currently not indexed") : indexed) });
  assert.equal(r.inspected, 3);
});

test("history records changes only, from scheduled and manual runs alike; changes list shows lost pages", async () => {
  run("UPDATE index_status SET inspected_at='2026-01-01 00:00:00' WHERE project_id=601");
  await rotate(p601(), { perDay: 6, inspect: async (u) => (u.endsWith("p0") ? answer("Crawled - currently not indexed") : indexed) });
  const h0 = urlHistory(601, `${S}/p0`);
  assert.deepEqual(h0.map((x) => x.kind), ["indexed", "crawled"]);
  assert.equal(urlHistory(601, `${S}/p1`).length, 1, "same state again: no new history row");
  // A manual run (indexing.mjs) goes through the same trigger.
  const m = await startIndexRun(p601(), { inspect: async () => indexed });
  await m.done;
  assert.deepEqual(urlHistory(601, `${S}/p0`).map((x) => x.kind), ["indexed", "crawled", "indexed"]);
  const ch = indexChanges(601);
  const p0 = ch.filter((c) => c.url === `${S}/p0`);
  assert.equal(p0.length, 2);
  assert.ok(p0.some((c) => c.lost) && p0.some((c) => c.gained));
  assert.ok(!ch.some((c) => c.url === `${S}/p1`), "first sightings are not changes");
});

test("errors are not history, a quota error stops the batch, and a running check is not overlapped", async () => {
  run("UPDATE index_status SET inspected_at='2026-01-01 00:00:00' WHERE project_id=601");
  const quota = Object.assign(new Error("Quota exceeded"), { response: { status: 429, data: { error: { message: "Quota exceeded for quota metric" } } } });
  let n = 0;
  const r = await rotate(p601(), { perDay: 6, inspect: async (u) => { if (++n === 1) throw new Error("URL not in property"); throw quota; } });
  assert.match(r.stopped, /Quota/);
  assert.equal(get("SELECT status FROM index_runs WHERE project_id=601 ORDER BY id DESC LIMIT 1").status, "stopped");
  const errored = get("SELECT url FROM index_status WHERE project_id=601 AND error IS NOT NULL");
  assert.ok(errored);
  assert.equal(urlHistory(601, errored.url).at(-1).kind, "indexed", "an error row adds nothing to the history");
  indexRunning.add(601);
  assert.deepEqual(await rotate(p601(), { perDay: 6, inspect: async () => indexed }), { skipped: "running" });
  indexRunning.delete(601);
  assert.deepEqual(await rotate({ ...p601(), settings: "{}" }, { inspect: async () => indexed }), { skipped: "off" });
});

test("status and the per-day setting", () => {
  const s = setPerDay(601, { perDay: 99999 });
  assert.equal(s.perDay, MAX_PER_DAY);
  assert.equal(s.pages, 6);
  assert.equal(s.cycleDays, 1);
  assert.equal(setPerDay(601, { perDay: -4 }).perDay, 0);
  const st = rotationStatus(601);
  assert.equal(st.dailyQuota, 2000);
  assert.ok(Array.isArray(st.changes));
});

test("a manual run of 500 pages no longer deletes results for audited pages beyond its 500", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (602, 'Example', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status) VALUES (6020, 602, 'done')");
  for (let i = 0; i < MAX_PER_RUN + 2; i++) run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, depth) VALUES (6020, ?, ?, 200, 1, 'text/html', 1)", `${S}/q${String(i).padStart(4, "0")}`, `${S}/q${String(i).padStart(4, "0")}`);
  run("INSERT INTO index_status (project_id, url, verdict, coverage, wanted, inspected_at) VALUES (602, ?, 'PASS', 'Submitted and indexed', 1, '2026-01-01 00:00:00')", `${S}/q0501`);
  run("INSERT INTO index_status (project_id, url, verdict, coverage, wanted, inspected_at) VALUES (602, ?, 'PASS', 'Submitted and indexed', 1, '2026-01-01 00:00:00')", `${S}/gone`);
  const m = await startIndexRun(get("SELECT * FROM projects WHERE id=602"), { inspect: async () => indexed });
  await m.done;
  assert.ok(get("SELECT 1 x FROM index_status WHERE project_id=602 AND url=?", `${S}/q0501`), "page 502 of the audit keeps its result");
  assert.equal(get("SELECT 1 x FROM index_status WHERE project_id=602 AND url=?", `${S}/gone`), undefined, "a page no longer in the audit drops out");
});
