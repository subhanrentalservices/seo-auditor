// AI visibility, more from stored data (src/visibility-plus.mjs): prompt suggestions from Search Console question
// searches (free), the opt-in scheduled run (paid, budget-checked), a trend per prompt, share of voice over time and
// cited sources mapped to own pages. Added below the AI visibility screen. Text only, never innerHTML: prompts,
// domains and titles come from AI answers, Google and the site.
import { h, api, toast, num, table, multiLineChart, shortUrl } from "./core.js";
import { VIEWS } from "./views.js";

const pct = (v) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
const day = (s) => new Date(s.replace(" ", "T") + "Z").toLocaleDateString("en-AU");
const link = (u, text) => (u ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, text || shortUrl(u)) : h("span", { class: "muted" }, "–"));

const base = VIEWS.visibility;
VIEWS.visibility = async (ctx) => {
  const pid = ctx.project.id;
  const [own, sug, sch, tr, src, st] = await Promise.all([base(ctx), api(`/api/projects/${pid}/visibility/suggestions`).catch(() => null),
    api(`/api/projects/${pid}/visibility/schedule`).catch(() => null), api(`/api/projects/${pid}/visibility/trends`).catch(() => null),
    api(`/api/projects/${pid}/visibility/sources`).catch(() => null), api("/api/dfs/status").catch(() => null)]);
  const lt = await api(`/api/projects/${pid}/visibility/listing-targets`).catch(() => null);
  return [...[own].flat(), trendCard(tr), sourcesCard(src), listingCard(lt), h("div", { class: "grid g2" }, suggestionsCard(ctx, sug), scheduleCard(ctx, sch, st))];
};

function suggestionsCard(ctx, sug) {
  if (!sug) return null;
  const card = h("div", { class: "card" }, h("h2", {}, "Prompt ideas from Search Console"),
    h("p", { class: "small muted" }, `Question searches people already make on Google that show your site (${sug.source}, 5+ impressions), not yet prompts. Free; adding them costs nothing until a run.`));
  if (!sug.suggestions.length) return card.append(h("p", { class: "muted" }, "No new question searches. They appear after Search Console is connected and refreshed.")), card;
  const picked = new Set();
  card.append(h("ul", { class: "small", style: { listStyle: "none", padding: 0, margin: "0 0 10px", maxHeight: "260px", overflow: "auto" } }, sug.suggestions.map((s) => h("li", { style: { padding: "3px 0" } },
    h("label", { class: "row", style: { gap: "6px", alignItems: "flex-start" } }, h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? picked.add(s.query) : picked.delete(s.query)) }),
      h("span", {}, s.query, h("span", { class: "muted" }, ` · ${num(s.impressions)} impressions${s.position ? ` · position ${s.position}` : ""}${s.brand ? " · brand" : ""}`)))))),
  h("button", { class: "btn", onclick: async () => {
    if (!picked.size) return toast("Tick the searches to add");
    try { const r = await api(`/api/projects/${ctx.project.id}/visibility/prompts`, { method: "POST", body: { prompts: [...picked].join("\n") } }); toast(`${r.added} prompts added`); ctx.app.refresh(); }
    catch (e) { toast(e.message); }
  } }, "Add as prompts"));
  return card;
}

function scheduleCard(ctx, s, st) {
  if (!s) return null;
  const enabled = h("input", { type: "checkbox", checked: s.enabled });
  const every = h("select", { "aria-label": "Run every" }, s.intervals.map((d) => h("option", { value: d, selected: d === s.everyDays }, `every ${d} days`)));
  const plats = new Set(s.platforms);
  const cap = h("input", { type: "number", min: "0.01", step: "0.01", value: s.maxCost ?? "", placeholder: "no cap", style: { width: "90px" }, "aria-label": "Cost cap per run in dollars" });
  const card = h("div", { class: "card" }, h("h2", {}, "Scheduled runs (paid, opt-in)"),
    h("p", { class: "small muted" }, `Off until you tick it. While the app runs, a run starts when the last one is older than the interval, only if its estimate (≈ $${s.estimate.toFixed(3)} for ${s.prompts} prompts) fits what is left of this month's DataForSEO budget${st ? ` ($${Math.max(st.budget - st.spent, 0).toFixed(3)} of $${st.budget.toFixed(2)})` : ""} and your cap. A run that doesn't fit is skipped and says why.`),
    h("label", { class: "row small" }, enabled, h("b", {}, "Run automatically (paid)")),
    h("div", { class: "row small", style: { flexWrap: "wrap", margin: "8px 0" } }, every, h("span", {}, "cap per run $"), cap),
    h("div", { class: "row small", style: { flexWrap: "wrap" } }, Object.entries(s.labels).map(([k, label]) => h("label", { class: "row", style: { marginRight: "10px" } },
      h("input", { type: "checkbox", checked: plats.has(k), onchange: (e) => (e.target.checked ? plats.add(k) : plats.delete(k)) }), label))),
    s.lastResult ? h("p", { class: "small", style: { margin: "8px 0 0" } }, `Last check ${new Date(s.lastCheckAt).toLocaleString("en-AU")}: ${s.lastResult}`) : null,
    h("button", { class: "btn", style: { marginTop: "8px" }, onclick: async () => {
      try {
        await api(`/api/projects/${ctx.project.id}/visibility/schedule`, { method: "PUT", body: { enabled: enabled.checked, everyDays: Number(every.value), platforms: [...plats], maxCost: cap.value === "" ? null : Number(cap.value) } });
        toast(enabled.checked ? "Scheduled runs on" : "Scheduled runs off"); ctx.app.refresh();
      } catch (e) { toast(e.message); }
    } }, "Save"));
  return card;
}

function trendCard(tr) {
  if (!tr || tr.runs.length < 2) return null;
  const runs = tr.runs.slice(-8), off = tr.runs.length - runs.length;
  const labels = runs.map((r) => day(r.at));
  const chartable = tr.shareOfVoice.filter((d) => d.own).concat(tr.shareOfVoice.filter((d) => !d.own)).slice(0, 3);
  return h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("h2", {}, "Trend per prompt"), h("p", { class: "small muted" }, "Per run: platforms that mentioned you / cited your site, of those that answered; best place in a list."),
      h("div", { class: "tbl-wrap" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, h("th", {}, "Prompt"), labels.map((l) => h("th", { class: "num" }, l)))),
        h("tbody", {}, tr.prompts.map((p) => h("tr", {}, h("td", {}, p.prompt), p.series.slice(off).map((c) => h("td", { class: "num" },
          c.answered ? `${c.mentioned}/${c.cited} of ${c.answered}${c.bestRank ? ` · #${c.bestRank}` : ""}` : "–")))))))),
    h("div", { class: "card" }, h("h2", {}, "Share of voice over time"), h("p", { class: "small muted" }, "Share of AI answers with sources that cite each domain, per run."),
      multiLineChart(labels, chartable.map((d) => ({ name: d.own ? `${d.domain} (you)` : d.domain, values: d.shares.slice(off).map((v) => (v === null ? null : Math.round(v * 100))) })), { fmt: (v) => `${v}%`, label: "Share of voice per run" }),
      table([{ label: "Domain", get: (d) => (d.own ? h("b", {}, `${d.domain} (you)`) : d.domain) }, ...runs.map((r, i) => ({ label: labels[i], num: true, get: (d) => pct(d.shares[off + i]) }))], tr.shareOfVoice)));
}

function sourcesCard(m) {
  if (!m?.run) return null;
  return h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("h2", {}, "Your pages AI cites"), h("p", { class: "small muted" }, `Run of ${day(m.run.started_at)}. Each cited page of your site, matched to the last audit.`),
      table([{ label: "Page", get: (c) => link(c.url, c.title || shortUrl(c.url)) }, { label: "Prompts", num: true, get: (c) => c.prompts.length }, { label: "Platforms", get: (c) => c.platforms.join(", ") },
        { label: "In audit", get: (c) => (c.inAudit ? `HTTP ${c.status}` : h("span", { class: "muted" }, "not crawled")) }], m.ownCited, { empty: "No page of your site was cited in this run." })),
    h("div", { class: "card" }, h("h2", {}, "Prompts others win: your closest page"), h("p", { class: "small muted" }, "Prompts where AI cited other sites but not yours, the sites it cited, and your page on the same topic (Search Console search first, then title/H1 words: a heuristic). No page means a content gap."),
      table([{ label: "Prompt", key: "prompt" }, { label: "Cited instead", get: (e) => e.cited.map((c) => `${c.domain} (${c.answers})`).join(", ") },
        { label: "Your page", get: (e) => (e.ownPage ? [link(e.ownPage.url, e.ownPage.title || shortUrl(e.ownPage.url)), h("div", { class: "small muted" }, e.ownPage.via)] : h("span", { class: "down" }, "none: content gap")) }],
      m.prompts, { empty: "Every prompt with sources cited your site." })));
}

function listingCard(m) {
  if (!m?.run || (!m.pages.length && !m.searches.length)) return null;
  return h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("h2", {}, "Pages to get listed on"), h("p", { class: "small muted" }, `Run of ${day(m.run.started_at)}. Other sites' pages AI cited (or ChatGPT read) for prompts that don't name you. "List" pages (best-of lists, directories) are ones a business can ask to be added to; a heuristic. Earn a place honestly: no paid fake reviews.`),
      table([{ label: "Page", get: (e) => [link(e.url, e.title || shortUrl(e.url)), e.listPage ? h("span", { class: "small" }, " list") : null] }, { label: "Prompts", num: true, get: (e) => e.prompts.length },
        { label: "Platforms", get: (e) => e.platforms.join(", ") }, { label: "Cited / read", get: (e) => `${e.cited} / ${e.retrieved}` }], m.pages, { empty: "No other sites' pages in this run." })),
    h("div", { class: "card" }, h("h2", {}, "ChatGPT's own searches"), h("p", { class: "small muted" }, "The searches ChatGPT ran to answer each prompt (OpenAI: it rewrites a question into targeted searches sent to its search partners). Pages that rank for these get read. Runs from 2 Nov 2026 on."),
      table([{ label: "Prompt", get: (e) => [e.prompt, e.mentioned ? h("span", { class: "small muted" }, " (names you)") : null] }, { label: "Searches", get: (e) => e.queries.join(" · ") }], m.searches, { empty: "None stored yet: the next ChatGPT run records them." })));
}
