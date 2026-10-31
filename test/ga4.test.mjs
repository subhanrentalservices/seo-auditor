// GA4 Data API (REQ-055 group 8 item 2): organic landing pages, daily trend, key events and AI referrals. The runReport
// transport is mocked: no Google call is made. Fixtures follow the runReport response shape (string values). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = DIR; // keep the real database and config untouched
const { propertyId, assistantOf, runReport, refreshGa4, ga4Data, friendlyError, AI_REGEX } = await import("../src/ga4.mjs");
const { saveConfig } = await import("../src/dataforseo.mjs");
const { run, get, all } = await import("../src/db.mjs");

const NOW = Date.parse("2026-10-29T03:00:00Z");
run("INSERT INTO projects (id, name, start_url, settings) VALUES (870, 'Example', 'https://example.com/', ?)", JSON.stringify({ ga4Property: "properties/123456789" }));
run("INSERT INTO projects (id, name, start_url) VALUES (871, 'No GA4', 'https://example.org/')");
const p870 = () => get("SELECT * FROM projects WHERE id=870");
const row = (dims, mets) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((v) => ({ value: String(v) })) });
const resp = (rows) => ({ rows, rowCount: rows.length });

function mockCall(overrides = {}) {
  const asked = [];
  const call = async (property, body) => {
    asked.push({ property, body });
    const dims = body.dimensions.map((d) => d.name).join(",");
    if (overrides[dims]) return overrides[dims](body);
    if (dims === "landingPage") return resp([row(["/"], [120, 80, 4, 100]), row(["/claims"], [60, 45, 9, 50])]);
    if (dims === "date") return resp([row(["20261027"], [10, 7, 1, 9]), row(["20261028"], [12, 8, 0, 11])]);
    if (dims === "landingPage,eventName") return resp([row(["/claims", "generate_lead"], [7]), row(["/", "click_to_call"], [4])]);
    if (dims === "sessionSource,landingPage") return resp([row(["chatgpt.com", "/claims"], [5, 4, 1]), row(["perplexity.ai", "/"], [2, 1, 0]), row(["copilot.microsoft.com", "/"], [1, 1, 0])]);
    throw new Error("unexpected report " + dims);
  };
  return { call, asked };
}

test("property IDs: digits or properties/digits only", () => {
  assert.equal(propertyId("properties/123456789"), "123456789");
  assert.equal(propertyId(" 123456789 "), "123456789");
  assert.equal(propertyId("G-ABC123"), null, "a measurement ID is not a property ID");
  assert.equal(propertyId(""), null);
});

test("AI sources map to assistant names and the filter regex catches each", () => {
  const re = new RegExp(AI_REGEX, "i");
  for (const [src, name] of [["chatgpt.com", "ChatGPT"], ["chat.openai.com", "ChatGPT"], ["perplexity.ai", "Perplexity"], ["gemini.google.com", "Gemini"],
    ["bard.google.com", "Gemini"], ["copilot.microsoft.com", "Copilot"], ["claude.ai", "Claude"]]) {
    assert.ok(re.test(src), src);
    assert.equal(assistantOf(src), name);
  }
  assert.ok(!re.test("google"));
});

test("runReport pages 10,000 rows at a time and turns string metrics into numbers", async () => {
  const offsets = [];
  const rows = await runReport("1", { dimensions: [] }, async (p, body) => {
    offsets.push(body.offset);
    const n = body.offset === 0 ? 10000 : 3;
    return { rowCount: 10003, rows: Array.from({ length: n }, (_, i) => row([`/p${body.offset + i}`], ["7"])) };
  });
  assert.deepEqual(offsets, [0, 10000]);
  assert.equal(rows.length, 10003);
  assert.deepEqual(rows[0], { d: ["/p0"], m: [7] });
});

test("refresh sends the four reports with the right bodies and stores them", async () => {
  const { call, asked } = mockCall();
  const d = await refreshGa4(p870(), { call, now: NOW });
  assert.equal(asked.length, 4);
  assert.ok(asked.every((a) => a.property === "123456789"));
  const by = Object.fromEntries(asked.map((a) => [a.body.dimensions.map((x) => x.name).join(","), a.body]));
  const organic = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } };
  assert.deepEqual(by.landingPage.dimensionFilter, organic);
  assert.deepEqual(by.landingPage.metrics.map((m) => m.name), ["sessions", "engagedSessions", "keyEvents", "totalUsers"]);
  assert.deepEqual(by.landingPage.dateRanges, [{ startDate: "2026-10-01", endDate: "2026-10-28" }], "the last 28 full days");
  assert.deepEqual(by.date.dateRanges, [{ startDate: "2026-07-31", endDate: "2026-10-28" }], "90 days for the trend");
  assert.deepEqual(by["landingPage,eventName"].metricFilter.filter.numericFilter.operation, "GREATER_THAN");
  assert.deepEqual(by["landingPage,eventName"].dimensionFilter, organic);
  const ai = by["sessionSource,landingPage"];
  assert.equal(ai.dimensionFilter.filter.stringFilter.matchType, "PARTIAL_REGEXP");
  assert.equal(ai.dimensionFilter.filter.stringFilter.value, AI_REGEX);
  assert.equal(ai.dimensionFilter.filter.fieldName, "sessionSource", "AI referrals from every channel, not only organic");

  assert.deepEqual({ ...d.totals }, { sessions: 180, engagedSessions: 125, keyEvents: 13, users: 150 });
  assert.deepEqual(d.daily.map((x) => x.date), ["2026-10-27", "2026-10-28"]);
  assert.equal(d.pages[0].page, "/");
  assert.deepEqual({ ...d.keyEvents[0] }, { page: "/claims", event: "generate_lead", keyEvents: 7 });
  assert.deepEqual(d.ai.assistants.map((a) => [a.assistant, a.sessions]), [["ChatGPT", 5], ["Perplexity", 2], ["Copilot", 1]]);
  assert.deepEqual(d.errors, {});
  assert.equal(d.endDate, "2026-10-28");
});

test("a failed report keeps its old rows, the others still save, and the permission error says who to add", async () => {
  const key = path.join(DIR, "sa.json");
  writeFileSync(key, JSON.stringify({ type: "service_account", client_email: "auditor@example.iam.gserviceaccount.com", private_key: "x" }));
  saveConfig({ gscKeyFile: key });
  const denied = () => { throw Object.assign(new Error("Request failed with status code 403"),
    { response: { status: 403, data: { error: { status: "PERMISSION_DENIED", message: "User does not have sufficient permissions for this property." } } } }); };
  const { call } = mockCall({ "sessionSource,landingPage": denied, date: () => resp([row(["20261029"], [3, 2, 0, 3])]) });
  const d = await refreshGa4(p870(), { call, now: NOW + 864e5 });
  assert.match(d.errors.ai, /add auditor@example\.iam\.gserviceaccount\.com as a Viewer in GA4 Admin → Property access management/);
  assert.equal(d.ai.rows.length, 3, "previous AI rows kept");
  assert.deepEqual(d.daily.map((x) => x.date), ["2026-10-27", "2026-10-28", "2026-10-29"], "daily history is kept and extended");
  assert.equal(d.errors.pages, undefined);
});

test("API-disabled and not-found errors get their own hint; a key in the message is removed", () => {
  const off = friendlyError({ response: { status: 403, data: { error: { message: "Google Analytics Data API has not been used in project 123 before or it is disabled." } } } }, "1");
  assert.match(off, /Enable the “Google Analytics Data API”/);
  assert.match(friendlyError({ response: { status: 404, data: { error: { status: "NOT_FOUND", message: "x" } } } }, "42"), /property 42 was not found/);
  assert.ok(!friendlyError({ message: "failed at https://x.test/?key=abcdef123456" }, "1").includes("abcdef123456"));
});

test("no property: a plain message and nothing is fetched; GET is empty but valid", async () => {
  let calls = 0;
  await assert.rejects(refreshGa4(get("SELECT * FROM projects WHERE id=871"), { call: async () => { calls++; return {}; } }), /GA4 Property ID/);
  assert.equal(calls, 0);
  const d = ga4Data(871);
  assert.deepEqual([d.configured, d.fetchedAt, d.pages.length], [false, null, 0]);
  assert.equal(all("SELECT * FROM ga4_pages WHERE project_id=871").length, 0);
});
