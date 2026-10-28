// Where alerts go (app-wide, App settings): email over SMTP, a generic webhook (JSON POST), a Slack-compatible incoming
// webhook ({"text": …}, also understood by Mattermost, Rocket.Chat and Discord's /slack endpoint) and the Windows toast.
// Settings live in data/config.json under "alerts". The SMTP password and the webhook URLs (they carry tokens) are
// write-only: GET returns them masked, and every error or log line goes through redact(). Each channel is rate-limited
// (sends per hour). Senders are injectable so tests never send mail, post webhooks or show toasts.
import { db, all, get, run } from "./db.mjs";
import { config } from "./gsc.mjs";
import { saveConfig } from "./dataforseo.mjs";
import { sendMail, validEmail, emailList } from "./smtp.mjs";
import { notify } from "./scheduler.mjs";

db.exec("CREATE TABLE IF NOT EXISTS alert_sends (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, ts INTEGER NOT NULL, ok INTEGER)");

export const CHANNELS = ["email", "webhook", "slack", "toast"];
export const DEFAULTS = {
  email: { on: false, host: "", port: 587, security: "starttls", user: "", password: "", from: "", to: "" },
  webhook: { on: false, url: "" },
  slack: { on: false, url: "" },
  toast: { on: true }, // the app's existing Windows alert, on as before
  maxPerHour: 10,      // per channel; extra sends in the same hour are dropped and logged
  dedupHours: 24,      // the same alert is sent at most once in this many hours (rules can ask for longer)
};
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function channelConfig() {
  const c = config().alerts || {};
  const out = { ...DEFAULTS, maxPerHour: c.maxPerHour ?? DEFAULTS.maxPerHour, dedupHours: c.dedupHours ?? DEFAULTS.dedupHours };
  for (const ch of CHANNELS) out[ch] = { ...DEFAULTS[ch], ...(c[ch] || {}) };
  return out;
}

/** Secret values currently saved (for redact). */
const secrets = (c = channelConfig()) => [c.email.password, c.webhook.url, c.slack.url, c.email.password && Buffer.from(c.email.password).toString("base64")].filter((s) => s && s.length >= 4);

/** Removes saved secrets, webhook tokens and URL credentials from any text before it is shown, stored or logged. */
export function redact(text, extra = []) {
  let s = String(text ?? "");
  for (const x of [...secrets(), ...extra].filter((v) => v && v.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(x).join("[hidden]");
  return s.replace(/(hooks\.slack\.com\/services\/|discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>]+/gi, "$1[hidden]")
    .replace(/(https?:\/\/)[^\s/@"'<>]+:[^\s/@"'<>]+@/gi, "$1[hidden]@")
    .replace(/([?&](?:token|key|secret|sig|signature|auth|access_token)=)[^&\s"'<>]+/gi, "$1[hidden]");
}

/** "https://hooks.slack.com/…" — enough to recognise which hook is saved, without the token. */
export const maskUrl = (u) => { try { const x = new URL(u); return `${x.protocol}//${x.host}/…`; } catch { return ""; } };

/** What GET returns: no password, no full webhook URL. */
export function publicConfig() {
  const c = channelConfig();
  const { password, ...email } = c.email;
  return { email: { ...email, hasPassword: Boolean(password) }, webhook: { on: c.webhook.on, saved: maskUrl(c.webhook.url) },
    slack: { on: c.slack.on, saved: maskUrl(c.slack.url) }, toast: { ...c.toast, supported: process.platform === "win32" },
    maxPerHour: c.maxPerHour, dedupHours: c.dedupHours };
}

function cleanUrl(v, { httpsOnly }) {
  let x; try { x = new URL(String(v).trim()); } catch { fail(400, "Enter the full webhook URL, starting with https://"); }
  if (!(x.protocol === "https:" || (!httpsOnly && x.protocol === "http:"))) fail(400, httpsOnly ? "A Slack-compatible webhook URL must start with https://" : "The webhook URL must start with http:// or https://");
  if (x.href.length > 2000) fail(400, "That URL is too long");
  return x.href;
}

/** PUT body → saved settings. Empty password / URL fields keep the saved value; clear* flags remove it. */
export function updateConfig(b = {}) {
  const cur = config().alerts || {}, next = { ...cur };
  const bool = (v, d) => (v === undefined ? d : Boolean(v));
  if (b.email) {
    const e = { ...DEFAULTS.email, ...(cur.email || {}) }, x = b.email;
    e.on = bool(x.on, e.on);
    if (x.host !== undefined) { e.host = String(x.host).trim().slice(0, 253); if (e.host && !/^[a-z0-9.-]+$/i.test(e.host)) fail(400, "SMTP server: a host name like smtp.example.com"); }
    if (x.port !== undefined) { const n = Number(x.port); if (!(Number.isInteger(n) && n > 0 && n < 65536)) fail(400, "SMTP port: 1–65535 (465 for TLS, 587 for STARTTLS)"); e.port = n; }
    if (x.security !== undefined) { if (!["tls", "starttls", "none"].includes(x.security)) fail(400, "Security: tls, starttls or none"); e.security = x.security; }
    if (x.user !== undefined) e.user = String(x.user).trim().slice(0, 200);
    if (x.password !== undefined && x.password !== "") e.password = String(x.password).slice(0, 500);
    if (x.clearPassword === true) e.password = "";
    if (x.from !== undefined) { e.from = String(x.from).trim(); if (e.from && !validEmail(e.from)) fail(400, "Sender: one valid email address"); }
    if (x.to !== undefined) { const list = emailList(x.to); if (list.length > 20 || !list.every(validEmail)) fail(400, "Recipients: up to 20 valid email addresses, separated by commas"); e.to = list.join(", "); }
    if (e.on && (!e.host || !e.from || !e.to)) fail(400, "Email alerts need an SMTP server, a sender and at least one recipient");
    next.email = e;
  }
  for (const [ch, httpsOnly] of [["webhook", false], ["slack", true]]) {
    if (!b[ch]) continue;
    const w = { ...DEFAULTS[ch], ...(cur[ch] || {}) }, x = b[ch];
    if (x.url !== undefined && x.url !== "") w.url = cleanUrl(x.url, { httpsOnly });
    if (x.clear === true) { w.url = ""; w.on = false; }
    w.on = bool(x.on, w.on) && Boolean(w.url);
    next[ch] = w;
  }
  if (b.toast) next.toast = { on: bool(b.toast.on, (cur.toast || DEFAULTS.toast).on) };
  if (b.maxPerHour !== undefined) { const n = Number(b.maxPerHour); if (!(Number.isInteger(n) && n >= 1 && n <= 100)) fail(400, "Sends per hour: 1–100"); next.maxPerHour = n; }
  if (b.dedupHours !== undefined) { const n = Number(b.dedupHours); if (!(n >= 1 && n <= 24 * 30)) fail(400, "Repeat after: 1–720 hours"); next.dedupHours = n; }
  saveConfig({ alerts: next });
  return publicConfig();
}

// ---------------------------------------------------------------- formatting
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** msg: { project: {id, name, start_url}, items: [{rule, title, detail, severity, urls?}] } → subject, text, html. */
export function format(msg) {
  const n = msg.items.length;
  const subject = msg.subject || `${msg.project.name}: ${n === 1 ? msg.items[0].title : `${n} SEO alerts`}`;
  const lines = msg.items.map((i) => `• ${i.title}${i.detail ? `\n  ${i.detail}` : ""}${i.urls?.length ? "\n  " + i.urls.slice(0, 10).join("\n  ") : ""}`);
  const text = `${msg.project.name} (${msg.project.start_url})\n\n${lines.join("\n\n")}\n\nOpen SEO Auditor to see the details.`;
  const html = `<div style="font:14px/1.5 system-ui,sans-serif;color:#111"><p><b>${esc(msg.project.name)}</b> <span style="color:#666">${esc(msg.project.start_url)}</span></p><ul>${msg.items.map((i) =>
    `<li style="margin-bottom:8px"><b>${esc(i.title)}</b>${i.detail ? `<br>${esc(i.detail)}` : ""}${i.urls?.length ? `<br><span style="color:#555;font-size:12px">${i.urls.slice(0, 10).map(esc).join("<br>")}</span>` : ""}</li>`).join("")}</ul>
<p style="color:#666;font-size:12px">Sent by SEO Auditor on your computer. Open the app to see the details.</p></div>`;
  return { subject: subject.slice(0, 200), text, html };
}

// ---------------------------------------------------------------- sending
async function post(url, body, fetchFn) {
  const res = await fetchFn(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "SEO-Auditor-alerts" },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the webhook answered HTTP ${res.status}`);
}

export const SENDERS = {
  email: (msg, c, d) => { const f = format(msg); return sendMail({ host: c.email.host, port: c.email.port, security: c.email.security, user: c.email.user, pass: c.email.password,
    from: c.email.from, to: emailList(msg.emailTo || c.email.to), subject: f.subject, text: f.text, html: f.html, attachments: msg.attachments || [] }, d.smtp); },
  webhook: (msg, c, d) => post(c.webhook.url, { source: "seo-auditor", sentAt: new Date().toISOString(), test: Boolean(msg.test),
    project: { id: msg.project.id, name: msg.project.name, url: msg.project.start_url }, alerts: msg.items.map(({ rule, title, detail, severity, urls }) => ({ rule, title, detail, severity, urls: urls || [] })) }, d.fetchFn),
  slack: (msg, c, d) => { const f = format(msg); return post(c.slack.url, { text: `*${f.subject}*\n${msg.items.map((i) => `• ${i.title}${i.detail ? ` — ${i.detail}` : ""}`).join("\n")}` }, d.fetchFn); },
  toast: (msg, c, d) => { const f = format(msg); d.toast(f.subject, msg.items.map((i) => i.title).join(" · ")); },
};

const sentLastHour = (ch, now) => get("SELECT COUNT(*) n FROM alert_sends WHERE channel=? AND ts > ?", ch, now - 3600e3).n;

/**
 * Sends one message on every enabled channel (or only `only`). Returns { channel: {ok} | {ok:false, error} | {skipped} }.
 * deps: { fetchFn, smtp: {connect, upgrade}, toast(title, body), now } — tests inject all of them.
 */
export async function deliver(msg, { only, deps = {} } = {}) {
  const c = channelConfig(), now = deps.now ?? Date.now();
  const d = { fetchFn: deps.fetchFn || fetch, smtp: deps.smtp || {}, toast: deps.toast || notify };
  const out = {};
  for (const ch of only ? [only] : CHANNELS) {
    if (!c[ch].on && !only) continue;
    if (only && ch !== "toast" && !(ch === "email" ? c.email.host : c[ch].url)) { out[ch] = { ok: false, error: "Not set up yet" }; continue; }
    if (sentLastHour(ch, now) >= c.maxPerHour) { out[ch] = { ok: false, rateLimited: true, error: `Rate limit: ${c.maxPerHour} sends per hour reached` }; continue; }
    try { await SENDERS[ch](msg, c, d); out[ch] = { ok: true }; }
    catch (e) { out[ch] = { ok: false, error: redact(e.message).slice(0, 300) }; console.error(`alerts (${ch}):`, out[ch].error); }
    run("INSERT INTO alert_sends (channel, ts, ok) VALUES (?,?,?)", ch, now, out[ch].ok ? 1 : 0);
  }
  run("DELETE FROM alert_sends WHERE ts < ?", now - 7 * 864e5);
  return out;
}

/** Test-send button: one sample alert on one channel, whether or not the channel is switched on. */
export function testSend(channel, deps) {
  if (!CHANNELS.includes(channel)) fail(400, "Unknown channel");
  const p = get("SELECT id, name, start_url FROM projects ORDER BY id LIMIT 1") || { id: 0, name: "Example site", start_url: "https://example.com/" };
  return deliver({ test: true, project: p, subject: "SEO Auditor test alert", items: [{ rule: "test", severity: "notice", title: "Test alert from SEO Auditor",
    detail: "If you can read this, alerts on this channel work. No action needed." }] }, { only: channel, deps });
}

export const recentSends = () => all("SELECT channel, ts, ok FROM alert_sends ORDER BY id DESC LIMIT 50");

export function register({ routes }) {
  routes.push(["GET", /^\/api\/alerts\/config$/, () => ({ ...publicConfig(), recent: recentSends() })]);
  routes.push(["PUT", /^\/api\/alerts\/config$/, (p, q, b) => updateConfig(b)]);
  routes.push(["POST", /^\/api\/alerts\/test$/, (p, q, b) => testSend(String(b.channel || ""))]);
}
