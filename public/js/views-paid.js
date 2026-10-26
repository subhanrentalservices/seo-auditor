// Paid data screens (DataForSEO, fetched only on request): keywords, backlinks; plus global app settings.
import { h, mount, api, toast, num, shortUrl, lineChart, barChart, table } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "search") + 1, 0, { view: "keywords", label: "Keywords" }, { view: "backlinks", label: "Backlinks" });
NAV.splice(NAV.findIndex((n) => n.view === "history"), 0, { section: "Project" });

async function paidFetch(btn, url, what, ctx) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = "Fetching…";
  try { await api(url, { method: "POST", body: {} }); toast(`${what} updated`); ctx.app.refresh(); }
  catch (e) { toast(e.message); btn.disabled = false; btn.textContent = label; }
}
const spendLine = (st) => (st ? h("span", { class: "small muted" }, `DataForSEO this month: $${st.spent.toFixed(3)} of $${st.budget.toFixed(2)} budget${typeof st.balance === "number" ? ` · account balance $${st.balance.toFixed(2)}` : ""}`) : null);
const delta = (a, b) => (b === undefined || b === null ? null : `${a - b >= 0 ? "+" : ""}${num(a - b)} since last`);

VIEWS.keywords = async (ctx) => {
  const [d, st] = await Promise.all([api(`/api/projects/${ctx.project.id}/keywords`), api("/api/dfs/status").catch(() => null)]);
  const btn = h("button", { class: "btn", onclick: () => paidFetch(btn, `/api/projects/${ctx.project.id}/keywords`, "Keywords", ctx) }, d.last ? "Refresh (≈ $0.03)" : "Fetch keywords (≈ $0.03)");
  const head = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Organic keywords (Google, DataForSEO)"), btn),
    h("p", { class: "hint", style: { margin: "0 0 4px" } }, d.last ? `Snapshot ${new Date(d.last.fetched_at + "Z").toLocaleString("en-AU")} · location ${ctx.project.settings.dfsLocation}. Estimates from DataForSEO's index; Search Console has your real numbers.`
      : "Every keyword the domain ranks for in Google's top 100, with search volume and estimated traffic. Paid per request; fetched only when you press the button."),
    spendLine(st));
  if (!d.last) return head;
  const m = d.last.metrics, base = ctx.project.start_url;
  const sum = (...k) => k.reduce((t, x) => t + (m[x] || 0), 0);
  const buckets = [["1", sum("pos_1")], ["2–3", sum("pos_2_3")], ["4–10", sum("pos_4_10")], ["11–20", sum("pos_11_20")], ["21–30", sum("pos_21_30")], ["31–50", sum("pos_31_40", "pos_41_50")], ["51–100", sum("pos_51_60", "pos_61_70", "pos_71_80", "pos_81_90", "pos_91_100")]];
  const snap = d.snapshots.at(-1), prev = d.snapshots.at(-2);
  const tile = (k, v, dl) => h("div", { class: "card stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "d muted" }, dl || " "));
  const brandKey = new URL(base).hostname.replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9]/g, "");
  const q = { text: "", hideBrand: false };
  const out = h("div", {});
  const draw = () => {
    const rows = d.items.filter((r) => (!q.text || r.keyword.includes(q.text.toLowerCase())) && (!q.hideBrand || !r.keyword.replace(/[^a-z0-9]/gi, "").includes(brandKey)));
    mount(out, table([{ label: "Keyword", key: "keyword" },
      { label: "Pos.", num: true, get: (r) => h("span", {}, r.position ?? "–", r.change ? h("span", { class: r.change > 0 ? "up" : "down", style: { marginLeft: "6px" } }, `${r.change > 0 ? "▲" : "▼"}${Math.abs(r.change)}`) : null) },
      { label: "Volume", num: true, get: (r) => num(r.volume) }, { label: "Est. visits", num: true, get: (r) => (r.etv ? r.etv.toFixed(1) : "–") }, { label: "KD", num: true, get: (r) => r.difficulty ?? "–" },
      { label: "Intent", get: (r) => r.intent || "" }, { label: "URL", cls: "url", get: (r) => (r.url ? shortUrl(r.url, base) : "") }], rows, { empty: "No keywords match." }));
  };
  draw();
  return [head,
    h("div", { class: "grid g4" }, tile("Ranked keywords", num(snap.total), delta(snap.total, prev?.total)), tile("Top 3", num(snap.top3), delta(snap.top3, prev?.top3)),
      tile("Top 10", num(snap.top10), delta(snap.top10, prev?.top10)), tile("Est. monthly visits", num(Math.round(snap.etv || 0)))),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Keywords by position"), barChart(buckets.map(([x, y]) => ({ x, y })), { width: 520, label: "Keywords by Google position", unit: " keywords" })),
      h("div", { class: "card" }, h("h2", {}, "Ranked keywords over time"), d.snapshots.length > 1
        ? lineChart(d.snapshots.map((s) => ({ x: new Date(s.fetched_at + "Z").toLocaleDateString("en-AU"), y: s.total, sub: `top 10: ${s.top10}` })), { max: null, label: "Ranked keywords per snapshot" })
        : h("p", { class: "muted" }, "Appears after the second snapshot."))),
    h("div", { class: "card" }, h("div", { class: "row", style: { marginBottom: "10px" } },
      h("input", { type: "search", placeholder: "Filter keywords", oninput: (e) => { q.text = e.target.value; draw(); } }),
      h("label", { class: "row small" }, h("input", { type: "checkbox", onchange: (e) => { q.hideBrand = e.target.checked; draw(); } }), "Hide brand keywords")), out)];
};

VIEWS.backlinks = async (ctx) => {
  const [d, st] = await Promise.all([api(`/api/projects/${ctx.project.id}/backlinks`), api("/api/dfs/status").catch(() => null)]);
  const btn = h("button", { class: "btn", onclick: () => paidFetch(btn, `/api/projects/${ctx.project.id}/backlinks`, "Backlinks", ctx) }, d.last ? "Refresh (≈ $0.08)" : "Fetch backlinks (≈ $0.08)");
  const head = h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Backlinks (DataForSEO)"), btn),
    h("p", { class: "hint", style: { margin: "0 0 4px" } }, d.last ? `Snapshot ${new Date(d.last.fetched_at + "Z").toLocaleString("en-AU")} · live links only.` : "Backlinks, referring domains, anchors and a spam review. Paid per request; fetched only when you press the button."),
    spendLine(st));
  if (!d.last) return head;
  const l = d.last, x = l.data, s = d.spam, prev = d.snapshots.at(-2);
  const tile = (k, v, sub) => h("div", { class: "card stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "d muted" }, sub || " "));
  const sw = l.spam_score >= 60 ? ["✕ High", "down"] : l.spam_score >= 30 ? ["! Medium", ""] : ["✓ Low", "up"];
  const top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ k, v }));
  return [head,
    h("div", { class: "grid g4" }, tile("Backlinks", num(l.backlinks), delta(l.backlinks, prev?.backlinks)), tile("Referring domains", num(l.ref_domains), delta(l.ref_domains, prev?.ref_domains)),
      tile("Dofollow", num(l.dofollow), l.backlinks ? `${Math.round((100 * l.dofollow) / l.backlinks)}% of links` : null),
      h("div", { class: "card stat" }, h("div", { class: "k" }, "Spam score (0–100)"), h("div", { class: "v" }, l.spam_score ?? "–"), h("div", { class: "d " + sw[1] }, sw[0]))),
    h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Spam review"),
      s.flagged.length ? h("a", { class: "btn sm", href: `/api/projects/${ctx.project.id}/disavow.txt` }, `Download disavow file (${s.flagged.length} domains)`) : null),
      s.flagged.length || s.spamAnchors.length ? [
        h("p", {}, `${s.flagged.length} of ${x.referringDomains.length} referring domains look like spam; ${Math.round(s.anchorShare * 100)}% of links use link-seller or spam anchors.`),
        h("p", { class: "hint" }, "Google ignores most spam links on its own, so this usually does no harm. Use the disavow file only if Search Console shows a manual action, or rankings drop while the spam keeps growing. Links bought from \u201cfree high-DR backlink\u201d lists look exactly like these."),
        s.spamAnchors.length ? h("details", {}, h("summary", { class: "small" }, "Spam anchors found"), h("ul", { class: "small" }, s.spamAnchors.map((a) => h("li", {}, a)))) : null]
        : h("p", { class: "up" }, "✓ No spam pattern found in the links checked.")),
    h("div", { class: "grid g2" }, diffCard(d), mixCard(d.anchorMix)),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", {}, "Referring domains (by authority)"), table([{ label: "Domain", key: "domain" }, { label: "Rank", num: true, get: (r) => r.rank ?? "–" },
        { label: "Links", num: true, get: (r) => num(r.backlinks) }, { label: "Spam", num: true, get: (r) => r.spam ?? "–" },
        { label: "", get: (r) => (s.flagged.includes(r.domain) ? h("span", { class: "badge error" }, "spam") : "") }], x.referringDomains)),
      h("div", { class: "card" }, h("h2", {}, "Anchor texts"), table([{ label: "Anchor", get: (r) => r.anchor || h("i", { class: "muted" }, "(empty / image)") },
        { label: "Links", num: true, get: (r) => num(r.backlinks) }, { label: "Domains", num: true, get: (r) => num(r.domains) }], x.anchors))),
    h("div", { class: "grid g3" },
      h("div", { class: "card" }, h("h2", {}, "Top-level domains"), table([{ label: "TLD", key: "k" }, { label: "Links", num: true, get: (r) => num(r.v) }], top(x.tlds))),
      h("div", { class: "card" }, h("h2", {}, "Countries"), table([{ label: "Country", get: (r) => r.k || "unknown" }, { label: "Links", num: true, get: (r) => num(r.v) }], top(x.countries))),
      h("div", { class: "card" }, h("h2", {}, "Link types"), table([{ label: "Type", key: "k" }, { label: "Links", num: true, get: (r) => num(r.v) }], top(x.types))))];
};

/** "Gained / lost since <date>": referring domains that came and went between the last two snapshots (stored data). */
function diffCard(d) {
  const x = d.diff;
  if (!x) return h("div", { class: "card" }, h("h2", {}, "Gained / lost"), h("p", { class: "muted" }, d.diffNote));
  const signed = (v) => (v === null || v === undefined ? "–" : `${v >= 0 ? "+" : ""}${num(v)}`);
  const list = (rows, gained) => (rows.length
    ? h("ul", { class: "small", style: { margin: 0, paddingLeft: "18px" } }, rows.map((r) => h("li", {}, r.domain, h("span", { class: "muted" }, ` · rank ${r.rank ?? "–"}`),
      gained && x.newSpam.includes(r.domain) ? h("span", { class: "badge error", style: { marginLeft: "6px" } }, `spam ${r.spam}`) : null)))
    : h("p", { class: "small muted" }, "None."));
  return h("div", { class: "card" }, h("h2", {}, `Gained / lost since ${new Date(x.since + "Z").toLocaleDateString("en-AU")}`),
    h("p", { class: "small" }, `Backlinks ${signed(x.totals.backlinks)} · referring domains ${signed(x.totals.ref_domains)} · dofollow ${signed(x.totals.dofollow)} · spam score ${signed(x.totals.spam_score)}`),
    x.newSpam.length ? h("p", { class: "down" }, `✕ ${x.newSpam.length} new referring domain${x.newSpam.length > 1 ? "s have" : " has"} a spam score of 60 or more.`) : null,
    h("div", { class: "grid g2" },
      h("div", {}, h("h3", { style: { margin: "0 0 6px" } }, `Gained (${x.gained.length})`), list(x.gained, true)),
      h("div", {}, h("h3", { style: { margin: "0 0 6px" } }, `Lost (${x.lost.length})`), list(x.lost, false))),
    x.note ? h("p", { class: "hint", style: { marginBottom: 0 } }, x.note) : null);
}

/** Anchor mix by type (brand, naked URL, generic, exact-match commercial, other), weighted by links. */
function mixCard(m) {
  if (!m) return null;
  const bar = (share) => h("div", { style: { background: "var(--line-2, #d3d7dd)", borderRadius: "3px", height: "6px", minWidth: "60px" } },
    h("div", { style: { background: "var(--ink-3, #757c88)", borderRadius: "3px", height: "6px", width: `${Math.round(share * 100)}%` } }));
  return h("div", { class: "card" }, h("h2", {}, "Anchor mix"),
    m.warning ? h("p", { class: "down" }, "! " + m.warning) : null,
    table([{ label: "Type", key: "label" }, { label: "Links", num: true, get: (r) => num(r.backlinks) }, { label: "Share", num: true, get: (r) => `${Math.round(r.share * 100)}%` },
      { label: "", get: (r) => bar(r.share) }, { label: "Examples", get: (r) => h("span", { class: "small muted" }, r.anchors.join(" · ")) }], m.types),
    h("p", { class: "hint", style: { marginBottom: 0 } }, `From the top ${m.cap} anchors by links (${m.anchorsChecked} stored). Brand = project name, domain or brand names in project settings. `
      + (m.queriesUsed ? `Exact-match = the anchor is one of your top ${m.queriesUsed} non-brand Search Console queries; above 20% of links looks unnatural.` : "Connect Search Console to spot exact-match commercial anchors.")));
}

// ---------- App settings (global, route #/app) ----------
VIEWS.app = async () => {
  const [c, st] = await Promise.all([api("/api/config"), api("/api/dfs/status").catch((e) => ({ error: e.message }))]);
  const budgetIn = h("input", { type: "number", min: 0, max: 1000, step: "0.5", value: c.dfsMonthlyBudget });
  const loginIn = h("input", { type: "text", value: c.dfsLogin, placeholder: "or set an .mcp.json file below", autocomplete: "off" });
  const passIn = h("input", { type: "password", placeholder: c.hasPassword ? "saved — type to replace" : "", autocomplete: "new-password" });
  const keyIn = h("input", { type: "text", value: c.gscKeyFile, placeholder: "~/.config/claude-seo/gsc-service-account.json" });
  const mcpIn = h("input", { type: "text", value: c.dfsConfigPath || "", placeholder: "optional: path to an .mcp.json with DataForSEO" });
  const cruxIn = h("input", { type: "password", placeholder: c.hasCruxKey ? "saved — type to replace" : "AIza…", autocomplete: "off" });
  const cruxClear = c.hasCruxKey ? h("button", { type: "button", class: "btn sm", style: { marginTop: "4px" }, onclick: async () => {
    try { await api("/api/config", { method: "PUT", body: { clearCruxKey: true } }); toast("Chrome UX Report key removed"); cruxIn.placeholder = "AIza…"; cruxClear.remove(); }
    catch (err) { toast(err.message); }
  } }, "Remove key") : null;
  const save = async (e) => {
    e.preventDefault();
    try { const r = await api("/api/config", { method: "PUT", body: { dfsMonthlyBudget: Number(budgetIn.value), dfsLogin: loginIn.value, dfsPassword: passIn.value, gscKeyFile: keyIn.value, dfsConfigPath: mcpIn.value, cruxApiKey: cruxIn.value } });
      toast("Saved"); passIn.value = ""; cruxIn.value = ""; if (r.hasCruxKey) cruxIn.placeholder = "saved — type to replace"; }
    catch (err) { toast(err.message); }
  };
  const row = (l, el, hint) => [h("label", {}, l), h("div", {}, el, hint ? h("div", { class: "small muted" }, hint) : null)];
  const auto = await api("/api/autostart").catch(() => ({ supported: false }));
  const autoBox = h("input", { type: "checkbox", checked: auto.enabled, onchange: async (e) => {
    try { const r = await api("/api/autostart", { method: "PUT", body: { enabled: e.target.checked } }); e.target.checked = r.enabled; toast(r.enabled ? "SEO Auditor will start with Windows" : "Autostart turned off"); }
    catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  } });
  const startCard = auto.supported ? h("div", { class: "card" }, h("h2", {}, "Run in the background"),
    h("label", { class: "row" }, autoBox, "Start SEO Auditor when I sign in to Windows"),
    h("p", { class: "hint", style: { marginBottom: 0 } }, "Needed for scheduled audits: they only run while the app is running. It starts quietly with no window; open it any time from the desktop shortcut. To stop it, run scripts\\stop.ps1.")) : null;
  return [startCard, h("form", { class: "card", onsubmit: save }, h("h2", {}, "Accounts and budget"), h("div", { class: "form" },
      ...row("DataForSEO monthly budget (USD)", budgetIn, "Paid requests stop when this month's spend reaches it."),
      ...row("DataForSEO login", loginIn, `Now using: ${st.source || "–"}`), ...row("DataForSEO password", passIn, "Stored only in data/config.json on this PC."),
      ...row("DataForSEO .mcp.json file", mcpIn, "Instead of a login above: an MCP config whose dataforseo server has the login. Read where it is, never copied."),
      ...row("Search Console key file", keyIn, "Service-account JSON. Read where it is, never copied."),
      ...row("Chrome UX Report API key", h("div", {}, cruxIn, cruxClear), "Free field data (real Chrome users) for the Performance screen. Google Cloud console → enable “Chrome UX Report API” → Credentials → Create API key. Stored only in data/config.json on this PC; never shown again."),
      h("div", { class: "full" }, h("button", { class: "btn primary" }, "Save")))),
    h("div", { class: "card" }, h("h2", {}, "DataForSEO usage"),
      st.error ? h("p", { class: "down" }, st.error) : h("p", {}, `This month: $${(st.spent || 0).toFixed(3)} of $${(st.budget || 0).toFixed(2)} · balance ${typeof st.balance === "number" ? "$" + st.balance.toFixed(2) : "–"}`),
      table([{ label: "When", get: (r) => new Date(r.ts + "Z").toLocaleString("en-AU") }, { label: "Project", get: (r) => r.project || "" }, { label: "Request", key: "endpoint" },
        { label: "Cost", num: true, get: (r) => "$" + r.cost.toFixed(4) }], st.recent || [], { empty: "No paid requests yet." }))];
};
