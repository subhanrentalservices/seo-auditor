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

VIEWS.competitors = async (ctx) => [gapForm(ctx), compareForm(ctx), linkGapForm(ctx)];
