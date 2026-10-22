// Campaigns: track who picks up a data study you published.
import {api, html, render, $, $$, icon, ago, plural, toast, busy, vcls, vlabel, safeUrl, localDate} from "../core.js";

export async function mount(el, ctx) {
  let data = null, sel = null;
  render(el, html`
    <header class="head"><div><h1>Campaigns</h1><p>Publish something worth citing, then see who writes about it and whether they link.</p></div>
      <div class="tools"><a class="btn primary" href="#/${ctx.site}/campaigns/new">${icon("plus")} Track a study</a></div></header>
    <div class="split" id="split">
      <section class="list" aria-label="Campaigns"><ul class="rows" id="rows"></ul></section>
      <section class="detail" id="detail" aria-live="polite"></section>
    </div>`);

  async function load() {
    try { data = await api(`/s/${ctx.site}/campaigns`); } catch (e) { return render($("#rows", el), html`<li class="empty err">${e.message}</li>`); }
    render($("#rows", el), data.campaigns.length ? data.campaigns.map(c => html`<li><a href="#/${ctx.site}/campaigns/${c.id}" aria-current="${c.id === sel}">
      <div class="l1"><b>${c.name}</b><span class="r">${c.active ? "tracking" : "ended"}</span></div>
      <div class="l2">${plural(c.stats.linked, "linking page")}, ${plural(c.stats.mentions, "mention")} without a link</div></a></li>`)
      : html`<li class="empty">No campaigns yet.</li>`);
  }
  async function show(id) {
    sel = id; await load();
    $("#split", el).classList.toggle("has-detail", id !== null);
    el.classList.toggle("in-detail", id !== null);
    const box = $("#detail", el);
    if (id === "new") return drawNew(box);
    if (id === null) return render(box, html`<div class="pad" style="max-width:640px">
      <h2 class="wide" style="font-size:22px;margin:0 0 8px">How a campaign works</h2>
      <p class="muted">A data study is the most reliable way for a local business to earn links from news sites: something like "Average smash repair cost in Melbourne, 2026", built from your own job records. Journalists cite numbers.</p>
      <p class="muted">Publish it on your site, then track it here. For ${data.active_days} days the tool looks every week for new pages linking to it, and for pages that quote it without a link, so you can ask them to cite you.</p>
      ${data.dataforseo || data.feeds ? "" : html`<div class="notice">To catch pages that write about a study, create a free <a href="https://www.google.com/alerts" target="_blank" rel="noreferrer">Google Alert</a> for its key phrase, set Deliver to: RSS feed, and add the feed in <a href="#/${ctx.site}/settings/free">Settings, Free sources</a>. You can also paste any page into <a href="#/${ctx.site}/opportunities">Check a page</a>.</div>`}
      <a class="btn primary" href="#/${ctx.site}/campaigns/new">${icon("plus")} Track a study</a></div>`);
    const c = data.campaigns.find(x => x.id === id);
    if (!c) return render(box, html`<div class="pad"><p class="err">That campaign no longer exists.</p></div>`);
    const running = ctx.jobs()?.task.running === "check campaign";
    render(box, html`<div class="pad">
      <a class="btn quiet crumb" href="#/${ctx.site}/campaigns">${icon("back")} All campaigns</a>
      <div class="dhead"><div><h2>${c.name}</h2><div class="sub"><a href="${safeUrl(c.asset_url)}" target="_blank" rel="noreferrer">${c.asset_url}</a></div></div>
        <button class="btn" id="checkNow" ${running ? "disabled" : ""}>${icon("refresh")} ${running ? "Checking…" : "Check now"}</button></div>
      <p class="muted">Launched ${new Date(c.started_at).toLocaleDateString(undefined, {day: "numeric", month: "long", year: "numeric"})}. ${c.active ? "Checked weekly." : "No longer tracked."} Last checked ${ago(c.last_checked)}.
        ${c.phrases.length ? html`<br>Looking for: ${c.phrases.map(p => `“${p}”`).join(", ")}.` : html`<br>No phrases set, so only links are tracked.`}</p>
      <div class="stats" style="margin-top:20px"><div><b>${c.stats.linked}</b><span>linking pages</span></div><div><b>${c.stats.counts}</b><span>of them count</span></div>
        <div><b>${c.stats.mentions}</b><span>mentions without a link</span></div><div><b>${c.stats.sites}</b><span>sites</span></div></div>
      <h3 class="sub">Pickups</h3>
      ${c.pickups.length ? html`<table class="plain"><thead><tr><th>Page</th><th>Found</th><th>Result</th></tr></thead><tbody>${c.pickups.map(p => html`<tr>
        <td><a href="${safeUrl(p.url)}" target="_blank" rel="noreferrer">${p.title || p.url}</a><div class="faint" style="font-size:13px">${p.site}</div></td>
        <td class="faint">${ago(p.found_at)}</td>
        <td>${p.kind === "linked" ? html`<a class="${vcls(p.verdict)} vtag" href="#/${ctx.site}/links/${p.link_id}"><i class="dot"></i>${vlabel(p.verdict)}</a>`
          : html`<a href="#/${ctx.site}/opportunities/${p.opp_id}">Ask for a link</a>`}</td></tr>`)}</tbody></table>`
        : html`<p class="muted">Nothing yet. Pickups usually start within days of you sending the study to journalists.</p>`}
      <div class="row" style="margin-top:30px"><button class="btn quiet danger" id="del">Stop tracking</button></div></div>`);
    $("#checkNow", box).onclick = e => busy(e.currentTarget, () => ctx.run({op: "campaign", id: c.id}), "Checking. Results appear here when it finishes.");
    $("#del", box).onclick = e => {
      const b = e.currentTarget;
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Click again to stop tracking (found links stay in Links)"; return; }
      busy(b, async () => { await api(`/s/${ctx.site}/campaigns/${c.id}/delete`, {}); ctx.go("campaigns"); }, "Stopped tracking");
    };
  }
  function drawNew(box) {
    render(box, html`<div class="pad" style="max-width:640px">
      <a class="btn quiet crumb" href="#/${ctx.site}/campaigns">${icon("back")} All campaigns</a>
      <h2 class="wide" style="font-size:22px;margin:0 0 18px">Track a study</h2>
      <form id="f" novalidate>
        <div class="field"><label for="cName">Name</label><input class="input" id="cName" placeholder="2026 smash repair cost study"></div>
        <div class="field"><label for="cUrl">Where it is published</label><input class="input" id="cUrl" placeholder="https://${ctx.app.sites.find(s => s.id === ctx.site)?.domain}/repair-cost-study"></div>
        <div class="field"><label for="cPhrases">Phrases people will quote</label><div class="help">One per line. Usually your headline number, and the study's name.</div>
          <textarea class="input" id="cPhrases" placeholder="average smash repair cost rose 18%"></textarea></div>
        <div class="field"><label for="cStart">Launch date</label><input class="input" id="cStart" type="date" value="${localDate()}" style="max-width:200px"></div>
        <p class="err" id="cErr" role="alert"></p>
        <div class="row"><button class="btn primary" type="submit">Start tracking</button><a class="btn quiet" href="#/${ctx.site}/campaigns">Cancel</a></div>
      </form></div>`);
    $("#cName", box).focus();
    $("#f", box).onsubmit = async e => {
      e.preventDefault();
      try { const r = await busy($("button[type=submit]", box), () => api(`/s/${ctx.site}/campaigns`, {name: $("#cName", box).value, asset_url: $("#cUrl", box).value,
          phrases: $("#cPhrases", box).value, started_at: $("#cStart", box).value}));
        toast("Tracking started"); ctx.go(`campaigns/${r.id}`); }
      catch (err) { $("#cErr", box).textContent = err.message; }
    };
  }
  const pick = rest => show(rest[0] === "new" ? "new" : rest[0] ? +rest[0] : null);
  await pick(ctx.rest);
  return {update: pick, refresh: () => (sel === "new" ? load() : pick(sel === null ? [] : [String(sel)]))};
}
