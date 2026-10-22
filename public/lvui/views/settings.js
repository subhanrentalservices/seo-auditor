// Settings: everything that used to mean editing config.toml by hand.
import {api, html, render, $, $$, icon, toast, busy} from "../core.js";

// How each settings section is laid out: one block per service, its test button underneath.
const BLOCKS = {
  free: [
    {title: "Google Alerts", help: "Free. At google.com/alerts, create an alert for your business name (and for each study's key phrase), set Deliver to: RSS feed, and paste the feed address here. Nothing is emailed.",
     link: "https://www.google.com/alerts", linkText: "Open Google Alerts", test: "feeds", attrs: ["google_alerts_feeds"]},
    {title: "Journalist requests", help: "Free. Reporters post requests tagged #journorequest on Bluesky and Mastodon. The tool picks the ones that match your topics.",
     attrs: ["bluesky_search", "mastodon_search", "bluesky_hashtags", "mastodon_instances", "journalist_days_back"]},
    {title: "Site strength", help: "Free. Rates linking sites by where they rank among the world's top million websites (the Tranco research list). It is not Ahrefs DR, but strong sites score high on both. Small local sites usually aren't in the list.",
     link: "https://tranco-list.eu/", linkText: "About Tranco", attrs: ["use_tranco"]},
  ],
  notify: [
    {title: "On this computer", help: "A Windows pop-up after the daily run, only when something needs you. Free, no email.", test: "notify", attrs: ["desktop_notifications"]},
    {title: "What to tell you about", attrs: ["alert_on", "alert_min_score"]},
  ],
  extras: [
    {title: "DataForSEO (paid)", help: "Pay-as-you-go search data from $50. Adds competitor gaps, dead competitor links, resource lists, Google mention search, study pickups by search, and the 'seen in Google' check.",
     link: "https://app.dataforseo.com/api-access", linkText: "API login", test: "dataforseo",
     attrs: ["dataforseo_login", "dataforseo_password", "dataforseo_monthly_budget_usd", "serp_mention_search", "dataforseo_language_code"]},
    {title: "Ahrefs (paid)", help: "Real Domain Rating and URL Rating instead of the free world ranking. Needs an Ahrefs plan with API access.",
     link: "https://app.ahrefs.com/api/keys", linkText: "Create a key", test: "ahrefs", attrs: ["ahrefs_api_key", "ahrefs_cache_days"]},
    {title: "Anthropic (paid)", help: "Rewrites outreach drafts with AI. The free template drafts work without it.",
     link: "https://console.anthropic.com/settings/keys", linkText: "Create a key", test: "anthropic", attrs: ["anthropic_api_key", "anthropic_model"]},
    {title: "Read your inbox", help: "Reads request newsletters (Source of Sources, Qwoted, Featured) from an email inbox, read-only.", test: "inbox",
     attrs: ["imap_host", "imap_username", "imap_password", "imap_port", "imap_folder", "journalist_senders"]},
    {title: "Email or Telegram alerts", help: "Sends the alerts by email or Telegram instead of a desktop pop-up.", test: "alerts",
     attrs: ["email_smtp_host", "email_username", "email_password", "email_to", "email_smtp_port", "email_from", "telegram_bot_token", "telegram_chat_id"]},
    {title: "Google Search Console", help: "Free from Google, but needs a service account set up in Google Cloud.", attrs: ["gsc_property", "gsc_service_account_file"]},
  ],
};
const COUNTRIES = [[2036, "Australia"], [2554, "New Zealand"], [2586, "Pakistan"], [2356, "India"], [2784, "United Arab Emirates"],
  [2826, "United Kingdom"], [2840, "United States"], [2124, "Canada"]];
const CHOICES = {dataforseo_location_code: COUNTRIES, alert_on: [["changes", "Problems and recoveries"], ["bad", "Problems only"]]};

const TEST_LABEL = {dataforseo: "DataForSEO", ahrefs: "Ahrefs", anthropic: "Anthropic", inbox: "inbox", alerts: "alerts (sends a test)",
  feeds: "Google Alerts feeds", notify: "a notification"};

export async function mount(el, ctx) {
  let data = null, group = ctx.rest[0] || "site", dirty = {}, clear = new Set();
  async function load() {
    data = await api(`/s/${ctx.site}/settings`);
    dirty = {}; clear = new Set();
    draw();
  }
  const fieldsOf = g => data.fields.filter(f => f.group === g);
  function input(f) {
    const id = "f-" + f.attr, v = f.attr in dirty ? dirty[f.attr] : f.value;
    if (f.kind === "bool") return html`<label class="toggle"><input type="checkbox" id="${id}" data-attr="${f.attr}" ${v ? "checked" : ""}><span><b>${f.label}</b>${f.help ? html`<br><span class="faint" style="font-size:13px">${f.help}</span>` : ""}</span></label>`;
    let control;
    if (f.secret && f.set && !clear.has(f.attr) && !(f.attr in dirty)) {
      control = html`<div class="secret"><span class="saved">${icon("check", 'width="16" height="16"')} Saved</span>
        <button type="button" class="btn small" data-replace="${f.attr}">Replace</button><button type="button" class="btn small quiet danger" data-clear="${f.attr}">Remove</button></div>`;
    } else if (CHOICES[f.attr]) {
      const opts = CHOICES[f.attr].some(([k]) => String(k) === String(v)) ? CHOICES[f.attr] : [[v, String(v)], ...CHOICES[f.attr]];
      control = html`<select class="input" id="${id}" data-attr="${f.attr}">${opts.map(([k, l]) => html`<option value="${k}" ${String(k) === String(v) ? "selected" : ""}>${l}</option>`)}</select>`;
    } else if (f.kind === "list") {
      control = html`<textarea class="input" id="${id}" data-attr="${f.attr}" rows="${Math.min(8, Math.max(3, String(v).split("\n").length + 1))}">${v}</textarea>`;
    } else {
      control = html`<input class="input" id="${id}" data-attr="${f.attr}" type="${f.secret ? "password" : f.kind === "int" || f.kind === "float" ? "number" : "text"}"
        ${f.kind === "float" ? 'step="any"' : ""} value="${f.secret ? (dirty[f.attr] || "") : v}" autocomplete="off" ${f.attr === "my_site" ? "readonly" : ""}>`;
    }
    return html`<div class="field"><label for="${id}">${f.label}</label>${f.help ? html`<div class="help">${f.help}</div>` : ""}${control}</div>`;
  }
  function draw() {
    const groups = data.groups;
    const g = groups.find(x => x.id === group);
    const navLink = x => html`<a href="#/${ctx.site}/settings/${x.id}" aria-current="${x.id === group ? "page" : "false"}">${x.title}</a>`;
    const navLinks = html`${groups.filter(x => x.id !== "extras").map(navLink)}<hr>
      <a href="#/${ctx.site}/settings/sites" aria-current="${group === "sites" ? "page" : "false"}">Your websites</a>
      <a href="#/${ctx.site}/settings/schedule" aria-current="${group === "schedule" ? "page" : "false"}">Daily run</a><hr>
      ${groups.filter(x => x.id === "extras").map(navLink)}`;
    render(el, html`
      <header class="head"><div><h1>Settings</h1><p>${data.site}</p></div></header>
      <div class="settings"><nav aria-label="Settings sections">${navLinks}</nav>
        <div class="scroll" style="display:flex;flex-direction:column"><div class="pad" style="flex:1" id="panel"></div>
          <div class="savebar" id="savebar" hidden><span>You have unsaved changes.</span><button class="btn quiet" id="discard">Discard</button><button class="btn primary" id="save">Save</button></div></div></div>`);
    const panel = $("#panel", el);
    if (group === "sites") return drawSites(panel);
    if (group === "schedule") return drawSchedule(panel);
    if (!g) { group = "site"; return draw(); }
    const fs = fieldsOf(g.id);
    const blocks = BLOCKS[g.id];
    const block = (b, fields) => {
      const basic = fields.filter(f => !f.advanced), adv = fields.filter(f => f.advanced);
      return html`<section class="block">${b.title ? html`<h3 class="sub" style="margin-top:6px">${b.title}</h3>` : ""}
        ${b.help ? html`<p class="muted" style="margin:-4px 0 14px;font-size:14px">${b.help}${b.link ? html` <a href="${b.link}" target="_blank" rel="noreferrer">${b.linkText || "Open"}</a>` : ""}</p>` : ""}
        ${basic.map(input)}
        ${adv.length ? html`<details class="more"><summary>More ${b.title ? b.title + " " : ""}settings</summary>${adv.map(input)}</details>` : ""}
        ${b.test ? html`<div class="test"><button type="button" class="btn small" data-test="${b.test}">Test ${TEST_LABEL[b.test]}</button><p id="res-${b.test}" class="muted"></p></div>` : ""}
      </section>`;
    };
    let body;
    if (blocks) {
      const used = new Set(blocks.flatMap(b => b.attrs));
      const rest = fs.filter(f => !used.has(f.attr));
      body = html`${blocks.map(b => block(b, b.attrs.map(a => fs.find(f => f.attr === a)).filter(Boolean)))}
        ${rest.length ? block({title: ""}, rest.map(f => ({...f, advanced: true}))) : ""}`;
    } else {
      body = block({test: (g.tests || [])[0]}, fs.every(f => f.advanced) ? fs.map(f => ({...f, advanced: false})) : fs);
    }
    render(panel, html`<form id="form" style="max-width:640px" novalidate>
      <h2 class="wide" style="font-size:20px;margin:0 0 4px">${g.title}</h2><p class="muted" style="margin:0 0 22px">${g.help}</p>
      ${!data.editable ? html`<div class="notice">Settings can't be saved in this mode. Start the app with dashboard.bat from the project folder.</div>` : ""}
      ${g.id === "site" ? html`<div class="notice" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <span>Fill the empty boxes from what's on your website.</span><button type="button" class="btn small" id="detect">Fill from my website</button></div>` : ""}
      ${body}
    </form>`);
    $$("[data-attr]", panel).forEach(i => i.addEventListener(i.type === "checkbox" || i.tagName === "SELECT" ? "change" : "input", () => {
      dirty[i.dataset.attr] = i.type === "checkbox" ? i.checked : i.value;
      clear.delete(i.dataset.attr);  // typing a new key after "Remove" keeps the new key
      $("#savebar", el).hidden = false; }));
    $$("[data-replace]", panel).forEach(b => b.onclick = () => { dirty[b.dataset.replace] = ""; draw(); $("#savebar", el).hidden = false; $(`#f-${b.dataset.replace}`, el)?.focus(); });
    $$("[data-clear]", panel).forEach(b => b.onclick = () => { clear.add(b.dataset.clear); draw(); $("#savebar", el).hidden = false; });
    $$("[data-test]", panel).forEach(b => b.onclick = async () => {
      const what = b.dataset.test;
      try {
        if (isDirty()) await saveNow();  // test what's on screen, not an older saved value
        const out = $(`#res-${what}`, el); out.textContent = "Testing…"; out.className = "muted";
        const btn = $(`[data-test="${what}"]`, el);
        const r = await busy(btn, () => api(`/s/${ctx.site}/settings/test`, {what}));
        const o2 = $(`#res-${what}`, el); o2.textContent = r.message; o2.className = r.ok ? "ok" : "err";
      } catch (e) { const o3 = $(`#res-${what}`, el); if (o3) { o3.textContent = e.message; o3.className = "err"; } }
    });
    const det = $("#detect", panel);
    if (det) det.onclick = async () => {
      try {
        const r = await busy(det, () => api("/detect", {domain: data.site}));
        let filled = 0;
        for (const [attr, val] of [["brand_names", r.brand_names], ["topics", r.topics], ["my_pages", r.pages], ["profile_email", r.emails[0]]]) {
          const f = data.fields.find(x => x.attr === attr);
          const cur = attr in dirty ? dirty[attr] : f.value;
          if (!String(cur || "").trim() && val && val.length) { dirty[attr] = Array.isArray(val) ? val.join("\n") : val; filled++; }
        }
        if (filled) { draw(); $("#savebar", el).hidden = false; }
        toast(filled ? `Filled ${filled} box${filled > 1 ? "es" : ""}. Check them, then save.` : "Nothing new to fill: the boxes already have values.");
        if (r.problems.length) render($("#detect", el).parentNode, html`<span><b>Found on your site:</b> ${r.problems.join(" ")}</span>`);
      } catch (e) { /* toast shown */ }
    };
    $("#discard", el).onclick = () => { dirty = {}; clear = new Set(); draw(); };
    $("#save", el).onclick = e => busy(e.currentTarget, saveNow, "Saved");
    if (Object.keys(dirty).length || clear.size) $("#savebar", el).hidden = false;
  }
  const isDirty = () => Object.keys(dirty).length > 0 || clear.size > 0;
  async function saveNow() {
    data = await api(`/s/${ctx.site}/settings`, {changes: dirty, clear: [...clear]});
    dirty = {}; clear = new Set(); draw(); ctx.refreshCounts();
  }
  async function drawSites(panel) {
    render(panel, html`<div style="max-width:640px"><h2 class="wide" style="font-size:20px;margin:0 0 4px">Your websites</h2>
      <p class="muted" style="margin:0 0 18px">Each website has its own links, opportunities and settings. Free sources, notifications and optional extras are shared.</p>
      <table class="plain"><tbody>${ctx.app.sites.map(s => html`<tr><td><b>${s.domain}</b>${s.id === ctx.site ? html` <span class="faint">(open now)</span>` : ""}</td>
        <td style="text-align:right">${s.legacy ? html`<span class="faint">Kept in config.toml</span>` : html`<button class="btn small quiet danger" data-rm="${s.id}">Remove</button>`}</td></tr>`)}</tbody></table>
      ${data.editable ? html`<div class="row" style="margin-top:18px"><a class="btn primary" href="#/welcome">${icon("plus")} Add a website</a></div>` : ""}
      <p class="faint" style="font-size:13px;margin-top:18px">Removing a website moves its folder into sites/_removed. Nothing is deleted.</p></div>`);
    $$("[data-rm]", panel).forEach(b => b.onclick = async () => {
      if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Click again to remove"; return; }
      try { await busy(b, () => api(`/sites/${b.dataset.rm}/remove`, {})); toast("Removed. Its folder was moved to sites/_removed.");
        dirty = {}; clear = new Set(); await ctx.reloadApp(b.dataset.rm === ctx.site ? "" : `${ctx.site}/settings/sites`); }
      catch (e) { /* toast shown */ }
    });
  }
  async function drawSchedule(panel) {
    render(panel, html`<p class="muted">Loading…</p>`);
    let s;
    try { s = await api("/schedule"); } catch (e) { return render(panel, html`<p class="err">${e.message}</p>`); }
    render(panel, html`<div style="max-width:640px"><h2 class="wide" style="font-size:20px;margin:0 0 4px">Daily run</h2>
      <p class="muted" style="margin:0 0 18px">Once a day your PC re-checks the links that are due and looks for new opportunities, for every website, then shows a notification if something needs you. If the PC is off at that time, it runs the next time it can.</p>
      ${!s.supported ? html`<div class="notice">The daily run is set up through Windows. On this computer, run <b>linkverify schedule install</b> to see the line to add to cron.</div>` : html`
        ${s.installed ? html`<dl class="kv"><dt>Status</dt><dd class="ok">On, every day${s.time ? ` at ${s.time}` : ""}</dd><dt>Next run</dt><dd>${s.next_run || "?"}</dd>
          <dt>Last run</dt><dd>${s.last_run || "not yet"}${s.last_result && s.last_result !== "0" && s.last_run && !/N\/A|1999/.test(s.last_run) ? html` <span class="err">(result code ${s.last_result})</span>` : ""}</dd></dl>`
          : html`<div class="notice"><b>The daily run is off.</b> Links are only re-checked when you open the app and ask.</div>`}
        <div class="row" style="margin-top:18px"><label class="label" for="time" style="margin:0">Run at</label><input class="input" id="time" type="time" value="${s.time || "10:00"}" style="width:130px">
          <button class="btn primary" id="install">${s.installed ? "Change time" : "Turn on"}</button>${s.installed ? html`<button class="btn quiet danger" id="remove">Turn off</button>` : ""}</div>
        <p class="err" id="sErr" role="alert"></p>`}</div>`);
    const ins = $("#install", panel);
    if (ins) ins.onclick = async () => { try { await busy(ins, () => api("/schedule", {action: "install", time: $("#time", panel).value}), "Daily run is on"); drawSchedule(panel); } catch (e) { $("#sErr", panel).textContent = e.message; } };
    const rm = $("#remove", panel);
    if (rm) rm.onclick = async () => { try { await busy(rm, () => api("/schedule", {action: "remove"}), "Daily run is off"); drawSchedule(panel); } catch (e) { $("#sErr", panel).textContent = e.message; } };
  }
  await load();
  // unsaved changes are kept while you move between sections; the save bar saves them all
  const warnClose = e => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", warnClose);
  return {
    update(rest) { group = rest[0] || "site"; draw(); },
    canLeave: () => !isDirty() || window.confirm("You have unsaved settings. Leave without saving them?"),
    unmount() { window.removeEventListener("beforeunload", warnClose); },
  };
}
