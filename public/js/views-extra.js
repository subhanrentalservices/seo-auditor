// Extra screens that build on optional server modules: performance (Lighthouse) now; keywords, backlinks,
// AI visibility and reports register in views-data.js.
import { h, mount, api, toast, num, shortUrl, meter } from "./core.js";
import { VIEWS, NAV, overviewCards, pageSections } from "./views.js";
import "./views-data.js";
import "./views-paid.js"; // after views-data: it anchors its nav entries to "search"
import "./views-reclaim.js"; // after views-paid: "Lost pages" sits right below Search Console
import "./views-rank.js"; // after views-reclaim: Rank tracker and GSC explorer sit right below Search Console; wraps VIEWS.search
import "./views-ai.js";
import "./views-report.js";
import "./views-ideas.js";
import "./views-local.js";

NAV.splice(NAV.findIndex((n) => n.view === "ai") + 1, 0, { view: "performance", label: "Performance" });

const fmtS = (ms) => (ms === null || ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);
/** Metric with its Good / Needs work / Poor label (icon + word, never colour alone). */
function rated(value, [good, poor], fmt) {
  if (value === null || value === undefined) return h("span", { class: "muted" }, "–");
  const r = value <= good ? ["up", "✓", "Good"] : value <= poor ? ["", "!", "Needs work"] : ["down", "✕", "Poor"];
  return h("span", { title: r[2], class: r[0], style: r[0] ? null : { color: "var(--warn-ink)" } }, `${r[1]} ${fmt(value)}`);
}
const avg = (rows, k) => { const v = rows.map((r) => r[k]).filter((x) => x !== null && x !== undefined); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

VIEWS.performance = async (ctx) => {
  if (!ctx.auditData) return h("div", { class: "card empty" }, "Run an audit first.");
  const aid = ctx.auditData.audit.id, base = ctx.project.start_url;
  const d = await api(`/api/audits/${aid}/cwv`);
  const T = d.thresholds, ok = d.rows.filter((r) => !r.error);
  const pagesIn = h("input", { type: "number", min: 1, max: 50, value: ctx.project.settings.cwvPages || 5, style: { width: "70px" } });
  const rerun = h("button", { class: "btn", onclick: async () => {
    try { await api(`/api/audits/${aid}/cwv`, { method: "POST", body: { pages: Number(pagesIn.value) } }); toast("Lighthouse started — about 30 s per page"); rerun.disabled = true; poll(); }
    catch (e) { toast(e.message); }
  } }, d.rows.length ? "Re-run Lighthouse" : "Run Lighthouse");
  const poll = () => setTimeout(async () => { const x = await api(`/api/audits/${aid}/cwv`).catch(() => null); if (x?.running) poll(); else ctx.app.refresh(); }, 5000);
  if (d.running) { rerun.disabled = true; poll(); }
  const header = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Lighthouse (lab, mobile)"), h("div", { class: "row" }, pagesIn, h("span", { class: "small muted" }, "pages"), rerun)),
    h("p", { class: "hint", style: { margin: 0 } }, "Same engine as PageSpeed Insights: a mid-range phone on slow 4G. Lab results are repeatable but Google ranks with field data from real Chrome users (CrUX) when a site has enough traffic."));
  const field = await fieldCard(ctx, aid, ok, T);
  if (!ok.length) return [header, h("div", { class: "card empty" }, d.running ? "Lighthouse is running…" : d.rows.length ? "Lighthouse failed on every page: " + d.rows[0].error : "No Lighthouse data for this audit yet."), field];
  const detail = h("div", {});
  const showDetail = (r) => mount(detail, pageCard(r, base));
  return [header, field,
    h("div", { class: "grid g4" }, ["perf:Performance", "a11y:Accessibility", "bp:Best practices", "seo:SEO"].map((s) => { const [k, l] = s.split(":"); return h("div", { class: "card" }, meter(avg(ok, k), l, `avg of ${ok.length}`)); })),
    h("div", { class: "card" }, h("h2", {}, "Pages measured"), h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
      h("thead", {}, h("tr", {}, ["Page", "Perf", "LCP", "CLS", "TBT", "FCP", "Speed Index", "Weight"].map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, d.rows.map((r) => h("tr", { style: { cursor: "pointer" }, onclick: () => showDetail(r) },
        h("td", { class: "url" }, shortUrl(r.url, base)),
        r.error ? h("td", { colspan: 7, class: "down" }, "Failed: " + r.error) : [
          h("td", { class: "num" }, r.perf ?? "–"), h("td", { class: "num" }, rated(r.lcp_ms, T.lcp_ms, fmtS)), h("td", { class: "num" }, rated(r.cls, T.cls, (v) => v.toFixed(3))),
          h("td", { class: "num" }, rated(r.tbt_ms, T.tbt_ms, (v) => `${num(v)} ms`), rechecked(r)), h("td", { class: "num" }, rated(r.fcp_ms, T.fcp_ms, fmtS)),
          h("td", { class: "num" }, fmtS(r.si_ms)), h("td", { class: "num" }, `${num(r.transfer_kb)} KB`)]))))),
      h("p", { class: "small muted" }, "Good / needs work / poor: LCP ≤ 2.5 s / ≤ 4 s, CLS ≤ 0.1 / ≤ 0.25, TBT ≤ 200 ms / ≤ 600 ms, FCP ≤ 1.8 s / ≤ 3 s. A page whose blocking time is twice the others' is re-run 5 times and its median run shown (“5 runs”). Click a row for fixes.")),
    detail];
};

// ---------- Field data (Chrome UX Report): real Chrome users, 28 days, 75th percentile ----------
const FIELD_COLS = [["largest_contentful_paint", "LCP", fmtS], ["interaction_to_next_paint", "INP", (v) => `${num(v)} ms`], ["cumulative_layout_shift", "CLS", (v) => v.toFixed(2)],
  ["first_contentful_paint", "FCP", fmtS], ["experimental_time_to_first_byte", "TTFB", fmtS]];
const goodShare = (m) => (m && m.good !== null && m.good !== undefined ? h("div", { class: "small muted" }, `${Math.round(m.good * 100)}% good · ${Math.round((m.poor || 0) * 100)}% poor`) : null);

async function fieldCard(ctx, aid, labRows, T) {
  const c = await api(`/api/projects/${ctx.project.id}/crux`).catch(() => null);
  if (!c) return null;
  const FT = c.thresholds, base = ctx.project.start_url;
  const note = h("p", { class: "small muted", style: { marginBottom: 0 } }, "Field data is what Google uses for Core Web Vitals (real Chrome users, last 28 days, 75th percentile); the Lighthouse lab numbers help find the cause. Good / poor: LCP ≤ 2.5 s / > 4 s, INP ≤ 200 ms / > 500 ms, CLS ≤ 0.1 / > 0.25.");
  if (!c.enabled) return h("div", { class: "card" }, h("h2", {}, "Field data (Chrome UX Report)"),
    h("p", {}, c.message, " ", h("a", { href: "#/app" }, "App settings →")), note);
  const btn = h("button", { class: "btn", onclick: async () => {
    btn.disabled = true; btn.textContent = "Fetching…";
    try { await api(`/api/projects/${ctx.project.id}/crux`, { method: "POST", body: { auditId: aid } }); toast("Field data updated"); ctx.app.refresh(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Fetch field data"; }
  } }, c.fetchedAt ? "Refresh field data" : "Fetch field data");
  const head = h("div", { class: "card-h" }, h("h2", {}, "Field data (Chrome UX Report)"), btn);
  if (!c.fetchedAt) return h("div", { class: "card" }, head, h("p", { class: "muted" }, "Not fetched yet. It is fetched after each audit, or press the button (free)."), note);
  const status = (rec) => (!rec ? "Not fetched" : rec.noData ? c.noDataMessage + " (common for small sites)." : rec.error ? "Failed: " + rec.error : null);
  const originRow = (label, rec) => h("tr", {}, h("td", {}, label), status(rec)
    ? h("td", { colspan: FIELD_COLS.length, class: rec?.error ? "down" : "muted" }, status(rec))
    : FIELD_COLS.map(([k, , f]) => h("td", { class: "num" }, rated(rec.metrics[k]?.p75, FT[k], f), goodShare(rec.metrics[k]))));
  const phone = c.origin.PHONE, byUrl = new Map(c.urls.map((r) => [r.url, r]));
  // Per page: lab next to field; a page without enough traffic falls back to the whole site's phone data, labelled.
  const fieldVal = (url, k, f) => {
    const rec = byUrl.get(url);
    if (rec && !rec.noData && !rec.error && rec.metrics[k]) return rated(rec.metrics[k].p75, FT[k], f);
    if (phone && phone.metrics[k]) return h("span", { title: "Too few Chrome users for this page: whole-site (origin) phone data shown" }, rated(phone.metrics[k].p75, FT[k], f), h("span", { class: "small muted" }, " site"));
    return h("span", { class: "muted", title: rec?.error || c.noDataMessage }, "–");
  };
  return h("div", { class: "card" }, head,
    h("p", { class: "hint", style: { margin: "0 0 8px" } }, `Fetched ${new Date(c.fetchedAt + "Z").toLocaleString("en-AU")}.`),
    h("h3", { style: { margin: "0 0 6px" } }, "Whole site (origin)"),
    h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
      h("thead", {}, h("tr", {}, ["Device", ...FIELD_COLS.map((x) => x[1])].map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, originRow("Phone", phone), originRow("Desktop", c.origin.DESKTOP)))),
    labRows.length ? [h("h3", { style: { margin: "14px 0 6px" } }, "Pages: lab (Lighthouse) vs field (phone)"),
      h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
        h("thead", {}, h("tr", {}, ["Page", "Lab LCP", "Field LCP", "Lab CLS", "Field CLS", "Lab TBT", "Field INP"].map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
        h("tbody", {}, labRows.map((r) => h("tr", {}, h("td", { class: "url" }, shortUrl(r.url, base)),
          h("td", { class: "num" }, rated(r.lcp_ms, T.lcp_ms, fmtS)), h("td", { class: "num" }, fieldVal(r.url, "largest_contentful_paint", fmtS)),
          h("td", { class: "num" }, rated(r.cls, T.cls, (v) => v.toFixed(3))), h("td", { class: "num" }, fieldVal(r.url, "cumulative_layout_shift", (v) => v.toFixed(2))),
          h("td", { class: "num" }, rated(r.tbt_ms, T.tbt_ms, (v) => `${num(v)} ms`)), h("td", { class: "num" }, fieldVal(r.url, "interaction_to_next_paint", (v) => `${num(v)} ms`)))))))] : null,
    note);
}

/** "5 runs" marker on a re-checked page: tells a page that is slow every time from a one-off busy computer. */
function rechecked(r) {
  const x = r.details; if (!x?.runs) return null;
  const tip = `Median of ${x.runs.length} runs (TBT ${x.runs.map((u) => num(u.tbt_ms)).join(", ")} ms). ` + (x.verdict === "page" ? "Slow in most runs: the page itself is slow." : "Slow in only some runs: the computer was busy during those runs.");
  return h("div", { class: "small muted", title: tip }, x.verdict === "page" ? `slow in ${x.slowRuns}/${x.runs.length} runs` : `${x.runs.length} runs`);
}

/** Runs, long tasks and main-thread time: what kept the page busy. */
function mainThread(x, base) {
  if (!x.runs && !x.longTasks?.length && !x.mainThread?.length) return null;
  const verdict = x.runs && (x.verdict === "page"
    ? `Slow in ${x.slowRuns} of ${x.runs.length} runs: the page itself keeps the main thread busy. Fix the long tasks below.`
    : `Slow in ${x.slowRuns} of ${x.runs.length} runs only: the slow runs came from the computer being busy, not from the page. The median run is shown.`);
  return h("div", {}, h("h3", { style: { margin: "14px 0 6px" } }, "Main thread"),
    verdict ? h("p", { class: "small" }, verdict) : null,
    x.runs ? h("p", { class: "small muted" }, "Runs (TBT · CPU benchmark): " + x.runs.map((u) => `${num(u.tbt_ms)} ms · ${u.benchmark ?? "–"}`).join("  |  ")) : null,
    x.warnings?.length ? h("p", { class: "small", style: { color: "var(--warn-ink)" } }, "! " + x.warnings.join(" ")) : null,
    h("div", { class: "grid g2" },
      h("div", {}, h("h4", { style: { marginBottom: "4px" } }, "Longest tasks"), x.longTasks?.length
        ? h("ul", { class: "small" }, x.longTasks.map((t) => h("li", {}, `${num(t.ms)} ms `, h("span", { class: "muted" }, `at ${fmtS(t.startMs)} · `), shortUrl(t.url, base))))
        : h("p", { class: "small muted" }, "No long tasks (over 50 ms).")),
      h("div", {}, h("h4", { style: { marginBottom: "4px" } }, "Time by activity"), x.mainThread?.length
        ? h("ul", { class: "small" }, x.mainThread.map((g) => h("li", {}, `${g.label}: ${num(g.ms)} ms`)))
        : h("p", { class: "small muted" }, "–"))));
}

function pageCard(r, base) {
  const x = r.details || {};
  return h("div", { class: "card" }, h("h2", {}, shortUrl(r.url, base)),
    x.lcpElement ? h("p", { class: "small" }, "Largest element: ", h("code", {}, x.lcpElement)) : null,
    h("div", { class: "grid g2" },
      h("div", {}, h("h3", { style: { marginBottom: "6px" } }, "Speed opportunities"), x.opportunities?.length ? h("ul", {}, x.opportunities.map((o) => h("li", {}, o.title, h("span", { class: "muted" }, o.savingsMs ? ` — saves ~${fmtS(o.savingsMs)}` : o.savingsKb ? ` — saves ~${num(o.savingsKb)} KB` : "")))) : h("p", { class: "muted" }, "None flagged.")),
      h("div", {}, h("h3", { style: { marginBottom: "6px" } }, "Failed checks"), x.failed?.length ? h("ul", {}, x.failed.map((f) => h("li", {}, h("span", { class: "muted" }, f.category + ": "), f.title))) : h("p", { class: "muted" }, "None."))),
    mainThread(x, base));
}

overviewCards.push(async (ctx) => {
  const d = await api(`/api/audits/${ctx.auditData.audit.id}/cwv`);
  const ok = d.rows.filter((r) => !r.error);
  if (!ok.length) return null;
  const worst = ok.reduce((a, b) => (b.lcp_ms > a.lcp_ms ? b : a));
  return h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Performance (Lighthouse, mobile)"), h("a", { href: `#/p/${ctx.project.id}/performance` }, "Details →")),
    h("div", { class: "grid g4" }, meter(avg(ok, "perf"), "Performance"), meter(avg(ok, "a11y"), "Accessibility"),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Slowest LCP"), h("div", { class: "v" }, rated(worst.lcp_ms, d.thresholds.lcp_ms, fmtS)), h("div", { class: "d muted" }, shortUrl(worst.url, ctx.project.start_url))),
      h("div", { class: "stat" }, h("div", { class: "k" }, "Pages measured"), h("div", { class: "v" }, ok.length))));
});

pageSections.push(async (ctx, d) => {
  const c = d.cwv; if (!c) return null;
  return h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, "Lighthouse (lab, mobile)"),
    h("div", { class: "row", style: { gap: "18px" } }, `Performance ${c.perf ?? "–"}`, `Accessibility ${c.a11y ?? "–"}`, `Best practices ${c.bp ?? "–"}`, `SEO ${c.seo ?? "–"}`),
    h("p", { class: "small" }, `LCP ${fmtS(c.lcp_ms)} · CLS ${c.cls} · TBT ${num(c.tbt_ms)} ms · ${num(c.transfer_kb)} KB`),
    c.details?.opportunities?.length ? h("ul", { class: "small" }, c.details.opportunities.slice(0, 4).map((o) => h("li", {}, o.title))) : null);
});
