// Competitors (REQ-062, 2026-10-31): pages a competitor has that you don't (src/competitor-pages.mjs) and your page vs
// theirs for one search (src/page-compare.mjs). Both read only what the owner asks for: the competitor's sitemap, or
// the two pages, once.
import { h, mount, api, toast, table, num, shortUrl } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "links") + 1, 0, { view: "competitors", label: "Competitors" });

const field = (placeholder, width = "320px", value = "") => h("input", { type: "text", placeholder, value, style: { width, maxWidth: "100%" } });
const USES = { exact: ["up", "✓ exact"], words: ["up", "✓ same words"] };
const usesCell = (u) => { const [c, l] = USES[u] || ["down", "✕ no"]; return h("span", { class: `small ${c}` }, l); };

function gapForm(ctx) {
  const input = field("rival.com.au, other-rival.com", "420px");
  const out = h("div", {});
  const go = async (e) => {
    e?.preventDefault();
    btn.disabled = true; btn.textContent = "Reading sitemaps…";
    try {
      const r = await api(`/api/projects/${ctx.project.id}/competitor-pages`, { method: "POST", body: { domains: input.value } });
      mount(out, r.sites.map((s) => s.error ? h("p", { class: "small", style: { color: "var(--warn-ink)" } }, `${s.site}: ${s.error}`) : h("div", { style: { marginTop: "12px" } },
        h("h3", { style: { marginBottom: "4px" } }, s.site),
        h("p", { class: "small muted", style: { marginTop: 0 } }, `${num(s.pages)} pages in the sitemap · ${num(s.covered)} topics you already have a page for · ${num(s.skipped)} set aside (templated sections, or too little in the address) · `,
          h("b", {}, `${num(s.gapCount)} topics you don't have`), s.gapCount > s.gaps.length ? ` (first ${s.gaps.length} shown)` : ""),
        h("details", {}, h("summary", { class: "small" }, "Sections"),
          table([{ label: "Section", get: (x) => `/${x.section === "/" ? "" : x.section}` }, { label: "Pages", num: true, get: (x) => num(x.pages) },
            { label: "Gaps", num: true, get: (x) => num(x.gaps) }, { label: "", get: (x) => x.templated ? h("span", { class: "small muted" }, "templated (place / brand / insurer swapped in): not counted") : "" }], s.sections)),
        s.gaps.length ? table([{ label: "Topic they have", get: (x) => h("b", {}, x.topic) }, { label: "Their page", cls: "url", get: (x) => h("a", { href: x.url, target: "_blank", rel: "noopener" }, shortUrl(x.url, s.site)) }], s.gaps)
          : h("p", {}, "You already have a page for every topic in their sitemap."))));
    } catch (err) { toast(err.message); }
    btn.disabled = false; btn.textContent = "Find gaps";
  };
  const btn = h("button", { class: "btn" }, "Find gaps");
  return h("form", { class: "card", onsubmit: go }, h("h2", {}, "Pages a competitor has that you don't"),
    h("p", { class: "hint" }, "Reads each competitor's public XML sitemap once (up to 3 sites) and checks every page's topic against your latest audit. ",
      "Sections that are one template with a suburb, brand or insurer swapped in are set aside: copying them is the doorway-page pattern Google warns about. ",
      "For the rest, write your own page or section only for things you genuinely offer. Never copy their text."),
    h("div", { class: "row" }, input, btn), out);
}

function compareForm(ctx) {
  const mine = field("Your page: https://…", "420px", ctx.project.start_url || "");
  const theirs = field("Their page: https://… (e.g. the one ranking first)", "420px");
  const kw = field("The search, e.g. emergency plumber brisbane", "420px");
  const out = h("div", {});
  const go = async (e) => {
    e?.preventDefault();
    btn.disabled = true; btn.textContent = "Comparing…";
    try {
      const r = await api(`/api/projects/${ctx.project.id}/page-compare`, { method: "POST", body: { mine: mine.value, theirs: theirs.value, keyword: kw.value } });
      const err = [r.mine, r.theirs].filter((x) => x.error).map((x) => `${x.url}: ${x.error}`);
      if (err.length) { mount(out, h("p", { style: { color: "var(--warn-ink)" } }, err.join(" · "))); return; }
      const rows = [
        ["Title", (x) => [x.title, h("div", {}, usesCell(x.titleUses), h("span", { class: "small muted" }, ` · ${x.titleLength} characters`))]],
        ["H1", (x) => [x.h1 || "—", h("div", {}, usesCell(x.h1Uses))]],
        ["In the first 100 words", (x) => usesCell(x.first100Uses)],
        ["Headings using the search", (x) => `${x.headingsUsing} of ${x.headings}`],
        ["Question headings", (x) => num(x.questionHeadings)],
        ["Words", (x) => num(x.words)],
        ["Exact search in the text", (x) => `${x.exactCount}×`],
        ["Meta description", (x) => [usesCell(x.descriptionUses), h("span", { class: "small muted" }, ` · ${x.descriptionLength} characters`)]],
        ["Images (no alt)", (x) => `${x.images} (${x.imagesNoAlt})`],
        ["Links in the text: own site / other sites", (x) => `${x.contentLinksInternal} / ${x.contentLinksExternal}`],
        ["Structured data", (x) => x.schemaTypes.join(", ") || "none"],
        ["Date shown · author named", (x) => `${x.dated ? "✓" : "✕"} · ${x.author ? "✓" : "✕"}`],
      ];
      mount(out, table([{ label: "", get: (row) => h("b", {}, row[0]) }, { label: "Yours", get: (row) => row[1](r.mine) }, { label: "Theirs", get: (row) => row[1](r.theirs) }], rows),
        h("h3", { style: { margin: "14px 0 6px" } }, r.gaps.length ? `What their page does for “${r.keyword}” that yours doesn't (${r.gaps.length})` : `Your page already does everything theirs does for “${r.keyword}”.`),
        r.gaps.length ? h("ol", { class: "small" }, r.gaps.map(([, text]) => h("li", { style: { margin: "4px 0" } }, text))) : null,
        h("p", { class: "small muted" }, "Answer the search better in your own words. Add a claim, a date or markup only when it's true for your page."));
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = "Compare"; }
  };
  const btn = h("button", { class: "btn" }, "Compare");
  return h("form", { class: "card", onsubmit: go }, h("h2", {}, "Your page vs theirs, for one search"),
    h("p", { class: "hint" }, "Search Google for the phrase, take the page that ranks first, and compare it with your page for that search: title, H1, first 100 words, headings, length, links, structured data, date and author. Each page is fetched once."),
    h("div", { class: "stack", style: { gap: "6px" } }, mine, theirs, h("div", { class: "row" }, kw, btn)), out);
}

// Link gap (REQ-086): sites that link to 2+ competitors but not to you (src/link-gap.mjs). Paid: one DataForSEO call
// per competitor plus one for your site, on the owner's button.
const KIND = { listing: ["up", "Business listing: join it yourself"], site: ["", "Article / news / association: earn it"], spam: ["down", "Likely spam or link network: leave it"] };
function linkGapForm(ctx) {
  const input = field("rival.com.au, other-rival.com, third.com.au", "420px");
  const out = h("div", {});
  const go = async (e) => {
    e?.preventDefault();
    btn.disabled = true; btn.textContent = "Reading links…";
    try {
      const r = await api(`/api/projects/${ctx.project.id}/link-gap`, { method: "POST", body: { domains: input.value } });
      mount(out,
        h("p", { class: "small muted" }, `Sites read: ${Object.entries(r.competitors).map(([d, n]) => `${d} ${num(n)}`).join(" · ")} · yours (${r.own}) ${num(r.ownLinks)}. `,
          h("b", {}, `${num(r.rows.length)} sites link to 2+ competitors but not to you`), ` (${r.counts.listing} listings, ${r.counts.site} articles/sites, ${r.counts.spam} likely spam).`),
        r.errors.length ? h("p", { class: "small", style: { color: "var(--warn-ink)" } }, r.errors.map((x) => `${x.domain}: ${x.error}`).join(" · ")) : null,
        r.rows.length ? table([
          { label: "Site", get: (x) => h("a", { href: `https://${x.domain}/`, target: "_blank", rel: "noopener" }, x.domain) },
          { label: "Links to", get: (x) => `${x.count}: ${x.competitors.join(", ")}` },
          { label: "Rank", num: true, get: (x) => num(x.rank) },
          { label: "What to do", get: (x) => { const [c, l] = KIND[x.kind]; return h("span", { class: `small ${c}` }, l); } },
        ], r.rows) : h("p", {}, "No site links to two or more of these competitors without also linking to you."));
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = "Find link gaps"; }
  };
  const btn = h("button", { class: "btn" }, "Find link gaps");
  return h("form", { class: "card", onsubmit: go }, h("h2", {}, "Sites that link to your competitors but not to you"),
    h("p", { class: "hint" }, "Paid: one DataForSEO call per competitor (up to 5) plus one for your site; the monthly budget applies. ",
      "Join the business listings yourself, and earn articles with something worth citing. Never buy links, swap links or join link networks: Google treats those as link spam."),
    h("div", { class: "row" }, input, btn), out);
}

// AI Overview gap (REQ-095): your page vs the Google AI Overview answer and every page it cites (src/aio-gap.mjs).
// Uses the AI Overview stored by the AI visibility run (no new paid call) or pages the owner pastes.
function aioGapForm(ctx, searches) {
  const mine = field("Your page: https://…", "420px", ctx.project.start_url || "");
  const kw = field("The search (as in AI visibility)", "420px");
  kw.setAttribute("list", "aio-searches");
  const list = h("datalist", { id: "aio-searches" }, searches.map((s) => h("option", { value: s })));
  const pasted = h("textarea", { rows: 2, placeholder: "Optional: pages to compare with, one per line (else the stored Google result is used)", style: { width: "420px", maxWidth: "100%" } });
  const out = h("div", {});
  const go = async (e) => {
    e?.preventDefault();
    btn.disabled = true; btn.textContent = "Reading pages…";
    try {
      const r = await api(`/api/projects/${ctx.project.id}/aio-gap`, { method: "POST", body: { mine: mine.value, keyword: kw.value, sources: pasted.value } });
      const link = (u) => h("a", { href: u, target: "_blank", rel: "noopener" }, shortUrl(u));
      mount(out,
        h("p", { class: "small muted" }, `Source: ${r.from}${r.aio === false ? " (no AI Overview showed: ranked results only)" : ""} · ${r.sources.length} page${r.sources.length === 1 ? "" : "s"} read`,
          r.skipped ? ` · ${r.skipped} social, Google or extra skipped` : "", r.ownPos ? ` · your site ranks #${r.ownPos}` : "",
          r.youCited ? h("b", { class: "up" }, " · your site is already cited in the AI Overview") : ""),
        h("p", { class: "small" }, "Read: ", ...r.sources.flatMap((x, i) => [i ? " · " : "", link(x.url), h("span", { class: "muted" }, ` (${x.role})`)])),
        h("div", { class: "card", style: { background: "var(--panel-2, transparent)", margin: "10px 0" } },
          h("b", {}, "Step 2: give it to Claude. "),
          h("span", { class: "small" }, `The lists below are a quick first pass. The real gap analysis (the method from the video) is Claude reading the AI answer, every page's content and yours: copy this brief (${Math.round(r.brief.length / 1000)}k characters) into Claude and implement what is true for your business.`),
          h("div", { class: "row", style: { marginTop: "6px" } },
            h("button", { class: "btn", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(r.brief); toast("Brief copied: paste it into Claude"); } catch { toast("Couldn't copy: use Download"); } } }, "Copy brief for Claude"),
            h("a", { class: "btn", href: URL.createObjectURL(new Blob([r.brief], { type: "text/markdown" })), download: `gap-brief-${r.keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60)}.md` }, "Download brief"))),
        r.sources.some((s) => s.error) ? h("p", { class: "small", style: { color: "var(--warn-ink)" } }, r.sources.filter((s) => s.error).map((s) => `${s.url}: ${s.error}`).join(" · ")) : null,
        h("h3", { style: { margin: "12px 0 6px" } }, `What the AI answer says that your page doesn't (${r.answerGaps.length})`),
        r.answerGaps.length ? h("ol", { class: "small" }, r.answerGaps.map((s) => h("li", { style: { margin: "4px 0" } }, s))) : h("p", { class: "small" }, "Your page covers every statement in the stored answer."),
        h("h3", { style: { margin: "12px 0 6px" } }, `“People also ask” questions your page doesn't answer (${(r.questionGaps || []).length})`),
        (r.questionGaps || []).length ? h("ol", { class: "small" }, r.questionGaps.map((q) => h("li", { style: { margin: "4px 0" } }, q))) : h("p", { class: "small" }, "None, or Google showed no “People also ask” box."),
        h("h3", { style: { margin: "12px 0 6px" } }, `Sections the other pages have that yours doesn't (${r.topicGaps.length})`),
        r.topicGaps.length ? table([{ label: "Their section", get: (x) => h("b", {}, x.topic) }, { label: "Pages", num: true, get: (x) => num(x.pages.length) },
          { label: "Where", get: (x) => h("span", { class: "small" }, ...x.pages.flatMap((u, i) => [i ? " · " : "", link(u)])) }], r.topicGaps) : h("p", { class: "small" }, "No missing sections."),
        h("h3", { style: { margin: "12px 0 6px" } }, `What most of these pages do that yours doesn't (${r.structure.length})`),
        r.structure.length ? h("ol", { class: "small" }, r.structure.map((s) => h("li", { style: { margin: "4px 0" } }, `${s.text} (${s.pages} of ${s.of})`))) : h("p", { class: "small" }, "Nothing most of them share."),
        h("p", { class: "small muted" }, "A checklist, not a template: add only what is true for your business, in your own words, and never copy their text. Google: no special optimisation is needed for AI features; pages must be indexed and eligible for a snippet."));
    } catch (err) { toast(err.message); }
    finally { btn.disabled = false; btn.textContent = "Find AI Overview gaps"; }
  };
  const btn = h("button", { class: "btn" }, "Find AI Overview gaps");
  return h("form", { class: "card", onsubmit: go }, h("h2", {}, "Your page vs the AI Overview, the pages it cites and the top results"),
    h("p", { class: "hint" }, "Takes the Google result stored by your last AI visibility run for the search: the AI Overview (answer + cited pages), the top-ranked pages and “People also ask”. ",
      "Reads each page once (up to 8 cited + 5 ranked) and your page, and lists what they cover that yours doesn't. No new paid call."),
    list, h("div", { class: "stack", style: { gap: "6px" } }, mine, kw, pasted, h("div", { class: "row" }, btn)), out);
}

VIEWS.competitors = async (ctx) => {
  const s = await api(`/api/projects/${ctx.project.id}/aio-gap/searches`).catch(() => ({ searches: [] }));
  return [gapForm(ctx), compareForm(ctx), aioGapForm(ctx, s.searches || []), linkGapForm(ctx)];
};
