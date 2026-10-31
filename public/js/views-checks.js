// "All checks": every check the audit can raise, with its severity, why it matters, how to fix it and where Google
// documents the topic (GET /api/checks?counts=1, check-sources.mjs). Heuristics, security and accessibility checks
// are labelled as such rather than given a Google page.
import { h, mount, api, num } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "issues") + 1, 0, { view: "checks", label: "All checks" });

const SEV = { error: "Error", warning: "Warning", notice: "Notice" };
const GROUPS = { seo: "SEO", crawl: "Crawlability", ai: "AI search", performance: "Core Web Vitals", security: "Security (information)", accessibility: "Accessibility (information)" };

VIEWS.checks = async () => {
  const { counts, checks } = await api("/api/checks?counts=1");
  const q = h("input", { type: "search", placeholder: "Search checks", "aria-label": "Search checks", style: { width: "240px" } });
  const sev = h("select", { "aria-label": "Severity" }, h("option", { value: "" }, "All severities"), ["error", "warning", "notice"].map((s) => h("option", { value: s }, SEV[s])));
  const grp = h("select", { "aria-label": "Group" }, h("option", { value: "" }, "All groups"), Object.entries(GROUPS).map(([k, l]) => h("option", { value: k }, l)));
  const list = h("div", { class: "card", style: { padding: "6px 10px" } });
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const shown = checks.filter((c) => (!sev.value || c.severity === sev.value) && (!grp.value || c.group === grp.value)
      && (!t || `${c.id} ${c.title} ${c.why}`.toLowerCase().includes(t)));
    mount(list, shown.length ? shown.map((c) => h("details", { style: { padding: "8px 2px", borderBottom: "1px solid var(--grid)" } },
      h("summary", {}, h("span", { class: `dot sev-${c.severity}`, "aria-hidden": "true", style: { marginRight: "8px" } }), h("b", {}, c.title),
        h("span", { class: "small muted" }, ` · ${SEV[c.severity]} · ${GROUPS[c.group] || c.group} · `, h("code", {}, c.id))),
      h("dl", { class: "kv small", style: { marginTop: "6px" } },
        h("dt", {}, "Why"), h("dd", {}, c.why || "–"),
        h("dt", {}, "Fix"), h("dd", {}, c.fix || "–"),
        h("dt", {}, "Source"), h("dd", {}, c.source.url ? h("a", { href: c.source.url, target: "_blank", rel: "noopener noreferrer" }, c.source.label) : c.source.label))))
      : [h("div", { class: "empty" }, "No check matches.")]);
  };
  for (const el of [q, sev, grp]) el.addEventListener("input", draw);
  draw();
  const s = counts.severity;
  return [h("p", { class: "hint", style: { margin: 0 } },
      `${num(counts.total)} checks: ${num(s.error)} errors, ${num(s.warning)} warnings, ${num(s.notice)} notices (${num(counts.ai)} of them AI-search checks). `,
      `${num(counts.withGoogleSource)} link to the Google Search Central page on their topic; the rest are labelled as tool heuristics, security or accessibility information.`),
    h("div", { class: "row" }, q, sev, grp), list];
};
