// Chrome UX Report History API: 25-week field-data trends (group 7). fetch is injected: no real Google call, and the
// key is a made-up placeholder. The fixture follows the records:queryHistoryRecord response shape. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHistory, queryHistory, refreshCruxHistory, cruxHistoryData, HISTORY_ENDPOINT, MAX_HISTORY_URLS } = await import("../src/crux-history.mjs");
const { NO_DATA, NO_KEY } = await import("../src/crux.mjs");
const { saveConfig } = await import("../src/dataforseo.mjs");
const { run } = await import("../src/db.mjs");

const FAKE_KEY = "TEST_placeholder_history_key_0000";
const periods = (n) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(2026, 4, 3 + 7 * i)); const e = new Date(+d + 27 * 864e5);
  const ymd = (x) => ({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() }); return { firstDate: ymd(d), lastDate: ymd(e) }; });
const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const hist = (n, g, ni, p) => [{ start: 0, end: 1, densities: series(n, g) }, { start: 1, end: 2, densities: series(n, ni) }, { start: 2, densities: series(n, p) }];
const record = (key, n = 25) => ({ record: { key, metrics: {
  largest_contentful_paint: { histogramTimeseries: hist(n, () => 0.8, () => 0.12, () => 0.08), percentilesTimeseries: { p75s: series(n, (i) => (i === 3 ? null : 2000 + 20 * i)) } },
  interaction_to_next_paint: { histogramTimeseries: hist(n, (i) => (i === 3 ? "NaN" : 0.9), () => 0.07, () => 0.03), percentilesTimeseries: { p75s: series(n, () => 150) } },
  cumulative_layout_shift: { histogramTimeseries: hist(n, () => 0.95, () => 0.03, () => 0.02), percentilesTimeseries: { p75s: series(n, () => "0.05") } },
}, collectionPeriods: periods(n) } });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, statusText: "", json: async () => body });

test("a history record is parsed into weekly points; null p75 and NaN densities become null; CLS strings become numbers", () => {
  const h = parseHistory(record({ origin: "https://acmemotors.com.au" }));
  assert.equal(h.periods.length, 25);
  assert.equal(h.periods[0], "2026-05-30");
  const lcp = h.metrics.largest_contentful_paint;
  assert.deepEqual(lcp[0], { end: "2026-05-30", p75: 2000, good: 0.8, ni: 0.12, poor: 0.08 });
  assert.equal(lcp[3].p75, null);
  assert.equal(h.metrics.interaction_to_next_paint[3].good, null);
  assert.equal(h.metrics.cumulative_layout_shift[0].p75, 0.05);
});

test("no key: nothing is fetched and the data says how to switch it on", async () => {
  saveConfig({ cruxApiKey: "" });
  let calls = 0;
  const f = async () => { calls++; return reply(200, {}); };
  await assert.rejects(refreshCruxHistory({ id: 1, start_url: "https://acmemotors.com.au/" }, [], { fetch: f }), /App settings/);
  await assert.rejects(queryHistory({ origin: "https://acmemotors.com.au" }, "PHONE", "", f), /App settings/);
  assert.equal(calls, 0);
  const d = cruxHistoryData(1);
  assert.equal(d.enabled, false);
  assert.equal(d.message, NO_KEY);
});

test("origin and pages, phone and desktop, are stored; a 404 is 'not enough data'; at most 10 pages; the key only in the header", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (960, 'Acme Motors', 'https://acmemotors.com.au/')");
  saveConfig({ cruxApiKey: FAKE_KEY });
  const asked = [];
  const f = async (url, o) => {
    const body = JSON.parse(o.body);
    asked.push({ url, headerKey: o.headers["X-Goog-Api-Key"], body });
    if (body.origin || body.url === "https://acmemotors.com.au/") return reply(200, record(body));
    return reply(404, { error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } });
  };
  const urls = Array.from({ length: 14 }, (_, i) => (i ? `https://acmemotors.com.au/p${i}` : "https://acmemotors.com.au/"));
  const d = await refreshCruxHistory({ id: 960, start_url: "https://acmemotors.com.au/" }, urls, { fetch: f });
  assert.equal(asked.length, 2 + 2 * MAX_HISTORY_URLS, "origin ×2, then 10 pages ×2");
  for (const a of asked) {
    assert.equal(a.url, HISTORY_ENDPOINT);
    assert.ok(!a.url.includes(FAKE_KEY));
    assert.equal(a.headerKey, FAKE_KEY);
    assert.deepEqual(a.body.metrics, ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"]);
  }
  assert.deepEqual(asked.slice(0, 2).map((a) => [a.body.origin, a.body.formFactor]), [["https://acmemotors.com.au", "PHONE"], ["https://acmemotors.com.au", "DESKTOP"]]);
  const originPhone = d.records.find((r) => r.scope === "origin" && r.formFactor === "PHONE");
  assert.equal(originPhone.metrics.largest_contentful_paint.length, 25);
  assert.equal(originPhone.metrics.largest_contentful_paint.at(-1).p75, 2480);
  const home = d.records.filter((r) => r.url === "https://acmemotors.com.au/" && r.scope === "url");
  assert.deepEqual(home.map((r) => r.formFactor), ["PHONE", "DESKTOP"]);
  const quiet = d.records.find((r) => r.url === "https://acmemotors.com.au/p1");
  assert.equal(quiet.noData, true);
  assert.equal(quiet.error, null);
  assert.equal(d.noDataMessage, NO_DATA);
  // A second refresh replaces the first.
  await refreshCruxHistory({ id: 960, start_url: "https://acmemotors.com.au/" }, [], { fetch: f });
  assert.equal(cruxHistoryData(960).records.length, 2);
});

test("API errors are stored with the key redacted; a network failure is an error, not a crash", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (961, 'Acme Two', 'https://acme2.com.au/')");
  saveConfig({ cruxApiKey: FAKE_KEY });
  const f = async (url, o) => (JSON.parse(o.body).formFactor === "PHONE"
    ? reply(400, { error: { message: `API key ${FAKE_KEY} not valid. Please pass a valid API key.` } })
    : Promise.reject(new TypeError("fetch failed")));
  const d = await refreshCruxHistory({ id: 961, start_url: "https://acme2.com.au/" }, [], { fetch: f });
  const phone = d.records.find((r) => r.formFactor === "PHONE"), desktop = d.records.find((r) => r.formFactor === "DESKTOP");
  assert.match(phone.error, /400: API key \[key\] not valid/);
  assert.ok(!phone.error.includes(FAKE_KEY));
  assert.match(desktop.error, /not reachable \(network error\)/);
});
