// Site health: is your own site ready to benefit from links?
import {api, html, render, $, $$, icon, ago, plural, busy, safeUrl} from "../core.js";

const CODES = {host_variant: "D01", temp_redirect: "D02", broken_internal: "L01", broken_external: "L02", orphan: "L03", redirect_internal: "L04",
  deep: "L05", unreached: "L06", weak_internal: "L07", unverified_external: "L08", sitemap_bad: "S01", not_in_sitemap: "S02",
  noindex_linked: "I01", canonical_other: "I02", dup_title: "C01", h1: "C02", no_description: "C03", thin: "C04", no_backlinks: "B01"};
const LEVEL = {high: "Fix first", medium: "Fix soon", low: "Tidy up", info: "For outreach"};

export async function mount(el, ctx) {
  let data = null, open = null;
  async function load() {
    try { data = await api(`/s/${ctx.site}/health`); } catch (e) { return render(el, html`<div class="pad"><p class="err">${e.message}</p></div>`); }
    draw();
  }
  const short = u => u.replace(/^https?:\/\/[^/]+/, "") || "/";
  // shorten addresses on your own site to their path; other sites keep their full address
  const own = () => (ctx.app.sites.find(s => s.id === ctx.site)?.domain || "").toLowerCase();
  const trim = text => text.replace(/https?:\/\/(?:www\.)?([^/\s]+)(\/[^\s]*)?/gi, (m, h, p) => h.toLowerCase() === own() ? (p || "/") : m);
  function draw() {
    const running = ctx.jobs()?.task.running === "map your site";
    render(el, html`
      <header class="head"><div><h1>Site health</h1><p>${data.mapped ? `Mapped ${ago(data.crawled_at)}.` : "Your site hasn't been mapped yet."} Links only help if your own site passes them on.</p></div>
        <div class="tools">${data.mapped ? html`<a class="btn quiet" href="/s/${ctx.site}/graph" target="_blank" rel="noreferrer">${icon("ext")} Full report</a>` : ""}
          <button class="btn primary" id="map" ${running ? "disabled" : ""}>${running ? "Mapping…" : data.mapped ? "Map again" : "Map my site"}</button></div></header>
      <div class="scroll"><div class="pad" style="max-width:980px">
      ${!data.mapped ? html`<div style="max-width:62ch"><p class="status-line" style="font-size:24px">See your site the way Google does.</p>
          <p class="muted">The tool opens every page of your site (about one a second), follows every link, and checks every link that points to other sites. Then it tells you what to fix: broken links, pages nobody links to, a www address that doesn't work, and which pages are strongest and worth getting links to.</p></div>` : html`
        <div class="stats"><div><b>${data.summary.pages}</b><span>pages</span></div><div><b>${data.summary.indexable}</b><span>indexable</span></div>
          <div><b>${data.summary.internal_links}</b><span>internal links</span></div><div><b>${data.summary.max_depth}</b><span>clicks to the deepest page</span></div>
          <div class="${faults() ? "bad" : ""}"><b>${faults()}</b><span>faults to fix</span></div></div>

        ${data.notes.length ? html`<div class="notice">${data.notes.map(n => html`<p style="margin:0">${n}</p>`)}</div>` : ""}
        <h2 class="section">Faults</h2>
        ${data.issues.length ? html`<ul class="faults">${data.issues.map(i => html`<li><details class="fault ${i.severity}" data-kind="${i.kind}" ${open === i.kind || (!open && i.severity === "high") ? "open" : ""}>
          <summary><span class="bar"></span><span class="code">${CODES[i.kind] || "X"}</span><b>${i.title}</b><span class="lvl">${LEVEL[i.severity]}</span></summary>
          <div class="body"><p>${i.fix}</p><ul>${i.pages.map(p => html`<li>${["host_variant", "temp_redirect"].includes(i.kind) ? p : trim(p)}</li>`)}</ul></div></details></li>`)}</ul>`
          : html`<div class="done">${icon("doneCircle")}<div><b>No faults.</b> Every page is reachable, indexable and linked.</div></div>`}

        <div class="grid2" style="gap:0 40px">
          <div><h2 class="section">Strongest pages</h2><p class="section-help">Where your internal links send the most strength. Good pages to point backlinks at.</p>
            <table class="plain"><tbody>${data.strongest.map(p => html`<tr><td><a href="${safeUrl(p.url)}" target="_blank" rel="noreferrer">${short(p.url)}</a></td>
              <td class="n">${Math.round(p.pagerank)}</td><td class="n faint">${p.backlinks ? plural(p.backlinks, "backlink") : "no backlinks"}</td></tr>`)}</tbody></table></div>
          <div><h2 class="section">Weakest pages</h2><p class="section-help">Few of your own pages link here. Add links to them from related pages.</p>
            <table class="plain"><tbody>${data.weakest.map(p => html`<tr><td><a href="${safeUrl(p.url)}" target="_blank" rel="noreferrer">${short(p.url)}</a></td>
              <td class="n">${Math.round(p.pagerank)}</td><td class="n faint" style="white-space:nowrap">${plural(p.inbound, "link")} in</td></tr>`)}</tbody></table></div>
        </div>

        <h2 class="section">Link map</h2>
        <p class="section-help">Every page and every link between them. Click a page to trace its links.</p>
        <div id="mapSlot"><button class="btn" id="showMap">Show the map</button></div>`}
      </div></div>`);
    $("#map", el).onclick = e => busy(e.currentTarget, () => ctx.run({op: "graph"}), "Mapping your site. This takes about a second per page.");
    const sm = $("#showMap", el);
    if (sm) sm.onclick = () => render($("#mapSlot", el), html`<iframe class="mapframe" title="Link map of your site" src="/s/${ctx.site}/graph?embed&t=${encodeURIComponent(data.crawled_at)}"></iframe>`);
    if (open) $(`[data-kind="${open}"]`, el)?.scrollIntoView({block: "start"});
  }
  const faults = () => data.issues.filter(i => i.severity === "high" || i.severity === "medium").length;
  open = ctx.rest[0] || null;
  await load();
  return {update(rest) { open = rest[0] || null; draw(); }, refresh: load};
}
