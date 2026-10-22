// Report screen (HTML preview, open, PDF) and the "Fix first" overview card (own idea I1).
import { h, api, toast, num } from "./core.js";
import { VIEWS, NAV, overviewCards } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "settings"), 0, { view: "report", label: "Report" });

VIEWS.report = async (ctx) => {
  if (!ctx.auditData) return h("div", { class: "card empty" }, "Run an audit first.");
  const id = ctx.auditData.audit.id;
  const pdf = h("button", { class: "btn primary", onclick: async () => {
    pdf.disabled = true; pdf.textContent = "Making PDF…";
    try {
      const res = await fetch(`/api/audits/${id}/report.pdf`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: `seo-report-${ctx.project.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${id}.pdf` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) { toast(e.message); }
    pdf.disabled = false; pdf.textContent = "Download PDF";
  } }, "Download PDF");
  return [h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Report"),
      h("div", { class: "row" }, h("a", { class: "btn", href: `/api/audits/${id}/report.html`, target: "_blank", rel: "noopener" }, "Open in new tab"), pdf)),
    h("p", { class: "hint", style: { margin: 0 } }, "Scores, what to fix first, every issue with affected URLs, performance, Search Console, keywords, backlinks and AI visibility — whatever data this project has. Print or save as PDF to share.")),
    h("iframe", { src: `/api/audits/${id}/report.html`, title: "Report preview", style: { width: "100%", height: "75vh", border: "1px solid var(--border)", borderRadius: "10px", background: "#fff" } })];
};

overviewCards.unshift(async (ctx) => {
  const rows = await api(`/api/audits/${ctx.auditData.audit.id}/priorities`);
  if (!rows.length) return null;
  return h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Fix first"), h("span", { class: "small muted" }, "severity × pages × Google impressions")),
    h("ol", { style: { margin: 0, paddingLeft: "20px" } }, rows.slice(0, 5).map((r) => h("li", { style: { padding: "4px 0" } },
      h("a", { href: `#/p/${ctx.project.id}/issues/${r.id}` }, r.title), h("span", { class: "muted small" }, ` — ${num(r.pages)} page${r.pages > 1 ? "s" : ""}${r.impressions ? `, ${num(r.impressions)} impressions` : ""}`),
      h("div", { class: "small muted" }, r.fix)))));
});
