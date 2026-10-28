// Search Console history and rank tracker (REQ-055 group 4, items 1-3): incremental day-by-day storage with a 16-month
// window, target keyword rows by device and page, the tracker report and the rank alert feed. The Search Console client
// is mocked: no Google API or network call is made. Fixtures use example.com only. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, all, get } = await import("../src/db.mjs");
const { refreshHistory, missingRange, chunks, keywordRegexes, addDays, firstKept, historyState, HISTORY_DAYS } = await import("../src/gsc-history.mjs");
const { trackerReport, keywordDetail, setTags, cleanTags, rankAlerts, detectEvents, byDay, windowStats } = await import("../src/rank.mjs");
const { refresh } = await import("../src/gsc.mjs");

const HOME = "https://example.com/";
const PROP = "sc-domain:example.com";

/** Mock Search Console: every requested day gets two searches; target keyword requests answer per keyword in the regex. */
function mock({ failOn } = {}) {
  const calls = [];
  const call = async (urlPath, body) => {
    calls.push({ urlPath, body });
    if (failOn && failOn(body, calls)) throw new Error("backend error");
    if (urlPath === "sites") return { siteEntry: [{ siteUrl: PROP }] };
    if (!body || body.startRow > 0) return { rows: [] };
    const d = (body.dimensions || []).join(",");
    const days = []; for (let x = body.startDate; x <= body.endDate; x = addDays(x, 1)) days.push(x);
    if (d === "date,query") return { rows: days.flatMap((x) => [{ keys: [x, "blue widgets"], clicks: 1, impressions: 10, position: 4 }, { keys: [x, "widget shop"], clicks: 0, impressions: 3, position: 9 }]) };
    const re = body.dimensionFilterGroups?.[0]?.filters?.[0]?.expression;
    if (re) {
      const kws = re.replace(/^\^\(\?:|\)\$$/g, "").split("|").map((k) => k.replace(/\\(.)/g, "$1"));
      if (d === "date,query,device") return { rows: days.flatMap((x) => kws.map((k) => ({ keys: [x, k, "MOBILE"], clicks: 1, impressions: 5, position: 3 }))) };
      if (d === "date,query,page") return { rows: days.flatMap((x) => kws.map((k) => ({ keys: [x, k, HOME], clicks: 1, impressions: 5, position: 3 }))) };
    }
    return { rows: [] };
  };
  return { call, calls };
}

run("INSERT INTO projects (id, name, start_url, settings) VALUES (701, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ gscProperty: PROP, targetKeywords: "blue widgets\nred widgets" }));
const p701 = () => get("SELECT * FROM projects WHERE id=701");

test("date helpers: missing range, 30-day windows, exact-match regexes within the length limit", () => {
  assert.deepEqual(missingRange(null, "2026-10-20"), { startDate: firstKept("2026-10-20"), endDate: "2026-10-20" });
  assert.equal(firstKept("2026-10-20"), addDays("2026-10-20", -(HISTORY_DAYS - 1)));
  assert.deepEqual(missingRange("2026-10-18", "2026-10-20"), { startDate: "2026-10-19", endDate: "2026-10-20" });
  assert.equal(missingRange("2026-10-20", "2026-10-20"), null, "up to date: nothing to fetch");
  assert.equal(missingRange("2024-01-01", "2026-10-20").startDate, firstKept("2026-10-20"), "a very old 'through' never fetches beyond 16 months");
  const c = chunks({ startDate: "2026-01-01", endDate: "2026-03-01" }, 30);
  assert.deepEqual(c.map((x) => [x.startDate, x.endDate]), [["2026-01-01", "2026-01-30"], ["2026-01-31", "2026-03-01"]]);
  assert.deepEqual(keywordRegexes(["a.b widgets", "c+d"]), ["^(?:a\\.b widgets|c\\+d)$"]);
  const many = keywordRegexes(Array.from({ length: 200 }, (_, i) => `keyword number ${i} with some longer words`), 1000);
  assert.ok(many.length > 1 && many.every((r) => r.length <= 1000));
  assert.equal(many.join("").match(/keyword number/g).length, 200, "every keyword is in exactly one regex");
});

test("first refresh fetches 16 months in 30-day windows; the next only the new days, keeping the old rows", async () => {
  const { call, calls } = mock();
  const r = await refreshHistory(p701(), { call, property: PROP, endDate: "2026-10-20" });
  const qCalls = calls.filter((c) => c.body.dimensions.join() === "date,query");
  assert.equal(qCalls.length, Math.ceil(HISTORY_DAYS / 30));
  assert.equal(qCalls[0].body.startDate, firstKept("2026-10-20"));
  assert.ok(qCalls.every((c) => c.body.dataState === "final"));
  assert.equal(r.queriesThrough, "2026-10-20");
  assert.equal(get("SELECT COUNT(*) n FROM gsc_query_daily WHERE project_id=701").n, HISTORY_DAYS * 2);
  assert.equal(get("SELECT COUNT(DISTINCT query) n FROM gsc_kw_daily WHERE project_id=701").n, 2);
  assert.equal(get("SELECT device FROM gsc_kw_daily WHERE project_id=701 LIMIT 1").device, "mobile");

  const second = mock();
  await refreshHistory(p701(), { call: second.call, property: PROP, endDate: "2026-10-23" });
  const q2 = second.calls.filter((c) => c.body.dimensions.join() === "date,query");
  assert.deepEqual(q2.map((c) => [c.body.startDate, c.body.endDate]), [["2026-10-21", "2026-10-23"]], "only the 3 new days");
  const kw2 = second.calls.filter((c) => c.body.dimensions.join() === "date,query,device");
  assert.deepEqual(kw2.map((c) => c.body.startDate), ["2026-10-21"]);
  const span = get("SELECT MIN(date) first, MAX(date) last, COUNT(*) n FROM gsc_query_daily WHERE project_id=701");
  assert.deepEqual([span.first, span.last, span.n], [firstKept("2026-10-23"), "2026-10-23", HISTORY_DAYS * 2], "3 old days aged out, 3 new ones in");
});

test("a keyword added later gets its full history; the others only the new days", async () => {
  run("UPDATE projects SET settings=? WHERE id=701", JSON.stringify({ gscProperty: PROP, targetKeywords: "blue widgets\nred widgets\ngreen widgets" }));
  const { call, calls } = mock();
  await refreshHistory(p701(), { call, property: PROP, endDate: "2026-10-24" });
  const dev = calls.filter((c) => c.body.dimensions.join() === "date,query,device");
  const forGreen = dev.filter((c) => c.body.dimensionFilterGroups[0].filters[0].expression.includes("green"));
  assert.equal(forGreen[0].body.startDate, firstKept("2026-10-24"));
  assert.ok(forGreen.every((c) => !c.body.dimensionFilterGroups[0].filters[0].expression.includes("blue")), "known keywords are not refetched");
  assert.ok(dev.some((c) => c.body.startDate === "2026-10-24" && c.body.dimensionFilterGroups[0].filters[0].expression.includes("blue")));
  assert.deepEqual(historyState(701).keywords, ["blue widgets", "red widgets", "green widgets"]);
  assert.equal(get("SELECT COUNT(DISTINCT date) n FROM gsc_kw_daily WHERE project_id=701 AND query='green widgets'").n, HISTORY_DAYS);
});

test("a failing window keeps the progress so far and the next refresh continues from there", async () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (702, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ gscProperty: PROP }));
  const p = get("SELECT * FROM projects WHERE id=702");
  let n = 0;
  const bad = mock({ failOn: (body) => body.dimensions.join() === "date,query" && ++n === 3 });
  const r = await refreshHistory(p, { call: bad.call, property: PROP, endDate: "2026-10-20" });
  assert.equal(r.queryError, "backend error");
  const through = historyState(702).queriesThrough;
  assert.equal(through, addDays(firstKept("2026-10-20"), 59), "two windows of 30 days stored");
  const good = mock();
  await refreshHistory(p, { call: good.call, property: PROP, endDate: "2026-10-20" });
  assert.equal(good.calls.find((c) => c.body.dimensions.join() === "date,query").body.startDate, addDays(through, 1));
  assert.equal(historyState(702).queryError, null);
  assert.equal(get("SELECT COUNT(DISTINCT date) n FROM gsc_query_daily WHERE project_id=702").n, HISTORY_DAYS);
});

test("another property starts the history again rather than mixing two sites", async () => {
  const { call } = mock();
  await refreshHistory(get("SELECT * FROM projects WHERE id=702"), { call, property: "https://www.example.com/", endDate: "2026-10-20" });
  assert.equal(historyState(702).property, "https://www.example.com/");
  assert.equal(get("SELECT COUNT(*) n FROM gsc_query_daily WHERE project_id=702").n, HISTORY_DAYS * 2);
});

test("gsc refresh runs the history step after saving its own data (afterRefresh)", async () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (703, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ gscProperty: PROP }));
  const { call } = mock();
  const r = await refresh(get("SELECT * FROM projects WHERE id=703"), { call, fetchFn: async () => ({ ok: true, json: async () => [] }) });
  assert.ok(r.extra.history, "history step reported");
  assert.equal(r.extra.history.queryError, null);
  assert.ok(get("SELECT COUNT(*) n FROM gsc_query_daily WHERE project_id=703").n > 0);
});

// ---- Rank tracker and alerts, from seeded rows ----
const END = "2026-10-20";
function seed(id, keywords, series) {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (?, 'Example Widgets', ?, ?)", id, HOME, JSON.stringify({ targetKeywords: keywords.join("\n") }));
  run("INSERT INTO meta (key, value) VALUES (?, ?)", `gsc-history:${id}`, JSON.stringify({ property: PROP, keywords, keywordsThrough: END, queriesThrough: END }));
  for (const [kw, fn] of Object.entries(series)) for (let i = 0; i < 35; i++) {
    const date = addDays(END, -i), x = fn(i);
    if (!x) continue;
    for (const [device, share] of [["mobile", 0.6], ["desktop", 0.4]])
      run("INSERT INTO gsc_kw_daily (project_id, query, date, device, clicks, impressions, position) VALUES (?,?,?,?,?,?,?)", id, kw, date, device, 1, Math.round(x.impressions * share), x.position + (device === "desktop" ? 1 : 0));
    run("INSERT INTO gsc_kw_page_daily (project_id, query, date, page, clicks, impressions, position) VALUES (?,?,?,?,?,?,?)", id, kw, date, HOME + kw.split(" ")[0], 2, x.impressions, x.position);
    run("INSERT INTO gsc_query_daily (project_id, query, date, clicks, impressions, position) VALUES (?,?,?,?,?,?)", id, kw, date, 2, x.impressions, x.position);
  }
}
// i = days before END: 0-6 this week, 7-13 the week before.
seed(710, ["blue widgets", "red widgets", "green widgets", "rare widgets", "never widgets"], {
  "blue widgets": (i) => ({ impressions: 10, position: i < 7 ? 6 : 2 }),
  "red widgets": (i) => ({ impressions: 10, position: i < 7 ? 14 : 8 }),
  "green widgets": (i) => ({ impressions: 10, position: i < 7 ? 2 : 5 }),
  "rare widgets": (i) => (i % 7 === 0 ? { impressions: 1, position: i < 7 ? 30 : 2 } : null),
});
run("INSERT INTO gsc_query_daily (project_id, query, date, clicks, impressions, position) VALUES (710, 'blue widgets springfield', ?, 0, 40, 9)", END);

test("byDay and windowStats weight position by impressions", () => {
  const d = byDay([{ date: "2026-10-01", clicks: 1, impressions: 30, position: 2 }, { date: "2026-10-01", clicks: 0, impressions: 10, position: 6 }, { date: "2026-10-02", clicks: 0, impressions: 0, position: 0 }]);
  assert.deepEqual(d[0], { date: "2026-10-01", clicks: 1, impressions: 40, position: 3 });
  assert.equal(d[1].position, null, "no impressions, no position");
  assert.equal(windowStats(d, "2026-10-01", "2026-10-02").position, 3);
});

test("tracker: position, change vs 7 and 28 days, device split, best page, variants and honest 'no impressions'", () => {
  const t = trackerReport(710);
  assert.equal(t.connected, true);
  assert.equal(t.endDate, END);
  const k = Object.fromEntries(t.keywords.map((x) => [x.keyword, x]));
  const blue = k["blue widgets"];
  assert.equal(blue.status, "ranking");
  assert.ok(Math.abs(blue.position - 6.4) < 1e-9, "this week: mobile 6 (60%), desktop 7 (40%)");
  assert.ok(Math.abs(blue.change7 - 4) < 1e-9, "4 places worse than the week before");
  assert.ok(Math.abs(blue.change28 - 4) < 1e-9);
  assert.equal(blue.devices.mobile.impressions, 6 * 28);
  assert.equal(blue.devices.tablet.impressions, 0);
  assert.equal(blue.bestPage.page, HOME + "blue");
  assert.deepEqual(blue.variants, { impressions: 40, searches: 1 }, "searches containing all its words, the keyword itself excluded");
  assert.equal(k["never widgets"].status, "no-impressions");
  assert.equal(k["never widgets"].position, null);
  assert.equal(t.counts.noImpressions, 1);
  assert.equal(t.counts.tracked, 5);
});

test("tracker before any fetch: keywords listed as not fetched, nothing invented", () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (711, 'Example Widgets', ?, ?)", HOME, JSON.stringify({ targetKeywords: "blue widgets" }));
  const t = trackerReport(711);
  assert.equal(t.connected, false);
  assert.deepEqual(t.keywords.map((k) => k.status), ["not-fetched"]);
});

test("keyword detail: whole history per day and per device, pages", () => {
  const d = keywordDetail(710, "Blue Widgets");
  assert.equal(d.keyword, "blue widgets");
  assert.equal(d.days.length, 35);
  assert.equal(d.devices.desktop.length, 35);
  assert.equal(d.pages28[0].page, HOME + "blue");
});

test("tags: cleaned, saved per keyword, shown in the report; empty removes them", () => {
  assert.deepEqual(cleanTags(" Local, Brakes ,local,, "), ["local", "brakes"]);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 10);
  setTags(710, { keyword: "blue widgets", tags: "Local, money" });
  const t = trackerReport(710);
  assert.deepEqual(t.keywords.find((k) => k.keyword === "blue widgets").tags, ["local", "money"]);
  assert.deepEqual(t.tags, ["local", "money"]);
  setTags(710, { keyword: "blue widgets", tags: "" });
  assert.deepEqual(trackerReport(710).tags, []);
  assert.throws(() => setTags(710, { keyword: " " }), /Keyword missing/);
});

test("alert feed: drops of 3+ places, lost top 10, new top 3; too few impressions are not judged", () => {
  const a = rankAlerts(710);
  assert.equal(a.threshold, 3);
  assert.equal(a.minImpressions, 10);
  const target = a.events.filter((e) => e.source === "target");
  const ids = target.map((e) => `${e.type}:${e.keyword}`).sort();
  assert.deepEqual(ids, ["drop:blue widgets", "drop:red widgets", "lost_top10:red widgets", "new_top3:green widgets"]);
  const drop = target.find((e) => e.type === "drop" && e.keyword === "blue widgets");
  assert.equal(drop.id, `drop:blue widgets:${END}`, "stable id for de-duplication");
  assert.equal(drop.severity, "warning");
  assert.deepEqual(drop.window.current, { startDate: addDays(END, -6), endDate: END });
  assert.ok(!target.some((e) => e.keyword === "rare widgets"), "1 impression a week: not enough to judge");
  // The same searches from all-search history (source "top") only when they are not targets.
  assert.ok(!a.events.some((e) => e.source === "top" && e.keyword === "blue widgets"));
  assert.equal(rankAlerts(710, { threshold: 5 }).events.filter((e) => e.type === "drop" && e.source === "target").length, 1, "threshold is configurable");
});

test("detectEvents: a keyword that vanished from the top 10 counts as lost; no end date, no events", () => {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays("2026-10-13", -i), clicks: 1, impressions: 5, position: 4 }));
  const ev = detectEvents([{ keyword: "x widgets", source: "target", days }], { endDate: "2026-10-20" });
  assert.deepEqual(ev.map((e) => [e.type, e.to]), [["lost_top10", null]]);
  assert.deepEqual(detectEvents([{ keyword: "x", days }], {}), []);
});

test("a project without history returns an empty feed, not an error", () => {
  assert.deepEqual(rankAlerts(711).events, []);
});
