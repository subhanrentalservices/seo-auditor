// Core Web Vitals field data from the Chrome UX Report API (gap #15, 2026-10-26). fetch is mocked: no real Google
// call, and the key below is a made-up placeholder. Fixture follows the CrUX records:queryRecord response shape.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseRecord, refreshCrux, cruxData, queryRecord, NO_DATA, NO_KEY, ENDPOINT } = await import("../src/crux.mjs");
const { saveConfig, register: registerDfs } = await import("../src/dataforseo.mjs");
const { run } = await import("../src/db.mjs");

const FAKE_KEY = "TEST_placeholder_key_not_real_0000";
const hist = (g, n, p) => [{ start: 0, end: 1, density: g }, { start: 1, end: 2, density: n }, { start: 2, density: p }];
const record = (key) => ({ record: { key, metrics: {
  largest_contentful_paint: { histogram: hist(0.81, 0.12, 0.07), percentiles: { p75: 2210 } },
  interaction_to_next_paint: { histogram: hist(0.9, 0.07, 0.03), percentiles: { p75: 168 } },
  cumulative_layout_shift: { histogram: hist(0.95, 0.03, 0.02), percentiles: { p75: "0.04" } },
  first_contentful_paint: { histogram: hist(0.7, 0.2, 0.1), percentiles: { p75: 1650 } },
  experimental_time_to_first_byte: { histogram: hist(0.6, 0.3, 0.1), percentiles: { p75: 790 } },
} }, collectionPeriod: {} });
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, statusText: "", json: async () => body });

test("a full record is parsed into p75 values and good / needs-improvement / poor shares", () => {
  const m = parseRecord(record({ origin: "https://acmemotors.com.au" }));
  assert.deepEqual(m.largest_contentful_paint, { p75: 2210, good: 0.81, ni: 0.12, poor: 0.07 });
  assert.equal(m.cumulative_layout_shift.p75, 0.04, "CLS p75 arrives as a string");
  assert.equal(m.interaction_to_next_paint.p75, 168);
  assert.equal(Object.keys(m).length, 5);
});

test("no key: the feature is off with a message and nothing is fetched", async () => {
  saveConfig({ cruxApiKey: "" });
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(200, {}); };
  try {
    const d = cruxData(1);
    assert.equal(d.enabled, false);
    assert.equal(d.message, NO_KEY);
    await assert.rejects(refreshCrux({ id: 1, start_url: "https://acmemotors.com.au/" }, []), /App settings/);
    await assert.rejects(queryRecord({ origin: "https://acmemotors.com.au" }, "PHONE"), /App settings/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = real; }
});

test("origin + page records are stored; a 404 is stored as 'not enough data', not as an error; the key stays out of the URL", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (950, 'Acme Motors', 'https://acmemotors.com.au/')");
  saveConfig({ cruxApiKey: FAKE_KEY });
  const real = globalThis.fetch, asked = [];
  globalThis.fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    asked.push({ url, headerKey: o.headers["X-Goog-Api-Key"], body });
    if (body.origin && body.formFactor === "PHONE") return reply(200, record({ origin: body.origin, formFactor: "PHONE" }));
    return reply(404, { error: { code: 404, message: "chrome ux report data not found", status: "NOT_FOUND" } });
  };
  try {
    const d = await refreshCrux({ id: 950, start_url: "https://acmemotors.com.au/" }, ["https://acmemotors.com.au/", "https://acmemotors.com.au/claims"]);
    assert.equal(asked.length, 4, "origin phone + desktop, then each page on phone");
    assert.ok(asked.every((a) => a.url === ENDPOINT && !a.url.includes(FAKE_KEY) && a.headerKey === FAKE_KEY));
    assert.deepEqual(asked.map((a) => [a.body.origin || a.body.url, a.body.formFactor]), [["https://acmemotors.com.au", "PHONE"], ["https://acmemotors.com.au", "DESKTOP"],
      ["https://acmemotors.com.au/", "PHONE"], ["https://acmemotors.com.au/claims", "PHONE"]]);
    assert.equal(d.enabled, true);
    assert.equal(d.origin.PHONE.metrics.largest_contentful_paint.p75, 2210);
    assert.equal(d.origin.PHONE.metrics.interaction_to_next_paint.good, 0.9);
    assert.deepEqual([d.origin.DESKTOP.noData, d.origin.DESKTOP.error], [true, null]);
    assert.equal(d.urls.length, 2);
    assert.ok(d.urls.every((u) => u.noData && !u.error));
    assert.equal(d.noDataMessage, NO_DATA);
    assert.ok(d.fetchedAt);
  } finally { globalThis.fetch = real; }
});

test("other API errors are stored as errors, without the key", async () => {
  saveConfig({ cruxApiKey: FAKE_KEY });
  const real = globalThis.fetch;
  globalThis.fetch = async () => reply(400, { error: { code: 400, message: `API key not valid: ${FAKE_KEY}` } });
  try {
    const r = await queryRecord({ origin: "https://acmemotors.com.au" }, "PHONE");
    assert.match(r.error, /400/);
    assert.ok(!r.error.includes(FAKE_KEY));
  } finally { globalThis.fetch = real; }
});

test("GET /api/config never returns the key; PUT stores it, validates it and answers without it", async () => {
  const routes = [];
  registerDfs({ routes });
  const route = (method, p) => routes.find(([m, re]) => m === method && re.test(p))[2];
  saveConfig({ cruxApiKey: "" });
  assert.equal(route("GET", "/api/config")().hasCruxKey, false);
  const put = route("PUT", "/api/config")([], {}, { cruxApiKey: FAKE_KEY });
  assert.equal(put.hasCruxKey, true);
  assert.ok(!JSON.stringify(put).includes(FAKE_KEY));
  const got = route("GET", "/api/config")();
  assert.equal(got.hasCruxKey, true);
  assert.ok(!JSON.stringify(got).includes(FAKE_KEY));
  assert.equal(cruxData(1).enabled, true, "the stored key turns the feature on");
  route("PUT", "/api/config")([], {}, { cruxApiKey: "" });
  assert.equal(route("GET", "/api/config")().hasCruxKey, true, "an empty field keeps the saved key");
  assert.throws(() => route("PUT", "/api/config")([], {}, { cruxApiKey: "not a key!" }), /Google API key/);
  route("PUT", "/api/config")([], {}, { clearCruxKey: true });
  assert.equal(route("GET", "/api/config")().hasCruxKey, false);
});
