// Rank tracker, Search Console explorer, and the sitemaps / Discover and News / scheduled inspection cards on the
// Search Console screen (REQ-055 group 4: src/rank.mjs, gsc-explorer.mjs, gsc-sitemaps.mjs, gsc-discover.mjs,
// index-rotation.mjs). Text only, never innerHTML: keywords and URLs come from Google and the site.
import { h, api, toast, num, pct, shortUrl, lineChart, table, mount } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "search") + 1, 0, { view: "rank", label: "Rank tracker" }, { view: "explorer", label: "GSC explorer" });

const pos = (p) => (p === null || p === undefined ? "–" : p.toFixed(1));
const fmtDay = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });
const local = (s) => (s ? new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").toLocaleString("en-AU") : "–");
/** Position change: positive = worse (a bigger number), shown as "▼ 2.3" in the "down" colour. */
const change = (d) => (d === null || d === undefined ? h("span", { class: "muted" }, "–")
  : Math.abs(d) < 0.05 ? h("span", { class: "muted" }, "0") : h("span", { class: d > 0 ? "down" : "up", title: d > 0 ? "worse" : "better" }, `${d > 0 ? "▼" : "▲"} ${Math.abs(d).toFixed(1)}`));
const tile = (k, v, sub) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v), sub ? h("div", { class: "small muted" }, sub) : null);
const tagBadges = (tags) => (tags || []).map((t) => h("span", { class: "badge", style: { marginLeft: "4px" } }, t));
const EVENT = { drop: ["warning", "Dropped"], lost_top10: ["error", "Left the top 10"], new_top3: ["fixed", "New in the top 3"] };
const STATUS = { "no-impressions": "No impressions", "not-fetched": "Not fetched yet" };

// ---------- Rank tracker ----------
async function keywordDrawer(ctx, k) {
  const pid = ctx.project.id, base = ctx.project.start_url;
  const d = await api(`/api/projects/${pid}/rank/keyword?k=${encodeURIComponent(k)}`);
  const tags = h("input", { type: "text", value: d.tags.join(", "), placeholder: "e.g. local, brakes", style: { width: "240px" } });
  const saveTags = h("form", { class: "row", onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${pid}/rank/tags`, { method: "PUT", body: { keyword: d.keyword, tags: tags.value } }); toast("Tags saved"); ctx.app.refresh(); } catch (err) { toast(err.message); }
  } }, tags, h("button", { class: "btn small" }, "Save tags"));
  const seen = d.days.filter((x) => x.position !== null);
  const devLine = (dv) => d.devices[dv].filter((x) => x.position !== null).map((x) => ({ x: fmtDay(x.date), y: x.position, sub: `${num(x.impressions)} impressions` }));
  ctx.app.openDrawer(h("h2", { style: { paddingRight: "90px" } }, d.keyword),
    h("p", { class: "small muted" }, d.endDate ? `Search Console data up to ${d.endDate}, ${d.days.length} days with impressions.` : "Not fetched yet."), saveTags,
    seen.length ? [
      h("h3", {}, "Average position per day (lower is better)"),
      lineChart(seen.map((x) => ({ x: fmtDay(x.date), y: x.position, sub: `${num(x.impressions)} impressions, ${num(x.clicks)} clicks` })), { max: null, fmt: (v) => v, label: "Average position per day" }),
      h("h3", {}, "Clicks per day"), lineChart(d.days.map((x) => ({ x: fmtDay(x.date), y: x.clicks })), { max: null, fmt: num, label: "Clicks per day" }),
      h("h3", {}, "Impressions per day"), lineChart(d.days.map((x) => ({ x: fmtDay(x.date), y: x.impressions })), { max: null, fmt: num, label: "Impressions per day" }),
      ...["mobile", "desktop"].filter((dv) => devLine(dv).length).flatMap((dv) => [h("h3", {}, `Position on ${dv}`), lineChart(devLine(dv), { max: null, label: `Position on ${dv}` })]),
      h("h3", {}, "Pages shown for it (last 28 days)"),
      table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.page, base) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) },
        { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Pos.", num: true, get: (r) => pos(r.position) }], d.pages28, { empty: "No page had impressions for it in the last 28 days." }),
      d.pagesAll.length > d.pages28.length ? h("details", {}, h("summary", { class: "small" }, `All pages over the stored history (${d.pagesAll.length})`),
        table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.page, base) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) },
          { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Pos.", num: true, get: (r) => pos(r.position) }], d.pagesAll)) : null]
      : h("p", {}, "Search Console has no impressions for this exact search in the stored history. It only reports searches someone made and saw your site for; rare searches are also left out for privacy."));
}

function alertsCard(a, base) {
  const ev = a.events || [];
  return h("div", { class: "card" }, h("h2", {}, `Rank changes (${ev.length})`),
    h("p", { class: "hint" }, `The 7 days up to ${a.endDate || "the latest data"} against the 7 before, for your target keywords and your 100 searches with the most impressions. `,
      `A drop is an average position ${a.threshold}+ places worse with at least ${a.minImpressions} impressions in each week (this tool's thresholds, changeable below). `,
      "Average position moves with personalisation, location and new search features, so look at a week, not a day."),
    table([{ label: "Change", get: (r) => h("span", { class: `badge ${EVENT[r.type][0]}` }, EVENT[r.type][1]) },
      { label: "Search", get: (r) => h("span", {}, r.keyword, r.source === "top" ? h("span", { class: "small muted" }, " (top search)") : null) },
      { label: "Position", get: (r) => `${pos(r.from)} → ${r.to === null ? "no impressions" : pos(r.to)}` },
      { label: "Impressions", num: true, get: (r) => `${num(r.impressions.previous)} → ${num(r.impressions.current)}` },
      { label: "Clicks", num: true, get: (r) => `${num(r.clicks.previous)} → ${num(r.clicks.current)}` }], ev, { empty: "No drops, lost top-10 places or new top-3 places this week." }));
}

VIEWS.rank = async (ctx) => {
  const pid = ctx.project.id, base = ctx.project.start_url;
  const [t, alerts] = await Promise.all([api(`/api/projects/${pid}/rank`), api(`/api/projects/${pid}/rank/alerts`)]);
  const intro = h("p", { class: "hint" }, "Built from Search Console, so it costs nothing: Google's average position for each exact search (the site's highest result, averaged over impressions), not a live ranking check from one place. ",
    "History is kept for 16 months and updated with each Search Console refresh (only the new days are fetched). A search with no impressions has no position.");
  if (!t.configured) return h("div", { class: "card" }, h("h2", {}, "Rank tracker"), intro,
    h("p", {}, "Add the searches you want to track under ", h("a", { href: `#/p/${pid}/settings` }, "Settings → Target keywords"), " (one per line, up to 200), then refresh Search Console."));
  const head = h("div", { class: "card" }, h("h2", {}, "Rank tracker"), intro,
    t.connected ? h("p", { class: "small" }, `Data up to ${t.endDate}. Position and changes: average of the last 7 days; clicks and impressions: last 28 days.`, t.error ? ` The last keyword refresh failed (${t.error}); showing stored data.` : "")
      : h("p", { class: "small" }, "Not fetched yet: press Refresh on the ", h("a", { href: `#/p/${pid}/search` }, "Search Console"), " screen."),
    t.counts ? h("div", { class: "grid g4" }, tile("Tracked", num(t.counts.tracked)), tile("With impressions (28 d)", num(t.counts.withImpressions)),
      tile("Top 3 / top 10 (7 d)", `${num(t.counts.top3)} / ${num(t.counts.top10)}`), tile("No impressions", num(t.counts.noImpressions))) : null);

  const thr = h("input", { type: "number", min: 1, max: 50, value: t.threshold, style: { width: "70px" } });
  const minI = h("input", { type: "number", min: 1, value: t.minImpressions, style: { width: "80px" } });
  const thresholds = h("form", { class: "row small", onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${pid}`, { method: "PUT", body: { settings: { rankDropThreshold: Number(thr.value), rankMinImpressions: Number(minI.value) } } }); toast("Saved"); ctx.app.refresh(); } catch (err) { toast(err.message); }
  } }, "Alert when a search drops", thr, "places or more, with at least", minI, "impressions a week", h("button", { class: "btn small" }, "Save"));

  const filterTag = h("select", { "aria-label": "Filter by tag" }, h("option", { value: "" }, "All tags"), t.tags.map((x) => h("option", { value: x }, x)));
  const search = h("input", { type: "search", placeholder: "Filter keywords", style: { width: "200px" } });
  const box = h("div", {});
  const draw = () => {
    const tag = filterTag.value, q = search.value.trim().toLowerCase();
    const rows = t.keywords.filter((k) => (!tag || k.tags.includes(tag)) && (!q || k.keyword.includes(q)));
    mount(box, table([
      { label: "Keyword", get: (r) => h("span", {}, r.keyword, tagBadges(r.tags)) },
      { label: "Position", num: true, get: (r) => (r.status === "ranking" ? pos(r.position) : h("span", { class: "muted small" }, STATUS[r.status] || "–")) },
      { label: "vs 7 days", num: true, get: (r) => change(r.change7) }, { label: "vs 28 days", num: true, get: (r) => change(r.change28) },
      { label: "Clicks", num: true, get: (r) => num(r.d28?.clicks) }, { label: "Impr.", num: true, get: (r) => num(r.d28?.impressions) },
      { label: "Mobile (28 d)", num: true, get: (r) => pos(r.devices?.mobile.position) }, { label: "Desktop (28 d)", num: true, get: (r) => pos(r.devices?.desktop.position) },
      { label: "Best page", cls: "url", get: (r) => (r.bestPage ? h("span", { title: r.pages > 1 ? `${r.pages} pages shown for it` : "" }, shortUrl(r.bestPage.page, base), r.pages > 1 ? h("span", { class: "small muted" }, ` +${r.pages - 1}`) : null)
        : r.variants?.impressions ? h("span", { class: "small muted", title: "Searches containing all its words" }, `${num(r.variants.impressions)} impr. on ${r.variants.searches} similar searches`) : "–") },
    ], rows, { onRow: (r) => keywordDrawer(ctx, r.keyword).catch((e) => toast(e.message)), empty: "No keyword matches the filter." }));
  };
  filterTag.onchange = draw; search.oninput = draw; draw();
  return [head, alertsCard(alerts, base),
    h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Keywords"), h("div", { class: "row" }, search, filterTag)),
      h("p", { class: "hint" }, "Click a keyword for its charts over time, mobile vs desktop, its pages and tags. Change arrows: ▲ better, ▼ worse (7-day average position against the 7 days ending 7 or 28 days earlier). ",
        "\"No impressions\" means Search Console reported no impressions for that exact search in 28 days; similar searches containing all its words are shown when there are some."),
      box),
    h("div", { class: "card" }, h("h2", {}, "Alert thresholds"), thresholds)];
};

// ---------- GSC explorer ----------
const OPS = [["contains", "contains"], ["notContains", "doesn't contain"], ["equals", "is exactly"], ["notEquals", "is not"], ["includingRegex", "matches regex"], ["excludingRegex", "doesn't match regex"]];
VIEWS.explorer = async (ctx) => {
  const pid = ctx.project.id, base = ctx.project.start_url;
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  const end = day(Date.now() - 3 * 864e5);
  const f = {
    startDate: h("input", { type: "date", value: day(Date.parse(end) - 27 * 864e5) }), endDate: h("input", { type: "date", value: end }),
    type: h("select", {}, [["web", "Web"], ["image", "Image"], ["video", "Video"], ["news", "News tab"], ["discover", "Discover"], ["googleNews", "Google News"]].map(([v, l]) => h("option", { value: v }, l))),
    qOp: h("select", {}, OPS.map(([v, l]) => h("option", { value: v }, l))), qVal: h("input", { type: "text", placeholder: "search words or regex" }),
    pOp: h("select", {}, OPS.map(([v, l]) => h("option", { value: v }, l))), pVal: h("input", { type: "text", placeholder: "/blog/ or regex" }),
    country: h("input", { type: "text", placeholder: "e.g. aus", maxLength: 3, style: { width: "70px" } }),
    device: h("select", {}, [["", "Any device"], ["mobile", "Mobile"], ["desktop", "Desktop"], ["tablet", "Tablet"]].map(([v, l]) => h("option", { value: v }, l))),
    limit: h("input", { type: "number", min: 1, max: 100000, value: 1000, style: { width: "90px" } }),
  };
  const dims = Object.fromEntries(["query", "page", "country", "device", "date"].map((d) => [d, h("input", { type: "checkbox", checked: d === "query" })]));
  const input = () => ({ startDate: f.startDate.value, endDate: f.endDate.value, type: f.type.value, dimensions: Object.keys(dims).filter((d) => dims[d].checked),
    query: f.qVal.value ? { operator: f.qOp.value, value: f.qVal.value } : undefined, page: f.pVal.value ? { operator: f.pOp.value, value: f.pVal.value } : undefined,
    country: f.country.value.trim() || undefined, device: f.device.value || undefined, limit: Number(f.limit.value) || 1000 });
  const out = h("div", {});
  const runIt = async (e) => {
    e?.preventDefault();
    mount(out, h("p", { class: "muted" }, "Asking Search Console…"));
    try {
      const r = await api(`/api/projects/${pid}/gsc/explore`, { method: "POST", body: input() });
      const sum = r.rows.reduce((a, x) => ({ clicks: a.clicks + x.clicks, impressions: a.impressions + x.impressions }), { clicks: 0, impressions: 0 });
      const shown = r.rows.slice(0, 1000);
      const cols = r.columns.map((c) => ({ label: c, num: ["clicks", "impressions", "ctr", "position"].includes(c), cls: c === "page" ? "url" : "",
        get: (x) => (c === "ctr" ? pct(x.ctr) : c === "position" ? pos(x.position) : c === "page" ? shortUrl(x.page, base) : ["clicks", "impressions"].includes(c) ? num(x[c]) : x[c]) }));
      mount(out, h("p", { class: "small" }, `${r.property} · ${r.request.startDate} → ${r.request.endDate} · ${num(r.rows.length)} rows${r.truncated ? " (row limit reached; raise it or narrow the filters)" : ""} · `,
        `${num(sum.clicks)} clicks, ${num(sum.impressions)} impressions in these rows. Search Console leaves out rare searches for privacy, so row totals can be lower than the report's total.`),
        table(cols, shown, { empty: "No rows: nothing matched these filters in this period." }),
        r.rows.length > shown.length ? h("p", { class: "small muted" }, `Showing the first 1,000 rows; the CSV has all ${num(r.rows.length)}.`) : null);
    } catch (err) { mount(out, h("p", { class: "down" }, err.message)); }
  };
  const csv = async () => {
    try {
      const res = await fetch(`/api/projects/${pid}/gsc/explore.csv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: `search-console-${f.startDate.value}-${f.endDate.value}.csv` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { toast(err.message); }
  };
  const lbl = (text, ...el) => h("label", { class: "row small", style: { gap: "6px" } }, text, ...el);
  return [h("form", { class: "card", onsubmit: runIt }, h("h2", {}, "Search Console explorer"),
    h("p", { class: "hint" }, "Asks Search Console's Performance data live, with any filter. Regex uses Google's RE2 syntax (no lookaheads). Discover and Google News report no searches and no position. Data is final data only, so the last 2–3 days are missing."),
    h("div", { class: "row", style: { flexWrap: "wrap", gap: "12px" } }, lbl("From", f.startDate), lbl("To", f.endDate), lbl("Type", f.type), lbl("Rows", f.limit)),
    h("div", { class: "row", style: { flexWrap: "wrap", gap: "12px", marginTop: "8px" } }, lbl("Search", f.qOp, f.qVal), lbl("Page", f.pOp, f.pVal), lbl("Country", f.country), f.device),
    h("div", { class: "row small", style: { flexWrap: "wrap", gap: "12px", marginTop: "8px" } }, "Group by:", Object.entries(dims).map(([d, el]) => lbl(d, el))),
    h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "btn primary" }, "Run"), h("button", { class: "btn", type: "button", onclick: csv }, "Download CSV"))),
    h("div", { class: "card" }, out)];
};

// ---------- Search Console screen: sitemaps, Discover / News, scheduled inspection ----------
async function sitemapsCard(ctx) {
  const d = await api(`/api/projects/${ctx.project.id}/gsc/sitemaps`);
  const card = (...kids) => h("div", { class: "card" }, h("h2", {}, `Sitemaps in Search Console (${d.sitemaps.length})`), ...kids);
  if (!d.fetched) return card(h("p", { class: "hint" }, d.error ? `Could not read sitemaps: ${d.error}` : "Fetched with the next Search Console refresh."));
  const ins = d.inspection;
  return card(h("p", { class: "hint" }, `Submitted sitemaps, when Google last read them and their errors and warnings (Search Console Sitemaps API, fetched ${local(d.fetchedAt)}). `,
      "Google no longer gives an indexed count per sitemap, so none is shown; open the Page indexing report filtered by sitemap in Search Console for that.", d.error ? ` The last refresh failed (${d.error}); showing the previous list.` : ""),
    h("div", { class: "grid g4" }, tile("Sitemaps", num(d.totals.sitemaps)), tile("Web URLs submitted", num(d.totals.submitted)), tile("Errors", num(d.totals.errors)), tile("Warnings", num(d.totals.warnings))),
    ins ? h("p", { class: "small" }, `Of the ${num(ins.sitemapPages)} sitemap pages in the latest audit, this tool's URL Inspection checked ${num(ins.inspected)}: ${num(ins.indexed)} indexed.`) : null,
    table([{ label: "Sitemap", cls: "url", get: (r) => h("span", {}, r.parent ? "↳ " : "", shortUrl(r.path, ctx.project.start_url), r.isIndex ? h("span", { class: "badge", style: { marginLeft: "4px" } }, "index") : null) },
      { label: "Last read", get: (r) => (r.lastDownloaded ? local(r.lastDownloaded) : "never") }, { label: "Submitted", get: (r) => local(r.lastSubmitted) },
      { label: "URLs", num: true, get: (r) => r.contents.map((c) => `${num(c.submitted)}${c.type === "web" ? "" : " " + c.type}`).join(", ") || "–" },
      { label: "Problems", get: (r) => (r.problems.length ? h("span", { class: "down small" }, r.problems.join(", ")) : h("span", { class: "up small" }, "none")) }], d.sitemaps,
    { empty: "No sitemap is submitted for this property. Submit one in Search Console → Sitemaps, and list it in robots.txt." }));
}

async function typesCard(ctx) {
  const d = await api(`/api/projects/${ctx.project.id}/gsc/types`);
  const base = ctx.project.start_url;
  return h("div", { class: "card" }, h("h2", {}, "Discover and Google News"),
    h("p", { class: "hint" }, "Kept apart from Search: Discover is the feed in the Google app and on phones; Google News is news.google.com and the News app. Both report clicks, impressions and CTR only (no searches, no position), ",
      "and Search Console shows them only once a site has enough impressions there."),
    d.types.map((t) => h("div", { style: { marginTop: "10px" } }, h("h3", {}, t.label),
      !t.fetched ? h("p", { class: "small muted" }, t.error ? `Could not fetch: ${t.error}` : "Fetched with the next Search Console refresh.")
        : !t.hasData ? h("p", { class: "small muted" }, `No ${t.label} data for this property in the last 16 months.`)
          : [h("div", { class: "grid g4" }, tile("Clicks (28 d)", num(t.last28.clicks), `28 days before: ${num(t.prev28.clicks)}`), tile("Impressions (28 d)", num(t.last28.impressions), `28 days before: ${num(t.prev28.impressions)}`),
            tile("CTR (28 d)", pct(t.last28.ctr)), tile("Data up to", t.endDate || "–")),
          lineChart(t.days.map((x) => ({ x: fmtDay(x.date), y: x.clicks, sub: `${num(x.impressions)} impressions` })), { max: null, fmt: num, label: `${t.label} clicks per day` }),
          h("details", {}, h("summary", { class: "small" }, `Pages (last 28 days, ${t.pages.length})`),
            table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.page, base) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) }, { label: "Impr.", num: true, get: (r) => num(r.impressions) }], t.pages)),
          t.error ? h("p", { class: "small" }, `The last refresh failed (${t.error}); showing the previous data.`) : null])));
}

const KIND = { indexed: "Indexed", crawled: "Crawled, not indexed", discovered: "Discovered, not crawled", unknown: "Unknown to Google", duplicate: "Duplicate", alternate: "Alternate", noindex: "noindex",
  redirect: "Redirect", soft404: "Soft 404", notfound: "404", blocked: "Blocked by robots.txt", server: "Server error", indexed_blocked: "Indexed, though blocked", indexed_no_content: "Indexed without content", other: "Other" };
async function rotationCard(ctx) {
  const pid = ctx.project.id, base = ctx.project.start_url;
  const d = await api(`/api/projects/${pid}/index-rotation`);
  const n = h("input", { type: "number", min: 0, max: d.maxPerDay, value: d.perDay, style: { width: "90px" } });
  const form = h("form", { class: "row small", onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${pid}/index-rotation`, { method: "PUT", body: { perDay: Number(n.value) } }); toast("Saved"); ctx.app.refresh(); } catch (err) { toast(err.message); }
  } }, "Inspect", n, `pages a day (0 = off, at most ${num(d.maxPerDay)})`, h("button", { class: "btn small" }, "Save"));
  const history = async (url) => {
    const rows = await api(`/api/projects/${pid}/index-history?url=${encodeURIComponent(url)}`);
    ctx.app.openDrawer(h("h2", { style: { paddingRight: "90px" } }, shortUrl(url, base)), h("p", { class: "small muted" }, "Each change of Google's verdict, reason or chosen canonical, with the inspection that first saw it."),
      table([{ label: "Seen", get: (r) => local(r.inspected_at) }, { label: "Google says", get: (r) => r.coverage || KIND[r.kind] }, { label: "Google's canonical", cls: "url", get: (r) => (r.google_canonical ? shortUrl(r.google_canonical, base) : "–") }], rows));
  };
  return h("div", { class: "card" }, h("h2", {}, "Scheduled index checks"),
    h("p", { class: "hint" }, `Google's URL Inspection API allows ${num(d.dailyQuota)} inspections a day per property. With a daily number set, the app checks the indexable pages of the latest audit in turn (never-checked first, then the longest-unchecked) `,
      "while it is running, keeping the last 24 hours under that number, manual checks included. Every change of index status is kept, so you can see when a page dropped out or came back."),
    form,
    h("div", { class: "grid g4", style: { marginTop: "8px" } }, tile("Checked in 24 h", num(d.used24h)), tile("Pages to cover", num(d.pages), d.cycleDays ? `a full round every ${d.cycleDays} day${d.cycleDays === 1 ? "" : "s"}` : "scheduled checks off"),
      tile("Never checked", num(d.neverInspected)), tile("Checked in 30 days", num(d.inspected30d), d.oldest ? `oldest check ${local(d.oldest)}` : null)),
    h("h3", { style: { marginTop: "10px" } }, `Index status changes, last 30 days (${d.changes.length})`),
    table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.url, base) },
      { label: "Change", get: (r) => h("span", { class: r.lost ? "down" : r.gained ? "up" : "" }, `${KIND[r.from.kind] || r.from.kind} → ${KIND[r.to.kind] || r.to.kind}`) },
      { label: "When", get: (r) => local(r.at) }], d.changes, { onRow: (r) => history(r.url).catch((e) => toast(e.message)), empty: "No page changed index status in the last 30 days (or it hasn't been checked twice yet)." }));
}

const searchView = VIEWS.search;
VIEWS.search = async (ctx) => {
  const base = await searchView(ctx);
  const safe = (fn, title) => fn(ctx).catch((e) => h("div", { class: "card" }, h("h2", {}, title), h("p", { class: "hint" }, e.message)));
  const [rot, maps, types] = await Promise.all([safe(rotationCard, "Scheduled index checks"), safe(sitemapsCard, "Sitemaps in Search Console"), safe(typesCard, "Discover and Google News")]);
  return [...[base].flat(), rot, maps, types];
};
