// Research (REQ-055 group 6): keyword ideas from Google Autocomplete (src/kw-ideas.mjs), search clusters from Search
// Console (src/clusters.mjs), the competitor content gap (src/competitor-gap.mjs), content briefs (src/content-brief.mjs, paid); and the Content inventory screen (src/content-inventory.mjs). Free reads go through the
// tool's polite reader (robots.txt, one request at a time, its own user agent); anything paid is a separate button with
// its cost on it.
import { h, mount, api, toast, num, shortUrl, table, sparkline } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "competitors") + 1, 0, { view: "research", label: "Research" }, { view: "inventory", label: "Content inventory" });

export const spendLine = (st) => (st && !st.error ? h("span", { class: "small muted" }, `DataForSEO this month: $${(st.spent || 0).toFixed(3)} of $${(st.budget || 0).toFixed(2)} budget`) : null);
const filterBox = (placeholder, on) => h("input", { type: "search", placeholder, style: { width: "260px", maxWidth: "100%" }, oninput: (e) => on(e.target.value.trim().toLowerCase()) });

/** Polls a background job's GET until it stops, re-rendering the card each time (stops when the card leaves the page). */
export function pollJob(card, load, render) {
  const tick = async () => {
    if (!card.isConnected) return;
    try { const d = await load(); render(d); if (d.job?.running) setTimeout(tick, 3000); } catch (e) { toast(e.message); }
  };
  setTimeout(tick, 1500);
}
export const jobLine = (job) => job?.running ? h("p", { class: "small" }, `Working: ${num(job.done)} of ${num(job.total)}${job.note ? ` · ${job.note}` : ""} (a polite pace: one request every few seconds)`)
  : job?.error ? h("p", { class: "small", style: { color: "var(--warn-ink)" } }, `Last run failed: ${job.error}`) : null;

const INTENT = { question: "Question", comparison: "Comparison", transactional: "Transactional", navigational: "Brand", informational: "Informational" };

async function ideasCard(ctx) {
  const pid = ctx.project.id, url = `/api/projects/${pid}/keyword-ideas`;
  const card = h("div", { class: "card" });
  const [first, st] = await Promise.all([api(url), api("/api/dfs/status").catch(() => null)]);
  let filter = "";
  const render = (d) => {
    const az = h("input", { type: "checkbox" });
    const start = h("button", { class: "btn primary", disabled: d.job?.running || !d.seeds.length, onclick: async () => {
      start.disabled = true;
      try { await api(url, { method: "POST", body: { az: az.checked } }); pollJob(card, () => api(url), render); render({ ...d, job: { running: true, done: 0, total: 0 } }); }
      catch (e) { toast(e.message); start.disabled = false; }
    } }, d.total ? "Get more ideas" : "Get ideas (free)");
    const missing = d.total - d.withVolume;
    const cost = (0.01 + 0.0001 * Math.min(missing, d.caps.volumes)).toFixed(3);
    const paid = h("button", { class: "btn quiet", disabled: !missing || !st?.configured || d.job?.running, title: st?.configured ? "" : "Add a DataForSEO login in Settings first", onclick: async () => {
      paid.disabled = true; paid.textContent = "Fetching…";
      try { const r = await api(`${url}/volumes`, { method: "POST", body: {} }); toast(`Volumes for ${r.updated} of ${r.asked} ideas`); ctx.app.refresh(); }
      catch (e) { toast(e.message); paid.disabled = false; paid.textContent = `Get search volumes (paid, ≈ $${cost})`; }
    } }, `Get search volumes (paid, ≈ $${cost})`);
    const list = h("div", {});
    const draw = () => {
      const rows = d.ideas.filter((x) => !filter || x.idea.includes(filter) || x.seed?.includes(filter));
      mount(list, rows.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "t" },
        h("thead", {}, h("tr", {}, ["Idea", "From seed", "Modifier", "Intent", "Your impressions (28 d)", "Volume", "Difficulty"].map((l, i) => h("th", { class: i > 3 ? "num" : "" }, l)))),
        h("tbody", {}, rows.slice(0, 400).map((x) => h("tr", {},
          h("td", {}, h("b", {}, x.idea), x.isTarget ? h("span", { class: "small muted" }, " · target") : ""),
          h("td", { class: "small" }, x.seed), h("td", { class: "small muted" }, x.modifier), h("td", { class: "small" }, INTENT[x.intent] || x.intent),
          h("td", { class: "num" }, x.gscImpressions === null ? "–" : num(x.gscImpressions)),
          h("td", { class: "num" }, x.volume === null ? "–" : num(x.volume)), h("td", { class: "num" }, x.difficulty === null ? "–" : num(x.difficulty)))))))
        : h("div", { class: "empty" }, d.total ? "No idea matches the filter" : "No ideas yet"),
      rows.length > 400 ? h("p", { class: "small muted" }, `First 400 of ${num(rows.length)} shown: filter to narrow.`) : null);
    };
    draw();
    mount(card, h("div", { class: "card-h" }, h("h2", {}, "Keyword ideas"), h("div", { class: "row" }, h("label", { class: "small" }, az, " also a–z"), start, paid)),
      h("p", { class: "hint" }, "Source: Google Autocomplete (what people start typing, not how often). Seeds: your target keywords (Settings), then your top non-brand searches in Search Console",
        d.seeds.length ? `: ${d.seeds.join(", ")}.` : ". None yet: add target keywords in Settings.",
        ` Each seed is asked alone, with question words and with vs / for / near; at most ${d.caps.requests} requests a run, read politely and cached for 7 days. Volumes appear only after you press the paid button.`),
      h("div", { class: "row" }, spendLine(st), h("span", { class: "small muted" }, `${num(d.total)} ideas · ${num(d.withVolume)} with a volume`)),
      jobLine(d.job), d.total ? filterBox("Filter ideas", (v) => { filter = v; draw(); }) : null, list,
      h("p", { class: "small muted" }, "Write for an idea only where your page genuinely answers it. Never paste lists of searches into a page."));
  };
  render(first);
  if (first.job?.running) pollJob(card, () => api(url), render);
  return card;
}

const HOW = { leader: "main search", pages: "same pages", words: "same words" };
async function clustersCard(ctx) {
  const d = await api(`/api/projects/${ctx.project.id}/clusters`);
  const base = ctx.project.start_url;
  const card = h("div", { class: "card" });
  const head = [h("h2", {}, "Search clusters"),
    h("p", { class: "hint" }, "Your non-brand searches (Search Console, last 28 days) grouped without paid data: searches Google answers with the same pages (co-ranking) and searches made of the same words. ",
      "A gap means no page's title or H1 covers the cluster's main search, or only the home page does: a dedicated page or section may serve those searchers better. Heuristic grouping: check the searches before acting.")];
  if (!d.connected) return mount(card, ...head, h("div", { class: "empty" }, "Connect Search Console (Settings) to see clusters."));
  if (!d.clusters.length) return mount(card, ...head, h("div", { class: "empty" }, "No non-brand searches yet."));
  let gapsOnly = false;
  const list = h("div", {});
  const draw = () => mount(list, table([
    { label: "Main search", get: (c) => h("details", {}, h("summary", {}, h("b", {}, c.head), c.size > 1 ? h("span", { class: "small muted" }, ` + ${c.size - 1}`) : ""),
      h("ul", { class: "small", style: { margin: "6px 0" } }, c.queries.map((x) => h("li", {}, `${x.query} · ${num(x.impressions)} impressions · ${HOW[x.how]}`)))) },
    { label: "Searches", num: true, get: (c) => num(c.size) },
    { label: "Impressions", num: true, get: (c) => num(c.impressions) },
    { label: "Clicks", num: true, get: (c) => num(c.clicks) },
    { label: "Avg position", num: true, get: (c) => c.position ?? "–" },
    { label: "Best page", cls: "url", get: (c) => h("a", { href: c.bestPage, target: "_blank", rel: "noopener" }, shortUrl(c.bestPage, base)) },
    { label: "Gap", get: (c) => c.gap ? h("span", { class: "small", style: { color: "var(--warn-ink)" } }, c.gap) : h("span", { class: "small muted" }, c.dedicatedPage ? `covered by ${shortUrl(c.dedicatedPage, base)}` : "–") },
  ], d.clusters.filter((c) => !gapsOnly || c.gap)));
  draw();
  return mount(card, ...head,
    h("div", { class: "row" }, h("span", { class: "small muted" }, `${num(d.queries)} searches · ${num(d.total)} clusters (${num(d.multi)} with 2+ searches) · ${num(d.gaps)} gaps${d.audited ? "" : " (run an audit to find gaps)"}`),
      h("label", { class: "small" }, h("input", { type: "checkbox", onchange: (e) => { gapsOnly = e.target.checked; draw(); } }), " gaps only")),
    d.hubs.length ? h("p", { class: "small muted" }, `Hub pages (rank for a large share of searches, so sharing them alone doesn't group searches): ${d.hubs.join(", ")}`) : null,
    list);
}

async function compGapCard(ctx) {
  const pid = ctx.project.id, url = `/api/projects/${pid}/competitor-gap`;
  const card = h("div", { class: "card" });
  const render = (d) => {
    const box = h("textarea", { rows: 3, maxLength: 500, style: { width: "100%" }, placeholder: "rival.com.au\nother-rival.com" }, ctx.project.settings.competitorDomains || "");
    const save = h("button", { class: "btn", onclick: async () => {
      try { await api(`/api/projects/${pid}`, { method: "PUT", body: { settings: { competitorDomains: box.value } } }); ctx.project.settings.competitorDomains = box.value; render(await api(url)); toast("Saved"); }
      catch (e) { toast(e.message); }
    } }, "Save");
    const start = h("button", { class: "btn primary", disabled: d.job?.running || !d.domains.length, onclick: async () => {
      start.disabled = true;
      try { await api(url, { method: "POST", body: {} }); render({ ...d, job: { running: true, done: 0, total: d.domains.length } }); pollJob(card, () => api(url), render); }
      catch (e) { toast(e.message); start.disabled = false; }
    } }, d.sites.some((x) => x.fetchedAt) ? "Read again" : "Read competitors (free)");
    mount(card, h("div", { class: "card-h" }, h("h2", {}, "Topics competitors cover that you don't"), start),
      h("p", { class: "hint" }, `Up to ${d.caps.domains} competitors. For each: robots.txt and its XML sitemaps, up to ${d.caps.urls} addresses, and the title and H1 of up to ${d.caps.pages} pages robots.txt allows (never their body text), `,
        "read politely with this tool's own user agent and cached for 7 days. Sections that are one template with a place, brand or insurer swapped in are set aside. ",
        "Their titles are shown as evidence only: write your own page or section, and only for things you genuinely offer."),
      h("div", { class: "row" }, box, save), jobLine(d.job),
      d.sites.length ? h("ul", { class: "small" }, d.sites.map((x) => h("li", {}, h("b", {}, x.origin), x.fetchedAt
        ? x.error ? h("span", { style: { color: "var(--warn-ink)" } }, ` · ${x.error}`)
          : ` · ${num(x.sitemapUrls)} addresses in the sitemap · ${num(x.kept)} kept${x.templated.length ? ` (templated set aside: /${x.templated.join(", /")})` : ""} · ${num(x.read)} pages read · ${num(x.blocked)} disallowed by robots.txt`
        : " · not read yet"))) : null,
      d.sites.some((x) => x.fetchedAt) ? h("p", { class: "small muted" }, `${num(d.topics)} topics · ${num(d.covered)} you already cover (a page title/H1, an H2/H3 section or a search you get) · `, h("b", {}, `${num(d.gapCount)} you don't`), d.audited ? "" : " (run an audit of your site for a fair comparison)") : null,
      d.gaps.length ? table([
        { label: "Topic", get: (g) => h("b", {}, g.examples[0]?.title || g.core.join(" ")) },
        { label: "Competitors", num: true, get: (g) => num(g.competitors.length) },
        { label: "Their pages", num: true, get: (g) => num(g.pages) },
        { label: "Examples", get: (g) => h("div", { class: "small" }, g.examples.map((x) => h("div", {}, h("a", { href: x.url, target: "_blank", rel: "noopener" }, x.title), x.fromAddress ? h("span", { class: "muted" }, " (from the address)") : ""))) },
      ], d.gaps) : null);
  };
  render(await api(url));
  return card;
}

async function briefCard(ctx) {
  const pid = ctx.project.id, url = `/api/projects/${pid}/briefs`;
  const card = h("div", { class: "card" });
  const [st] = await Promise.all([api("/api/dfs/status").catch(() => null)]);
  const view = h("div", {});
  const show = async (id) => {
    try {
      const b = await api(`${url}/${id}`);
      const sec = (title, kids) => [h("h3", { style: { margin: "14px 0 6px" } }, title), kids];
      mount(view, h("div", { class: "card-h" }, h("h3", {}, `“${b.topic}”`), h("span", { class: "small muted" }, `${b.createdAt} · ${b.status}`),
          h("button", { class: "btn sm", onclick: async () => { try { await api(`${url}/${id}`, { method: "DELETE" }); mount(view); render(await api(url)); } catch (e) { toast(e.message); } } }, "Delete")),
        b.status === "reading" ? h("p", { class: "small" }, "Reading the top results' headings politely…") : null,
        ...sec("Headings the top pages use (merged; pages using each)", b.headings.length ? table([{ label: "Heading", get: (x) => h("span", { title: x.variants.join(" · ") }, x.text) }, { label: "Pages", num: true, get: (x) => num(x.pages) }], b.headings) : h("p", { class: "small muted" }, "None read yet.")),
        ...sec("People also ask", b.paa.length ? h("ul", { class: "small" }, b.paa.map((q) => h("li", {}, q))) : h("p", { class: "small muted" }, "None shown for this search.")),
        ...sec("Your searches with these words (Search Console, questions first)", b.siteSearches.length ? table([{ label: "Search", get: (x) => x.query }, { label: "Impressions", num: true, get: (x) => num(x.impressions) }, { label: "Clicks", num: true, get: (x) => num(x.clicks) }], b.siteSearches) : h("p", { class: "small muted" }, "None.")),
        ...sec("Related searches", b.related.length ? h("p", { class: "small" }, b.related.join(" · ")) : h("p", { class: "small muted" }, "None.")),
        ...sec("Top 10 results", table([{ label: "#", num: true, get: (x) => x.pos ?? "" }, { label: "Result", get: (x) => h("a", { href: x.url, target: "_blank", rel: "noopener" }, x.title || x.url) },
          { label: "Headings read", get: (x) => h("span", { class: "small muted" }, b.pagesRead.find((r) => r.url === x.url)?.status || "") }], b.organic)),
        h("p", { class: "small muted" }, "An outline of what searchers ask and the ranking pages cover. Write your own answer from what you genuinely know and do; never copy their text."));
      if (b.status === "reading") setTimeout(() => view.isConnected && show(id), 4000);
      else api(url).then(render).catch(() => {}); // the button comes back once the reading job is over
    } catch (e) { toast(e.message); }
  };
  const render = (d) => {
    const topic = h("input", { type: "text", placeholder: "Topic or search, e.g. how to descale an espresso machine", style: { width: "380px", maxWidth: "100%" } });
    const go = h("button", { class: "btn primary", disabled: !st?.configured || d.job?.running, title: st?.configured ? "" : "Add a DataForSEO login in Settings first" }, `Make brief (paid, ≈ $${d.cost.toFixed(3)})`);
    const make = async (e) => {
      e.preventDefault(); go.disabled = true;
      try { const r = await api(url, { method: "POST", body: { topic: topic.value } }); render(await api(url)); show(r.id); }
      catch (err) { toast(err.message); go.disabled = false; }
    };
    mount(card, h("h2", {}, "Content brief"),
      h("p", { class: "hint" }, "One paid Google results call (DataForSEO, checked against your monthly budget first) for the top 10 results, People Also Ask and related searches; then the top pages' H2/H3 headings, read politely (robots.txt obeyed), merged with your own Search Console searches on the topic. Outline only: no text is written for you."),
      h("form", { class: "row", onsubmit: make }, topic, go), spendLine(st),
      d.briefs.length ? h("div", { class: "row", style: { marginTop: "8px", flexWrap: "wrap" } }, d.briefs.map((b) => h("button", { class: "btn sm", onclick: () => show(b.id) }, b.topic))) : null,
      view);
  };
  render(await api(url));
  return card;
}

VIEWS.research = async (ctx) => Promise.all([ideasCard(ctx), clustersCard(ctx), compGapCard(ctx), briefCard(ctx)]);

const ACTION = { merge: ["Merge", "var(--warn-ink)"], refresh: ["Refresh", "var(--warn-ink)"], prune: ["Prune or noindex", "var(--warn-ink)"], keep: ["Keep", "var(--muted)"] };
const change = (now, before) => before ? h("span", { class: "small muted" }, ` (${now >= before ? "+" : ""}${num(now - before)})`) : null;
VIEWS.inventory = async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/inventory`);
  const base = ctx.project.start_url;
  const head = h("div", { class: "card-h" }, h("h2", {}, "Content inventory"), d.audited ? h("a", { class: "btn", href: `/api/projects/${ctx.project.id}/inventory.csv` }, "Download CSV") : null);
  const hint = h("p", { class: "hint" }, "Every indexable page of the latest audit with its words, last modified date (the page's own, else the sitemap's), Search Console clicks and impressions for 28 days against the 28 before, internal links in and the decay verdict. ",
    `Each page gets one suggested action from simple rules: merge (another page wins the same searches), refresh (decaying, positions ${d.rules?.minPos ?? 8}–${d.rules?.maxPos ?? 20}, or over ${d.rules?.staleMonths ?? 12} months old and still shown), `,
    `prune or noindex (under ${d.rules?.thinWords ?? 300} words, no impressions in 90 days, ${d.rules?.pruneInlinks ?? 2} or fewer links in, 90+ days old, not a utility page), else keep. Suggestions only: you decide.`);
  if (!d.audited) return [h("div", { class: "card" }, head, hint, h("div", { class: "empty" }, "Run an audit first."))];
  let only = "";
  const list = h("div", {});
  const draw = () => mount(list, table([
    { label: "Page", cls: "url", get: (p) => h("div", {}, h("a", { href: p.url, target: "_blank", rel: "noopener" }, shortUrl(p.url, base)), p.title ? h("div", { class: "small muted" }, p.title) : null) },
    { label: "Action", get: (p) => h("div", {}, h("b", { style: { color: ACTION[p.action][1] } }, ACTION[p.action][0]), p.into ? h("div", { class: "small" }, "into ", shortUrl(p.into, base)) : null,
      h("details", {}, h("summary", { class: "small muted" }, "why"), h("p", { class: "small", style: { maxWidth: "420px" } }, p.reason))) },
    { label: "Words", num: true, get: (p) => num(p.words) },
    { label: "Links in", num: true, get: (p) => num(p.inlinks) },
    { label: "Last modified", get: (p) => p.lastModified ? h("span", { class: "small" }, p.lastModified, h("span", { class: "muted" }, ` (${p.lastModifiedFrom})`)) : "–" },
    { label: "Clicks 28 d", num: true, get: (p) => [num(p.clicks), change(p.clicks, p.prevClicks)] },
    { label: "Impressions 28 d", num: true, get: (p) => [num(p.impressions), change(p.impressions, p.prevImpressions)] },
    { label: "Position", num: true, get: (p) => p.position ?? "–" },
    { label: "Clicks by week", get: (p) => p.weekly ? sparkline(p.weekly) : "" },
  ], d.pages.filter((p) => !only || p.action === only)));
  draw();
  const pick = h("select", { onchange: (e) => { only = e.target.value; draw(); } }, h("option", { value: "" }, `All pages (${num(d.pages.length)})`),
    Object.entries(ACTION).map(([k, [l]]) => h("option", { value: k }, `${l} (${num(d.counts[k])})`)));
  return [h("div", { class: "card" }, head, hint,
    h("div", { class: "row" }, pick, h("span", { class: "small muted" }, d.connected ? d.window ? `Search Console ${d.window.from} → ${d.window.to}` : "Search Console 28-day totals" : "Search Console not connected: nothing is flagged for traffic, and no page is suggested for pruning.")),
    list)];
};
