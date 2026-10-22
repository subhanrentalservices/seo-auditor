// App shell: routing, the sidebar with the site switcher, background-job status.
import {api, html, render, $, $$, icon, toast, VERSION, plural} from "./core.js";
import * as today from "./views/today.js";
import * as links from "./views/links.js";
import * as opps from "./views/opps.js";
import * as campaigns from "./views/campaigns.js";
import * as health from "./views/health.js";
import * as settings from "./views/settings.js";
import * as welcome from "./views/welcome.js";

const VIEWS = {today, links, opportunities: opps, campaigns, health, settings};
const NAV = [["today", "Today", "today"], ["links", "Links", "links"], ["opportunities", "Opportunities", "opps"],
  ["campaigns", "Campaigns", "camps"], ["health", "Site health", "health"]];

const state = {app: null, site: null, view: null, viewName: "", jobs: null, wasBusy: false, todayCount: 0, pollTimer: null};

export const nav = (to, replace = false) => {
  const h = "#/" + to.replace(/^\/+/, "");
  if (replace) history.replaceState(null, "", h); else location.hash = h;
  if (replace) route();
};
export const sitePath = (rest = "") => `${state.site}/${rest}`;
export const go = rest => nav(sitePath(rest));
export const appInfo = () => state.app;

async function loadApp() {
  state.app = await api("/app");
  return state.app;
}

function parse() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return parts;
}

async function route() {
  const parts = parse();
  if (!state.app) await loadApp();
  const sites = state.app.sites;
  // a view with unsaved changes can ask to stay (Settings)
  if (state.view?.canLeave && (parts[0] !== state.site || parts[1] !== state.viewName) && !state.view.canLeave()) {
    history.replaceState(null, "", state.leftFrom || "#/"); return;
  }
  state.leftFrom = location.hash;
  if (parts[0] === "welcome" || !sites.length) {
    if (!state.app.editable && !sites.length) return render($("#root"), html`<p class="pad">No site is set up.</p>`);
    return showWelcome(parts[0] === "welcome" && sites.length > 0);
  }
  let [site, view, ...rest] = parts;
  if (!sites.find(s => s.id === site)) return nav(`${sites[0].id}/today`, true);
  if (!VIEWS[view] && view !== "settings") return nav(`${site}/today`, true);
  const siteChanged = state.site !== site;
  state.site = site;
  if (siteChanged || !$(".frame")) shell();
  markNav(view);
  if (state.viewName === view && !siteChanged && state.view?.update) {
    state.view.update(rest);
  } else {
    state.view?.unmount?.();
    state.view = null;
    state.viewName = view;
    // each screen draws into its own fresh element: a slow screen that finishes loading after
    // you've already moved on draws into a detached element instead of over the new screen
    const work = document.createElement("div");
    work.className = "view";
    $("#work").replaceChildren(work);
    const routeId = state.routeId = (state.routeId || 0) + 1;
    const mounted = await VIEWS[view].mount(work, {site, rest, app: state.app, go, nav, jobs: () => state.jobs, run, refreshCounts, lastTask,
      async reloadApp(to) { await loadApp(); state.site = null; nav(to || ""); }});
    if (routeId === state.routeId) state.view = mounted; else mounted?.unmount?.();
  }
  if (siteChanged) { state.wasBusy = false; state.jobs = null; state.lastTaskSeen = undefined; refreshCounts(); poll(); }
}

function showWelcome(adding) {
  state.view?.unmount?.(); state.view = null; state.viewName = ""; state.site = null;
  welcome.mount($("#root"), {adding, sites: state.app.sites, async done(siteId) { await loadApp(); state.site = null; nav(`${siteId}/today`); },
    cancel() { history.back(); }});
}

function shell() {
  const s = state.app.sites.find(x => x.id === state.site);
  render($("#root"), html`
  <div class="frame">
    <aside class="side">
      <div style="position:relative">
        <button class="switcher" id="switcher" aria-haspopup="menu" aria-expanded="false">
          <span class="mono">${s.domain[0]}</span>
          <span style="min-width:0"><b>${s.domain}</b><small>${plural(state.app.sites.length, "website")}</small></span>
          <span class="chev">${icon("chev", 'width="16" height="16"')}</span>
        </button>
        <div class="menu" id="siteMenu" role="menu" hidden></div>
      </div>
      <nav class="main" aria-label="Main">
        ${NAV.map(([id, label, ic]) => html`<a href="#/${state.site}/${id}" data-nav="${id}">${icon(ic)}<span>${label}</span>${id === "today" ? html`<span class="count" id="todayCount" hidden></span>` : ""}</a>`)}
      </nav>
      <div class="spacer"></div>
      <div id="busy"></div>
      <nav class="main" aria-label="Settings" style="margin-top:8px"><a href="#/${state.site}/settings" data-nav="settings">${icon("settings")}<span>Settings</span></a></nav>
      <div class="ver">Backlink Verifier ${VERSION}</div>
    </aside>
    <main class="work" id="work"></main>
    <nav class="tabbar" aria-label="Main">
      ${[["today", "Today", "today"], ["links", "Links", "links"], ["opportunities", "Leads", "opps"], ["campaigns", "Studies", "camps"],
         ["health", "Health", "health"], ["settings", "Settings", "settings"]].map(([id, label, ic]) =>
        html`<a href="#/${state.site}/${id}" data-nav="${id}">${icon(ic)}<span>${label}</span>${id === "today" ? html`<span class="count" id="todayCount2" hidden></span>` : ""}</a>`)}
    </nav>
  </div>`);
  const btn = $("#switcher"), menu = $("#siteMenu");
  btn.onclick = e => {
    e.stopPropagation();
    const open = menu.hidden;
    render(menu, html`${state.app.sites.map(x => html`<button role="menuitem" data-site="${x.id}"><span class="mono">${x.domain[0]}</span>${x.domain}</button>`)}
      ${state.app.editable ? html`<hr><button role="menuitem" data-add>${icon("plus", 'width="18" height="18"')} Add a website</button>` : ""}`);
    menu.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button")?.focus();
  };
  menu.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    menu.hidden = true;
    if (b.dataset.add !== undefined) nav("welcome"); else nav(`${b.dataset.site}/${state.viewName || "today"}`);
  };
  document.addEventListener("click", () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); });
  menu.addEventListener("keydown", e => {
    const items = $$("button", menu), i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === "Escape") { menu.hidden = true; btn.focus(); }
  });
}

function markNav(view) {
  $$("[data-nav]").forEach(a => a.dataset.nav === view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));
}

export async function refreshCounts() {
  if (!state.site) return;
  try {
    const t = await api(`/s/${state.site}/today`);
    const n = t.actions.filter(a => a.priority === "urgent" || a.priority === "today").length;
    for (const id of ["#todayCount", "#todayCount2"]) { const el = $(id); if (el) { el.textContent = n; el.hidden = !n; } }
  } catch (e) { /* the view shows connection errors */ }
}

// ---- background jobs: one poller for the whole app
const TASK_DONE = {
  find: r => {
    const n = r.results.reduce((a, x) => a + x.new, 0), problems = r.results.flatMap(x => x.errors);
    return `Search finished: ${plural(n, "new opportunity", "new opportunities")}` + (problems.length ? `. ${problems[0]}` : "");
  },
  graph: r => `Site mapped: ${plural(r.pages, "page")}, ${plural(r.issues, "fault")} to fix`,
  campaign: r => `Campaign checked: ${r.linked} new linking, ${r.mentions} unlinked`,
  scan: r => r.scan.summary[0],
};
async function poll() {
  clearTimeout(state.pollTimer);
  const site = state.site;
  if (!site) return;
  try {
    const j = await api(`/s/${site}/jobs`);
    if (site === state.site) setJobs(j);
  } catch (e) { /* keep polling */ }
  state.pollTimer = setTimeout(poll, isBusy(state.jobs) ? 1500 : 15000);
}
const isBusy = j => !!j && (j.checks.running !== null || j.checks.queued.length > 0 || !!j.task.running);
export function setJobs(j) {
  const before = state.wasBusy;
  const seen = state.lastTaskSeen;
  state.jobs = j;
  const busy = isBusy(j);
  state.wasBusy = busy;
  const el = $("#busy");
  if (el) {
    const parts = [];
    const nChecks = j.checks.queued.length + (j.checks.running !== null ? 1 : 0);
    if (nChecks) parts.push(`Checking ${plural(nChecks, "link")}`);
    if (j.task.running) parts.push(j.task.running[0].toUpperCase() + j.task.running.slice(1));
    render(el, busy ? html`<div class="busy" role="status"><b>${parts.join(" and ")}…</b>${j.task.progress ? html`<span>${j.task.progress}</span>` : ""}
      <div class="track"><i></i></div>${j.task.running ? html`<button class="btn small quiet" id="stopTask" style="margin-top:6px" ${j.task.stopping ? "disabled" : ""}>${j.task.stopping ? "Stopping…" : "Stop"}</button>` : ""}</div>` : "");
    const stop = $("#stopTask");
    if (stop) stop.onclick = () => run({op: "stop"}).then(() => toast("Stopping after the current page")).catch(e => toast(e.message));
  }
  // a long task finished (seen for the first time): say how it went
  const last = j.task.last;
  if (last && seen !== undefined && last.finished !== seen) {
    toast(last.ok ? (TASK_DONE[last.op?.op]?.(last) || "Done") : last.cancelled ? "Stopped." : `Stopped with an error: ${last.error}`);
  }
  state.lastTaskSeen = last ? last.finished : null;
  if (before && !busy) {
    if (!last || last.finished === seen) toast("Checks finished");
    state.view?.refresh?.();
    refreshCounts();
  }
}
export async function run(body) {
  const j = await api(`/s/${state.site}/run`, body);
  const {checks, task} = j;
  setJobs({checks, task});
  poll();
  return j;
}
export const lastTask = () => state.jobs?.task.last || null;

window.addEventListener("hashchange", route);
route().catch(e => render($("#root"), html`<div class="welcome"><div class="box"><h1>Can't start</h1><p class="lead">${e.message}</p></div></div>`));
