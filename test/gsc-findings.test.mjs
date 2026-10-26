// Search Console findings (REQ-044 build rows 25, 47, 56) and the refresh that feeds them, with the Search Console client
// and the Status Dashboard fetch mocked: no Google API or network call is made. Fixtures use example.com only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, all, get } = await import("../src/db.mjs");
const { refresh, summary } = await import("../src/gsc.mjs");
const { brandNotTop, ambiguousBrand, homeLike, appearanceTable, appearanceGaps, APPEARANCE_FEATURES, projectFindings } = await import("../src/gsc-findings.mjs");
const { parseTargets, targetGaps, targetReport } = await import("../src/queries.mjs");
const { brandTest } = await import("../src/page2.mjs");

const HOME = "https://example.com/";
const isBrand = brandTest("Example Widgets", HOME);
const row = (query, page, impressions, position, clicks = 0) => ({ query, page, impressions, position, clicks });
const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ---- Row 25: brand not top ----
test("brand_not_top: brand searches below first place, or led by a deep page; quiet when the home page leads", () => {
  const low = brandNotTop([row("example widgets", HOME, 40, 2.4), row("example widgets", "https://example.com/blog/a", 10, 6), row("blue widgets", HOME, 99, 9)], { isBrand, home: HOME });
  assert.equal(low.id, "brand_not_top");
  assert.equal(low.severity, "warning");
  assert.equal(low.impressions, 40, "per search: the most impressions one page got, not the pages added up");
  assert.equal(low.position, 2.4, "per search: the best position any page had");
  assert.match(low.why, /SEO for small businesses/);
  const deep = brandNotTop([row("example widgets", "https://example.com/blog/a", 30, 1), row("example widgets", HOME, 5, 1.2)], { isBrand, home: HOME });
  assert.equal(deep.pageOk, false);
  assert.match(deep.detail, /blog\/a/);
  assert.equal(brandNotTop([row("example widgets", HOME, 60, 1.1), row("example widgets reviews", "https://example.com/about.html", 30, 1)], { isBrand, home: HOME }), null);
  assert.equal(brandNotTop([row("example widgets", HOME, 12, 5)], { isBrand, home: HOME }), null, "under 20 brand impressions: too few to judge");
  const info = brandNotTop([row("example widgets", HOME, 40, 3)], { isBrand, home: HOME, ambiguous: true });
  assert.equal(info.severity, "info");
  assert.match(info.detail, /information only/);
});

test("brand helpers: home/about/contact pages, and single short-word brands count as ambiguous", () => {
  assert.ok(homeLike("https://www.example.com/index.html", HOME));
  assert.ok(homeLike("https://example.com/contact-us/", HOME));
  assert.ok(!homeLike("https://example.com/services/widgets", HOME));
  assert.equal(ambiguousBrand(["Apple", "apple"]), true);
  assert.equal(ambiguousBrand(["Example Widgets", "example"]), false);
  assert.equal(ambiguousBrand(["examplewidgets.com"]), false, "a long run-together name is not an everyday word");
});

// ---- Row 47: search appearance ----
test("appearance table: 90-day totals and the latest week against the week before, 30% falls flagged", () => {
  const daily = [];
  for (let i = 0; i < 14; i++) {
    const date = add("2026-09-01", i);
    daily.push({ appearance: "REVIEW_SNIPPET", date, clicks: 1, impressions: i < 7 ? 20 : 10, position: 3 });
    daily.push({ appearance: "VIDEO", date, clicks: 0, impressions: 2, position: 8 });
  }
  const t = appearanceTable(daily, "2026-09-14");
  const r = t.find((x) => x.appearance === "REVIEW_SNIPPET");
  assert.equal(r.label, "Review snippet");
  assert.deepEqual([r.prevWeek, r.lastWeek, r.drop], [140, 70, true]);
  assert.equal(t.find((x) => x.appearance === "VIDEO").drop, false, "under 50 impressions the week before: not judged");
});

test("appearance gaps: 5+ pages with markup for 28+ days and no matching impressions; self-serving ratings never count", () => {
  const product = (i) => ({ url: `https://example.com/p/${i}`, types: ["Product", "Offer", "AggregateRating"] });
  const pages = [1, 2, 3, 4, 5].map(product);
  const old = () => "2026-07-01";
  const gaps = appearanceGaps({ pages, appearances: [], firstSeen: old, endDate: "2026-09-30" });
  assert.deepEqual(gaps.map((g) => g.feature).sort(), ["Product snippets and merchant listings", "Review snippets"]);
  assert.equal(gaps[0].pages, 5);
  assert.equal(appearanceGaps({ pages: pages.slice(0, 4), appearances: [], firstSeen: old, endDate: "2026-09-30" }).length, 0, "4 pages: below the 5-page guard");
  assert.equal(appearanceGaps({ pages, appearances: [], firstSeen: () => "2026-09-20", endDate: "2026-09-30" }).length, 0, "markup under 28 days old");
  assert.equal(appearanceGaps({ pages, appearances: [{ appearance: "PRODUCT_SNIPPETS", impressions: 4 }, { appearance: "REVIEW_SNIPPET", impressions: 1 }], firstSeen: old, endDate: "2026-09-30" }).length, 0);
  const local = [1, 2, 3, 4, 5, 6].map((i) => ({ url: `https://example.com/l/${i}`, types: ["LocalBusiness", "AggregateRating", "PostalAddress"] }));
  assert.equal(appearanceGaps({ pages: local, appearances: [], firstSeen: old, endDate: "2026-09-30" }).length, 0, "a business rating itself never gets review stars");
  assert.ok(!APPEARANCE_FEATURES.some((f) => /faq|how.?to/i.test(f.feature)), "retired rich results are not checked");
});

// ---- Row 56: target keywords ----
test("target keywords: shown, page not shown, no page; brand targets skipped", () => {
  assert.deepEqual(parseTargets("Blue Widgets\nblue widgets, red  widgets;\n\n"), ["blue widgets", "red widgets"]);
  const rows = [row("blue widgets springfield", "https://example.com/blue", 30, 7, 2)];
  const pages = [{ url: "https://example.com/red", title: "Red Widgets | Example Widgets", h1: "Red widgets", status: 200, indexable: 1, inlinks: 3 },
    { url: "https://example.com/blue", title: "Blue widgets", h1: "", status: 200, indexable: 1, inlinks: 9 }];
  const r = targetGaps(["blue widgets", "red widgets", "green widgets", "example widgets"], rows, pages, isBrand);
  const by = Object.fromEntries(r.targets.map((x) => [x.keyword, x]));
  assert.equal(by["blue widgets"].status, "shown");
  assert.equal(by["blue widgets"].impressions, 30);
  assert.equal(by["red widgets"].status, "page-not-shown");
  assert.equal(by["red widgets"].page, "https://example.com/red");
  assert.equal(by["green widgets"].status, "no-page");
  assert.deepEqual(r.brand, ["example widgets"]);
});

// ---- Refresh with a mocked Search Console client and Status Dashboard fetch ----
const FEED = [
  { id: "a1", begin: "2026-09-24T16:15:00+00:00", end: "2026-10-08T08:00:00+00:00", external_desc: "Example 2026 core update", service_name: "Ranking", status_impact: "SERVICE_INFORMATION", uri: "incidents/a1" },
  { id: "b2", begin: "2026-09-02T10:00:00+00:00", end: "2026-09-03T08:00:00+00:00", external_desc: "Indexing was experiencing an issue", service_name: "Indexing", status_impact: "SERVICE_DISRUPTION", uri: "incidents/b2" },
];
function mockClient() {
  const calls = [];
  const call = async (urlPath, body) => {
    calls.push({ urlPath, body });
    if (urlPath === "sites") return { siteEntry: [{ siteUrl: "sc-domain:example.com" }] };
    const d = (body.dimensions || []).join(","), f = body.dimensionFilterGroups?.[0]?.filters?.[0];
    if (body.startRow > 0) return { rows: [] };
    if (d === "page") return { rows: [{ keys: [HOME], clicks: 5, impressions: 80, ctr: 0.06, position: 2 }] };
    if (d === "query,page") return { rows: [{ keys: ["example widgets", "https://example.com/blog/a"], clicks: 1, impressions: 40, ctr: 0.02, position: 4 }] };
    if (d === "searchAppearance") return { rows: [{ keys: ["VIDEO"], clicks: 0, impressions: 6 }, { keys: ["REVIEW_SNIPPET"], clicks: 2, impressions: 60 }] };
    if (d === "date" && f?.dimension === "searchAppearance") return { rows: [{ keys: ["2026-09-01"], clicks: 1, impressions: f.expression === "VIDEO" ? 6 : 60, position: 4 }] };
    if (d === "date,country") return { rows: Array.from({ length: 12 }, (_, i) => ({ keys: ["2026-09-01", `c${String(i).padStart(2, "0")}`], clicks: 0, impressions: 100 - i, position: 5 })) };
    if (d === "date" || d === "page,date" || d === "date,device") return { rows: [{ keys: d === "page,date" ? [HOME, "2026-09-01"] : d === "date,device" ? ["2026-09-01", "MOBILE"] : ["2026-09-01"], clicks: 3, impressions: 90, ctr: 0.03, position: 3 }] };
    throw new Error(`unexpected ${d}`);
  };
  return { call, calls };
}

test("refresh: country trend (top 10), search appearance in two steps, the Status Dashboard feed; all mocked", async () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (901, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ gscProperty: "sc-domain:example.com" }));
  const project = get("SELECT * FROM projects WHERE id=901");
  const { call, calls } = mockClient();
  let fetches = 0;
  const fetchFn = async (url, opts) => { fetches++; assert.equal(url, "https://status.search.google.com/incidents.json"); assert.ok(opts.signal, "the GET has a timeout"); return { ok: true, json: async () => FEED }; };
  const r = await refresh(project, { call, fetchFn });
  assert.equal(r.countryRows, 12);
  assert.equal(r.appearanceRows, 2);
  assert.equal(r.statusFeed.error, null);
  const list = calls.find((c) => c.body?.dimensions?.includes("searchAppearance"));
  assert.deepEqual(list.body.dimensions, ["searchAppearance"], "search appearance is never grouped with another dimension");
  const perType = calls.filter((c) => c.body?.dimensionFilterGroups?.[0]?.filters?.[0]?.dimension === "searchAppearance");
  assert.deepEqual(perType.map((c) => c.body.dimensionFilterGroups[0].filters[0].expression).sort(), ["REVIEW_SNIPPET", "VIDEO"]);
  const countries = all("SELECT DISTINCT segment FROM gsc_trend WHERE project_id=901 AND segment LIKE 'country:%'").map((x) => x.segment);
  assert.equal(countries.length, 10);
  assert.ok(!countries.includes("country:c11"), "the two smallest countries are not kept");
  assert.equal(all("SELECT * FROM gsc_appearance WHERE project_id=901").length, 2);
  const s = summary(901);
  assert.deepEqual(s.appearance.appearances.map((a) => a.appearance), ["REVIEW_SNIPPET", "VIDEO"]);
  assert.ok(s.findings.some((f) => f.id === "brand_not_top"), "brand search led by a blog post at position 4");
  // A second refresh within 12 hours reuses the cached feed: still one GET.
  await refresh(project, { call, fetchFn });
  assert.equal(fetches, 1);
});

test("refresh: a failing search appearance call keeps the other data and the previous appearance rows", async () => {
  const project = get("SELECT * FROM projects WHERE id=901");
  const { call } = mockClient();
  const failing = async (p, body) => { if (body?.dimensions?.includes("searchAppearance")) throw new Error("quota"); return call(p, body); };
  const r = await refresh(project, { call: failing, fetchFn: async () => { throw new Error("offline"); } });
  assert.equal(r.appearanceRows, 0);
  assert.equal(r.pages, 1, "the rest of the refresh still saved");
  assert.equal(all("SELECT * FROM gsc_appearance WHERE project_id=901").length, 2, "previous rows kept");
  const meta = JSON.parse(get("SELECT value FROM meta WHERE key='gsc-appearance:901'").value);
  assert.equal(meta.error, "quota");
  assert.ok(meta.fetchedAt, "previous fetch date kept");
  assert.equal(summary(901).appearance.gaps.length, 0, "no gap is claimed while the last fetch failed");
});

test("projectFindings: appearance gap and targets from the database", () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (902, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ targetKeywords: "green widgets\nred widgets" }));
  run("INSERT INTO audits (id, project_id, status, started_at, finished_at) VALUES (9020, 902, 'done', '2026-06-01 10:00:00', '2026-06-01 11:00:00')");
  for (let i = 1; i <= 5; i++) run(`INSERT INTO pages (audit_id, url, status, content_type, title, h1, indexable, data) VALUES (9020, ?, 200, 'text/html', ?, '', 1, ?)`,
    `https://example.com/v/${i}`, i === 1 ? "Red widgets" : `Video ${i}`, JSON.stringify({ schemaTypes: ["VideoObject", "WebPage"] }));
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (902, 'example widgets', ?, 3, 30, 0.1, 1)", HOME);
  run("INSERT INTO meta (key, value) VALUES ('gsc-appearance:902', ?)", JSON.stringify({ startDate: "2026-07-01", endDate: "2026-09-28", fetchedAt: "2026-10-01T00:00:00Z", error: null }));
  run("INSERT INTO gsc_appearance (project_id, appearance, date, clicks, impressions, position) VALUES (902, 'REVIEW_SNIPPET', '2026-09-20', 0, 3, 4)");
  const f = projectFindings(902);
  const ids = f.map((x) => x.id);
  assert.ok(ids.includes("search_appearance_gap"), "5 video pages since June, no video impressions");
  assert.match(f.find((x) => x.id === "search_appearance_gap").detail, /Videos: markup on 5 pages since at least 2026-06-01/);
  assert.ok(ids.includes("target_keyword_gap") && ids.includes("target_page_not_shown"));
  assert.ok(!ids.includes("brand_not_top"), "home page first for the brand");
  assert.deepEqual(targetReport(902).targets.map((t) => t.status), ["no-page", "page-not-shown"]);
});
