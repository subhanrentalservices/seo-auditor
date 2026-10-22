// AI Visibility screen: prompts, run (paid, with estimate), per-platform rates, prompt × platform matrix,
// share of voice and history.
import { h, api, toast, num, table } from "./core.js";
import { VIEWS, NAV, overviewCards } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "ai") + 1, 0, { view: "visibility", label: "AI visibility" });

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "–");

VIEWS.visibility = async (ctx) => {
  const pid = ctx.project.id;
  const [d, st] = await Promise.all([api(`/api/projects/${pid}/visibility`), api("/api/dfs/status").catch(() => null)]);
  const chosen = new Set(Object.keys(d.platforms));
  const est = h("span", { class: "small muted" });
  const updateEst = () => { const per = [...chosen].reduce((t, k) => t + d.platforms[k].cost, 0); est.textContent = `${d.prompts.length} prompts × ${chosen.size} platforms ≈ $${(per * d.prompts.length).toFixed(3)}`; };
  const runBtn = h("button", { class: "btn primary", disabled: d.running, onclick: async () => {
    try { const r = await api(`/api/projects/${pid}/visibility/run`, { method: "POST", body: { platforms: [...chosen] } }); toast(`Running ${r.calls} checks…`); runBtn.disabled = true; poll(); }
    catch (e) { toast(e.message); }
  } }, d.running ? "Running…" : "Run check");
  const poll = () => setTimeout(async () => { const x = await api(`/api/projects/${pid}/visibility`).catch(() => null); if (x?.running) poll(); else ctx.app.refresh(); }, 6000);
  if (d.running) poll();
  updateEst();

  const promptsBox = h("textarea", { rows: 4, style: { width: "100%" }, placeholder: "One prompt per line, written the way a customer would ask an AI assistant" });
  const prompts = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, `Prompts (${d.prompts.length})`)),
    promptsBox, h("div", { class: "row", style: { margin: "8px 0 12px" } }, h("button", { class: "btn", onclick: async () => {
      try { const r = await api(`/api/projects/${pid}/visibility/prompts`, { method: "POST", body: { prompts: promptsBox.value } }); toast(`${r.added} added`); ctx.app.refresh(); } catch (e) { toast(e.message); }
    } }, "Add prompts")),
    d.prompts.length ? h("details", {}, h("summary", { class: "small" }, "Show / remove prompts"), h("ul", { class: "small" }, d.prompts.map((p) => h("li", {}, p.prompt, " ",
      h("button", { class: "linkish", title: "Remove", onclick: async () => { await api(`/api/projects/${pid}/visibility/prompts/${p.id}`, { method: "DELETE" }); ctx.app.refresh(); } }, "✕"))))) : null);

  const head = h("div", { class: "card" }, h("h2", {}, "AI visibility"),
    h("p", { class: "hint" }, "Asks each prompt on ChatGPT (with web search), Google (AI Overview, organic top 20 and local pack) and Google AI Mode, then checks whether your brand is mentioned, your site is cited, and who gets cited instead. One snapshot per run: real answers vary by user, location and day."),
    h("div", { class: "row" }, Object.entries(d.platforms).map(([k, p]) => h("label", { class: "row small", style: { marginRight: "10px" } },
      h("input", { type: "checkbox", checked: true, onchange: (e) => { e.target.checked ? chosen.add(k) : chosen.delete(k); updateEst(); } }), `${p.label} ($${p.cost})`)), runBtn, est),
    st ? h("p", { class: "small muted", style: { marginBottom: 0 } }, `DataForSEO this month: $${st.spent.toFixed(3)} of $${st.budget.toFixed(2)} budget`) : null);
  if (!d.last) return [head, prompts];

  const R = Object.fromEntries(d.last.rates.map((r) => [r.platform, r]));
  const tiles = Object.entries(d.platforms).filter(([k]) => R[k]).map(([k, p]) => {
    const r = R[k], ok = k === "google" ? r.present || 0 : r.n - r.errors; // Google: only searches that showed an AI Overview
    return h("div", { class: "card" }, h("div", { class: "small muted" }, p.label),
      h("div", { class: "grid g2", style: { marginTop: "6px", gap: "8px" } },
        h("div", { class: "stat" }, h("div", { class: "k" }, "Mentioned"), h("div", { class: "v" }, pct(r.mentioned, ok)), h("div", { class: "d muted" }, `${r.mentioned || 0} of ${ok}`)),
        h("div", { class: "stat" }, h("div", { class: "k" }, "Cited"), h("div", { class: "v" }, pct(r.cited, ok)), h("div", { class: "d muted" }, `${r.cited || 0} of ${ok}`))),
      k === "google" ? h("p", { class: "small", style: { margin: "6px 0 0" } }, `AI Overview shown on ${r.present || 0} of ${ok} · you in organic top 10 on ${r.top10 || 0} · in local pack on ${r.in_pack || 0}`) : null,
      r.errors ? h("p", { class: "small down", style: { margin: "6px 0 0" } }, `${r.errors} failed`) : null);
  });

  const byPrompt = new Map();
  for (const r of d.results) { if (!byPrompt.has(r.prompt)) byPrompt.set(r.prompt, {}); byPrompt.get(r.prompt)[r.platform] = r; }
  const cell = (r) => {
    if (!r) return h("span", { class: "muted" }, "–");
    if (r.error) return h("span", { class: "down", title: r.error }, "error");
    const bits = [];
    if (r.platform === "google" && !r.present) bits.push(h("span", { class: "muted" }, "no AIO"));
    if (r.mentioned) bits.push(h("span", { class: "up" }, "✓ mentioned" + (r.rank ? ` #${r.rank}` : "")));
    if (r.cited) bits.push(h("span", { class: "up" }, "✓ cited"));
    if (r.platform === "google" && r.organic_pos) bits.push(h("span", {}, `organic #${r.organic_pos}`));
    if (r.platform === "google" && r.local_pos) bits.push(h("span", {}, `map pack #${r.local_pos}`));
    if (!bits.length || (r.present && !r.mentioned && !r.cited && !(r.platform === "google"))) bits.unshift(h("span", { class: "down" }, "✕ absent"));
    return h("button", { class: "linkish", style: { textAlign: "left", color: "inherit" }, onclick: () => answerDrawer(ctx, r) }, bits.flatMap((b, i) => (i ? [" · ", b] : [b])));
  };
  const plats = Object.keys(d.platforms).filter((k) => R[k]);
  const matrix = h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
    h("thead", {}, h("tr", {}, h("th", {}, "Prompt"), plats.map((k) => h("th", {}, d.platforms[k].label)))),
    h("tbody", {}, [...byPrompt].map(([prompt, row]) => h("tr", {}, h("td", {}, prompt), plats.map((k) => h("td", {}, cell(row[k]))))))));

  const hist = d.runs.filter((r) => r.status !== "running");
  return [head,
    h("div", { class: `grid g${Math.min(tiles.length, 3) || 1}` }, tiles),
    h("div", { class: "card" }, h("h2", {}, `Results · ${new Date(d.last.started_at + "Z").toLocaleString("en-AU")} · cost $${(d.last.cost || 0).toFixed(3)}`), h("p", { class: "small muted" }, "Click a cell to read the answer and its sources."), matrix),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Who AI cites (share of voice)"), h("p", { class: "small muted" }, "Domains cited across all AI answers in this run. These sites are what AI trusts for your prompts."),
        table([{ label: "Domain", get: (r) => (r.own ? h("b", {}, r.domain + " (you)") : r.domain) }, { label: "Answers", num: true, key: "answers" }, { label: "Share", num: true, get: (r) => `${Math.round(r.share * 100)}%` }], d.shareOfVoice, { empty: "No citations recorded." })),
      h("div", { class: "card" }, h("h2", {}, "Runs"), table([{ label: "When", get: (r) => new Date(r.started_at + "Z").toLocaleString("en-AU") }, { label: "Prompts", num: true, key: "prompts" },
        ...plats.map((k) => ({ label: d.platforms[k].label.split(" ")[0] + (k === "ai_mode" ? " AI Mode" : k === "google" ? " AIO" : ""), num: true, get: (r) => { const x = r.rates.find((y) => y.platform === k); return x ? `${x.mentioned || 0}/${x.cited || 0}` : "–"; } })),
        { label: "Cost", num: true, get: (r) => `$${(r.cost || 0).toFixed(3)}` }], hist.slice().reverse()), h("p", { class: "small muted" }, "Per platform: mentioned / cited."))),
    prompts];
};

function answerDrawer(ctx, r) {
  ctx.app.openDrawer(h("h2", { style: { paddingRight: "90px" } }, r.prompt), h("p", { class: "small muted" }, r.platform, r.check_url ? [" · ", h("a", { href: r.check_url, target: "_blank", rel: "noopener" }, "open the live result")] : null),
    h("div", { class: "stack" },
      r.excerpt ? h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, "Answer (first 1,500 characters)"), h("div", { class: "quote", style: { whiteSpace: "pre-wrap" } }, r.excerpt)) : h("div", { class: "card muted" }, r.platform === "google" ? "Google showed no AI Overview for this search." : "No answer text."),
      r.brands?.length ? h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, r.platform === "google" ? "Local pack" : "Businesses named"), h("ol", { class: "small" }, r.brands.map((b) => h("li", {}, b)))) : null,
      h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, r.sources.some((s) => s.organic) ? "Organic results (no AI Overview)" : "Sources cited"),
        r.sources.length ? h("ol", { class: "small" }, r.sources.map((s) => h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.domain), s.title ? h("span", { class: "muted" }, " — " + s.title) : null))) : h("p", { class: "muted" }, "None."))));
}

overviewCards.push(async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/visibility`);
  if (!d.last) return null;
  const rows = d.last.rates.filter((r) => r.platform !== "google" || r.present);
  const n = rows.reduce((t, r) => t + r.n - r.errors, 0), m = rows.reduce((t, r) => t + (r.mentioned || 0), 0), c = rows.reduce((t, r) => t + (r.cited || 0), 0);
  return h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "AI visibility (last run)"), h("a", { href: `#/p/${ctx.project.id}/visibility` }, "Details →")),
    h("div", { class: "grid g4" }, ...[["Prompts", num(d.last.prompts)], ["AI answers checked", num(n)], ["You mentioned", pct(m, n)], ["Your site cited", pct(c, n)]]
      .map(([k, v]) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v)))));
});
