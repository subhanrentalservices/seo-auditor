// Small shared helpers: API calls, safe HTML templates, dates, toasts, icons.

const TOKEN = document.querySelector('meta[name="lv-token"]').content;
export const VERSION = document.querySelector('meta[name="lv-version"]').content;

export class ApiError extends Error {}

export async function api(path, body) {
  const opt = body === undefined ? {} : {method: "POST", headers: {"Content-Type": "application/json", "X-LV-Token": TOKEN}, body: JSON.stringify(body)};
  let r;
  try { r = await fetch("/api" + path, opt); }
  catch (e) { throw new ApiError("The app server isn't answering. Is its window still open?"); }
  const data = (r.headers.get("content-type") || "").includes("json") ? await r.json() : null;
  if (!r.ok) throw new ApiError(data?.error || `The server answered ${r.status}.`);
  return data;
}

// ---- HTML: every ${value} is escaped unless wrapped in raw()
const RAW = Symbol("raw");
export const raw = s => ({[RAW]: String(s ?? "")});
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
// null/undefined print nothing; booleans print "true"/"false" (for aria-* attributes)
const part = v => v == null ? "" : Array.isArray(v) ? v.map(part).join("") : v[RAW] !== undefined ? v[RAW] : esc(v);
export function html(strings, ...vals) {
  let out = "";
  strings.forEach((s, i) => { out += s + (i < vals.length ? part(vals[i]) : ""); });
  return raw(out);
}
export const render = (el, tpl) => { el.innerHTML = part(tpl); };
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---- time
export function ago(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 0) { const d = Math.ceil(-s / 86400); return d <= 1 ? "within a day" : `in ${d} days`; }
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, {day: "numeric", month: "short", year: "numeric"});
}
export const longDate = (d = new Date()) => d.toLocaleDateString(undefined, {weekday: "long", day: "numeric", month: "long"});
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + "s")}`;

// ---- toast
let toastTimer;
export function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---- verdicts
export const VERDICTS = ["Counts", "Weak", "Pending", "Not counted"];
export const vcls = v => "v v-" + (v === "Not counted" ? "Not" : v || "none");
export const vlabel = v => v || "Not checked";
export const VERDICT_HELP = {
  "Counts": "A real, followed link on a page Google can index.",
  "Weak": "A real link, but marked nofollow, sponsored or similar, or on a page with very many links.",
  "Pending": "Clean link, but the page isn't seen in Google yet.",
  "Not counted": "No working link: missing, hidden, blocked, broken or not crawlable.",
  null: "Not checked yet.",
};

// ---- icons (18px line icons)
const I = {
  today: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  links: '<path d="M10 14l4-4M8.5 15.5l-1.8 1.8a3.5 3.5 0 01-5-5l1.8-1.8M15.5 8.5l1.8-1.8a3.5 3.5 0 015 5l-1.8 1.8" transform="translate(-1 0)"/>',
  opps: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
  camps: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  health: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="7" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M8 6.5l7.8.4M7 8l4 8M16.8 9l-3.6 7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  chev: '<path d="M8 10l4 4 4-4"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/>',
  doneCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/>',
};
export const icon = (name, extra = "") => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${I[name] || ""}</svg>`);

// only web addresses become links: a "javascript:" URL from a crawled page or an API can never run here
export const safeUrl = u => /^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "#";
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
export const path = u => { try { const x = new URL(u); return (x.pathname + x.search) || "/"; } catch (e) { return u; } };

// a button that shows it is busy while its promise runs, and reports errors next to itself
export async function busy(btn, fn, okMsg) {
  const label = btn.innerHTML; btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg); return r; }
  catch (e) { toast(e.message); throw e; }
  finally { btn.disabled = false; btn.innerHTML = label; }
}
