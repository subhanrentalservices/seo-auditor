// Data screens: Search Console now; keywords, backlinks, AI visibility and report are added below by T11–T13.
import { h, api, toast, num, shortUrl, lineChart, table } from "./core.js";
import { VIEWS, NAV, overviewCards } from "./views.js";

const at = (view) => NAV.findIndex((n) => n.view === view);
NAV.splice(at("history"), 0, { section: "Search data" }, { view: "search", label: "Search Console" });

const pos = (p) => (p === null || p === undefined ? "–" : p.toFixed(1));
const brandTag = (r) => (r.brand ? h("span", { class: "badge", title: "Contains your brand name" }, "brand") : null);
const fmtDay = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });

async function gscRefresh(ctx, btn) {
  btn.disabled = true; btn.textContent = "Fetching…";
  try { const r = await api(`/api/projects/${ctx.project.id}/gsc`, { method: "POST", body: {} }); toast(`Search Console: ${r.pages} pages, ${r.queries} query rows`); ctx.app.refresh(); }
  catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Fetch now"; }
}

const KIND_LABEL = { unknown: "Unknown to Google", discovered: "Discovered, not crawled", crawled: "Crawled, not indexed", duplicate: "Duplicate (Google chose another URL)",
  alternate: "Alternate with canonical", noindex: "noindex", redirect: "Redirect", soft404: "Soft 404", notfound: "404", blocked: "Blocked by robots.txt", server: "Server error", other: "Other" };

// Index status: URL Inspection for every page the audit found indexable; the not-indexed ones grouped with a fix each.
async function indexCard(ctx) {
  const pid = ctx.project.id, base = ctx.project.start_url;
  const d = await api(`/api/projects/${pid}/indexing`);
  const btn = h("button", { class: "btn", disabled: d.running || !d.pending }, d.running ? "Checking…" : `Check ${d.pending} pages`);
  const poll = () => setTimeout(async () => { const x = await api(`/api/projects/${pid}/indexing`).catch(() => null); if (x?.running) poll(); else ctx.app.refresh(); }, 3000);
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Checking…";
    try { const r = await api(`/api/projects/${pid}/indexing`, { method: "POST", body: {} }); toast(`Inspecting ${r.urls} pages…`); poll(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = `Check ${d.pending} pages`; }
  };
  if (d.running) poll();
  const last = d.lastRun;
  const byKind = (a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url);
  const bad = d.rows.filter((r) => !r.error && r.wanted && r.kind !== "indexed").sort(byKind);
  const expected = d.rows.filter((r) => !r.error && !r.wanted && r.kind !== "indexed").sort(byKind);
  const stray = d.rows.filter((r) => !r.error && !r.wanted && r.kind === "indexed");
  const tile = (k, v) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v));
  return h("div", { class: "card" },
    h("div", { class: "card-h" }, h("h2", {}, "Index status"), btn),
    h("p", { class: "hint" }, "Asks Google (URL Inspection) about every HTML page in the latest audit. Pages your site wants indexed (200 and indexable) are counted; ",
      "the rest (canonical pointing elsewhere, noindex, redirects) should stay out of Google and are listed as expected. Search Console's \"not indexed\" count also includes old URLs nothing links to any more. ",
      last ? `Last check ${new Date(last.started_at.replace(" ", "T") + "Z").toLocaleString("en-AU")}${last.status === "stopped" ? " (stopped: daily inspection limit)" : ""}.` : "Not checked yet."),
    d.total ? h("div", { class: "grid g4" }, tile("Pages to index", num(d.total)), tile("Indexed", num(d.indexed)), tile("Not indexed (to fix)", num(d.notIndexed)), tile("Expected out of Google", num(d.expected))) : null,
    stray.length ? h("p", { class: "small" }, `Indexed although your site keeps them out (canonical elsewhere, noindex or redirect): ${stray.map((r) => shortUrl(r.url, base)).join(", ")}. Check the canonical and links.`) : null,
    d.errors ? h("p", { class: "small" }, `${d.errors} pages could not be checked: ${d.rows.filter((r) => r.error)[0].error}`) : null,
    bad.length ? table([
      { label: "Page", cls: "url", get: (r) => shortUrl(r.url, base) },
      { label: "Google says", get: (r) => h("span", { title: r.coverage || "" }, KIND_LABEL[r.kind] || r.coverage) },
      { label: "Last crawl", get: (r) => (r.last_crawl ? new Date(r.last_crawl).toLocaleDateString("en-AU") : "never") },
      { label: "What to do", get: (r) => h("span", { class: "small" }, r.advice, r.google_canonical && r.google_canonical !== r.url ? h("div", { class: "small" }, "Google's canonical: ", shortUrl(r.google_canonical, base)) : null) },
    ], bad) : d.total ? h("p", {}, "Every page you want in Google is indexed.") : null,
    expected.length ? h("details", {}, h("summary", { class: "small" }, `Expected out of Google (${expected.length})`),
      table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.url, base) }, { label: "Google says", get: (r) => r.coverage || KIND_LABEL[r.kind] }], expected)) : null);
}

// Content decay (pages losing clicks vs the 28 days before and vs last year) and indexable pages Google shows for nothing.
const CAUSE = { gone: "Dropped out", rank: "Ranks lower", demand: "Fewer searches", ctr: "Fewer clicks per view", seasonal: "Seasonal" };
async function decayCards(ctx) {
  const d = await api(`/api/projects/${ctx.project.id}/decay`);
  const base = ctx.project.start_url;
  const delta = (x) => (x ? h("span", { title: `${num(x.clicksThen)} clicks then, position ${pos(x.positionThen)}` }, `−${num(x.lost)} (${Math.round(x.pct * 100)}%)`) : "–");
  const refetch = !d.prevWindow ? h("p", { class: "small" }, "Press Refresh above once: comparison windows are fetched with the next Search Console refresh.") : null;
  return [h("div", { class: "card" }, h("h2", {}, `Content decay (${d.decaying.filter((r) => !r.seasonal).length})`),
    h("p", { class: "hint" }, "Pages that lost at least 30% of their clicks (and 5 or more) against the 28 days before",
      d.hasYoy ? " or the same 28 days last year" : "", ". Refresh the top of this list first: it's traffic you already earned. ",
      d.prevWindow ? `Compared windows: ${d.prevWindow}${d.yoyWindow ? ` and ${d.yoyWindow}` : ""}.` : ""), refetch,
    table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.url, base) }, { label: "Clicks now", num: true, get: (r) => num(r.clicks) },
      { label: "vs prior 28 days", num: true, get: (r) => delta(r.vsPrev) }, { label: "vs last year", num: true, get: (r) => delta(r.vsYear) },
      { label: "Likely cause", get: (r) => h("span", { class: `badge ${r.seasonal ? "notice" : "warning"}` }, CAUSE[r.cause]) },
      { label: "What to do", get: (r) => h("span", { class: "small" }, r.advice) }], d.decaying, { empty: "No page lost a meaningful share of its clicks." })),
  h("div", { class: "card" }, h("h2", {}, `Pages Google shows for nothing (${d.invisible.length})`),
    h("p", { class: "hint" }, "Indexable pages from the latest audit with no impressions in 56 days. Give each one a clear search to answer, merge it into a stronger page (with a 301), or keep it out of the index if it isn't meant for search. Pages under 30 days old may just need time."),
    table([{ label: "Page", cls: "url", get: (r) => h("span", {}, shortUrl(r.url, base), r.isNew ? h("span", { class: "badge new", style: { marginLeft: "6px" } }, "new") : null) },
      { label: "Title", get: (r) => h("span", { class: "small" }, r.title || "–") }, { label: "Words", num: true, get: (r) => num(r.words) }, { label: "Internal links in", num: true, get: (r) => num(r.inlinks) }],
      d.invisible, { empty: d.connected ? "Every indexable page got impressions." : "Fetch Search Console data first." }),
    d.expected.length ? h("p", { class: "small" }, `Also without impressions, as expected (contact, legal, account pages): ${d.expected.map((r) => shortUrl(r.url, base)).join(", ")}.`) : null)];
}

VIEWS.search = async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/gsc`);
  const btn = h("button", { class: "btn", onclick: () => gscRefresh(ctx, btn) }, d.connected ? "Refresh" : "Fetch now");
  const head = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Google Search Console"), btn),
    h("p", { class: "hint", style: { margin: 0 } }, d.connected ? `${d.property} · ${d.startDate} → ${d.endDate} (last 28 days of final data) · fetched ${new Date(d.fetchedAt).toLocaleString("en-AU")}`
      : "Not fetched yet. The service account must be added as a user on the property in Search Console (Settings → Users and permissions). The property is detected from the site URL, or set it in Settings."));
  const index = await indexCard(ctx).catch((e) => h("div", { class: "card" }, h("h2", {}, "Index status"), h("p", { class: "hint" }, e.message)));
  if (!d.connected) return [head, index];
  const decay = await decayCards(ctx).catch((e) => h("div", { class: "card" }, h("h2", {}, "Content decay"), h("p", { class: "hint" }, e.message)));
  const base = ctx.project.start_url, t = d.totals;
  const tile = (k, v) => h("div", { class: "card stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  return [head, index,
    h("div", { class: "grid g4" }, tile("Clicks", num(t.clicks)), tile("Impressions", num(t.impressions)), tile("CTR", `${((t.ctr || 0) * 100).toFixed(2)}%`), tile("Average position", pos(t.position))),
    h("div", { class: "grid g4" }, tile("Keywords with impressions", num(d.keywords)), tile("Keywords in top 3", num(d.top3)), tile("Keywords in top 10", num(d.top10)), tile("Pages with impressions", num(d.topPages.length >= 100 ? "100+" : d.topPages.length))),
    decay,
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Clicks per day (90 days)"), lineChart(d.daily.map((r) => ({ x: fmtDay(r.date), y: r.clicks, sub: `${num(r.impressions)} impressions` })), { max: null, label: "Clicks per day" })),
      h("div", { class: "card" }, h("h2", {}, "Impressions per day (90 days)"), lineChart(d.daily.map((r) => ({ x: fmtDay(r.date), y: r.impressions, sub: `position ${pos(r.position)}` })), { max: null, fmt: num, label: "Impressions per day" }))),
    d.ctr ? h("div", { class: "card" }, h("h2", {}, "Why CTR is what it is"),
      h("p", { class: "hint" }, `${Math.round(d.ctr.deepShare * 100)}% of impressions come from position 21 or lower, where almost nobody clicks; there, CTR is a ranking problem, not a snippet problem. `,
        "Brand searches that are really for another business with a similar name also pull CTR down. Clicks on your Google Business Profile (calls, directions, website button) aren't counted here at all."),
      table([{ label: "Position", key: "band" },
        { label: "Non-brand impr.", num: true, get: (r) => num(r.other.impressions) }, { label: "Non-brand CTR", num: true, get: (r) => (r.other.impressions ? `${(100 * r.other.clicks / r.other.impressions).toFixed(1)}%` : "–") },
        { label: "Brand impr.", num: true, get: (r) => num(r.brand.impressions) }, { label: "Brand CTR", num: true, get: (r) => (r.brand.impressions ? `${(100 * r.brand.clicks / r.brand.impressions).toFixed(1)}%` : "–") }], d.ctr.bands),
      h("h3", { style: { marginTop: "12px" } }, `Page-1 queries clicked far less than expected (${d.ctr.gaps.length})`),
      h("p", { class: "hint" }, "Non-brand queries at positions 1–10 with under half the clicks a 2026 CTR benchmark expects for that position. Look at that results page: a local pack, AI Overview or ads above you explain a lot; otherwise make the title and description answer the search better."),
      table([{ label: "Query", key: "query" }, { label: "Page", cls: "url", get: (r) => shortUrl(r.page, base) }, { label: "Pos.", num: true, get: (r) => pos(r.position) },
        { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Clicks", num: true, key: "clicks" }, { label: "Expected", num: true, get: (r) => r.expectedClicks.toFixed(1) }], d.ctr.gaps, { empty: "None: page-1 queries get about the clicks their position predicts." })) : null,
    h("div", { class: "card" }, h("h2", {}, `Quick wins (${d.quickWins.length})`),
      h("p", { class: "hint" }, "Queries where you already rank 4–20 and get seen. Improving the page that ranks (title, a direct answer, internal links) moves these up fastest."),
      table([{ label: "Query", get: (r) => h("span", {}, r.query, " ", brandTag(r)) }, { label: "Ranking page", cls: "url", get: (r) => shortUrl(r.page, base) },
        { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) }, { label: "Position", num: true, get: (r) => pos(r.position) }], d.quickWins, { empty: "No quick wins in this period." })),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Top queries"), table([{ label: "Query", get: (r) => h("span", {}, r.query, " ", brandTag(r)) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) },
        { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Pos.", num: true, get: (r) => pos(r.position) }], d.topQueries)),
      h("div", { class: "card" }, h("h2", {}, "Top pages"), table([{ label: "Page", cls: "url", get: (r) => shortUrl(r.url, base) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) },
        { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Pos.", num: true, get: (r) => pos(r.position) }], d.topPages))),
    h("div", { class: "card" }, h("h2", {}, `Keyword cannibalisation (${d.cannibal.length})`),
      h("p", { class: "hint" }, "Queries where two or more of your pages each take at least 15% of the impressions. Google splits signals between them; pick one page for the query and link the others to it."),
      table([{ label: "Query", get: (r) => h("span", {}, r.query, " ", brandTag(r)) }, { label: "Pages", num: true, key: "pages" }, { label: "Impr.", num: true, get: (r) => num(r.impressions) },
        { label: "Pages (position)", get: (r) => h("span", { class: "small" }, r.detail.split("  |  ").map((x) => shortUrl(x.replace(/ \([\d.]+\)$/, ""), base) + x.match(/ \([\d.]+\)$/)?.[0]).join(" · ")) }], d.cannibal, { empty: "No cannibalisation found." }))];
};

overviewCards.push(async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/gsc`);
  if (!d.connected) return null;
  const t = d.totals;
  return h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Google Search (last 28 days)"), h("a", { href: `#/p/${ctx.project.id}/search` }, "Details →")),
    h("div", { class: "grid g4" }, ...[["Clicks", num(t.clicks)], ["Impressions", num(t.impressions)], ["Keywords / top 10", `${num(d.keywords)} / ${num(d.top10)}`], ["Quick wins", num(d.quickWins.filter((q) => !q.brand).length) + " non-brand"]]
      .map(([k, v]) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v)))));
});
