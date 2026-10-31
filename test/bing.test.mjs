// Bing Webmaster Tools API and IndexNow (REQ-055 group 8 item 1). fetch is mocked: no Bing, IndexNow or site request is
// made. Fixtures follow Bing's JSON API shape ({ d: … }, /Date(…)/ dates); the API key is a made-up placeholder.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = DIR; // keep the real database and config untouched
const bing = await import("../src/bing.mjs");
const inx = await import("../src/indexnow.mjs");
const { run, get, all } = await import("../src/db.mjs");

const KEY = "FAKEbingKEY0123456789abcdef0000";
const HOME = "https://example.com/";
run("INSERT INTO projects (id, name, start_url) VALUES (880, 'Example', ?)", HOME);
run("INSERT INTO projects (id, name, start_url, settings) VALUES (881, 'Example IN', ?, ?)", HOME, JSON.stringify({ indexNowKey: "abcd1234-key" }));
const p = (id) => get("SELECT * FROM projects WHERE id=?", id);
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, statusText: "", json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const D = (iso) => `/Date(${Date.parse(iso + "T07:00:00Z")}-0700)/`; // midnight in UTC-7, as Bing sends it

const FIX = {
  GetUserSites: [{ Url: "https://www.other.test/", IsVerified: true }, { Url: "https://example.com/", IsVerified: true }],
  GetRankAndTrafficStats: [{ Date: D("2026-10-26"), Clicks: 3, Impressions: 40 }, { Date: D("2026-10-27"), Clicks: 5, Impressions: 60 }],
  GetQueryStats: [
    { Query: "brake repair dandenong", Date: D("2026-10-12"), Clicks: 2, Impressions: 10, AvgImpressionPosition: 4, AvgClickPosition: 3 },
    { Query: "brake repair dandenong", Date: D("2026-10-19"), Clicks: 1, Impressions: 30, AvgImpressionPosition: 8, AvgClickPosition: 5 },
    { Query: "smash repairs", Date: D("2026-10-19"), Clicks: 0, Impressions: 5, AvgImpressionPosition: -1, AvgClickPosition: -1 }],
  GetPageStats: [{ Query: "https://example.com/claims", Date: D("2026-10-19"), Clicks: 4, Impressions: 50, AvgImpressionPosition: 6 }],
  GetCrawlStats: [{ Date: D("2026-10-27"), CrawledPages: 40, CrawlErrors: 2, InIndex: 35, InLinks: 120, Code4xx: 1, Code5xx: 1 }],
  GetCrawlIssues: [{ Url: "https://example.com/old", Issues: 4 | 16, HttpCode: 404, InLinks: 3 }, { Url: "https://example.com/moved", Issues: 1, HttpCode: 301, InLinks: 9 }],
  GetLinkCounts: { Links: [{ Url: "https://example.com/", Count: 12 }, { Url: "https://example.com/claims", Count: 30 }], TotalPages: 1 },
  GetUrlLinks: { Details: [{ Url: "https://blog.test/post", AnchorText: "accident help" }], TotalPages: 1 },
};
function mockBing(fail = {}) {
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url), method = u.pathname.split("/").pop();
    asked.push({ method, params: Object.fromEntries(u.searchParams), url });
    if (fail[method]) return fail[method](u);
    return reply(200, { d: FIX[method] });
  };
  return { fetchFn, asked };
}
const saveKey = (k) => bing.updateBingConfig(k ? { apiKey: k } : { clear: true });

test("dates and crawl-issue flags are decoded", () => {
  assert.equal(bing.parseDate("/Date(1316156400000-0700)/"), "2011-09-16");
  assert.equal(bing.parseDate("/Date(1761523200000)/"), "2025-10-27");
  assert.equal(bing.parseDate("nonsense"), null);
  assert.deepEqual(bing.issueLabels(4 | 16), ["4xx error", "Blocked by robots.txt"]);
  assert.deepEqual(bing.issueLabels(256 | 128), ["DNS error", "Timeout"]);
  assert.deepEqual(bing.issueLabels(0), []);
});

test("the API key is write-only and validated", () => {
  assert.throws(() => saveKey("short"), /16–64 letters and digits/);
  assert.deepEqual(saveKey(KEY), { hasKey: true });
  assert.equal(JSON.parse(readFileSync(path.join(DIR, "config.json"), "utf8")).bingApiKey, KEY);
  assert.deepEqual(bing.updateBingConfig({ apiKey: "" }), { hasKey: true }, "empty keeps the saved key");
});

test("no key: a plain message and nothing is fetched", async () => {
  saveKey(null);
  const { fetchFn, asked } = mockBing();
  await assert.rejects(bing.refreshBing(p(880), { fetchFn }), /API key/);
  assert.equal(asked.length, 0);
  assert.equal(bing.bingData(880).hasKey, false);
  saveKey(KEY);
});

test("refresh detects the site, calls every method with siteUrl and the key, and stores aggregated rows", async () => {
  const { fetchFn, asked } = mockBing();
  const d = await bing.refreshBing(p(880), { fetchFn });
  assert.equal(d.siteUrl, "https://example.com/");
  assert.deepEqual(asked.map((a) => a.method).sort(), ["GetCrawlIssues", "GetCrawlStats", "GetLinkCounts", "GetPageStats", "GetQueryStats", "GetRankAndTrafficStats", "GetUrlLinks", "GetUserSites"]);
  assert.ok(asked.every((a) => a.params.apikey === KEY && a.url.startsWith(bing.API)));
  assert.ok(asked.filter((a) => a.method !== "GetUserSites").every((a) => a.params.siteUrl === "https://example.com/"));
  assert.equal(asked.find((a) => a.method === "GetUrlLinks").params.link, "https://example.com/claims", "inbound links sampled for the most-linked page");
  assert.deepEqual(d.errors, {});
  const q = d.queries.find((r) => r.key === "brake repair dandenong");
  assert.deepEqual([q.clicks, q.impressions, q.position], [3, 40, 7], "impression-weighted position (4×10 + 8×30) / 40");
  assert.equal(d.queries.find((r) => r.key === "smash repairs").position, null, "-1 means no position");
  assert.deepEqual(d.pages.map((r) => [r.key, r.clicks]), [["https://example.com/claims", 4]]);
  assert.deepEqual({ ...d.totals }, { clicks: 8, impressions: 100, from: "2026-09-30", to: "2026-10-27" });
  const day = d.daily.find((x) => x.date === "2026-10-27");
  assert.deepEqual([day.clicks, day.crawledPages, day.inIndex, day.code4xx], [5, 40, 35, 1], "traffic and crawl stats merge per day");
  assert.deepEqual(d.crawlIssues.map((r) => [r.url, r.labels]), [["https://example.com/moved", ["301 redirect"]], ["https://example.com/old", ["4xx error", "Blocked by robots.txt"]]]);
  assert.deepEqual(d.links.targets.map((r) => r.count), [30, 12]);
  assert.deepEqual({ ...d.links.sample[0] }, { target: "https://example.com/claims", source: "https://blog.test/post", anchor: "accident help" });
  assert.deepEqual([d.rowsFrom, d.rowsTo], ["2026-10-12", "2026-10-19"]);
});

test("a failed part keeps its rows and its stored error never contains the key", async () => {
  const echo = (u) => reply(400, { ErrorCode: 3, Message: `ERROR!!! InvalidApiKey for ${u.href} key ${KEY}` });
  const { fetchFn } = mockBing({ GetQueryStats: echo, GetCrawlIssues: async () => { throw new Error(`socket closed at ${bing.API}GetCrawlIssues?apikey=${KEY}`); } });
  const d = await bing.refreshBing(p(880), { fetchFn });
  assert.match(d.errors.queries, /Bing GetQueryStats: 400 ERROR!!! InvalidApiKey.*check the API key/);
  assert.match(d.errors.issues, /not reachable/);
  const stored = get("SELECT value FROM meta WHERE key='bing:880'").value;
  assert.ok(!stored.includes(KEY) && !JSON.stringify(d).includes(KEY), "key never stored or returned");
  assert.ok(d.queries.length === 2 && d.crawlIssues.length === 2, "previous rows kept");
  assert.equal(d.errors.pages, undefined);
});

test("a site not in the account gives a plain message; a saved Bing site URL skips detection", async () => {
  const { fetchFn } = mockBing({ GetUserSites: () => reply(200, { d: [{ Url: "https://other.test/" }] }) });
  await assert.rejects(bing.refreshBing(p(881), { fetchFn }), /isn't in your Bing Webmaster Tools account/);
  run("UPDATE projects SET settings=? WHERE id=881", JSON.stringify({ indexNowKey: "abcd1234-key", bingSiteUrl: "https://example.com/" }));
  const m = mockBing({ GetUserSites: () => { throw new Error("should not be called"); } });
  assert.equal((await bing.refreshBing(p(881), { fetchFn: m.fetchFn })).siteUrl, "https://example.com/");
  // www and non-www match the same site when the origin differs.
  const w = mockBing({ GetUserSites: () => reply(200, { d: [{ Url: "https://www.example.com/" }] }) });
  assert.equal(await bing.detectSite(HOME, (method, params) => bing.bingCall(method, params, { key: KEY, fetchFn: w.fetchFn })), "https://www.example.com/");
});

// ---- IndexNow ----
test("IndexNow sends only URLs on the project's exact host and returns the rest", () => {
  const r = inx.filterUrls(p(881), ["https://example.com/a", "http://example.com/b", "https://example.com/a#top", "https://www.example.com/c",
    "https://shop.example.com/d", "https://evil.test/e", "ftp://example.com/f", "not a url"]);
  assert.deepEqual(r.accepted, ["https://example.com/a", "http://example.com/b"]);
  assert.deepEqual(r.rejected.map((x) => x.reason), ["not on example.com", "not on example.com", "not on example.com", "not http(s)", "not a full URL"]);
  const many = inx.filterUrls(p(881), Array.from({ length: 10002 }, (_, i) => `https://example.com/p${i}`));
  assert.equal(many.accepted.length, 10000);
  assert.equal(many.rejected.length, 2);
});

test("IndexNow refuses without a key and sends the protocol body; each status has a plain message", async () => {
  await assert.rejects(inx.submit(p(880), ["https://example.com/a"], { fetchFn: async () => reply(200, "") }), /IndexNow key/);
  const asked = [];
  for (const status of [200, 202, 400, 403, 422, 429]) {
    const r = await inx.submit(p(881), ["https://example.com/a", "https://other.test/x"], { fetchFn: async (url, o) => { asked.push({ url, body: JSON.parse(o.body) }); return reply(status, ""); } });
    assert.equal(r.message, inx.STATUS_TEXT[status]);
    assert.equal(r.ok, status === 200 || status === 202);
    assert.equal(r.rejected.length, 1);
  }
  assert.equal(asked[0].url, inx.ENDPOINT);
  assert.deepEqual(asked[0].body, { host: "example.com", key: "abcd1234-key", keyLocation: "https://example.com/abcd1234-key.txt", urlList: ["https://example.com/a"] });
  assert.equal(all("SELECT * FROM indexnow_log WHERE project_id=881").length, 6);
  await assert.rejects(inx.submit(p(881), ["https://other.test/x"], { fetchFn: async () => reply(200, "") }), /No URL on example\.com/);
});

test("IndexNow key file check compares the trimmed body", async () => {
  const seen = [];
  const ok = await inx.checkKeyFile(p(881), { fetchFn: async (url) => { seen.push(url); return reply(200, "abcd1234-key\n"); } });
  assert.deepEqual([ok.ok, seen[0]], [true, "https://example.com/abcd1234-key.txt"]);
  assert.equal((await inx.checkKeyFile(p(881), { fetchFn: async () => reply(200, "something else") })).ok, false);
  assert.match((await inx.checkKeyFile(p(881), { fetchFn: async () => reply(404, "") })).message, /answered 404/);
});

test("changed URLs: new indexable pages and pages whose text or title changed since the previous audit", () => {
  const audit = (id) => run("INSERT INTO audits (id, project_id, status) VALUES (?, 881, 'done')", id);
  const page = (aid, url, title, hash, indexable = 1, status = 200) =>
    run("INSERT INTO pages (audit_id, url, status, indexable, title, data) VALUES (?,?,?,?,?,?)", aid, url, status, indexable, title, JSON.stringify({ textHash: hash }));
  audit(8810);
  assert.match(inx.changedUrls(881).note, /second finished audit/);
  page(8810, "https://example.com/", "Home", "h1"); page(8810, "https://example.com/a", "A", "h2"); page(8810, "https://example.com/b", "B", "h3");
  audit(8811);
  page(8811, "https://example.com/", "Home", "h1");         // unchanged
  page(8811, "https://example.com/a", "A", "h2-new");       // text changed
  page(8811, "https://example.com/b", "B (new title)", "h3"); // title changed
  page(8811, "https://example.com/c", "C", "h4");           // new
  page(8811, "https://example.com/d", "D", "h5", 0);        // new but noindex: not suggested
  const r = inx.changedUrls(881);
  assert.deepEqual([r.auditId, r.previousAuditId], [8811, 8810]);
  assert.deepEqual(r.urls, [{ url: "https://example.com/a", reason: "text changed" }, { url: "https://example.com/b", reason: "title changed" }, { url: "https://example.com/c", reason: "new" }]);
});
