// Extra screens that build on optional server modules: performance (Lighthouse) now; keywords, backlinks,
// AI visibility and reports register in views-data.js.
import { h, mount, api, toast, num, shortUrl, meter } from "./core.js";
import { VIEWS, NAV, overviewCards, pageSections } from "./views.js";
import "./views-data.js";
import "./views-paid.js"; // after views-data: it anchors its nav entries to "search"
import "./views-ai.js";
import "./views-report.js";
import "./views-ideas.js";

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
  if (!ok.length) return [header, h("div", { class: "card empty" }, d.running ? "Lighthouse is running…" : d.rows.length ? "Lighthouse failed on every page: " + d.rows[0].error : "No Lighthouse data for this audit yet.")];
  const detail = h("div", {});
  const showDetail = (r) => mount(detail, pageCard(r, base));
  return [header,
    h("div", { class: "grid g4" }, ["perf:Performance", "a11y:Accessibility", "bp:Best practices", "seo:SEO"].map((s) => { const [k, l] = s.split(":"); return h("div", { class: "card" }, meter(avg(ok, k), l, `avg of ${ok.length}`)); })),
    h("div", { class: "card" }, h("h2", {}, "Pages measured"), h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
      h("thead", {}, h("tr", {}, ["Page", "Perf", "LCP", "CLS", "TBT", "FCP", "Speed Index", "Weight"].map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, d.rows.map((r) => h("tr", { style: { cursor: "pointer" }, onclick: () => showDetail(r) },
        h("td", { class: "url" }, shortUrl(r.url, base)),
        r.error ? h("td", { colspan: 7, class: "down" }, "Failed: " + r.error) : [
          h("td", { class: "num" }, r.perf ?? "–"), h("td", { class: "num" }, rated(r.lcp_ms, T.lcp_ms, fmtS)), h("td", { class: "num" }, rated(r.cls, T.cls, (v) => v.toFixed(3))),
          h("td", { class: "num" }, rated(r.tbt_ms, T.tbt_ms, (v) => `${num(v)} ms`)), h("td", { class: "num" }, rated(r.fcp_ms, T.fcp_ms, fmtS)),
          h("td", { class: "num" }, fmtS(r.si_ms)), h("td", { class: "num" }, `${num(r.transfer_kb)} KB`)]))))),
      h("p", { class: "small muted" }, "Good / needs work / poor: LCP ≤ 2.5 s / ≤ 4 s, CLS ≤ 0.1 / ≤ 0.25, TBT ≤ 200 ms / ≤ 600 ms, FCP ≤ 1.8 s / ≤ 3 s. Click a row for fixes.")),
    detail];
};

function pageCard(r, base) {
  const x = r.details || {};
  return h("div", { class: "card" }, h("h2", {}, shortUrl(r.url, base)),
    x.lcpElement ? h("p", { class: "small" }, "Largest element: ", h("code", {}, x.lcpElement)) : null,
    h("div", { class: "grid g2" },
      h("div", {}, h("h3", { style: { marginBottom: "6px" } }, "Speed opportunities"), x.opportunities?.length ? h("ul", {}, x.opportunities.map((o) => h("li", {}, o.title, h("span", { class: "muted" }, o.savingsMs ? ` — saves ~${fmtS(o.savingsMs)}` : o.savingsKb ? ` — saves ~${num(o.savingsKb)} KB` : "")))) : h("p", { class: "muted" }, "None flagged.")),
      h("div", {}, h("h3", { style: { marginBottom: "6px" } }, "Failed checks"), x.failed?.length ? h("ul", {}, x.failed.map((f) => h("li", {}, h("span", { class: "muted" }, f.category + ": "), f.title))) : h("p", { class: "muted" }, "None."))));
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
