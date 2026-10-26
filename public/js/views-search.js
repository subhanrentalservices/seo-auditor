// Search Console cards added for REQ-044 rows 25, 47, 48, 49 and 56 (src/gsc-findings.mjs, src/trends.mjs,
// src/status-feed.mjs, src/queries.mjs targetReport). Used by views-data.js.
import { h, num, shortUrl, table, sevBadge } from "./core.js";

const pos = (p) => (p === null || p === undefined ? "–" : p.toFixed(1));
const pctTxt = (p) => (p === null || p === undefined ? "–" : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(Math.round(p * 100))}%`);
const sev = (s) => (s === "info" ? h("span", { class: "badge" }, "Info") : sevBadge(s));

/** Project findings from Search Console data (brand, rich results, target keywords); never part of Site Health. */
export function findingsCard(d, base) {
  const list = d.findings || [];
  return h("div", { class: "card" }, h("h2", {}, `Search Console findings (${list.length})`),
    h("p", { class: "hint" }, "Raised from Search Console data for the whole project, not from one audit, so they don't change Site Health. Each says what Google says and what this tool's own thresholds are."),
    list.length ? h("div", { class: "stack" }, list.map((f) => h("div", { class: "card", style: { boxShadow: "none" } },
      h("div", { class: "row", style: { gap: "8px", alignItems: "center" } }, sev(f.severity), h("b", {}, f.title)),
      h("p", { class: "small", style: { margin: "6px 0" } }, f.detail),
      f.items?.length ? h("div", { class: "small muted" }, f.items.map((x) => (x.query ? `${x.query} (${num(x.impressions)} impr., #${pos(x.position)})` : shortUrl(x.url, base))).join(" · ")) : null,
      h("details", {}, h("summary", { class: "small" }, "Why and how to fix"), h("p", { class: "small" }, f.why), h("p", { class: "small" }, h("b", {}, "Fix: "), f.fix)))))
      : h("p", { class: "muted" }, "Nothing found: your site leads its brand searches, rich result types with markup are getting impressions, and every target keyword is shown."));
}

/** Search appearance (rich result types) for the last 90 days, with week-on-week change. */
export function appearanceCard(a) {
  if (!a) return null;
  const card = (...kids) => h("div", { class: "card" }, h("h2", {}, "Rich results in Search (search appearance)"), ...kids);
  if (!a.fetched) return card(h("p", { class: "hint" }, a.error ? `Could not fetch search appearance: ${a.error}` : "Press Refresh above once: search appearance for the last 90 days is fetched with the next Search Console refresh."));
  return card(h("p", { class: "hint" }, `Impressions and clicks per search appearance type, ${a.startDate} → ${a.endDate} (Search Console's Performance report, Search appearance). `,
      "Latest week: the last 7 days of data against the 7 before; a fall of 30% or more from 50+ impressions is flagged (this tool's threshold). Markup makes a page eligible for a rich result, not certain to get one.",
      a.error ? ` The last refresh failed (${a.error}); showing the previous data.` : ""),
    table([{ label: "Appearance", get: (r) => h("span", {}, r.label, r.drop ? h("span", { class: "badge warning", style: { marginLeft: "6px" } }, "dropped") : null) },
      { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) }, { label: "Pos.", num: true, get: (r) => pos(r.position) },
      { label: "Latest week", num: true, get: (r) => num(r.lastWeek) }, { label: "Week before", num: true, get: (r) => num(r.prevWeek) }, { label: "Change", num: true, get: (r) => pctTxt(r.change) }],
    a.appearances, { empty: "No search appearance types had impressions in these 90 days: your pages show as plain results." }),
    a.gaps.length ? h("p", { class: "small", style: { marginTop: "8px" } }, h("b", {}, "Markup with no impressions: "), a.gaps.map((g) => `${g.feature} (${g.pages} pages since ${g.firstSeen})`).join(" · ")) : null);
}

/** Owner-entered target keywords against Search Console and the latest audit. */
export function targetsCard(t, base) {
  if (!t) return null;
  const card = (...kids) => h("div", { class: "card" }, h("h2", {}, `Target keywords (${t.targets.length})`), ...kids);
  if (!t.configured) return card(h("p", { class: "hint" }, "Add the searches you want to be found for under Settings → Target keywords (one per line). Each is checked against the last 28 days of Search Console data and the titles and H1s of the latest audit."));
  const STATUS = { shown: ["fixed", "shown"], "page-not-shown": ["notice", "page, not shown"], "no-page": ["warning", "no page"] };
  return card(h("p", { class: "hint" }, "Impressions for searches containing all of the target's words (last 28 days), and a page that names it in its title or H1. ",
      "\"No page\": demand you haven't served yet; write one page only if you can genuinely help with it. \"Page, not shown\": check the page is indexed, linked and answers the search."),
    t.brand?.length ? h("p", { class: "small muted" }, `Brand targets skipped: ${t.brand.join(", ")}`) : null,
    table([{ label: "Target", key: "keyword" }, { label: "Status", get: (r) => h("span", { class: `badge ${STATUS[r.status][0]}` }, STATUS[r.status][1]) },
      { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Clicks", num: true, get: (r) => num(r.clicks) }, { label: "Pos.", num: true, get: (r) => pos(r.position) },
      { label: "Page", cls: "url", get: (r) => (r.page ? shortUrl(r.page, base) : "–") }], t.targets, { empty: "No target keywords left after brand terms." }));
}

// ---- Search trend additions (rows 48, 49) ----
const SVC = { crawling: "crawling", indexing: "indexing", serving: "serving" };
export const segName = (s) => (s?.startsWith("country:") ? s.slice(8).toUpperCase() : s?.startsWith("section:") ? s.slice(8) : s);
export const leadTxt = (x) => (x ? `${segName(x.segment)} (${Math.round(x.share * 100)}% of the loss)` : "–");
const CHANGE = { robots: "robots.txt now blocks", noindex: "turned non-indexable", "5xx": "new 5xx" };
/** What the audits saw change in a drop's window. */
export function siteChangesCell(sc, base) {
  if (!sc) return "–";
  if (!sc.audits) return h("span", { class: "small muted" }, "no audit in this window");
  if (!sc.changes.length) return h("span", { class: "small muted" }, `${sc.audits} audit(s): no robots.txt block, noindex or new 5xx`);
  return h("span", { class: "small" }, sc.changes.map((c) => h("div", { title: c.urls.map((u) => shortUrl(u, base)).join("\n") }, `${c.date}: ${num(c.count)} ${CHANGE[c.kind]}`)));
}
/** Countries and site sections table, plus the Status Dashboard note. */
export function trendExtras(d) {
  const segs = d.segments || [];
  const feed = d.feed;
  return [
    segs.length ? h("h3", { style: { marginTop: "12px" } }, "By country and site section (last 4 weeks vs the 4 before)") : null,
    segs.length ? table([{ label: "Segment", get: (r) => `${r.kind === "country" ? "Country" : "Section"} ${segName(r.segment)}` },
      { label: "Clicks", num: true, get: (r) => num(r.clicks) }, { label: "Before", num: true, get: (r) => num(r.before.clicks) }, { label: "Change", num: true, get: (r) => pctTxt(r.clicksPct) },
      { label: "Impr.", num: true, get: (r) => num(r.impressions) }, { label: "Before", num: true, get: (r) => num(r.before.impressions) }, { label: "Change", num: true, get: (r) => pctTxt(r.impressionsPct) }], segs) : null,
    segs.length ? h("p", { class: "small muted" }, "Only countries and sections averaging 100+ impressions a week (this tool's threshold). Google says some updates start in one country or language before others.") : null,
    (d.incidents || []).length ? h("p", { class: "small" }, "Google incidents in this period: ", d.incidents.map((i) => h("span", {}, h("a", { href: i.source, target: "_blank", rel: "noopener" }, `${i.name} (${SVC[i.service] || i.service}, ${i.start})`), " ")) ) : null,
    h("p", { class: "small muted" }, feed?.fetchedAt ? `Search Status Dashboard feed fetched ${feed.fetchedAt.slice(0, 10)}${feed.error ? ` (last try failed: ${feed.error})` : ""}; updates from it are added to the hand-curated list, each with its incident link.`
      : feed?.error ? `Search Status Dashboard feed not available (${feed.error}): using the hand-curated list only.` : "The Search Status Dashboard feed is fetched with the next Search Console refresh."),
  ];
}
