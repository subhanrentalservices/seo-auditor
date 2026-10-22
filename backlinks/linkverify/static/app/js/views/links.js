// Links: every page that links to you, and the proof of whether each link counts.
import {api, html, render, $, $$, icon, ago, plural, vcls, vlabel, VERDICT_HELP, toast, busy, safeUrl} from "../core.js";

const FILTERS = [["all", "All"], ["problems", "Need a look"], ["Counts", "Count"], ["unchecked", "Not checked"]];
const RANK = {"Not counted": 0, "Weak": 1, null: 2, "Pending": 3, "Counts": 4};
const STRATEGIES = ["Journalist request", "Guest post", "Unlinked mention", "Broken link", "Resource page", "Directory or profile",
  "Supplier or partner", "Sponsorship", "Digital PR", "Other"];

export async function mount(el, ctx) {
  let data = null, filter = "all", q = "", sel = null, detail = null;
  render(el, html`
    <header class="head"><div><h1>Links</h1><p id="lsub">&nbsp;</p></div>
      <div class="tools"><button class="btn" id="checkDue">${icon("refresh")} Re-check due links</button>
        <a class="btn primary" href="#/${ctx.site}/links/new">${icon("plus")} Add a link</a></div></header>
    <div class="split" id="split">
      <section class="list" aria-label="Your links">
        <div class="filters"><input class="input" type="search" id="q" placeholder="Search by site, page or note" aria-label="Search links">
          <div class="seg" role="group" aria-label="Show">${FILTERS.map(([k, l]) => html`<button data-f="${k}" aria-pressed="${k === filter}">${l}</button>`)}</div></div>
        <ul class="rows" id="rows"></ul>
      </section>
      <section class="detail" id="detail" aria-live="polite"></section>
    </div>`);
  $("#q", el).oninput = e => { q = e.target.value.trim().toLowerCase(); drawList(); };
  $$("[data-f]", el).forEach(b => b.onclick = () => { filter = b.dataset.f; $$("[data-f]", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); drawList(); });
  $("#checkDue", el).onclick = e => busy(e.currentTarget, () => ctx.run({op: "check", which: "due"}), r => r.queued ? `${plural(r.queued, "link")} queued` : "No links are due");
  $("#rows", el).addEventListener("keydown", e => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = $$("#rows a", el), i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)];
    next.focus(); next.click();
  });

  async function load() {
    try { data = await api(`/s/${ctx.site}/links`); }
    catch (e) { render($("#rows", el), html`<li class="empty err">${e.message}</li>`); return; }
    const v = data.links.reduce((a, l) => (a[l.verdict || "unchecked"] = (a[l.verdict || "unchecked"] || 0) + 1, a), {});
    $("#lsub", el).textContent = data.links.length
      ? `${plural(data.links.length, "link")}. ${v["Counts"] || 0} count${(v["Weak"] || 0) + (v["Not counted"] || 0) ? `, ${(v["Weak"] || 0) + (v["Not counted"] || 0)} need a look` : ""}.`
      : "Log every page that links to you. Each one gets 15 checks.";
    drawList();
  }
  function shown() {
    let rows = data.links.slice();
    if (filter === "problems") rows = rows.filter(l => l.verdict === "Weak" || l.verdict === "Not counted");
    else if (filter === "unchecked") rows = rows.filter(l => !l.verdict);
    else if (filter !== "all") rows = rows.filter(l => l.verdict === filter);
    if (q) rows = rows.filter(l => [l.host, l.path, l.target, l.strategy, l.notes, l.anchor].join(" ").toLowerCase().includes(q));
    return rows.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.id - a.id);
  }
  function drawList() {
    if (!data) return;
    const jobs = ctx.jobs(), queued = new Set(jobs?.checks.queued || []), running = jobs?.checks.running;
    const rows = shown();
    render($("#rows", el), rows.length ? rows.map(l => html`<li><a href="#/${ctx.site}/links/${l.id}" aria-current="${l.id === sel}" class="${vcls(l.verdict)}">
      <div class="l1"><i class="dot"></i><b>${l.host}</b><span class="r">${running === l.id ? "checking…" : queued.has(l.id) ? "queued" : ago(l.last_checked)}</span></div>
      <div class="l2">${l.path}${l.strategy ? `, ${l.strategy}` : ""}</div></a></li>`)
      : html`<li class="empty">${data.links.length ? "No links match." : html`No links yet. <a href="#/${ctx.site}/links/new">Add the first one</a>.`}</li>`);
  }

  async function showDetail(id) {
    sel = id; drawList();
    $("#split", el).classList.toggle("has-detail", id !== null);
    el.classList.toggle("in-detail", id !== null);
    const box = $("#detail", el);
    if (id === "new") return drawNew(box);
    if (id === null) {
      return render(box, html`<div class="blank pad"><p class="muted">${data?.links.length ? "Pick a link to see why it got its verdict." : ""}</p>
        ${data && !data.links.length ? addHelp() : ""}</div>`);
    }
    try { detail = await api(`/s/${ctx.site}/links/${id}`); }
    catch (e) { return render(box, html`<div class="pad"><p class="err">${e.message}</p></div>`); }
    drawDetail(box);
  }
  function addHelp() {
    return html`<h2 class="wide" style="font-size:22px;margin:0 0 8px">Log your first link</h2>
      <p class="muted" style="max-width:56ch">Add each page on another site that links to you: a directory listing, a supplier page, an article. The tool opens the page the way Google does and runs 15 checks to prove whether the link really counts. Then it keeps re-checking.</p>
      <a class="btn primary" href="#/${ctx.site}/links/new">${icon("plus")} Add a link</a>`;
  }
  function drawDetail(box) {
    const l = detail.link, r = detail.result || {}, link = r.link || {};
    const jobs = ctx.jobs(), checking = jobs && (jobs.checks.running === l.id || jobs.checks.queued.includes(l.id));
    const checks = r.checks || [];
    const glyph = {pass: "✓", warn: "!", fail: "✕", skip: "–", info: "i"};
    const why = ((r.reasons || [])[0] || "").replace(/^\d+\.\s*[^:]+:\s*/, "") || VERDICT_HELP[l.verdict ?? null];
    const order = {fail: 0, warn: 1, pass: 2, info: 3, skip: 4};
    const sorted = checks.slice().sort((a, b) => order[a.status] - order[b.status] || a.num - b.num);
    const problems = checks.filter(c => c.status === "fail" || c.status === "warn").length;
    render(box, html`<div class="pad">
      <a class="btn quiet crumb" href="#/${ctx.site}/links">${icon("back")} All links</a>
      <div class="dhead"><div><h2>${l.host}</h2><div class="sub"><a href="${safeUrl(l.source_url)}" target="_blank" rel="noreferrer">${l.path}</a></div></div>
        <div class="row"><button class="btn" id="recheck" ${checking ? "disabled" : ""}>${icon("refresh")} ${checking ? "Checking…" : "Re-check"}</button>
          <a class="btn quiet" href="${safeUrl(l.source_url)}" target="_blank" rel="noreferrer">${icon("ext")} Open page</a></div></div>
      <div class="verdict-block ${vcls(l.verdict)}"><div class="vword">${vlabel(l.verdict)}</div>
        <p>${why}${l.last_checked ? html`<br><span class="faint">Checked ${ago(l.last_checked)}. ${new Date(l.next_due) <= new Date() ? "A re-check is due now." : `Next re-check ${ago(l.next_due)}.`}</span>` : ""}</p></div>
      ${checking ? html`<div class="notice">Checking this link now. This takes up to a minute.</div>` : ""}
      <dl class="kv">
        <dt>Links to</dt><dd>${l.target}</dd>
        ${link.url ? html`<dt>Anchor text</dt><dd>${link.anchor_text || "(none)"}</dd>
          <dt>Link type</dt><dd>${link.kind === "wrapped" ? `Through a redirect on ${link.via ? new URL(link.via).hostname : "another site"}`
            : link.kind !== "a" ? "Not a real link" : (link.rel || []).length ? `rel="${link.rel.join(" ")}"` : "Followed (no rel)"}</dd>` : ""}
        ${l.dr != null ? html`<dt>Ahrefs ratings</dt><dd>DR ${l.dr}${l.ur != null ? `, page UR ${l.ur}` : ""}</dd>` : ""}
        ${l.dr == null && l.world_rank ? html`<dt>Site strength</dt><dd>${l.popularity} of 100 <span class="faint">(world rank ${l.world_rank.toLocaleString()}, free Tranco list)</span></dd>` : ""}
        ${r.outbound_sites != null ? html`<dt>Page links out to</dt><dd>${plural(r.outbound_sites, "other site")}</dd>` : ""}
        <dt><label for="strategy">How you got it</label></dt><dd><input class="input" id="strategy" list="strategies" value="${l.strategy}" placeholder="For example: guest post"></dd>
        <dt><label for="notes">Notes</label></dt><dd><textarea class="input" id="notes" rows="2" style="min-height:62px" placeholder="Who placed it, what it cost, when it renews">${l.notes}</textarea></dd>
      </dl>
      <datalist id="strategies">${STRATEGIES.map(s => html`<option value="${s}">`)}</datalist>
      ${checks.length ? html`<h3 class="sub">The 15 checks${problems ? `, problems first` : ", all clear"}</h3>
        <ul class="checks">${sorted.map(c => html`<li class="${c.status}"><span class="g" aria-label="${c.status}">${glyph[c.status] || "?"}</span>
          <span class="t">${c.num}. ${c.name}</span><span class="d">${c.detail}</span></li>`)}</ul>` : ""}
      ${detail.history.length > 1 ? html`<h3 class="sub">Every check so far</h3><div class="hist" role="img" aria-label="Verdict history">
        ${detail.history.slice().reverse().map(h => html`<i class="${vcls(h.verdict)}" title="${h.verdict}, ${new Date(h.at).toLocaleString()}"></i>`)}</div>` : ""}
      ${detail.events.filter(e => e.kind !== "first_check").length ? html`<h3 class="sub">Changes</h3><ul class="recent">${detail.events.filter(e => e.kind !== "first_check").map(e =>
        html`<li><span class="${e.severity === "bad" ? "v v-Not" : e.severity === "good" ? "v v-Counts" : "v"}"><i class="dot"></i></span><span>${e.detail}</span><span class="when">${ago(e.at)}</span></li>`)}</ul>` : ""}
      ${detail.screenshot ? html`<details style="margin-top:22px"><summary class="label" style="cursor:pointer">Screenshot from the last check</summary>
        <img class="shot" loading="lazy" alt="The linking page as the checker saw it" src="/api/s/${ctx.site}/links/${l.id}/screenshot?t=${encodeURIComponent(l.last_checked || "")}"></details>` : ""}
      <div class="row" style="margin-top:30px"><button class="btn quiet danger" id="remove">Remove from my links</button></div>
    </div>`);
    $("#recheck", box).onclick = e => busy(e.currentTarget, async () => { await ctx.run({op: "check", which: "ids", ids: [l.id]}); drawDetail(box); }, "Checking");
    // notes save as you type (after a pause), so a background refresh can never lose them
    let saveTimer;
    const save = (quiet) => { clearTimeout(saveTimer); saveTimer = setTimeout(async () => {
      try { await api(`/s/${ctx.site}/links/${l.id}`, {strategy: $("#strategy", box).value, notes: $("#notes", box).value});
        l.strategy = $("#strategy", box).value; l.notes = $("#notes", box).value; if (!quiet) toast("Saved"); load(); }
      catch (e) { toast(e.message); } }, quiet ? 900 : 0); };
    for (const id of ["#strategy", "#notes"]) { $(id, box).oninput = () => save(true); $(id, box).onchange = () => save(false); }
    $("#remove", box).onclick = e => {
      const b = e.currentTarget;
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Click again to remove it and its history"; return; }
      busy(b, async () => { await api(`/s/${ctx.site}/links/${l.id}/delete`, {}); await load(); ctx.go("links"); }, "Removed");
    };
  }
  function drawNew(box) {
    render(box, html`<div class="pad" style="max-width:640px">
      <a class="btn quiet crumb" href="#/${ctx.site}/links">${icon("back")} All links</a>
      <h2 class="wide" style="font-size:22px;margin:0 0 6px">Add a link</h2>
      <p class="muted" style="margin:0 0 22px">The page on another site that links to you. It is checked as soon as you add it.</p>
      <form id="addForm" novalidate>
        <div class="field"><label for="fUrl">Page that links to you</label><input class="input" id="fUrl" placeholder="https://news-site.com.au/article" autocomplete="off" required></div>
        <div class="field"><label for="fTarget">It should link to</label><div class="help">Your whole site, or one exact page if the link must point there.</div>
          <input class="input" id="fTarget" value="${ctx.app.sites.find(s => s.id === ctx.site)?.domain || ""}"></div>
        <div class="grid2"><div class="field"><label for="fStrategy">How you got it</label><input class="input" id="fStrategy" list="strategies2" placeholder="Optional"></div>
          <div class="field"><label for="fNotes">Notes</label><input class="input" id="fNotes" placeholder="Optional"></div></div>
        <datalist id="strategies2">${STRATEGIES.map(s => html`<option value="${s}">`)}</datalist>
        <p class="err" id="addErr" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit">Add and check</button><a class="btn quiet" href="#/${ctx.site}/links">Cancel</a></div>
      </form></div>`);
    $("#fUrl", box).focus();
    $("#addForm", box).onsubmit = async e => {
      e.preventDefault();
      const b = e.submitter || $("button[type=submit]", box);
      try {
        const r = await busy(b, () => api(`/s/${ctx.site}/links`, {source_url: $("#fUrl", box).value, target: $("#fTarget", box).value,
          strategy: $("#fStrategy", box).value, notes: $("#fNotes", box).value, check: true}));
        toast(r.created ? "Added. Checking it now." : "Already in your links. Checking it again.");
        ctx.run({op: "check", which: "ids", ids: [r.id]}).catch(() => {});
        await load(); ctx.go(`links/${r.id}`);
      } catch (err) { $("#addErr", box).textContent = err.message; }
    };
  }

  await load();
  const pick = rest => showDetail(rest[0] === "new" ? "new" : rest[0] ? +rest[0] : null);
  await pick(ctx.rest);
  return {
    update: pick,
    async refresh() {
      await load();
      const editing = document.activeElement && $("#detail", el).contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (typeof sel === "number" && !editing) showDetail(sel);
    },
  };
}
