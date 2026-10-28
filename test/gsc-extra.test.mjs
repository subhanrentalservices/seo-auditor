// Search Console sitemaps, Discover / Google News and the explorer (REQ-055 group 4, items 4, 5 and 7). The Search
// Console client is mocked: no Google API or network call is made. Fixtures use example.com only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, get, all } = await import("../src/db.mjs");
const { refreshSitemaps, sitemapReport, parseSitemap, sitemapProblems } = await import("../src/gsc-sitemaps.mjs");
const { refreshTypes, typesReport } = await import("../src/gsc-discover.mjs");
const { buildRequest, explore, toCsv, shapeRows } = await import("../src/gsc-explorer.mjs");
const { addDays } = await import("../src/gsc-history.mjs");

const HOME = "https://example.com/";
const PROP = "sc-domain:example.com";
const NOW = Date.parse("2026-10-28T00:00:00Z");
run("INSERT INTO projects (id, name, start_url, settings) VALUES (801, 'Example', ?, ?)", HOME, JSON.stringify({ gscProperty: PROP }));
const p801 = () => get("SELECT * FROM projects WHERE id=801");

// ---- Item 4: sitemaps ----
const SITEMAPS = { sitemap: [
  { path: "https://example.com/sitemap_index.xml", isSitemapsIndex: true, type: "sitemap", lastSubmitted: "2026-10-01T00:00:00Z", lastDownloaded: "2026-10-27T00:00:00Z", warnings: "0", errors: "0",
    contents: [{ type: "web", submitted: "12", indexed: "0" }] },
  { path: "https://example.com/old-sitemap.xml", type: "sitemap", lastSubmitted: "2025-01-01T00:00:00Z", lastDownloaded: "2026-08-01T00:00:00Z", warnings: "2", errors: "1",
    contents: [{ type: "web", submitted: "3", indexed: "3" }] },
] };
const CHILDREN = { sitemap: [
  { path: "https://example.com/pages.xml", type: "sitemap", lastDownloaded: "2026-10-27T00:00:00Z", warnings: "0", errors: "0", contents: [{ type: "web", submitted: "10" }, { type: "image", submitted: "4" }] },
  { path: "https://example.com/posts.xml", type: "sitemap", isPending: true, contents: [{ type: "web", submitted: "2" }] },
] };

test("parseSitemap: string counts become numbers and the deprecated indexed count is dropped", () => {
  const s = parseSitemap(SITEMAPS.sitemap[1]);
  assert.deepEqual([s.warnings, s.errors, s.isIndex], [2, 1, 0]);
  assert.deepEqual(s.contents, [{ type: "web", submitted: 3 }]);
  assert.ok(!("indexed" in s.contents[0]));
  assert.deepEqual(sitemapProblems(s, NOW), ["1 error", "2 warnings", "not read for 30+ days"]);
  assert.deepEqual(sitemapProblems(parseSitemap({ path: "x", isPending: true }), NOW), ["not processed yet"]);
});

test("sitemaps refresh: the list, children of an index, and the sitemap pages matched with URL Inspection", async () => {
  const calls = [];
  const call = async (p) => { calls.push(p); return p.includes("?sitemapIndex=") ? CHILDREN : SITEMAPS; };
  const r = await refreshSitemaps(p801(), { call, property: PROP });
  assert.equal(r.sitemaps, 4);
  assert.equal(calls[0], `sites/${encodeURIComponent(PROP)}/sitemaps`);
  assert.ok(calls[1].endsWith(`?sitemapIndex=${encodeURIComponent("https://example.com/sitemap_index.xml")}`));
  run("INSERT INTO audits (id, project_id, status) VALUES (8010, 801, 'done')");
  for (const [u, inSitemap] of [["a", 1], ["b", 1], ["c", 0]]) run("INSERT INTO pages (audit_id, url, status, indexable, in_sitemap, content_type) VALUES (8010, ?, 200, 1, ?, 'text/html')", HOME + u, inSitemap);
  // index_status is created by indexing.mjs (imported by gsc-sitemaps.mjs).
  run("INSERT INTO index_status (project_id, url, verdict, coverage, wanted) VALUES (801, ?, 'PASS', 'Submitted and indexed', 1)", HOME + "a");
  const rep = sitemapReport(801, NOW);
  assert.equal(rep.totals.sitemaps, 4);
  assert.equal(rep.totals.submitted, 3 + 10 + 2, "web URLs in the leaf sitemaps (the index's own count is not added twice)");
  assert.deepEqual([rep.totals.errors, rep.totals.warnings], [1, 2]);
  assert.equal(rep.sitemaps.find((s) => s.path.endsWith("posts.xml")).parent, "https://example.com/sitemap_index.xml");
  assert.deepEqual(rep.inspection, { auditId: 8010, sitemapPages: 2, inspected: 1, indexed: 1 });
});

test("a failed sitemaps call keeps the previous list and reports the error", async () => {
  const r = await refreshSitemaps(p801(), { call: async () => { throw new Error("403 forbidden"); }, property: PROP });
  assert.equal(r.error, "403 forbidden");
  const rep = sitemapReport(801, NOW);
  assert.equal(rep.sitemaps.length, 4);
  assert.equal(rep.error, "403 forbidden");
  assert.ok(rep.fetchedAt, "the last good fetch time is kept");
});

// ---- Item 5: Discover and Google News ----
test("Discover and Google News: fetched separately, pages only when the property has data, no position", async () => {
  const calls = [];
  const call = async (p, body) => {
    calls.push(body);
    if (body.startRow > 0) return { rows: [] };
    if (body.type === "googleNews") return { rows: [] };
    if (body.dimensions[0] === "date") return { rows: [{ keys: ["2026-10-24"], clicks: 4, impressions: 100 }, { keys: ["2026-09-20"], clicks: 1, impressions: 50 }] };
    return { rows: [{ keys: [HOME + "story"], clicks: 4, impressions: 100 }] };
  };
  const r = await refreshTypes(p801(), { call, property: PROP, endDate: "2026-10-25" });
  assert.deepEqual(r, { discover: { days: 2, pages: 1 }, googleNews: { days: 0, pages: 0 } });
  assert.ok(calls.every((b) => ["discover", "googleNews"].includes(b.type)));
  assert.equal(calls.filter((b) => b.type === "googleNews").length, 1, "no page call for a type without data");
  const rep = typesReport(801);
  const d = rep.types.find((t) => t.type === "discover"), n = rep.types.find((t) => t.type === "googleNews");
  assert.equal(d.hasData, true);
  assert.deepEqual(d.last28, { clicks: 4, impressions: 100, ctr: 0.04 });
  assert.deepEqual(d.prev28, { clicks: 1, impressions: 50, ctr: 0.02 });
  assert.equal(d.pages[0].page, HOME + "story");
  assert.ok(!("position" in d.pages[0]));
  assert.deepEqual([n.fetched, n.hasData, n.pages.length], [true, false, 0]);
  // A failure on one type is recorded and the other still fetched.
  const r2 = await refreshTypes(p801(), { call: async (p, b) => { if (b.type === "discover") throw new Error("boom"); return { rows: [] }; }, property: PROP, endDate: "2026-10-26" });
  assert.equal(r2.discover.error, "boom");
  assert.equal(typesReport(801).types.find((t) => t.type === "discover").days.length, 2, "previous rows kept");
});

// ---- Item 7: explorer ----
test("explorer request: defaults, filters, country and device, and every bad input refused with a reason", () => {
  const { body, limit } = buildRequest({}, NOW);
  assert.deepEqual([body.startDate, body.endDate, body.type, body.dimensions, limit], [addDays("2026-10-25", -27), "2026-10-25", "web", ["query"], 1000]);
  const r = buildRequest({ startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["page", "query", "page"], query: { operator: "includingRegex", value: "^(how|what) " },
    page: { operator: "contains", value: "/blog/" }, country: "AUS", device: "mobile", limit: 999999 }, NOW);
  assert.deepEqual(r.body.dimensions, ["page", "query"]);
  assert.deepEqual(r.body.dimensionFilterGroups[0].filters, [
    { dimension: "query", operator: "includingRegex", expression: "^(how|what) " }, { dimension: "page", operator: "contains", expression: "/blog/" },
    { dimension: "country", operator: "equals", expression: "aus" }, { dimension: "device", operator: "equals", expression: "MOBILE" }]);
  assert.equal(r.limit, 100000);
  for (const [input, re] of [[{ startDate: "2026/09/01" }, /YYYY-MM-DD/], [{ startDate: "2026-10-10", endDate: "2026-10-01" }, /after/], [{ startDate: "2024-01-01" }, /16 months/],
    [{ type: "shopping" }, /Search type/], [{ dimensions: ["searchAppearance"] }, /Unknown dimension/], [{ type: "discover" }, /don't report searches/],
    [{ query: { operator: "like", value: "x" } }, /Unknown operator/], [{ query: { operator: "includingRegex", value: "(" } }, /valid regular/],
    [{ query: { operator: "includingRegex", value: "^(?!brand)" } }, /RE2/], [{ country: "australia" }, /three-letter/], [{ device: "watch" }, /Device/],
    [{ query: { value: "x".repeat(5000) } }, /too long/]]) assert.throws(() => buildRequest(input, NOW), (e) => e.status === 400 && re.test(e.message), JSON.stringify(input).slice(0, 80));
});

test("explore: live rows shaped per dimension (no position for Discover), CSV with spreadsheet-safe cells", async () => {
  const call = async (p, body) => {
    assert.equal(p, `sites/${encodeURIComponent(PROP)}/searchAnalytics/query`);
    if (body.startRow > 0) return { rows: [] };
    return { rows: [{ keys: [HOME, "DESKTOP"], clicks: 3, impressions: 30, ctr: 0.1, position: 2.5 }, { keys: ["=cmd|calc", "MOBILE"], clicks: 0, impressions: 2, ctr: 0, position: 9 }] };
  };
  const r = await explore(p801(), { dimensions: ["page", "device"] }, { call, now: NOW });
  assert.deepEqual(r.columns, ["page", "device", "clicks", "impressions", "ctr", "position"]);
  assert.deepEqual(r.rows[0], { page: HOME, device: "desktop", clicks: 3, impressions: 30, ctr: 0.1, position: 2.5 });
  const csv = toCsv(r.columns, r.rows).split("\r\n");
  assert.equal(csv[0], "page,device,clicks,impressions,ctr,position");
  assert.equal(csv[2], `"'=cmd|calc",mobile,0,2,0,9`, "formula-like cells are defused");
  const d = shapeRows([{ keys: ["2026-10-01"], clicks: 1, impressions: 4 }], ["date"], "discover");
  assert.deepEqual(d, [{ date: "2026-10-01", clicks: 1, impressions: 4, ctr: 0.25 }]);
  const limited = await explore(p801(), { limit: 1 }, { call, now: NOW });
  assert.equal(limited.rows.length, 1);
  assert.equal(limited.truncated, true);
});
