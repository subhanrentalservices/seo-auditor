// Opportunities: places that could link to you, best first, with a draft for each.
import {api, html, render, $, $$, icon, ago, plural, toast, busy, safeUrl} from "../core.js";

const KIND = {unlinked_mention: "Mentions you, no link", journalist: "Journalist request", gap: "Links to competitors",
  broken_backlink: "Dead competitor link", broken_link: "Dead link on a page", resource_page: "Resource list",
  listing: "Free listing", profile: "Your profile", partner: "Competitor partner"};
const SELF_SERVE = new Set(["listing", "profile"]);  // you do it yourself: no email to write
const STATUS = [["new", "New"], ["working", "Working on it"], ["pitched", "Pitched"], ["lost", "Didn't work"], ["ignored", "Not for me"]];
const VIEWS = [["open", "Open"], ["pitched", "Pitched"], ["won", "Won"], ["closed", "Closed"]];
const FINDER_LABEL = {mentions: "Unlinked mentions", journalists: "Journalist requests", listings: "Free listings", partners: "Competitor partners",
  gap: "Competitor gaps", broken: "Dead competitor links", resources: "Resource lists", campaigns: "Study pickups"};

export async function mount(el, ctx) {
  let data = null, view = "open", kinds = new Set(), q = "", sel = null;
  render(el, html`
    <header class="head"><div><h1>Opportunities</h1><p id="osub">&nbsp;</p><div id="lastFind"></div></div>
      <div class="tools"><select class="input" id="which" aria-label="Where to look" style="width:auto"><option value="all">Every source</option></select>
        <button class="btn primary" id="find">Find new</button></div></header>
    <form class="scanbar" id="scan" novalidate><label for="scanUrl">Check a page</label>
      <input class="input" id="scanUrl" type="url" inputmode="url" placeholder="Paste any page: a blog post, a news story, a list of links" autocomplete="off">
      <button class="btn" id="scanGo">Check</button>
      <p class="faint scanhelp">Finds whether it links to you, names you without a link, or has dead links you could replace.</p>
      <div id="scanOut" aria-live="polite"></div></form>
    <div class="split" id="split">
      <section class="list" aria-label="Opportunities">
        <div class="filters"><input class="input" type="search" id="q" placeholder="Search" aria-label="Search opportunities">
          <div class="seg" role="group" aria-label="Show">${VIEWS.map(([k, l]) => html`<button data-v="${k}" aria-pressed="${k === view}">${l}</button>`)}</div>
          <div class="chips" id="kinds"></div></div>
        <ul class="rows" id="rows"></ul>
      </section>
      <section class="detail" id="detail" aria-live="polite"></section>
    </div>`);
  $("#q", el).oninput = e => { q = e.target.value.trim().toLowerCase(); drawList(); };
  $$("[data-v]", el).forEach(b => b.onclick = () => { view = b.dataset.v; $$("[data-v]", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); drawList(); });
  $("#find", el).onclick = e => busy(e.currentTarget, () => ctx.run({op: "find", which: $("#which", el).value}), "Looking. Results appear here when it finishes.");
  let scanSeen = ctx.lastTask()?.op?.op === "scan" ? ctx.lastTask().finished : null;
  $("#scan", el).onsubmit = e => {
    e.preventDefault();
    const url = $("#scanUrl", el).value.trim();
    if (!url) return $("#scanUrl", el).focus();
    render($("#scanOut", el), html`<p class="faint">Reading the page and testing its links…</p>`);
    busy($("#scanGo", el), () => ctx.run({op: "scan", url})).catch(err => render($("#scanOut", el), html`<p class="err">${err.message}</p>`));
  };
  function drawScan() {
    const last = ctx.lastTask();
    if (!last || last.op?.op !== "scan" || last.finished === scanSeen) return;
    scanSeen = last.finished;
    const out = $("#scanOut", el);
    if (!last.ok) return render(out, html`<p class="err">${last.error}</p>`);
    const s = last.scan;
    render(out, html`<div class="scanres"><b>${s.title}</b> <span class="faint">${s.site}</span>
      <ul>${s.summary.map(x => html`<li>${x}</li>`)}</ul>
      <div class="row">${s.links.length && !s.link_id ? html`<button type="button" class="btn small primary" id="scanAdd">Add to my links</button>` : ""}
        ${s.link_id ? html`<a class="btn small" href="#/${ctx.site}/links/${s.link_id}">See it in my links</a>` : ""}
        ${s.opps.map((id, i) => html`<a class="btn small" href="#/${ctx.site}/opportunities/${id}">Open opportunity${s.opps.length > 1 ? ` ${i + 1}` : ""}</a>`)}</div></div>`);
    const add = $("#scanAdd", out);
    if (add) add.onclick = async () => {
      try { const r = await busy(add, () => api(`/s/${ctx.site}/links`, {source_url: s.url}));
        toast("Added. Checking it now."); ctx.go(`links/${r.id}`); }
      catch (err) { /* toast shown */ }
    };
  }

  async function load() {
    try { data = await api(`/s/${ctx.site}/opps`); }
    catch (e) { render($("#rows", el), html`<li class="empty err">${e.message}</li>`); return; }
    const s = data.sources, which = $("#which", el), keep = which.value;
    render(which, html`<option value="all">Every source</option>${data.finders.map(k => html`<option value="${k}">${FINDER_LABEL[k] || k}</option>`)}`);
    which.value = [...which.options].some(o => o.value === keep) ? keep : "all";
    $("#osub", el).innerHTML = "";
    render($("#osub", el), html`${plural(data.opps.filter(o => ["new", "working", "pitched"].includes(o.status)).length, "open opportunity", "open opportunities")}.
      ${s.dataforseo ? ` DataForSEO this month: $${data.spent.toFixed(2)} of $${data.budget.toFixed(2)}.` : ""}`);
    drawScan();
    // what the last search found, including why a source found nothing
    const last = ctx.lastTask();
    const lf = $("#lastFind", el);
    if (lf) render(lf, last && last.op?.op === "find" && last.ok ? html`<p class="faint" style="font-size:13px;margin-top:6px">Last search ${ago(new Date(last.finished * 1000).toISOString())}:
      ${last.results.map(r => html`<span style="display:block">${FINDER_LABEL[r.name] || r.name}: ${plural(r.new, "new", "new")}${r.errors.length ? html`. <span class="err" style="display:inline">${r.errors.join(" ")}</span>` : r.notes.length ? `. ${r.notes.join(" ")}` : ""}</span>`)}</p>` : "");
    const present = [...new Set(data.opps.map(o => o.kind))];
    render($("#kinds", el), present.length > 1 ? present.map(k => html`<button class="chip" data-k="${k}" aria-pressed="${kinds.has(k)}">${KIND[k] || k}</button>`) : "");
    $$("[data-k]", el).forEach(b => b.onclick = () => { kinds.has(b.dataset.k) ? kinds.delete(b.dataset.k) : kinds.add(b.dataset.k); b.setAttribute("aria-pressed", String(kinds.has(b.dataset.k))); drawList(); });
    drawList();
  }
  function shown() {
    const inView = o => view === "open" ? ["new", "working"].includes(o.status) : view === "pitched" ? o.status === "pitched"
      : view === "won" ? o.status === "won" : ["lost", "ignored"].includes(o.status);
    let rows = data.opps.filter(o => inView(o) && (!kinds.size || kinds.has(o.kind)));
    if (q) rows = rows.filter(o => [o.title, o.site, o.url, o.notes, o.data.request].join(" ").toLowerCase().includes(q));
    return rows.sort((a, b) => b.score - a.score || b.id - a.id);
  }
  function drawList() {
    if (!data) return;
    const rows = shown();
    const empty = !data.opps.length
      ? html`Nothing found yet. Pick where to look at the top and click <b>Find new</b>.`
      : view === "open" ? "Nothing open here. Try another filter, or find more." : "Nothing here yet.";
    render($("#rows", el), rows.length ? rows.map(o => html`<li><a href="#/${ctx.site}/opportunities/${o.id}" aria-current="${o.id === sel}">
      <div class="l1"><span class="score ${o.score >= 60 ? "hi" : o.score >= 40 ? "mid" : ""}">${o.score}</span><b>${o.title || o.site}</b></div>
      <div class="l2">${KIND[o.kind] || o.kind}${o.site ? `, ${o.site}` : ""}. Found ${ago(o.found_at)}</div></a></li>`) : html`<li class="empty">${empty}</li>`);
  }

  async function showDetail(id) {
    sel = id; drawList();
    $("#split", el).classList.toggle("has-detail", id !== null);
    el.classList.toggle("in-detail", id !== null);
    const box = $("#detail", el);
    if (id === null) return render(box, html`<div class="blank pad"><p class="muted" style="max-width:56ch">Pick an opportunity. Each one says what to do, and can write a first draft of the email for you to check and send yourself. Nothing is ever sent by the tool.</p></div>`);
    let o = data?.opps.find(x => x.id === id);
    if (!o) { await load(); o = data?.opps.find(x => x.id === id); }
    if (!o) return render(box, html`<div class="pad"><p class="err">That opportunity no longer exists.</p></div>`);
    drawDetail(box, o);
    if (!SELF_SERVE.has(o.kind)) loadDraft(box, o);
  }
  function facts(o) {
    const d = o.data, link = u => u ? html`<a href="${safeUrl(u)}" target="_blank" rel="noreferrer">${u}</a>` : "";
    const rows = [
      [SELF_SERVE.has(o.kind) ? "Start here" : "Page", o.url.startsWith("email:") ? "" : link(o.url)],
      ["They wrote", d.context], ["Dead link", link(d.dead_url)], ["Dead because", d.dead_status], ["Its anchor text", d.anchor],
      ["Old copy", link(d.wayback)], ["Offer this page", link(d.suggested_page)], [o.kind === "partner" ? "Competitors linking to it" : "Also links to", (d.competitors || []).join(", ")],
      ["Outlet", d.outlet], ["Deadline", d.deadline], ["From", d.source], ["Campaign", d.campaign],
      ["Linked from", (d.where || []).length ? html`${d.where.map(u => html`<span style="display:block">${link(u)}</span>`)}` : ""],
      ["Strength", d.strength != null ? `${d.strength} of 100 (${d.strength_source}${d.ahrefs_dr != null ? `, DR ${d.ahrefs_dr}` : ""}${d.ahrefs_ur != null ? `, UR ${d.ahrefs_ur}` : ""})` : ""],
      ["Good to know", d.note],
      ["Dead links on it", d.broken_links != null ? `${d.broken_links} of ${d.links_checked} checked` : ""],
      ["Why this score", o.score_detail],
    ].filter(([, v]) => v);
    return html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
  }
  function drawDetail(box, o) {
    render(box, html`<div class="pad">
      <a class="btn quiet crumb" href="#/${ctx.site}/opportunities">${icon("back")} All opportunities</a>
      <div class="dhead"><div><h2>${o.title || o.site}</h2><div class="sub">${KIND[o.kind] || o.kind}${o.site ? `, ${o.site}` : ""}. Score ${o.score}.</div></div>
        ${o.url.startsWith("http") ? html`<a class="btn ${SELF_SERVE.has(o.kind) ? "primary" : "quiet"}" href="${safeUrl(o.url)}" target="_blank" rel="noreferrer">${icon("ext")} ${o.kind === "listing" ? "Sign up" : o.kind === "profile" ? "Open profile" : "Open page"}</a>` : ""}</div>
      ${o.data.how ? html`<p class="how">${o.data.how}</p>` : o.kind === "journalist" ? html`<p class="how">Answer only if you really know this subject. Short, specific, first-hand answers get picked.</p>` : ""}
      <h3 class="sub">Details</h3>${facts(o)}
      ${o.data.request ? html`<h3 class="sub">The request</h3><pre class="req">${o.data.request}</pre>` : ""}
      ${SELF_SERVE.has(o.kind) ? "" : html`<h3 class="sub">Draft</h3><div id="draft"><p class="faint">Loading…</p></div>`}
      <h3 class="sub">Where it stands</h3>
      <div class="seg status-pick" role="group" aria-label="Status">${STATUS.map(([k, l]) => html`<button data-s="${k}" aria-pressed="${o.status === k}">${l}</button>`)}</div>
      <div class="field" style="margin-top:16px"><label for="oNotes">Notes</label><textarea class="input" id="oNotes" placeholder="Who you contacted and when">${o.notes}</textarea></div>
      <h3 class="sub">Got the link?</h3>
      ${o.status === "won" && o.link_id ? html`<p>Won. <a href="#/${ctx.site}/links/${o.link_id}">See the link and its checks</a>.</p>`
        : o.status === "won" ? html`<p>Done.</p>`
        : o.kind === "listing" && o.data.verify === false ? html`<p class="muted">This listing lives inside a map app, so it can't be checked automatically.</p>
          <div class="row"><button class="btn primary" id="done">I've done it</button></div>` : html`
        <div class="row"><input class="input" id="wonUrl" style="flex:1;min-width:220px" value="${o.url.startsWith("http") && o.kind !== "listing" ? o.url : ""}" placeholder="${o.kind === "listing" ? "Address of your listing page" : "Page where your link now is"}" aria-label="Page where your link now is">
          <button class="btn primary" id="won">Add it to my links</button></div><p class="err" id="wonErr" role="alert"></p>`}
    </div>`);
    $$("[data-s]", box).forEach(b => b.onclick = async () => {
      try { await api(`/s/${ctx.site}/opps/${o.id}`, {status: b.dataset.s}); o.status = b.dataset.s;
        $$("[data-s]", box).forEach(x => x.setAttribute("aria-pressed", String(x === b))); toast(`Marked: ${b.textContent}`); load(); }
      catch (e) { toast(e.message); }
    });
    $("#oNotes", box).onchange = async e => { try { await api(`/s/${ctx.site}/opps/${o.id}`, {notes: e.target.value}); o.notes = e.target.value; toast("Notes saved"); } catch (err) { toast(err.message); } };
    const done = $("#done", box);
    if (done) done.onclick = async () => { try { await api(`/s/${ctx.site}/opps/${o.id}`, {status: "won"}); o.status = "won"; toast("Marked as done"); drawDetail(box, o); load(); } catch (e) { toast(e.message); } };
    const won = $("#won", box);
    if (won) won.onclick = async () => {
      try { const r = await busy(won, () => api(`/s/${ctx.site}/opps/${o.id}/won`, {link_url: $("#wonUrl", box).value}));
        toast("Added to your links. Checking it now."); ctx.run({op: "check", which: "ids", ids: [r.link_id]}).catch(() => {}); ctx.go(`links/${r.link_id}`); }
      catch (e) { $("#wonErr", box).textContent = e.message; }
    };
  }

  async function loadDraft(box, o) {
    let r;
    try { r = await api(`/s/${ctx.site}/opps/${o.id}/draft`); } catch (e) { return render($("#draft", box), html`<p class="err">${e.message}</p>`); }
    drawDraft(box, o, r.draft, r.ai);
  }
  function drawDraft(box, o, d, ai) {
    const slot = $("#draft", box); if (!slot) return;
    const makeBtns = html`<button class="btn ${d ? "" : "primary"}" data-make="0">${d ? "Start again" : "Write a draft"}</button>
      ${ai ? html`<button class="btn" data-make="1">${d ? "Rewrite with AI" : "Write with AI"}</button>` : ""}`;
    if (!d) {
      render(slot, html`<p class="muted" style="margin:0 0 12px;max-width:62ch">Writes an honest first draft from your settings and what was found on the page, and looks up their public email address. ${ai ? "" : "You check and send it yourself."}</p>
        <div class="row">${makeBtns}</div><p class="err" id="dErr" role="alert"></p>`);
    } else {
      const c = d.contacts || {}, emails = c.emails || [];
      render(slot, html`<div class="composer">
        <div class="faint" style="font-size:13px;margin-bottom:10px">${d.source === "ai" ? "Written with AI" : d.source === "edited" ? "Your edited version" : "Template draft"}, ${ago(d.created_at)}.
          ${c.author ? ` Author: ${c.author}.` : ""}${(c.contact_pages || []).length ? html` Contact page: <a href="${safeUrl(c.contact_pages[0])}" target="_blank" rel="noreferrer">${c.contact_pages[0].replace(/^https?:\/\//, "")}</a>` : ""}</div>
        <div class="field"><label for="dTo">To</label><input class="input" id="dTo" list="dToList" value="${d.to}" placeholder="No public email found. Check their contact page.">
          <datalist id="dToList">${emails.map(e => html`<option value="${e}">`)}</datalist></div>
        <div class="field"><label for="dSubject">Subject</label><input class="input" id="dSubject" value="${d.subject}"></div>
        <div class="field" style="margin:0"><label for="dBody">Message</label><textarea class="input" id="dBody">${d.body}</textarea></div>
        <div id="dPh"></div>
        ${(d.tips || []).length ? html`<ul class="tips">${d.tips.map(t => html`<li>${t}</li>`)}</ul>` : ""}
        ${(d.notes || []).map(n => html`<p class="err">${n}</p>`)}
        <div class="row" style="margin-top:14px"><button class="btn primary" id="dMail">Open in my email app</button><button class="btn" id="dCopy">Copy</button>
          <button class="btn quiet" id="dSave">Save changes</button><span style="flex:1"></span>${makeBtns}</div>
        <p class="err" id="dErr" role="alert"></p></div>`);
      const ph = () => {
        const found = [...new Set((($("#dSubject", slot).value + "\n" + $("#dBody", slot).value).match(/\[[A-Z][A-Z0-9 ,.'\/&:;()?!\-–—]{2,}\]/g) || []))];
        render($("#dPh", slot), found.length ? html`<div class="ph">Fill in or delete before sending: ${found.join(", ")}</div>` : "");
      };
      ph(); $("#dBody", slot).oninput = ph; $("#dSubject", slot).oninput = ph;
      const cur = () => ({to: $("#dTo", slot).value.trim(), subject: $("#dSubject", slot).value, body: $("#dBody", slot).value});
      $("#dSave", slot).onclick = e => busy(e.currentTarget, async () => { const r = await api(`/s/${ctx.site}/opps/${o.id}/draft/save`, cur()); drawDraft(box, o, r.draft, ai); }, "Draft saved");
      $("#dCopy", slot).onclick = async () => {
        const t = `Subject: ${cur().subject}\n\n${cur().body}`;
        try { await navigator.clipboard.writeText(t); } catch (e) { const a = document.createElement("textarea"); a.value = t; document.body.append(a); a.select(); document.execCommand("copy"); a.remove(); }
        toast("Copied");
      };
      $("#dMail", slot).onclick = async () => {
        const v = cur();
        const long = encodeURIComponent(v.body).length > 1800;  // Outlook and others cut long mailto links
        if (long) { try { await navigator.clipboard.writeText(v.body); } catch (e) { /* shown below */ } }
        api(`/s/${ctx.site}/opps/${o.id}/draft/save`, v).catch(() => {});
        if (o.status === "new" || o.status === "working") { api(`/s/${ctx.site}/opps/${o.id}`, {status: "pitched"}).then(() => { toast("Opened in your email app. Marked as pitched."); load(); }).catch(() => {}); }
        location.href = `mailto:${encodeURIComponent(v.to).replace(/%40/g, "@")}?subject=${encodeURIComponent(v.subject)}&body=${encodeURIComponent(long ? "(The message is on your clipboard: paste it here.)" : v.body)}`;
        if (long) toast("The message was long, so it's on your clipboard. Paste it into the email.");
      };
    }
    $$("[data-make]", slot).forEach(b => b.onclick = async () => {
      const aiOn = b.dataset.make === "1";
      const edited = d && (d.source === "edited" || ($("#dBody", slot) && $("#dBody", slot).value !== d.body));
      if (!aiOn && edited && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Click again to replace your edits"; return; }
      const body = $("#dBody", slot) ? {subject: $("#dSubject", slot).value, body: $("#dBody", slot).value} : {};
      $$("[data-make]", slot).forEach(x => x.disabled = true);
      b.textContent = aiOn ? "Writing with AI…" : "Writing…";
      try { const r = await api(`/s/${ctx.site}/opps/${o.id}/draft`, aiOn ? {ai: true, ...body} : {ai: false}); drawDraft(box, o, r.draft, ai); }
      catch (e) { $$("[data-make]", slot).forEach(x => x.disabled = false); $("#dErr", slot).textContent = e.message; }
    });
  }

  await load();
  const pick = rest => showDetail(rest[0] ? +rest[0] : null);
  await pick(ctx.rest);
  // refresh only the list: re-drawing the detail would throw away a draft being edited
  return {update: pick, refresh: load};
}
