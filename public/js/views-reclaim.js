// Lost pages: URLs that are gone (404/410) or redirect from a deep path to the home page but had value (earlier audits,
// Search Console, sitemap, internal links, stored backlinks), each with the closest live page as a 301 target.
import { h, api, toast, num, shortUrl, table } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "search") + 1, 0, { view: "lostpages", label: "Lost pages" });

const nowBadge = (r) => (r.kind === "home-redirect"
  ? h("span", { class: "badge warning", title: `Redirects to ${r.redirectsTo}` }, `${r.status} → home`)
  : h("span", { class: "badge error" }, String(r.status)));

function evidence(e) {
  const bits = [];
  if (e.lastSeen) bits.push(`200 on ${e.lastSeen.date}${e.lastSeen.title ? ` (“${e.lastSeen.title}”)` : ""}`);
  if (e.clicks || e.impressions) bits.push(`${num(e.clicks)} clicks, ${num(e.impressions)} impressions`);
  if (e.backlinks) bits.push(`${num(e.backlinks)} backlinks`);
  if (e.inSitemap) bits.push("in the sitemap");
  if (e.inlinks) bits.push(`linked from ${num(e.inlinks)} page${e.inlinks === 1 ? "" : "s"}`);
  return h("span", { class: "small" }, bits.join(" · ") || "–");
}

VIEWS.lostpages = async (ctx) => {
  const d = await api(`/api/projects/${ctx.project.id}/lost-urls`);
  const base = ctx.project.start_url;
  if (!d.audit) return [h("div", { class: "card" }, h("h2", {}, "Lost pages worth redirecting"), h("p", { class: "hint" }, "Run an audit first."))];
  const copy = h("button", { class: "btn", disabled: !d.lines.length,
    onclick: () => navigator.clipboard.writeText(d.lines.join("\n") + "\n").then(() => toast(`${d.lines.length} redirect lines copied`), () => toast("Could not copy")) },
  `Copy ${d.lines.length} redirect line${d.lines.length === 1 ? "" : "s"}`);
  const bl = d.backlinks;
  const blNote = !bl.fetched ? "Backlinks: none fetched, so not counted."
    : bl.perPage ? "Backlinks: from the last stored backlink fetch."
    : `Backlinks: the last stored fetch has no per-page targets, so they are not counted per URL${bl.brokenBacklinks ? ` (it counted ${num(bl.brokenBacklinks)} backlinks to broken pages site-wide)` : ""}.`;
  return [
    h("div", { class: "card" },
      h("div", { class: "card-h" }, h("h2", {}, `Lost pages worth redirecting (${d.lost.length})`), copy),
      h("p", { class: "hint" }, `Audit of ${d.audit.date}. Pages that now return 404/410, or redirect from a deep path straight to the home page, `,
        "and had value: they returned 200 in an earlier audit, Google showed them, the sitemap lists them, or other pages still link to them. ",
        "A 301 to the closest live page keeps their visitors and links; a redirect to the home page is treated by Google like a missing page. ",
        "The suggested target is the live page whose address and title share the most words with the old page: check it fits before adding the line to .htaccess. ",
        d.gscConnected ? "" : "Search Console is not connected, so clicks and impressions are not counted. ", blNote),
      table([
        { label: "Old URL", cls: "url", get: (r) => shortUrl(r.url, base) },
        { label: "Now", get: nowBadge },
        { label: "Evidence", get: (r) => evidence(r.evidence) },
        { label: "Suggested 301 target", cls: "url", get: (r) => (r.target
          ? h("span", {}, shortUrl(r.target.url, base), h("div", { class: "small", title: `Shared words: ${r.target.words.join(", ")}` }, `score ${r.target.score}`))
          : h("span", { class: "small" }, "No close match: pick one by hand")) },
        { label: "Redirect line (Apache)", get: (r) => (r.redirect
          ? h("span", {}, h("code", { class: "small", style: { wordBreak: "break-all" } }, r.redirect), r.kind === "home-redirect" ? h("div", { class: "small" }, "Replace the existing redirect to the home page.") : null)
          : h("span", { class: "small" }, r.target ? "Has a query string: needs a RewriteRule" : "–")) },
      ], d.lost, { empty: "No lost pages with value: every page that had traffic, links or a sitemap entry still answers." })),
    h("div", { class: "card" }, h("h2", {}, `Could not be checked (${d.unchecked.length})`),
      h("p", { class: "hint" }, "Pages with value that did not load in the latest audit (timeout, blocked, server error) or that the crawl never reached. Their status is unknown, so they are not called lost: open them, or run the audit again."),
      table([
        { label: "URL", cls: "url", get: (r) => shortUrl(r.url, base) },
        { label: "Status", get: (r) => h("span", { class: "small" }, r.status === null ? "not crawled" : String(r.status), " · ", r.reason) },
        { label: "Evidence", get: (r) => evidence(r.evidence) },
      ], d.unchecked, { empty: "None." })),
  ];
};
