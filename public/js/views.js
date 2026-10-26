// Main screens: projects, overview, issues, pages (+ page drawer), AI audit, history/compare, settings.
import { h, mount, api, toast, num, when, shortUrl, sevBadge, SEV_LABEL, meter, lineChart, barChart, table } from "./core.js";

export const VIEWS = {};
// Sidebar entries; other modules push more (with optional `section` headers).
export const NAV = [
  { view: "overview", label: "Overview" },
  { view: "issues", label: "Issues", badge: (s) => s.auditData?.audit.errors ? h("span", { class: "badge error" }, s.auditData.audit.errors) : null },
  { view: "pages", label: "Pages" },
  { view: "ai", label: "AI audit" },
  { view: "history", label: "History & compare" },
  { view: "settings", label: "Settings" },
];

const noAudit = (ctx) => h("div", { class: "card empty" }, h("h2", {}, "No finished audit yet"),
  h("p", {}, ctx.project.running ? "The first audit is running — results appear here when it finishes." : "Press “Run audit” to crawl the site."));

// ---------- Projects ----------
VIEWS.projects = async (ctx) => {
  const name = h("input", { type: "text", placeholder: "Name (optional)", style: { width: "180px" } });
  const url = h("input", { type: "url", placeholder: "https://example.com", required: true, style: { width: "280px" } });
  const form = h("form", { class: "row", onsubmit: async (e) => {
    e.preventDefault();
    try { const p = await api("/api/projects", { method: "POST", body: { name: name.value, start_url: url.value } }); location.hash = `#/p/${p.id}/settings`; toast("Project added — check settings, then run the audit"); }
    catch (err) { toast(err.message); }
  } }, url, name, h("button", { class: "btn primary" }, "Add website"));
  const list = ctx.projects.map((p) => {
    const a = p.last;
    return h("div", { class: "card" },
      h("div", { class: "card-h" }, h("div", {}, h("h2", {}, h("a", { href: `#/p/${p.id}/overview` }, p.name)), h("div", { class: "small muted" }, p.start_url)),
        p.running ? h("span", { class: "badge notice" }, "Audit running…") : null),
      a ? h("div", { class: "grid g2", style: { alignItems: "center" } },
        h("div", { class: "row", style: { gap: "18px" } }, meter(a.health, "Site Health", null, "tool score, not a Google metric"), meter(a.ai_readiness, "AI Readiness", null, "tool score, not a Google metric")),
        h("div", { class: "grid g3" },
          stat("Errors", a.errors, "error"), stat("Warnings", a.warnings, "warning"), stat("Notices", a.notices, "notice"),
          h("div", { class: "small muted", style: { gridColumn: "1/-1" } }, `${num(a.pages_crawled)} pages · ${when(a.finished_at)}`,
            p.healthDelta ? h("span", { class: p.healthDelta > 0 ? "up" : "down" }, ` · health ${p.healthDelta > 0 ? "+" : ""}${p.healthDelta}`) : null)))
        : h("p", { class: "muted" }, "Not audited yet."));
  });
  return [h("div", { class: "card" }, h("h2", {}, "Add a website"), h("p", { class: "hint" }, "Any site you can open in a browser. Crawls have no page limit unless you set one."), form),
    list.length ? h("div", { class: "grid g2" }, list) : null];
};

function stat(label, value, sev, delta, invert = true) {
  return h("div", { class: "stat" },
    h("div", { class: "k" }, sev ? h("span", { class: `dot sev-${sev}`, "aria-hidden": "true" }) : null, label),
    h("div", { class: "v" }, num(value)),
    delta !== null && delta !== undefined && delta !== 0 ? h("div", { class: "d " + ((invert ? delta < 0 : delta > 0) ? "up" : "down") }, `${delta > 0 ? "+" : ""}${num(delta)} since last audit`) : h("div", { class: "d muted" }, " "));
}

// ---------- Overview ----------
VIEWS.overview = async (ctx) => {
  if (!ctx.auditData) return noAudit(ctx);
  const { audit: a, previous: pr, groups, depth, statuses } = ctx.auditData;
  const d = (k) => (pr ? a[k] - pr[k] : null);
  const hist = ctx.project.history.filter((x) => x.status === "done").reverse();
  const top = groups.filter((g) => g.count && !g.ai).slice(0, 8);
  const info = a.site_info || {};
  const extra = (await Promise.all((overviewCards).map((f) => f(ctx).catch(() => null)))).filter(Boolean);
  return [
    h("div", { class: "grid g4" },
      h("div", { class: "card", title: "This tool's score, not a Google metric. Site Health = 100 × (1 − (pages with errors + ½ × pages with only warnings) ÷ pages crawled)" }, meter(a.health, "Site Health", pr ? `${a.health - pr.health >= 0 ? "+" : ""}${a.health - pr.health}` : null, "tool score, not a Google metric")),
      h("div", { class: "card", title: "This tool's score, not a Google metric" }, meter(a.ai_readiness, "AI Readiness", pr?.ai_readiness !== null && pr?.ai_readiness !== undefined ? `${a.ai_readiness - pr.ai_readiness >= 0 ? "+" : ""}${a.ai_readiness - pr.ai_readiness}` : null, "tool score, not a Google metric")),
      h("div", { class: "card" }, stat("Pages crawled", a.pages_crawled, null, d("pages_crawled"), false), h("div", { class: "small muted" }, `${num(info.sitemapUrls)} in sitemap`)),
      h("div", { class: "card grid g3", style: { gap: "8px" } }, stat("Errors", a.errors, "error", d("errors")), stat("Warnings", a.warnings, "warning", d("warnings")), stat("Notices", a.notices, "notice", d("notices")))),
    extra.length ? extra : null,
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("div", { class: "card-h" }, h("h2", {}, "Top issues"), h("a", { href: `#/p/${ctx.project.id}/issues` }, "All issues →")),
        top.length ? top.map((g) => h("div", { class: "row", style: { justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--grid)" } },
          h("a", { href: `#/p/${ctx.project.id}/issues/${g.id}` }, h("span", { class: `dot sev-${g.severity}`, "aria-hidden": "true", style: { marginRight: "8px" } }), g.title),
          h("span", { class: "row" }, g.added ? h("span", { class: "badge new" }, `${g.added} new`) : null, h("b", {}, num(g.count)))))
          : h("p", { class: "muted" }, "No SEO issues found.")),
      h("div", { class: "card" }, h("h2", {}, "Site Health over time"),
        hist.length > 1 ? lineChart(hist.map((x) => ({ x: when(x.finished_at), y: x.health, sub: `${x.errors} errors · ${x.warnings} warnings` })), { label: "Site Health per audit" })
          : h("p", { class: "muted" }, "The trend appears after the second audit."))),
    h("div", { class: "grid g3" },
      h("div", { class: "card" }, h("h2", {}, "Crawl depth (clicks from home)"), barChart(depth.map((r) => ({ x: r.depth === null ? "none" : String(r.depth), y: r.n })), { label: "Pages by click depth", unit: " pages" })),
      h("div", { class: "card" }, h("h2", {}, "HTTP status"), table([{ label: "Status", get: (r) => r.status || "not fetched (robots.txt or error)" }, { label: "Pages", num: true, get: (r) => num(r.n) }], statuses)),
      h("div", { class: "card" }, h("h2", {}, "Site files"), h("dl", { class: "kv" },
        h("dt", {}, "robots.txt"), h("dd", {}, info.robotsTxt ? "✓ found" : "✕ missing"),
        h("dt", {}, "Sitemap"), h("dd", {}, info.sitemapUrls ? `✓ ${num(info.sitemapUrls)} URLs${info.sitemapDeclared ? ", declared in robots.txt" : ""}` : "✕ not found"),
        h("dt", {}, "llms.txt"), h("dd", {}, info.llmsTxt ? "✓ found" : "– not found (optional)"),
        h("dt", {}, "JavaScript rendering"), h("dd", {}, info.renderJs ? "On" : "Off (HTML only)"),
        h("dt", {}, "Audit took"), h("dd", {}, a.started_at && a.finished_at ? `${Math.round((new Date(a.finished_at + "Z") - new Date(a.started_at + "Z")) / 1000)} s` : "–")))),
  ];
};
export const overviewCards = []; // other modules add async (ctx) => element

// ---------- Issues ----------
VIEWS.issues = async (ctx) => {
  if (!ctx.auditData) return noAudit(ctx);
  const groups = ctx.auditData.groups;
  const aid = ctx.auditData.audit.id;
  const tabs = [["all", "All"], ["error", "Errors"], ["warning", "Warnings"], ["notice", "Notices"], ["crawl", "Crawlability"], ["ai", "AI search"], ["fixed", "Fixed"]];
  let tab = ctx.route.q.tab || "all";
  const listEl = h("div", { class: "card", style: { padding: "6px 10px" } });
  const tabBar = h("div", { class: "tabs" });
  const draw = () => {
    mount(tabBar, tabs.map(([k, l]) => h("button", { class: k === tab ? "on" : "", onclick: () => { tab = k; draw(); } }, l, " ",
      h("span", { class: "muted" }, num(k === "all" ? groups.filter((g) => g.count && !g.ai).length : k === "crawl" ? groups.filter((g) => g.crawl && g.count).length : k === "ai" ? groups.filter((g) => g.ai && g.count).length : k === "fixed" ? groups.filter((g) => g.fixed).length : groups.filter((g) => g.severity === k && g.count && !g.ai).length)))));
    const shown = groups.filter((g) => tab === "fixed" ? g.fixed : tab === "ai" ? g.ai && g.count : tab === "crawl" ? g.crawl && g.count : g.count && !g.ai && (tab === "all" || g.severity === tab));
    const rows = shown.length ? shown.map((g) => issueRow(ctx, aid, g, g.id === ctx.route.arg)) : [h("div", { class: "empty" }, tab === "fixed" ? "Nothing fixed since the previous audit." : "No issues in this group.")];
    // Crawlability lists what passed too: an empty list should read as "checked and fine", not "not checked".
    const passed = tab === "crawl" ? (ctx.auditData.crawlChecks || []).filter((c) => !groups.some((g) => g.id === c.id && g.count)) : [];
    if (passed.length) rows.push(h("details", { style: { padding: "8px 2px" } }, h("summary", { class: "small" }, `Passed (${passed.length} of ${ctx.auditData.crawlChecks.length} crawlability checks)`),
      h("ul", { class: "small", style: { margin: "6px 0 0 18px" } }, passed.map((c) => h("li", {}, "✓ ", c.title)))));
    mount(listEl, rows);
  };
  draw();
  return [h("div", { class: "row", style: { justifyContent: "space-between" } }, h("p", { class: "hint", style: { margin: 0 } }, "Click an issue for why it matters, how to fix it and the affected URLs. AI-search issues and notices (including items marked information: not a Google ranking issue) don't count toward Site Health, which is this tool's score, not a Google metric."),
    h("div", { class: "row" }, h("a", { class: "btn sm", href: `/api/audits/${aid}/export/issues.csv` }, "Export issues CSV"), h("a", { class: "btn sm", href: `/api/audits/${aid}/export/links.csv` }, "Export links CSV"))),
    tabBar, listEl];
};

function issueRow(ctx, aid, g, open) {
  const body = h("div", { class: "body", hidden: !open });
  const btn = h("button", { "aria-expanded": String(!!open), onclick: () => { body.hidden = !body.hidden; btn.setAttribute("aria-expanded", String(!body.hidden)); if (!body.hidden && !body.childNodes.length) loadIssue(ctx, aid, g, body); } },
    h("span", { class: `dot sev-${g.severity}`, "aria-hidden": "true" }),
    h("span", {}, g.title, " ", h("span", { class: "small muted" }, `· ${SEV_LABEL[g.severity].slice(0, -1)}`)),
    h("span", { class: "row" }, g.added ? h("span", { class: "badge new" }, `${g.added} new`) : null, g.fixed ? h("span", { class: "badge fixed" }, `${g.fixed} fixed`) : null),
    h("span", { class: "n" }, num(g.count)));
  if (open) loadIssue(ctx, aid, g, body);
  return h("div", { class: "issue" }, btn, body);
}

async function loadIssue(ctx, aid, g, body) {
  mount(body, h("div", { class: "muted" }, "Loading…"));
  const d = await api(`/api/audits/${aid}/issues/${g.id}?limit=2000`);
  const base = ctx.project.start_url;
  mount(body,
    h("div", { class: "why" }, h("div", {}, h("b", {}, "Why it matters"), d.why), h("div", {}, h("b", {}, "How to fix"), d.fix)),
    d.rows.length ? table([
      { label: "URL", cls: "url", get: (r) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); pageDrawer(ctx, aid, r.url); } }, shortUrl(r.url, base)) },
      { label: "Detail", get: (r) => r.detail || "" },
      { label: "", get: (r) => (r.isNew ? h("span", { class: "badge new" }, "new") : "") },
    ], d.rows) : null,
    d.total > d.rows.length ? h("p", { class: "small muted" }, `Showing ${d.rows.length} of ${num(d.total)} — export CSV for all.`) : null,
    d.fixedUrls.length ? h("details", {}, h("summary", { class: "small" }, `${d.fixedUrls.length} URL(s) fixed since the previous audit`), h("ul", { class: "small" }, d.fixedUrls.map((u) => h("li", {}, shortUrl(u, base))))) : null);
}

// ---------- Pages ----------
VIEWS.pages = async (ctx) => {
  if (!ctx.auditData) return noAudit(ctx);
  const aid = ctx.auditData.audit.id, base = ctx.project.start_url;
  const q = { q: ctx.route.q.q || "", status: "", indexable: "", issue: ctx.route.q.issue || "", sort: "url", dir: "asc", offset: 0, limit: 100 };
  const out = h("div", {}); const info = h("span", { class: "small muted" });
  const search = h("input", { type: "search", placeholder: "Search URL or title", value: q.q, style: { width: "260px" }, oninput: debounce(() => { q.q = search.value; q.offset = 0; load(); }, 250) });
  const sel = (key, opts) => h("select", { onchange: (e) => { q[key] = e.target.value; q.offset = 0; load(); } }, opts.map(([v, l]) => h("option", { value: v, selected: q[key] === v }, l)));
  const issueOpts = [["", "Any issue"], ...ctx.auditData.groups.filter((g) => g.count).map((g) => [g.id, g.title])];
  const cols = [
    { key: "url", label: "URL", cls: "url", get: (r) => shortUrl(r.url, base) },
    { key: "status", label: "Status", num: true }, { key: "depth", label: "Depth", num: true },
    { key: "inlinks", label: "Inlinks", num: true }, { key: "words", label: "Words", num: true },
    { key: "response_ms", label: "TTFB ms", num: true }, { key: "issues", label: "Issues", num: true, get: (r) => h("span", {}, r.errors ? h("span", { class: "badge error" }, r.errors) : null, " ", num(r.issues)) },
    { key: "clicks", label: "Clicks", num: true, get: (r) => num(r.clicks) }, { key: "impressions", label: "Impr.", num: true, get: (r) => num(r.impressions) },
  ];
  async function load() {
    const d = await api(`/api/audits/${aid}/pages?` + new URLSearchParams(q));
    info.textContent = `${num(d.total)} pages${d.total > q.limit ? ` · ${q.offset + 1}–${Math.min(q.offset + q.limit, d.total)}` : ""}`;
    const th = (c) => h("th", { class: "sortable " + (c.num ? "num" : ""), onclick: () => { q.dir = q.sort === c.key && q.dir === "asc" ? "desc" : "asc"; q.sort = c.key; load(); } }, c.label, q.sort === c.key ? (q.dir === "asc" ? " ▲" : " ▼") : "");
    mount(out, h("div", { class: "tbl-wrap" }, h("table", { class: "t" }, h("thead", {}, h("tr", {}, cols.map(th))),
      h("tbody", {}, d.rows.map((r) => h("tr", { style: { cursor: "pointer" }, onclick: () => pageDrawer(ctx, aid, r.url) },
        cols.map((c) => h("td", { class: [c.num ? "num" : "", c.cls || ""].join(" "), title: c.key === "url" ? r.title || "" : null }, c.get ? c.get(r) : num(r[c.key])))))))),
      d.total > q.limit ? h("div", { class: "row", style: { marginTop: "10px" } },
        h("button", { class: "btn sm", disabled: q.offset === 0, onclick: () => { q.offset = Math.max(0, q.offset - q.limit); load(); } }, "← Previous"),
        h("button", { class: "btn sm", disabled: q.offset + q.limit >= d.total, onclick: () => { q.offset += q.limit; load(); } }, "Next →")) : null);
  }
  await load();
  return [h("div", { class: "row" }, search, sel("status", [["", "Any status"], ["ok", "200 OK"], ["redirect", "Redirects"], ["error", "Errors (4xx/5xx)"]]),
    sel("indexable", [["", "Indexable or not"], ["1", "Indexable"], ["0", "Not indexable"]]), sel("issue", issueOpts), info,
    h("a", { class: "btn sm", href: `/api/audits/${aid}/export/pages.csv`, style: { marginLeft: "auto" } }, "Export pages CSV")), out];
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Page detail sections can be extended by other modules: async (ctx, detail) => element
export const pageSections = [];
export async function pageDrawer(ctx, aid, url) {
  const d = await api(`/api/audits/${aid}/page?url=${encodeURIComponent(url)}`);
  const p = d.page, x = p.data || {}, base = ctx.project.start_url;
  const extra = (await Promise.all(pageSections.map((f) => f(ctx, d).catch(() => null)))).filter(Boolean);
  ctx.app.openDrawer(
    h("h2", { style: { marginBottom: "4px", paddingRight: "90px" } }, p.title || shortUrl(p.url, base)),
    h("p", { class: "small" }, h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.url), p.final_url && p.final_url !== p.url ? ` → ${p.final_url}` : ""),
    h("div", { class: "stack" },
      serpPreview(p),
      d.issues.length ? h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, `Issues on this page (${d.issues.length})`),
        d.issues.map((i) => h("div", { style: { padding: "6px 0", borderBottom: "1px solid var(--grid)" } }, sevBadge(i.severity), " ", h("b", {}, i.title || i.check_id), i.detail ? h("span", { class: "muted" }, " — " + i.detail) : null, h("div", { class: "small muted" }, i.fix))))
        : h("div", { class: "card" }, "✓ No issues on this page."),
      extra,
      h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, "Details"), h("dl", { class: "kv" },
        ...kv("Status", `${p.status}${x.redirect ? ` (redirect, ${x.redirect.hops} hop${x.redirect.hops > 1 ? "s" : ""})` : ""}`),
        ...kv("Indexable", p.indexable ? "Yes" : `No${x.noindexSource ? " — noindex via " + x.noindexSource : p.canonical && p.canonical !== p.url ? " — canonical points elsewhere" : ""}`),
        ...kv("Canonical", p.canonical || "none"), ...kv("H1", p.h1 || "none"),
        ...kv("Words", num(p.words)), ...kv("Text/HTML", `${p.text_ratio}%`), ...kv("HTML size", `${num(Math.round(p.bytes / 1024))} KB`),
        ...kv("Server response", `${num(p.response_ms)} ms`), ...kv("Click depth", p.depth ?? "not linked"), ...kv("In sitemap", p.in_sitemap ? "Yes" : "No"),
        ...kv("Schema types", (x.schemaTypes || []).join(", ") || "none"), ...kv("Language", x.lang || "–"),
        ...kv("Open Graph", x.og ? "✓" : "missing"), ...kv("Author / date", `${x.author ? "author ✓" : "no author"} · ${x.dated ? "dated ✓" : "no date"}`))),
      d.gsc ? h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, `Google Search (${d.gsc.start_date} → ${d.gsc.end_date})`),
        h("div", { class: "grid g4" }, stat("Clicks", d.gsc.clicks), stat("Impressions", d.gsc.impressions), h("div", { class: "stat" }, h("div", { class: "k" }, "CTR"), h("div", { class: "v" }, `${(d.gsc.ctr * 100).toFixed(1)}%`)), h("div", { class: "stat" }, h("div", { class: "k" }, "Avg position"), h("div", { class: "v" }, d.gsc.position?.toFixed(1))))) : null,
      h("details", { class: "card" }, h("summary", {}, h("b", {}, `Internal links to this page (${d.inlinks.length})`)), table([{ label: "From", cls: "url", get: (r) => shortUrl(r.from_url, base) }, { label: "Anchor", get: (r) => r.anchor || h("i", { class: "muted" }, "(no text)") }], d.inlinks)),
      h("details", { class: "card" }, h("summary", {}, h("b", {}, `Links on this page (${d.outlinks.length})`)), table([{ label: "To", cls: "url", get: (r) => shortUrl(r.to_url, base) }, { label: "Anchor", get: (r) => r.anchor || "" }, { label: "", get: (r) => [r.internal ? "" : "external", r.nofollow ? " nofollow" : ""].join("") }], d.outlinks))));
}
const kv = (k, v) => [h("dt", {}, k), h("dd", {}, String(v))];

// Google truncates by pixel width (≈580 px title at 20px Arial, ≈920 px description at 14px), not characters.
const measure = (() => { const c = document.createElement("canvas").getContext("2d"); return (t, font) => { c.font = font; return c.measureText(t).width; }; })();
function fit(text, font, max) {
  if (measure(text, font) <= max) return { text, cut: false };
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(text.slice(0, mid) + " …", font) <= max) lo = mid; else hi = mid - 1; }
  return { text: text.slice(0, lo).replace(/\s+\S*$/, "") + " …", cut: true };
}
function serpPreview(p) {
  const t = fit(p.title || "(no title)", "20px Arial", 580), de = fit(p.description || "(no meta description — Google will pick text from the page)", "14px Arial", 920);
  const tw = Math.round(measure(p.title || "", "20px Arial")), dw = Math.round(measure(p.description || "", "14px Arial"));
  return h("div", { class: "card" }, h("h3", { style: { marginBottom: "8px" } }, "Google result preview"),
    h("div", { class: "serp" }, h("div", { class: "u" }, p.final_url || p.url), h("div", { class: "ti" }, t.text), h("div", { class: "de" }, de.text)),
    h("p", { class: "small muted", style: { marginBottom: 0 } }, `Title ${(p.title || "").length} chars / ${tw} px${t.cut ? " — cut off in results" : ""} · Description ${(p.description || "").length} chars / ${dw} px${de.cut ? " — cut off" : ""}`));
}

// ---------- AI audit ----------
VIEWS.ai = async (ctx) => {
  if (!ctx.auditData) return noAudit(ctx);
  const { audit: a, groups } = ctx.auditData;
  const ai = groups.filter((g) => g.ai && g.count);
  const bots = a.site_info?.aiBots || [];
  return [h("div", { class: "grid g2" },
    h("div", { class: "card" }, meter(a.ai_readiness, "AI Readiness", null, "tool score, not a Google metric"),
      h("p", { class: "hint" }, "This tool's estimate of how easily AI search (Google AI Overviews and AI Mode, ChatGPT search, Perplexity, Copilot) can fetch, understand and quote your pages; not a Google metric. Each indexable page starts at 100 and loses points per AI issue; each blocked AI search crawler costs 15 points. Training opt-outs (Google-Extended, GPTBot, ClaudeBot…) cost nothing: blocking them doesn't affect search.")),
    h("div", { class: "card" }, h("h2", {}, "AI crawler access (robots.txt)"),
      table([{ label: "Crawler", key: "bot" }, { label: "Purpose", get: (r) => ({ search: "Search / answers", training: "Training opt-out token", other: "Other (not Search)" })[r.kind] || "–" },
        { label: "Access", get: (r) => (r.allowed ? h("span", { class: "up" }, "✓ allowed") : h("span", { class: r.kind === "search" || !r.kind ? "down" : "muted" }, "✕ blocked")) }], bots),
      h("p", { class: "small muted" }, a.site_info?.llmsTxt ? "llms.txt: found (optional; Google ignores it)." : "llms.txt: not found (optional; Google ignores it)."))),
    h("div", { class: "card", style: { padding: "6px 10px" } }, ai.length ? ai.map((g) => issueRow(ctx, a.id, g, false)) : h("div", { class: "empty" }, "No AI-search issues found."))];
};

// ---------- History & compare ----------
VIEWS.history = async (ctx) => {
  const hist = ctx.project.history;
  const done = hist.filter((x) => x.status === "done");
  const out = h("div", {});
  const selA = h("select", {}, done.map((x, i) => h("option", { value: x.id, selected: i === 1 }, `${when(x.finished_at)} · health ${x.health}`)));
  const selB = h("select", {}, done.map((x, i) => h("option", { value: x.id, selected: i === 0 }, `${when(x.finished_at)} · health ${x.health}`)));
  async function compare() {
    if (selA.value === selB.value) { mount(out, h("p", { class: "muted" }, "Pick two different audits.")); return; }
    const c = await api(`/api/compare/${selA.value}/${selB.value}`);
    const base = ctx.project.start_url;
    const list = (rows) => table([{ label: "Issue", get: (r) => h("span", {}, h("span", { class: `dot sev-${r.severity}`, "aria-hidden": "true", style: { marginRight: "6px" } }), r.title || r.check) }, { label: "URL", cls: "url", get: (r) => shortUrl(r.url, base) }], rows, { empty: "None" });
    mount(out, h("div", { class: "grid g4", style: { margin: "14px 0" } },
      stat("Health", c.newer.health, null, c.newer.health - c.older.health, false), stat("Errors", c.newer.errors, "error", c.newer.errors - c.older.errors),
      stat("New issues", c.added.length), stat("Fixed issues", c.fixed.length)),
      h("div", { class: "grid g2" }, h("div", { class: "card" }, h("h2", {}, `New issues (${c.added.length})`), list(c.added)), h("div", { class: "card" }, h("h2", {}, `Fixed (${c.fixed.length})`), list(c.fixed))),
      c.newPages.length || c.lostPages.length ? h("div", { class: "card", style: { marginTop: "16px" } }, h("h2", {}, "Pages found / gone"),
        h("p", { class: "small" }, `New: ${c.newPages.length} · No longer found: ${c.lostPages.length}`),
        h("ul", { class: "small" }, c.newPages.slice(0, 50).map((u) => h("li", {}, "+ " + shortUrl(u, base))), c.lostPages.slice(0, 50).map((u) => h("li", {}, "− " + shortUrl(u, base))))) : null);
  }
  if (done.length > 1) compare();
  return [h("div", { class: "card" }, h("h2", {}, "Audits"), table([
    { label: "Finished", get: (r) => when(r.finished_at || r.started_at) }, { label: "Status", key: "status" },
    { label: "Pages", num: true, get: (r) => num(r.pages_crawled) }, { label: "Health", num: true, get: (r) => r.health ?? "–" }, { label: "AI", num: true, get: (r) => r.ai_readiness ?? "–" },
    { label: "Errors", num: true, get: (r) => num(r.errors) }, { label: "Warnings", num: true, get: (r) => num(r.warnings) }, { label: "Notices", num: true, get: (r) => num(r.notices) },
    { label: "", get: (r) => (r.status === "done" ? h("a", { href: `#/p/${ctx.project.id}/overview?a=${r.id}` }, "Open") : r.message || "") }], hist, { empty: "No audits yet." })),
  done.length > 1 ? h("div", { class: "card" }, h("h2", {}, "Compare two audits"), h("div", { class: "row" }, selA, "→", selB, h("button", { class: "btn", onclick: compare }, "Compare")), out) : null];
};

// ---------- Settings ----------
VIEWS.settings = async (ctx) => {
  const p = ctx.project, s = p.settings;
  const f = {
    name: h("input", { type: "text", value: p.name }), start_url: h("input", { type: "url", value: p.start_url }),
    maxPages: h("input", { type: "number", min: 0, value: s.maxPages }), concurrency: h("input", { type: "number", min: 1, max: 20, value: s.concurrency }),
    renderJs: h("input", { type: "checkbox", checked: s.renderJs }), respectRobots: h("input", { type: "checkbox", checked: s.respectRobots }),
    includeSubdomains: h("input", { type: "checkbox", checked: s.includeSubdomains }), checkExternalLinks: h("input", { type: "checkbox", checked: s.checkExternalLinks }),
    auditBlockedUrls: h("input", { type: "checkbox", checked: s.auditBlockedUrls === true }),
    siteProbes: h("input", { type: "checkbox", checked: s.siteProbes === true }),
    schedule: h("select", {}, [["off", "Off"], ["daily", "Daily"], ["weekly", "Weekly"]].map(([v, l]) => h("option", { value: v, selected: s.schedule === v }, l))),
    cwvPages: h("input", { type: "number", min: 0, max: 50, value: s.cwvPages }), gscProperty: h("input", { type: "text", value: s.gscProperty, placeholder: "sc-domain:example.com or https://example.com/" }),
    localFolder: h("input", { type: "text", value: s.localFolder || "", placeholder: "C:\\path\\to\\site (optional)" }),
    dfsLocation: h("input", { type: "number", min: 0, value: s.dfsLocation }), aiLocation: h("input", { type: "number", min: 0, value: s.aiLocation }),
    brandTerms: h("input", { type: "text", value: s.brandTerms || "", placeholder: "e.g. Acme Plumbing, Acme" }),
    spamAllowTerms: h("input", { type: "text", value: s.spamAllowTerms || "", placeholder: "e.g. casino (only when the site is about it)" }),
    userAgent: h("input", { type: "text", value: s.userAgent }),
    napName: h("input", { type: "text", value: s.napName || "", placeholder: "From the home page's schema when empty" }),
    napAddress: h("input", { type: "text", value: s.napAddress || "", placeholder: "e.g. 5 Main Street, Springfield VIC 3000" }),
    napPhone: h("input", { type: "text", value: s.napPhone || "", placeholder: "e.g. 03 9000 0000" }),
  };
  const row = (label, el, hint) => [h("label", {}, label), h("div", {}, el, hint ? h("div", { class: "small muted" }, hint) : null)];
  const save = async (e) => {
    e.preventDefault();
    const settings = {}; for (const k of Object.keys(s)) if (f[k]) settings[k] = f[k].type === "checkbox" ? f[k].checked : f[k].type === "number" ? Number(f[k].value) : f[k].value;
    if (f.localFolder.value || s.localFolder) settings.localFolder = f.localFolder.value;
    try { await api(`/api/projects/${p.id}`, { method: "PUT", body: { name: f.name.value, start_url: f.start_url.value, settings } }); toast("Saved"); ctx.app.refresh(); } catch (err) { toast(err.message); }
  };
  return [h("form", { class: "card", onsubmit: save }, h("h2", {}, "Project settings"), h("div", { class: "form" },
    ...row("Name", f.name), ...row("Start URL", f.start_url),
    ...row("Page limit", f.maxPages, "0 = no limit"), ...row("Parallel requests", f.concurrency, "Lower (2–3) for small shared hosting"),
    ...row("Render JavaScript", f.renderJs, "Uses headless Chrome; slower. Turn on for React/Vue sites."),
    ...row("Respect robots.txt", f.respectRobots), ...row("Include subdomains", f.includeSubdomains), ...row("Check external links", f.checkExternalLinks),
    ...row("Check robots-blocked URLs", f.auditBlockedUrls, "Fetches up to 50 robots.txt-blocked URLs your site links to, once each, to find a noindex Google can't see. Only for sites you own (off by default)."),
    ...row("Extra site probes", f.siteProbes, "Up to 60 requests after the crawl, one at a time: search result pages, what Googlebot and phones get, staging copies, 304 and compression, exposed .env/.git files, certificate expiry, language redirects. Only for sites you own (off by default)."),
    ...row("Scheduled audit", f.schedule, "Runs while the app is open (it starts with Windows if enabled in README)."),
    ...row("Core Web Vitals pages", f.cwvPages, "Measured in headless Chrome after each audit (0 = off)"),
    ...row("Search Console property", f.gscProperty, "Uses the service account file; add its email as a user in Search Console."),
    ...row("Local site folder", f.localFolder, "If the site's files are on this PC, issues link to the file to edit."),
    ...row("Keyword country (DataForSEO)", f.dfsLocation, "Location code: 2036 Australia, 2840 USA, 2826 UK, 2124 Canada"),
    ...row("Local search location", f.aiLocation, "City code for Google / AI Mode checks, e.g. 9199156 = Dandenong VIC. 0 = same as country."),
    ...row("Brand names", f.brandTerms, "Extra names that count as a mention in AI answers (comma-separated)."),
    ...row("Allowed spam words", f.spamAllowTerms, "Words the hacked-content check never reports here, when the site is genuinely about them (comma-separated)."),
    ...row("Business name", f.napName, "Business listings are checked against this name, address and phone. Leave all three empty to use the home page's LocalBusiness schema."),
    ...row("Business address", f.napAddress), ...row("Business phone", f.napPhone),
    ...row("User agent", f.userAgent),
    h("div", { class: "full row" }, h("button", { class: "btn primary" }, "Save settings")))),
  h("div", { class: "card" }, h("h2", {}, "Danger zone"), h("button", { class: "btn danger", onclick: async () => {
    if (!confirm(`Delete ${p.name} and all its audits? This can't be undone.`)) return;
    await api(`/api/projects/${p.id}`, { method: "DELETE" }); location.hash = "#/"; toast("Project deleted");
  } }, "Delete project"))];
};
