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

VIEWS.search = async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/gsc`);
  const btn = h("button", { class: "btn", onclick: () => gscRefresh(ctx, btn) }, d.connected ? "Refresh" : "Fetch now");
  const head = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Google Search Console"), btn),
    h("p", { class: "hint", style: { margin: 0 } }, d.connected ? `${d.property} · ${d.startDate} → ${d.endDate} (last 28 days of final data) · fetched ${new Date(d.fetchedAt).toLocaleString("en-AU")}`
      : "Not fetched yet. The service account must be added as a user on the property in Search Console (Settings → Users and permissions). The property is detected from the site URL, or set it in Settings."));
  const index = await indexCard(ctx).catch((e) => h("div", { class: "card" }, h("h2", {}, "Index status"), h("p", { class: "hint" }, e.message)));
  if (!d.connected) return [head, index];
  const base = ctx.project.start_url, t = d.totals;
  const tile = (k, v) => h("div", { class: "card stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));
  return [head, index,
    h("div", { class: "grid g4" }, tile("Clicks", num(t.clicks)), tile("Impressions", num(t.impressions)), tile("CTR", `${((t.ctr || 0) * 100).toFixed(2)}%`), tile("Average position", pos(t.position))),
    h("div", { class: "grid g4" }, tile("Keywords with impressions", num(d.keywords)), tile("Keywords in top 3", num(d.top3)), tile("Keywords in top 10", num(d.top10)), tile("Pages with impressions", num(d.topPages.length >= 100 ? "100+" : d.topPages.length))),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Clicks per day (90 days)"), lineChart(d.daily.map((r) => ({ x: fmtDay(r.date), y: r.clicks, sub: `${num(r.impressions)} impressions` })), { max: null, label: "Clicks per day" })),
      h("div", { class: "card" }, h("h2", {}, "Impressions per day (90 days)"), lineChart(d.daily.map((r) => ({ x: fmtDay(r.date), y: r.impressions, sub: `position ${pos(r.position)}` })), { max: null, fmt: num, label: "Impressions per day" }))),
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
