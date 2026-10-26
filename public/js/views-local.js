// Business listings: directory pages that list the business, each checked against the site's name, address and phone.
import { h, api, toast, num, table } from "./core.js";
import { VIEWS, NAV } from "./views.js";

NAV.splice(NAV.findIndex((n) => n.view === "backlinks") + 1, 0, { view: "listings", label: "Business listings" });

const STATUS = { match: ["Matches", "fixed"], mismatch: ["Different details", "error"], blocked: ["Check by hand", "warning"], gone: ["Page gone", "error"], error: ["Not loaded", "warning"] };
const yes = (v) => (v === null || v === undefined ? "–" : v ? "✓" : "✗");

VIEWS.listings = async (ctx) => {
  const pid = ctx.project.id;
  const d = await api(`/api/projects/${pid}/citations`);
  const poll = () => setTimeout(async () => { const x = await api(`/api/projects/${pid}/citations`).catch(() => null); if (x?.running) poll(); else ctx.app.refresh(); }, 2500);
  const btn = h("button", { class: "btn", disabled: d.running || !d.total }, d.running ? "Checking…" : `Check ${d.total} listings`);
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = "Checking…";
    try { const r = await api(`/api/projects/${pid}/citations/check`, { method: "POST", body: {} }); toast(`Checking ${r.urls} listings against ${r.nap.name}, ${r.nap.phone}`); poll(); }
    catch (e) { toast(e.message); btn.disabled = false; btn.textContent = `Check ${d.total} listings`; }
  };
  if (d.running) poll();
  const input = h("input", { type: "url", placeholder: "https://www.yellowpages.com.au/... (the listing page)", required: true, style: { flex: "1", minWidth: "260px" } });
  const add = h("form", { class: "row", onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${pid}/citations`, { method: "POST", body: { url: input.value } }); toast("Listing added"); ctx.app.refresh(); } catch (err) { toast(err.message); }
  } }, input, h("button", { class: "btn" }, "Add listing"));
  const remove = (r) => h("button", { class: "btn sm", onclick: async () => {
    await api(`/api/projects/${pid}/citations?url=${encodeURIComponent(r.url)}`, { method: "DELETE" }); ctx.app.refresh();
  } }, "Remove");
  const tile = (k, v) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v", style: { fontSize: "22px" } }, v));
  const n = d.napSettings;
  return [h("div", { class: "card" },
    h("div", { class: "card-h" }, h("h2", {}, "Business listings"), btn),
    h("p", { class: "hint" }, "Directories and social profiles that list the business (Yellow Pages, TrueLocal, Hotfrog, Facebook…). Google trusts a local business more when every listing shows the same name, address and phone as the site; ",
      "an old address or a different phone on one listing is worth fixing. Each listing page is loaded once and compared with ",
      n.name && n.address && n.phone ? `the details in Settings (${n.name}, ${n.address}, ${n.phone}).` : "the name, address and phone in the home page's LocalBusiness schema (or the ones in Settings)."),
    add,
    d.total ? h("div", { class: "grid g4", style: { marginTop: "12px" } }, tile("Listings", num(d.total)), tile("Match", num(d.match)), tile("Different details", num(d.mismatch)), tile("Check by hand", num(d.blocked))) : null,
    d.noWebsite ? h("p", { class: "small" }, `${d.noWebsite} matching listings don't link to the site: add the website address to them.`) : null,
    d.total ? table([
      { label: "Listing", cls: "url", get: (r) => h("a", { href: r.url, target: "_blank", rel: "noopener noreferrer" }, r.site) },
      { label: "Result", get: (r) => (r.status ? h("span", { class: `badge ${STATUS[r.status][1]}`, title: r.error || "" }, STATUS[r.status][0]) : "Not checked") },
      { label: "Name", get: (r) => yes(r.name_ok) }, { label: "Address", get: (r) => yes(r.address_ok) }, { label: "Phone", get: (r) => yes(r.phone_ok) }, { label: "Links to site", get: (r) => yes(r.website_ok) },
      { label: "What to do", get: (r) => h("span", { class: "small" }, r.advice, r.other_phones.length ? h("div", { class: "small" }, "Other numbers on the page: ", r.other_phones.join(", ")) : null) },
      { label: "", get: remove },
    ], d.rows) : h("p", {}, "No listings yet. Add the web address of each listing page (search the business name and phone number to find them)."))];
};
