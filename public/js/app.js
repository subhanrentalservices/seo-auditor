// App shell in the Backlink Verifier design (lv-app.css): site switcher, icon nav, one white sheet.
// Two kinds of screens share it:
//   SEO screens (views*.js)            #/p/<projectId>/<view>[/<arg>]  — header with audit picker + Run audit
//   Link building (lv/views, original) #/<engine site>/<view>[/...]    — exactly the Backlink Verifier screens
// A project and an engine site are the same website when their domains match.
import { h, mount, api, toast, when } from "./core.js";
import { VIEWS, NAV } from "./views.js";
import "./views-extra.js";
import { api as lvApi, html, raw, render, $, $$, icon, plural } from "../lvui/core.js";
import * as today from "../lvui/views/today.js";
import * as links from "../lvui/views/links.js";
import * as opps from "../lvui/views/opps.js";
import * as campaigns from "../lvui/views/campaigns.js";
import * as health from "../lvui/views/health.js";
import * as lvSettings from "../lvui/views/settings.js";
import * as welcome from "../lvui/views/welcome.js";

const LV = { today, links, opportunities: opps, campaigns, health, settings: lvSettings };
const LV_NAV = [["today", "Today", "today"], ["links", "Links", "links"], ["opportunities", "Opportunities", "opps"],
  ["campaigns", "Campaigns", "camps"], ["health", "Site health", "health"], ["settings", "Link settings", "settings"]];
const LABEL = { settings: "Audit settings", links: "Link ideas", backlinks: "Backlink data" };
// Line icons for the SEO screens, same 24px grid and stroke as the Backlink Verifier set.
const SEO_ICONS = {
  overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  issues: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.5"/>',
  pages: '<path d="M7 3.5h7l4 4V20a.5.5 0 01-.5.5h-10A.5.5 0 017 20z"/><path d="M14 3.5V8h4"/>',
  links: '<path d="M4 12h9M10 7l5 5-5 5"/><path d="M19 5v14"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  performance: '<path d="M4 16a8 8 0 1116 0"/><path d="M12 16l4-5"/>',
  visibility: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  keywords: '<path d="M4 7h16M4 12h10M4 17h13"/>',
  rank: '<path d="M4 19h16"/><path d="M7 16V11M12 16V6M17 16v-3"/>',
  explorer: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  backlinks: '<path d="M9 15l6-6M7.5 11.5L5.6 13.4a3.5 3.5 0 005 5l1.9-1.9M16.5 12.5l1.9-1.9a3.5 3.5 0 00-5-5l-1.9 1.9"/>',
  alerts: '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
  "issue-trends": '<path d="M4 19.5h16"/><path d="M5 15l4-5 4 3 6-7"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  report: '<path d="M6 3.5h12v17H6z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
};
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const domainOf = (u) => { try { return new URL(u.includes("://") ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

const state = { projects: [], lv: { sites: [] }, project: null, auditData: null, site: null, route: null, view: null, viewKey: "",
  progress: new Map(), jobs: null, wasBusy: false, lastTaskSeen: undefined, pollTimer: null, todayCount: 0 };
export const app = { state, go, refresh: () => route(true), openDrawer, closeDrawer };

const siteOf = (p) => p && state.lv.sites.find((s) => domainOf(s.domain) === domainOf(p.start_url));
const projectOf = (siteId) => { const s = state.lv.sites.find((x) => x.id === siteId); return s && state.projects.find((p) => domainOf(p.start_url) === domainOf(s.domain)); };

function parse() {
  const [p, qs] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
  const q = Object.fromEntries(new URLSearchParams(qs || ""));
  if (!parts.length) return { kind: "home", q };
  if (parts[0] === "websites") return { kind: "seo", view: "projects", q };
  if (parts[0] === "app-settings" || parts[0] === "app") return { kind: "seo", view: "app", q };
  if (parts[0] === "link-building") return { kind: "link-building", q };
  if (parts[0] === "p") return { kind: "seo", projectId: Number(parts[1]), view: parts[2] || "overview", arg: parts.slice(3).join("/"), q };
  if (parts[0] === "welcome") return { kind: "welcome", q };
  return { kind: "lv", site: parts[0], view: parts[1] || "today", rest: parts.slice(2), q };
}
export function go(view, { arg, q } = {}) {
  const pid = state.project?.id, a = state.route?.q?.a;
  const qs = new URLSearchParams({ ...(a ? { a } : {}), ...(q || {}) }).toString();
  location.hash = view === "projects" ? "#/websites" : `#/p/${pid}/${view}${arg ? "/" + encodeURIComponent(arg) : ""}${qs ? "?" + qs : ""}`;
}
const lvNav = (to, replace) => { const target = "#/" + String(to).replace(/^\/+/, ""); if (replace) location.replace(target); else location.hash = target; };

async function loadProject(id, wantAudit) {
  state.project = await api(`/api/projects/${id}`);
  const done = state.project.history.filter((a) => a.status === "done");
  const auditId = Number(wantAudit) || done[0]?.id || null;
  state.auditData = auditId ? await api(`/api/audits/${auditId}`) : null;
}

let seq = 0;
async function route(force) {
  const my = ++seq, r = parse(), prev = state.route;
  // a Backlink Verifier screen with unsaved changes can ask to stay (Link settings)
  if (state.view?.canLeave && state.viewKey !== keyOf(r) && !state.view.canLeave()) { history.replaceState(null, "", state.leftFrom || "#/"); return; }
  state.leftFrom = location.hash; state.route = r; closeDrawer();
  try {
    [state.projects, state.lv] = await Promise.all([api("/api/projects"), lvApi("/app").catch(() => ({ sites: [] }))]);
  } catch (e) { return render($("#root"), html`<div class="pad"><p class="err">Could not load: ${e.message}</p></div>`); }
  if (my !== seq) return;
  if (r.kind === "home" || r.kind === "link-building") {
    const p = (r.kind === "link-building" && state.projects.find((x) => siteOf(x))) || state.projects[0];
    if (!p) return lvNav("websites", true);
    const s = siteOf(p);
    return lvNav(r.kind === "link-building" && s ? `${s.id}/today` : `p/${p.id}/overview`, true);
  }
  if (r.kind === "lv") {
    if (!state.lv.sites.find((s) => s.id === r.site)) return lvNav("", true);
    if (!LV[r.view]) return lvNav(`${r.site}/today`, true);
    const p = projectOf(r.site);
    if (p && (force || state.project?.id !== p.id)) await loadProject(p.id);
    if (!p) { state.project = null; state.auditData = null; }
    state.site = r.site;
  } else if (r.kind === "seo" && r.projectId) {
    if (force || state.project?.id !== r.projectId || prev?.q?.a !== r.q.a || !state.auditData) await loadProject(r.projectId, r.q.a).catch(() => null);
    state.site = siteOf(state.project)?.id || null;
  } else if (r.kind === "seo") { state.project = null; state.auditData = null; }
  if (my !== seq) return;
  shell(); markNav();
  if (r.kind === "lv") return mountLv(r);
  if (r.kind === "welcome") return mountWelcome();
  return mountSeo(r);
}
const keyOf = (r) => `${r.kind}:${r.site || r.projectId || ""}:${r.view || ""}`;

// ---------------------------------------------------------------- frame
function shell() {
  const p = state.project;
  const pid = p?.id, site = state.site;
  const seoHref = (v) => `#/p/${pid}/${v}`;
  const lvHref = (v) => (site ? `#/${site}/${v}` : `#/p/${pid}/link-setup`);
  const seoItems = NAV.map((n) => n.section ? html`<div class="navsec">${n.section}</div>`
    : html`<a href="${seoHref(n.view)}" data-nav="seo:${n.view}">${raw(svg(SEO_ICONS[n.view] || SEO_ICONS.pages))}<span>${LABEL[n.view] || n.label}</span>${n.view === "issues" && state.auditData?.audit.errors ? html`<span class="count">${state.auditData.audit.errors}</span>` : ""}</a>`);
  render($("#root"), html`
  <div class="frame">
    <aside class="side">
      <div style="position:relative">
        <button class="switcher" id="switcher" aria-haspopup="menu" aria-expanded="false">
          <span class="mono">${(p?.name || "S")[0]}</span>
          <span style="min-width:0"><b>${p ? p.name : "All websites"}</b><small>${plural(state.projects.length, "website")}</small></span>
          <span class="chev">${icon("chev", 'width="16" height="16"')}</span>
        </button>
        <div class="menu" id="siteMenu" role="menu" hidden></div>
      </div>
      <nav class="main" aria-label="Main" style="overflow:auto;min-height:0">
        ${p ? html`<div class="navsec">SEO audit</div>${seoItems}
          <div class="navsec">Link building</div>
          ${LV_NAV.map(([id, label, ic]) => html`<a href="${lvHref(id)}" data-nav="lv:${id}">${icon(ic)}<span>${label}</span>${id === "today" ? html`<span class="count" id="todayCount" hidden></span>` : ""}</a>`)}`
          : html`<a href="#/websites" data-nav="seo:projects">${raw(svg(SEO_ICONS.overview))}<span>All websites</span></a>`}
      </nav>
      <div class="spacer"></div>
      <div id="busy"></div>
      <div class="foot">
        <button type="button" id="appSettings">App settings</button>
        <button type="button" id="themeBtn">Theme: auto</button>
      </div>
      <div class="ver">SEO Auditor · link building</div>
    </aside>
    <main class="work" id="work"></main>
    <nav class="tabbar" aria-label="Main">
      ${p ? [["seo", "overview", "Overview", SEO_ICONS.overview], ["seo", "issues", "Issues", SEO_ICONS.issues], ["lv", "today", "Today", null], ["lv", "links", "Links", null], ["lv", "opportunities", "Leads", null]].map(([k, v, label, ic]) =>
        html`<a href="${k === "seo" ? seoHref(v) : lvHref(v)}" data-nav="${k}:${v}">${ic ? raw(svg(ic)) : icon(v === "opportunities" ? "opps" : v)}<span>${label}</span></a>`) : ""}
    </nav>
  </div>`);
  const btn = $("#switcher"), menu = $("#siteMenu");
  btn.onclick = (e) => {
    e.stopPropagation(); const open = menu.hidden;
    render(menu, html`${state.projects.map((x) => html`<button role="menuitem" data-pid="${x.id}"><span class="mono">${x.name[0]}</span>${x.name}</button>`)}
      <hr><button role="menuitem" data-all>${icon("plus", 'width="18" height="18"')} All websites / add a website</button>`);
    menu.hidden = !open; btn.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button")?.focus();
  };
  menu.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return; menu.hidden = true;
    if (b.dataset.all !== undefined) return lvNav("websites");
    const r = state.route, x = state.projects.find((y) => y.id === Number(b.dataset.pid)), s = siteOf(x);
    if (r.kind === "lv" && s) return lvNav(`${s.id}/${r.view}`);
    lvNav(`p/${x.id}/${r.kind === "seo" && r.projectId ? r.view : "overview"}`);
  };
  document.onclick = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  $("#appSettings").onclick = () => lvNav("app-settings");
  $("#themeBtn").onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % 3]; try { localStorage.setItem("theme", theme); } catch {} applyTheme(); };
  applyTheme();
  if (state.jobs) setJobs(state.jobs);
  refreshCounts();
}
function markNav() {
  const r = state.route, key = r.kind === "lv" ? `lv:${r.view}` : r.view === "link-setup" ? "lv:today" : `seo:${r.view}`;
  $$("[data-nav]").forEach((a) => (a.dataset.nav === key ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
}

// ---------------------------------------------------------------- Backlink Verifier screens (unchanged originals)
async function mountLv(r) {
  const key = keyOf(r);
  if (state.viewKey === key && state.view?.update && $("#work .view")) { state.view.update(r.rest); return; }
  state.view?.unmount?.(); state.view = null; state.viewKey = key;
  const work = document.createElement("div"); work.className = "view"; $("#work").replaceChildren(work);
  const routeId = state.routeId = (state.routeId || 0) + 1;
  const site = r.site;
  const mounted = await LV[r.view].mount(work, { site, rest: r.rest, app: state.lv, go: (rest) => lvNav(`${site}/${rest}`), nav: lvNav,
    jobs: () => state.jobs, run, refreshCounts, lastTask: () => state.jobs?.task.last || null,
    async reloadApp(to) { state.lv = await lvApi("/app"); lvNav(to || ""); } });
  if (routeId === state.routeId) state.view = mounted; else mounted?.unmount?.();
  if (state.pollSite !== site) { state.pollSite = site; state.wasBusy = false; state.jobs = null; state.lastTaskSeen = undefined; poll(); }
}
function mountWelcome(domain) {
  state.view?.unmount?.(); state.view = null; state.viewKey = "welcome";
  const work = document.createElement("div"); work.className = "view scroll"; $("#work").replaceChildren(work);
  welcome.mount(work, { adding: state.lv.sites.length > 0, sites: state.lv.sites,
    async done(siteId) { state.lv = await lvApi("/app"); lvNav(`${siteId}/today`); }, cancel() { history.back(); } });
  const input = $("#domain", work); if (input && domain) input.value = domain;
}

// ---------------------------------------------------------------- SEO screens
async function mountSeo(r) {
  state.view?.unmount?.(); state.view = null; state.viewKey = keyOf(r);
  if (r.view === "link-setup") return mountWelcome(domainOf(state.project?.start_url || ""));
  const entry = NAV.find((n) => n.view === r.view);
  const title = r.view === "projects" ? "All websites" : r.view === "app" ? "App settings" : LABEL[r.view] || entry?.label || r.view;
  const p = state.project, a = state.auditData?.audit;
  const head = h("header", { class: "head" },
    h("div", {}, h("h1", {}, title),
      h("p", {}, p ? [p.start_url, a ? ` · audit ${when(a.finished_at)} · ${a.pages_crawled} pages` : " · not audited yet"]
        : r.view === "app" ? "Accounts, budget and keys used by every website" : "Every website you audit and build links for, on this computer")),
    h("div", { class: "tools", id: "seoTools" }));
  const body = h("div", { class: "pad seo stack" }, h("p", { class: "muted" }, "Loading…"));
  const view = h("div", { class: "view" }, head, h("div", { class: "scroll" }, body));
  mount($("#work"), view);
  renderTools();
  const fn = VIEWS[r.view] || VIEWS.overview;
  const ctx = { projects: state.projects, project: state.project, auditData: state.auditData, route: { view: r.view, projectId: r.projectId, arg: r.arg || "", q: r.q }, app };
  try { mount(body, await fn(ctx)); } catch (e) { console.error(e); mount(body, h("div", { class: "card empty" }, e.message)); }
}
function renderTools() {
  const el = document.getElementById("seoTools"), p = state.project;
  if (!el || !p) return;
  const a = state.auditData?.audit, audits = p.history.filter((x) => x.status === "done");
  const running = p.running || state.progress.get(p.id)?.auditId, prog = state.progress.get(p.id);
  mount(el,
    audits.length > 1 ? h("select", { "aria-label": "Show audit", onchange: (e) => go(state.route.view, { arg: state.route.arg, q: { a: e.target.value } }) },
      audits.map((x) => h("option", { value: x.id, selected: a && x.id === a.id }, `${when(x.finished_at)} · health ${x.health}`))) : null,
    running ? h("div", { class: "run" },
      h("div", { class: "progress" + (prog?.crawled ? "" : " indet") }, h("i", { style: { width: prog?.crawled ? `${Math.round((100 * prog.crawled) / (prog.crawled + prog.queued || 1))}%` : "30%" } })),
      h("span", { class: "small" }, prog?.crawled ? `${prog.crawled} pages${prog.queued ? `, ${prog.queued} queued` : ""}` : prog?.phase || "starting…"),
      h("button", { class: "btn small", onclick: async () => { await api(`/api/audits/${running}/stop`, { method: "POST", body: {} }); toast("Stopping…"); } }, "Stop"))
    : h("button", { class: "btn primary", onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api(`/api/projects/${p.id}/audits`, { method: "POST", body: {} }); state.progress.set(p.id, { auditId: r.auditId }); p.running = r.auditId; renderTools(); toast("Audit started"); }
      catch (err) { toast(err.message); e.currentTarget.disabled = false; }
    } }, "Run audit"),
    // The newest audit was stopped or interrupted: continue it without fetching its stored pages again.
    !running && ["stopped", "failed"].includes(p.history[0]?.status) ? h("button", { class: "btn", title: "Continue the last audit; pages it already stored aren't fetched again", onclick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await api(`/api/audits/${p.history[0].id}/resume`, { method: "POST", body: {} }); state.progress.set(p.id, { auditId: r.auditId }); p.running = r.auditId; renderTools(); toast("Audit resumed"); }
      catch (err) { toast(err.message); b.disabled = false; }
    } }, "Resume audit") : null);
}
function openDrawer(...content) {
  const d = document.getElementById("drawer");
  mount(d, h("button", { class: "btn small close", onclick: closeDrawer }, "Close ✕"), ...content);
  d.hidden = false; d.scrollTop = 0;
}
function closeDrawer() { const d = document.getElementById("drawer"); if (d) d.hidden = true; }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// live audit progress (Server-Sent Events)
const es = new EventSource("/api/events");
es.onmessage = (m) => {
  const ev = JSON.parse(m.data), p = state.project;
  if (ev.type === "progress") state.progress.set(ev.projectId, { auditId: ev.auditId, crawled: ev.crawled, queued: ev.queued });
  if (ev.type === "phase" && !ev.phase) { state.progress.delete(ev.projectId); if (p?.id === ev.projectId) { p.running = null; renderTools(); } return; }
  if (ev.type === "phase") state.progress.set(ev.projectId, { ...(state.progress.get(ev.projectId) || {}), auditId: ev.auditId, phase: ev.phase });
  if (ev.type === "started") state.progress.set(ev.projectId, { auditId: ev.auditId });
  if (ev.type === "done" || ev.type === "failed") {
    state.progress.delete(ev.projectId);
    toast(ev.type === "done" ? "Audit finished" : "Audit failed: " + (ev.message || ""));
    if (p?.id === ev.projectId && state.route.kind === "seo") route(true);
    return;
  }
  if (p?.id === ev.projectId) { p.running = ev.auditId; renderTools(); }
};
// The "done" event is the only signal above. If it is lost (the server restarted while after-audit steps ran, or
// the connection dropped) the progress bar would spin forever, so check with the server after a reconnect and
// every 15 s while anything shows as running.
async function resyncRunning() {
  const ids = new Set([...state.progress.keys(), ...(state.project?.running ? [state.project.id] : [])]);
  for (const id of ids) {
    try {
      const pr = await api(`/api/projects/${id}`);
      if (pr.running) continue;
      const was = state.progress.get(id)?.auditId ?? (state.project?.id === id ? state.project.running : null);
      state.progress.delete(id);
      const last = pr.history.find((a) => a.id === was);
      if (last) toast(last.status === "done" ? "Audit finished" : `Audit ${last.status}` + (last.message ? `: ${last.message}` : ""));
      if (state.project?.id === id) { state.project.running = null; if (state.route.kind === "seo") route(true); else renderTools(); }
    } catch { /* server unreachable: try again on the next tick */ }
  }
}
let esDropped = false;
es.onerror = () => { esDropped = true; };
es.onopen = () => { if (esDropped) { esDropped = false; resyncRunning(); } };
setInterval(() => { if (state.progress.size || state.project?.running) resyncRunning(); }, 15000);

// ---------------------------------------------------------------- link building background jobs (as in the Backlink Verifier)
const TASK_DONE = {
  find: (r) => { const n = r.results.reduce((a, x) => a + x.new, 0), e = r.results.flatMap((x) => x.errors);
    return `Search finished: ${plural(n, "new opportunity", "new opportunities")}` + (e.length ? `. ${e[0]}` : ""); },
  graph: (r) => `Site mapped: ${plural(r.pages, "page")}, ${plural(r.issues, "fault")} to fix`,
  campaign: (r) => `Campaign checked: ${r.linked} new linking, ${r.mentions} unlinked`,
  scan: (r) => r.scan.summary[0],
};
const isBusy = (j) => !!j && (j.checks.running !== null || j.checks.queued.length > 0 || !!j.task.running);
async function poll() {
  clearTimeout(state.pollTimer);
  const site = state.site; if (!site) return;
  try { const j = await lvApi(`/s/${site}/jobs`); if (site === state.site) setJobs(j); } catch { /* keep polling */ }
  state.pollTimer = setTimeout(poll, isBusy(state.jobs) ? 1500 : 15000);
}
function setJobs(j) {
  const before = state.wasBusy, seen = state.lastTaskSeen, busyNow = isBusy(j);
  state.jobs = j; state.wasBusy = busyNow;
  const el = $("#busy");
  if (el) {
    const parts = [], n = j.checks.queued.length + (j.checks.running !== null ? 1 : 0);
    if (n) parts.push(`Checking ${plural(n, "link")}`);
    if (j.task.running) parts.push(j.task.running[0].toUpperCase() + j.task.running.slice(1));
    render(el, busyNow ? html`<div class="busy" role="status"><b>${parts.join(" and ")}…</b>${j.task.progress ? html`<span>${j.task.progress}</span>` : ""}
      <div class="track"><i></i></div>${j.task.running ? html`<button class="btn small quiet" id="stopTask" style="margin-top:6px" ${j.task.stopping ? "disabled" : ""}>${j.task.stopping ? "Stopping…" : "Stop"}</button>` : ""}</div>` : "");
    const stop = $("#stopTask");
    if (stop) stop.onclick = () => run({ op: "stop" }).then(() => toast("Stopping after the current page")).catch((e) => toast(e.message));
  }
  const last = j.task.last;
  if (last && seen !== undefined && last.finished !== seen) toast(last.ok ? (TASK_DONE[last.op?.op]?.(last) || "Done") : last.cancelled ? "Stopped." : `Stopped with an error: ${last.error}`);
  state.lastTaskSeen = last ? last.finished : null;
  if (before && !busyNow) { if (!last || last.finished === seen) toast("Checks finished"); state.view?.refresh?.(); refreshCounts(); }
}
async function run(body) {
  const j = await lvApi(`/s/${state.site}/run`, body);
  setJobs({ checks: j.checks, task: j.task }); poll();
  return j;
}
async function refreshCounts() {
  if (!state.site) return;
  try {
    const t = await lvApi(`/s/${state.site}/today`);
    const n = t.actions.filter((a) => a.priority === "urgent" || a.priority === "today").length;
    const el = $("#todayCount"); if (el) { el.textContent = n; el.hidden = !n; }
  } catch { /* the screens show connection errors */ }
}

// ---------------------------------------------------------------- theme: auto → light → dark
const THEMES = ["auto", "light", "dark"];
let theme = "auto";
try { theme = localStorage.getItem("theme") || "auto"; } catch {}
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = theme;
  const b = document.getElementById("themeBtn"); if (b) b.textContent = "Theme: " + theme;
}
applyTheme();

addEventListener("hashchange", () => route());
route().catch((e) => render($("#root"), html`<div class="welcome"><div class="box"><h1>Can't start</h1><p class="lead">${e.message}</p></div></div>`));
