// Search trend segments and drop cross-check (REQ-044 rows 48-49), the Search Status Dashboard feed (fetch mocked, the
// shipped google-updates.json is never written) and Google title rewrites from stored SERP snapshots (row 41, no new
// paid calls). Fixtures use example.com only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates the Search Console tables
const { analyse, loadUpdates, loadShipped, loadIncidents, sectionOf, sectionSeries, siteChangesBetween, trendReport } = await import("../src/trends.mjs");
const { parseFeed, mergeUpdates, refreshFeed, cachedFeed } = await import("../src/status-feed.mjs");
const { titleCore, titleRewrite, serpOpportunities, serpSnapshot } = await import("../src/serpfeatures.mjs");

const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const series = (from, n, value) => Array.from({ length: n }, (_, i) => { const date = add(from, i), c = value(i, date); return { date, clicks: c, impressions: c * 10, position: 5 }; });
const SHIPPED = readFileSync(new URL("../src/google-updates.json", import.meta.url), "utf8");

// ---- Row 49: Search Status Dashboard feed ----
const FEED = [
  { id: "u1", begin: "2026-09-24T16:15:00+00:00", end: "2026-10-08T08:00:00+00:00", external_desc: "September 2026 spam update", service_name: "Ranking", uri: "incidents/u1" },
  { id: "u2", begin: "2026-10-20T16:00:00+00:00", end: null, external_desc: "Example 2026 core update", service_name: "Ranking", uri: "incidents/u2" },
  { id: "i1", begin: "2026-03-14T09:00:00+00:00", end: "2026-03-16T09:00:00+00:00", external_desc: "Serving was experiencing an issue", service_name: "Serving", status_impact: "SERVICE_DISRUPTION", uri: "incidents/i1" },
  { id: "x", begin: "2026-01-01T00:00:00+00:00", external_desc: "", service_name: "Ranking" },
];

test("feed: ranking updates and incidents parsed with their source URL; the shipped list is never duplicated", () => {
  const f = parseFeed(FEED);
  assert.deepEqual(f.updates.map((u) => [u.name, u.type, u.start]), [["September 2026 spam update", "spam", "2026-09-24"], ["Example 2026 core update", "core", "2026-10-20"]]);
  assert.equal(f.updates[1].source, "https://status.search.google.com/incidents/u2");
  assert.deepEqual(f.incidents.map((i) => [i.service, i.start, i.end]), [["serving", "2026-03-14", "2026-03-16"]]);
  const shipped = [{ name: "September 2026 spam update", type: "spam", start: "2026-09-24" }];
  const merged = mergeUpdates(shipped, f.updates, "2026-10-27");
  assert.equal(merged.length, 2, "the September update is already on the hand-curated list");
  assert.deepEqual(merged[0], shipped[0], "hand-curated entries are returned untouched");
  assert.deepEqual([merged[1].fromFeed, merged[1].fetched, merged[1].source], [true, "2026-10-27", "https://status.search.google.com/incidents/u2"]);
});

test("feed: one GET with a timeout, cached, failures keep the last good copy; google-updates.json is not written", async () => {
  assert.equal(cachedFeed(), null);
  let n = 0;
  const ok = async (url, opts) => { n++; assert.ok(opts.signal); return { ok: true, json: async () => FEED }; };
  const now = Date.parse("2026-10-27T00:00:00Z");
  await refreshFeed({ fetchFn: ok, now });
  await refreshFeed({ fetchFn: ok, now: now + 3600e3 });
  assert.equal(n, 1, "checked again only after 12 hours");
  assert.ok(loadUpdates().some((u) => u.name === "Example 2026 core update" && u.fromFeed));
  assert.equal(loadUpdates().filter((u) => /September 2026 spam update/.test(u.name)).length, 1);
  assert.equal(loadIncidents().length, 1);
  const failed = await refreshFeed({ fetchFn: async () => ({ ok: false, status: 503 }), now: now + 13 * 3600e3 });
  assert.equal(failed.error, "HTTP 503");
  assert.equal(failed.updates.length, 2, "last good copy kept");
  await refreshFeed({ fetchFn: async () => { throw new Error("timeout"); }, now: now + 26 * 3600e3 });
  assert.equal(cachedFeed().error, "timeout");
  assert.ok(loadShipped().length >= 5);
  assert.equal(readFileSync(new URL("../src/google-updates.json", import.meta.url), "utf8"), SHIPPED, "the shipped list is never written");
});

// ---- Row 48: countries, sections, incidents, cross-check ----
test("a drop names the country and section that lost most, only those with 100+ impressions, and an open incident", () => {
  const from = "2026-01-01", drop = "2026-03-15", n = 120, after = (d) => d >= drop;
  const s = {
    all: series(from, n, (i, d) => (after(d) ? 70 : 100)),
    "country:aus": series(from, n, (i, d) => (after(d) ? 40 : 70)),
    "country:nzl": series(from, n, () => 25),
    "country:fji": series(from, n, (i, d) => (after(d) ? 0 : 1)), // 10 impressions a day: never judged
    "section:/blog/": series(from, n, (i, d) => (after(d) ? 10 : 40)),
    "section:/": series(from, n, () => 60),
  };
  const r = analyse(s, [], [{ name: "Serving was experiencing an issue", service: "serving", start: "2026-03-14", end: "2026-03-16", source: "https://status.search.google.com/incidents/i1" }]);
  assert.equal(r.drops.length, 1);
  const x = r.drops[0];
  assert.equal(x.label, "during a Google incident");
  assert.equal(x.incident.service, "serving");
  assert.equal(x.driver.country.segment, "country:aus");
  assert.equal(x.driver.section.segment, "section:/blog/");
  assert.equal(x.split["country:fji"].impressionsBefore, 70, "fji had 70 impressions that week: under 100, left out of the lead");
  assert.equal(r.weekly["country:aus"], undefined, "countries don't add weekly charts");
  assert.ok(r.segments.some((g) => g.segment === "country:aus") && !r.segments.some((g) => g.segment === "country:fji"));
  const plain = analyse(s, [], []);
  assert.equal(plain.drops[0].label, "unexplained");
});

test("sections: first folder of the URL; one section only gives no split", () => {
  assert.equal(sectionOf("https://example.com/blog/post-a"), "/blog/");
  assert.equal(sectionOf("https://example.com/services.html"), "/");
  const rows = [{ url: "https://example.com/blog/a", date: "2026-01-01", clicks: 1, impressions: 10, position: 3 },
    { url: "https://example.com/blog/b", date: "2026-01-01", clicks: 1, impressions: 30, position: 5 },
    { url: "https://example.com/about", date: "2026-01-01", clicks: 0, impressions: 5, position: 2 }];
  const s = sectionSeries(rows);
  assert.deepEqual(Object.keys(s), ["section:/blog/", "section:/"]);
  assert.deepEqual([s["section:/blog/"][0].impressions, s["section:/blog/"][0].position], [40, 4.5]);
  assert.deepEqual(sectionSeries(rows.slice(0, 2)), {});
});

test("cross-check: robots.txt block, pages turned noindex and new 5xx from audits in the drop window", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (950, 'Example', 'https://example.com/')");
  run("INSERT INTO audits (id, project_id, status, started_at, finished_at) VALUES (9501, 950, 'done', '2026-03-01 09:00:00', '2026-03-01 10:00:00')");
  run("INSERT INTO audits (id, project_id, status, started_at, finished_at) VALUES (9502, 950, 'done', '2026-03-12 09:00:00', '2026-03-12 10:00:00')");
  for (const [a, idx] of [[9501, 1], [9502, 0]]) {
    run("INSERT INTO pages (audit_id, url, status, content_type, indexable) VALUES (?, 'https://example.com/a', 200, 'text/html', ?)", a, idx);
    run("INSERT INTO pages (audit_id, url, status, content_type, indexable) VALUES (?, 'https://example.com/b', 200, 'text/html', 1)", a);
  }
  run("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (9502, 'robots_disallow_added', 'warning', 'https://example.com/robots.txt', 'Disallow: /blog/')");
  run("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (9501, 'http_5xx', 'error', 'https://example.com/old', '500')");
  run("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (9502, 'http_5xx', 'error', 'https://example.com/old', '500')");
  run("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (9502, 'http_5xx', 'error', 'https://example.com/new', '503')");
  const r = siteChangesBetween(950, "2026-03-05", "2026-03-20");
  assert.equal(r.audits, 1);
  assert.deepEqual(r.changes.map((c) => [c.kind, c.count, c.urls[0]]), [["robots", 1, "https://example.com/robots.txt"], ["noindex", 1, "https://example.com/a"], ["5xx", 1, "https://example.com/new"]]);
  assert.deepEqual(siteChangesBetween(950, "2026-04-01", "2026-04-20"), { audits: 0, changes: [] });
  for (const r2 of series("2026-01-01", 120, (i, d) => (d >= "2026-03-15" ? 70 : 100))) run("INSERT INTO gsc_trend (project_id,date,segment,clicks,impressions,position) VALUES (950,?,?,?,?,?)", r2.date, "all", r2.clicks, r2.impressions, r2.position);
  const t = trendReport(950);
  assert.equal(t.drops[0].siteChanges.changes.length, 3, "the report attaches the audit changes to each drop");
  assert.ok(t.feed && t.feed.url, "the report says where the feed came from");
});

// ---- Row 41: title rewritten by Google ----
const BRAND = ["Example Widgets", "example.com"];
test("title rewrites: brand suffix, truncation and case are not rewrites; a different title is", () => {
  assert.equal(titleCore("Blue Widgets in Springfield | Example Widgets", BRAND), "blue widgets in springfield");
  assert.equal(titleRewrite("Blue Widgets in Springfield - Example Widgets", "Blue widgets in Springfield | Example Widgets", BRAND), null);
  assert.equal(titleRewrite("Blue Widgets in Springfield and Nearby Sub…", "Blue Widgets in Springfield and Nearby Suburbs | Example Widgets", BRAND), null, "cut off mid-word");
  assert.equal(titleRewrite("Blue Widgets in Springfield ...", "Blue Widgets in Springfield and Nearby Suburbs", BRAND), null, "cut off after a word");
  const r = titleRewrite("Example Widgets: Widget Repairs and Spare Parts", "Blue Widgets in Springfield | Example Widgets", BRAND);
  assert.ok(r && r.similarity < 0.6);
  assert.equal(r.pageTitle, "Blue Widgets in Springfield | Example Widgets");
});

test("SERP opportunities flag a rewritten title from the stored snapshot, old snapshots included (top 10 entry)", () => {
  const OWN = "https://example.com/blue.html";
  const items = [{ type: "organic", rank_group: 1, domain: "example.com", url: OWN, title: "Widget Repairs and Spare Parts - Example Widgets" },
    { type: "organic", rank_group: 2, domain: "other.example.net", url: "https://other.example.net/", title: "Other" }];
  const fresh = serpSnapshot(items, (d) => /(^|\.)example\.com$/.test(d));
  assert.equal(fresh.own.title, "Widget Repairs and Spare Parts - Example Widgets");
  const old = { ...fresh, own: { pos: 1, url: OWN } }; // stored before own.title existed
  const pages = [{ url: OWN, final_url: OWN, status: 200, indexable: 1, title: "Blue Widgets in Springfield | Example Widgets", h1: "Blue widgets", data: {} }];
  for (const serp of [fresh, old]) {
    const out = serpOpportunities([{ prompt: "blue widgets springfield", organic_pos: 1, serp }], pages, "https://example.com/", { brand: BRAND });
    const o = out.opportunities.find((x) => x.kind === "title_rewritten");
    assert.ok(o, "rewrite flagged");
    assert.match(o.detail, /Anatomy of a Search Result/);
    assert.equal(out.prompts[0].titleRewritten, true);
  }
  const same = serpOpportunities([{ prompt: "blue widgets", organic_pos: 1, serp: { ...fresh, own: { pos: 1, url: OWN, title: "Blue Widgets in Springfield…" } } }], pages, "https://example.com/", { brand: BRAND });
  assert.ok(!same.opportunities.some((x) => x.kind === "title_rewritten"), "truncation only");
});
