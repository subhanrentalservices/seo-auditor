// Google sign-in for Search Console and GA4: the existing service-account key file (default), or the owner's own
// Google account through an installed-app OAuth client they create (loopback flow on 127.0.0.1, PKCE, state check,
// 5-minute timeout). The client secret and the refresh token are write-only: saved in data/config.json, never returned
// by the API, and removed from every error message. config().googleAuthMode = "service" | "oauth"; OAuth is used only
// while a refresh token is saved, so service accounts keep working unchanged.
import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { config } from "./gsc.mjs";
import { saveConfig } from "./dataforseo.mjs";
import { redact } from "./alert-channels.mjs";

export const SCOPES = { gsc: "https://www.googleapis.com/auth/webmasters.readonly", ga4: "https://www.googleapis.com/auth/analytics.readonly" };
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const EXPIRED = "Google sign-in expired or was revoked: sign in again in App settings.";
const FLOW_MS = 5 * 60e3;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// Service-account key: App settings, else GSC_KEY_FILE, else ~/.config/claude-seo/gsc-service-account.json.
const DEFAULT_KEY = process.env.GSC_KEY_FILE || path.join(os.homedir(), ".config", "claude-seo", "gsc-service-account.json");
/** Key file for a service: GA4 may use its own (ga4KeyFile), else the Search Console one. */
export const serviceKeyFile = (service = "gsc") => (service === "ga4" && config().ga4KeyFile) || config().gscKeyFile || DEFAULT_KEY;

const oauthCfg = () => { const o = config().googleOAuth; return o && typeof o === "object" ? o : {}; };
/** "oauth" only while signed in (a refresh token is saved); otherwise the service account. */
export function authMode() { return config().googleAuthMode === "oauth" && oauthCfg().refreshToken ? "oauth" : "service"; }
/** Saved secrets (for redaction): client secret and refresh token. */
export const secretValues = () => { const o = oauthCfg(); return [o.clientSecret, o.refreshToken].filter(Boolean); };
const fp = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

const cache = new Map();
/** An authorised client for a scope: OAuth2Client while signed in, else a service-account client from the key file. */
export async function googleClient(scope, { service = "gsc", label = "Search Console" } = {}) {
  if (authMode() === "oauth") {
    const o = oauthCfg(), k = `oauth|${o.clientId}|${fp(o.clientSecret)}|${fp(o.refreshToken)}`;
    if (!cache.has(k)) { const c = new OAuth2Client({ clientId: o.clientId, clientSecret: o.clientSecret }); c.setCredentials({ refresh_token: o.refreshToken }); cache.set(k, c); }
    return cache.get(k);
  }
  const file = serviceKeyFile(service);
  if (!existsSync(file)) fail(400, `${label} key file not found: ${file}`);
  const k = `service|${scope}|${file}`;
  if (!cache.has(k)) cache.set(k, await new GoogleAuth({ keyFile: file, scopes: [scope] }).getClient());
  return cache.get(k);
}
export const clearClients = () => cache.clear();

const isInvalidGrant = (e) => e?.response?.data?.error === "invalid_grant" || /invalid_grant/.test(e?.message || "");
/** One authorised request; returns the response body. invalid_grant → a plain "sign in again"; secrets never in messages. */
export async function googleRequest(scope, opts, { service = "gsc", label } = {}) {
  const client = await googleClient(scope, { service, label });
  try { return (await client.request(opts)).data; } catch (e) {
    if (isInvalidGrant(e)) throw Object.assign(new Error(EXPIRED), { status: 401 });
    const access = client.credentials?.access_token;
    e.message = redact(e.message, [...secretValues(), access].filter(Boolean));
    throw e;
  }
}

// ---------- Loopback sign-in flow ----------
const b64url = (buf) => Buffer.from(buf).toString("base64url");
let pending = null;  // { server, state, verifier, redirectUri, expiresAt, timer, fetchFn }
let lastResult = null; // { ok, error, at }

/** Ends the pending flow now; the listener closes once `res` (the callback's reply, if any) has been sent. */
function endFlow(result, res) {
  if (!pending) return;
  const { server, timer } = pending;
  clearTimeout(timer);
  pending = null;
  if (result) lastResult = { ...result, at: new Date().toISOString() };
  const close = () => { server.close(); server.closeAllConnections?.(); };
  if (res && !res.writableFinished) res.once("finish", close).once("close", close); else close();
}

const page = (res, status, text) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer", Connection: "close" });
  res.end(`<!doctype html><meta charset="utf-8"><title>SEO Auditor</title><p style="font:16px system-ui;margin:40px">${text}</p>`);
};
const sameState = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && timingSafeEqual(x, y); };

/** Email from the id_token Google returned straight to us over TLS (payload only; no signature check needed here). */
export function idTokenEmail(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8")).email || ""; } catch { return ""; }
}

async function exchange(flow, code) {
  const o = oauthCfg(), hide = [o.clientSecret, code, flow.verifier];
  let res, j;
  try {
    res = await flow.fetchFn(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: flow.redirectUri, grant_type: "authorization_code", code_verifier: flow.verifier }).toString() });
    j = await res.json().catch(() => ({}));
  } catch (e) { throw new Error(redact(`Google token endpoint not reachable: ${e.message}`, hide)); }
  hide.push(j.access_token, j.refresh_token, j.id_token);
  if (!res.ok) throw new Error(redact(`Google refused the sign-in (${res.status}): ${j.error_description || j.error || ""}`.trim(), hide).slice(0, 300));
  if (!j.refresh_token) throw new Error("Google returned no refresh token: remove SEO Auditor's access at myaccount.google.com/permissions and sign in again.");
  saveConfig({ googleAuthMode: "oauth", googleOAuth: { ...oauthCfg(), refreshToken: j.refresh_token, email: idTokenEmail(j.id_token), connectedAt: new Date().toISOString(), scope: j.scope || "" } });
  clearClients();
}

async function onCallback(req, res) {
  const flow = pending;
  const u = new URL(req.url, "http://127.0.0.1");
  if (!flow || u.pathname !== "/") return page(res, 404, "Not found.");
  if (!sameState(u.searchParams.get("state"), flow.state)) return page(res, 400, "This sign-in link doesn't match the one SEO Auditor started. Start again from App settings.");
  const err = u.searchParams.get("error"), code = u.searchParams.get("code");
  if (err || !code) {
    endFlow({ ok: false, error: err === "access_denied" ? "Sign-in was cancelled." : `Google sign-in failed: ${String(err || "no code returned").replace(/[^\w .-]/g, "").slice(0, 80)}` }, res);
    return page(res, 400, "Sign-in did not complete. You can close this tab and try again in SEO Auditor.");
  }
  try {
    await exchange(flow, code);
    endFlow({ ok: true, error: null }, res);
    page(res, 200, "Signed in to Google. You can close this tab and go back to SEO Auditor.");
  } catch (e) {
    endFlow({ ok: false, error: e.message }, res);
    page(res, 400, "Sign-in did not complete. Go back to SEO Auditor for the reason.");
  }
}

/** Starts a sign-in: a one-off listener on 127.0.0.1 (random port) and Google's consent URL. One flow at a time. */
export async function startOAuth({ fetchFn = fetch, timeoutMs = FLOW_MS } = {}) {
  const o = oauthCfg();
  if (!o.clientId || !o.clientSecret) fail(400, "Save the OAuth client ID and client secret first.");
  endFlow(null); // a new start replaces an unfinished one
  const server = http.createServer((req, res) => { onCallback(req, res).catch(() => page(res, 500, "Something went wrong.")); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const redirectUri = `http://127.0.0.1:${server.address().port}/`;
  const state = b64url(randomBytes(24)), verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const expiresAt = Date.now() + timeoutMs;
  pending = { server, state, verifier, redirectUri, expiresAt, fetchFn,
    timer: setTimeout(() => endFlow({ ok: false, error: "Sign-in timed out after 5 minutes: start again." }), timeoutMs) };
  pending.timer.unref?.();
  lastResult = null;
  const url = `${AUTH_URL}?${new URLSearchParams({ client_id: o.clientId, redirect_uri: redirectUri, response_type: "code",
    scope: [SCOPES.gsc, SCOPES.ga4, "openid", "email"].join(" "), access_type: "offline", prompt: "consent", state,
    code_challenge: challenge, code_challenge_method: "S256" })}`;
  return { url, redirectUri, expiresAt: new Date(expiresAt).toISOString() };
}

/** What GET returns: never the secret or the token. */
export function oauthStatus() {
  const o = oauthCfg();
  return { clientId: o.clientId || "", hasSecret: Boolean(o.clientSecret), connected: Boolean(o.refreshToken), email: o.email || "",
    connectedAt: o.connectedAt || null, mode: authMode(), pending: Boolean(pending), expiresAt: pending ? new Date(pending.expiresAt).toISOString() : null,
    lastError: lastResult && !lastResult.ok ? lastResult.error : null };
}

/** PUT body: { clientId, clientSecret (empty = keep), clearSecret, mode }. A new client ID drops the old sign-in. */
export function updateOAuth(b = {}) {
  const o = { ...oauthCfg() };
  const patch = {};
  if (b.clientId !== undefined) {
    const id = String(b.clientId).trim();
    if (id && !/^[\w.-]{5,200}\.apps\.googleusercontent\.com$/.test(id)) fail(400, "The client ID ends with .apps.googleusercontent.com (Google Cloud console → Credentials → OAuth client, type Desktop app).");
    if (id !== (o.clientId || "")) { delete o.refreshToken; delete o.email; delete o.connectedAt; }
    o.clientId = id;
  }
  if (b.clientSecret !== undefined && b.clientSecret !== "") {
    const s = String(b.clientSecret).trim();
    if (!/^[\w-]{10,100}$/.test(s)) fail(400, "That doesn't look like an OAuth client secret (letters, digits, - and _, usually starting GOCSPX-).");
    o.clientSecret = s;
  }
  if (b.clearSecret === true) { delete o.clientSecret; delete o.refreshToken; delete o.email; delete o.connectedAt; }
  patch.googleOAuth = o;
  if (b.mode !== undefined) {
    if (!["service", "oauth"].includes(b.mode)) fail(400, "Mode: service or oauth");
    if (b.mode === "oauth" && !o.refreshToken) fail(400, "Sign in with Google first.");
    patch.googleAuthMode = b.mode;
  }
  if (!o.refreshToken) patch.googleAuthMode = "service";
  saveConfig(patch);
  clearClients();
  return oauthStatus();
}

/** Signs out: best-effort revoke at Google, then forget the token and go back to the service account. */
export async function disconnect({ fetchFn = fetch } = {}) {
  const o = { ...oauthCfg() };
  if (o.refreshToken) await fetchFn(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: o.refreshToken }).toString(), signal: AbortSignal.timeout(15000) }).catch(() => null);
  delete o.refreshToken; delete o.email; delete o.connectedAt; delete o.scope;
  saveConfig({ googleOAuth: o, googleAuthMode: "service" });
  clearClients();
  return oauthStatus();
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/google\/oauth$/, () => oauthStatus()]);
  routes.push(["PUT", /^\/api\/google\/oauth$/, (p, q, b) => updateOAuth(b)]);
  routes.push(["POST", /^\/api\/google\/oauth\/start$/, () => startOAuth()]);
  routes.push(["POST", /^\/api\/google\/oauth\/disconnect$/, () => disconnect()]);
}
