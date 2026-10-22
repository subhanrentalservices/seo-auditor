// Today: where you stand in one line, then what to do next.
import {api, html, render, $, icon, ago, longDate, plural, vcls, busy} from "../core.js";

export async function mount(el, ctx) {
  let data = null;
  async function load() {
    try { data = await api(`/s/${ctx.site}/today`); draw(); }
    catch (e) { render(el, html`<div class="pad"><p class="err">${e.message}</p></div>`); }
  }
  function statusLine(s) {
    const v = s.verdicts;
    if (!s.links) return "No links logged yet.";
    if (v["Counts"] === s.links) return `${plural(s.links, "link")}, and every one counts.`;
    const parts = v["Counts"] ? [`${v["Counts"]} count`] : ["none count yet"];
    const bad = v["Weak"] + v["Not counted"];
    if (bad) parts.push(`${bad} need${bad === 1 ? "s" : ""} a look`);
    if (v["Pending"]) parts.push(`${v["Pending"]} waiting for Google`);
    if (v.unchecked) parts.push(`${v.unchecked} not checked yet`);
    const list = parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts.at(-1) : parts[0];
    return `${plural(s.links, "link")}. ${list[0].toUpperCase() + list.slice(1)}.`;
  }
  function draw() {
    const s = data.summary, v = s.verdicts, total = s.links || 1;
    const seg = [["Counts", v["Counts"]], ["Weak", v["Weak"]], ["Pending", v["Pending"]], ["Not counted", v["Not counted"]], [null, v.unchecked]];
    const acts = data.actions;
    const main = acts.filter(a => a.priority !== "setup"), setup = acts.filter(a => a.priority === "setup");
    render(el, html`
      <header class="head"><div><h1>Today</h1><p>${longDate()}</p></div>
        <div class="tools"><a class="btn" href="#/${ctx.site}/links/new">${icon("plus")} Add a link</a></div></header>
      <div class="scroll"><div class="pad today">
        <p class="status-line">${statusLine(s)}</p>
        ${s.links ? html`
          <div class="vbar" role="img" aria-label="${seg.filter(x => x[1]).map(([k, n]) => `${n} ${k || "not checked"}`).join(", ")}">
            ${seg.filter(x => x[1]).map(([k, n]) => html`<i class="${vcls(k)}" style="width:${(100 * n / total).toFixed(2)}%"></i>`)}</div>
          <div class="vkey">${seg.filter(x => x[1]).map(([k, n]) => html`<span class="${vcls(k)}"><i class="dot"></i><b>${n}</b> ${k ? k.toLowerCase() : "not checked yet"}</span>`)}
            ${s.opportunities_open ? html`<span><b>${s.opportunities_open}</b> open opportunities</span>` : ""}
            ${s.won ? html`<span><b>${s.won}</b> won</span>` : ""}</div>` : ""}

        <h2 class="section">Do these next</h2>
        ${main.length ? html`<ul class="acts">${main.map(actRow)}</ul>`
          : html`<div class="done">${icon("doneCircle")}<div><b>Nothing urgent.</b> Your links are checked and there is nothing waiting for you. Find new opportunities when you have time.</div>
             <button class="btn" data-run='{"op":"find","which":"all"}' style="margin-left:auto">Find opportunities</button></div>`}

        ${setup.length ? html`<h2 class="section">Set up to get more</h2><p class="section-help">Each of these switches on more of the tool.</p>
          <ul class="acts">${setup.map(actRow)}</ul>` : ""}

        ${data.recent.length ? html`<h2 class="section">Recent changes</h2>
          <ul class="recent">${data.recent.map(e => html`<li><span class="${e.severity === "bad" ? "v v-Not" : e.severity === "good" ? "v v-Counts" : "v"}"><i class="dot"></i></span>
            <a href="#/${ctx.site}/links/${e.link_id}">${e.host}</a><span class="muted">${e.detail}</span><span class="when">${ago(e.at)}</span></li>`)}</ul>` : ""}
      </div></div>`);
    el.querySelectorAll("[data-run]").forEach(b => b.onclick = () => busy(b, () => ctx.run(JSON.parse(b.dataset.run)), "Started"));
  }
  function actRow(a) {
    const b = a.action;
    return html`<li class="act ${a.priority}"><span class="bar" aria-hidden="true"></span>
      <div><b>${a.title}</b><p>${a.why}</p></div>
      ${b.go ? html`<a class="btn ${a.priority === "urgent" ? "primary" : ""}" href="#/${ctx.site}/${b.go}">${b.label}</a>`
        : html`<button class="btn ${a.priority === "urgent" ? "primary" : ""}" data-run='${JSON.stringify(b.run)}'>${b.label}</button>`}</li>`;
  }
  await load();
  return {refresh: load, update: load};
}
