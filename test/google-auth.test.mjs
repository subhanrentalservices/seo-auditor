// Google sign-in (REQ-055 group 8 item 3): service-account default, OAuth loopback flow with state check and PKCE,
// write-only secrets, invalid_grant message, disconnect. Google's token and revoke endpoints are mocked; the only
// requests made are to the test's own listener on 127.0.0.1. Client IDs, secrets and tokens below are made up.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = DIR; // keep the real database and config untouched
const ga = await import("../src/google-auth.mjs");
const { gsc } = await import("../src/gsc.mjs");
const { saveConfig } = await import("../src/dataforseo.mjs");

const CLIENT_ID = "1234567890-fakeclient.apps.googleusercontent.com";
const SECRET = "GOCSPX-fake_secret_for_tests_0001";
const REFRESH = "1//fake-refresh-token-for-tests-XYZ";
const ACCESS = "ya29.fake-access-token-for-tests";
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`;
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fileConfig = () => JSON.parse(readFileSync(path.join(DIR, "config.json"), "utf8"));
const reset = () => { saveConfig({ googleOAuth: {}, googleAuthMode: "service", gscKeyFile: "" }); ga.clearClients(); };

test("service account is the default; a missing key file gives the same Search Console message as before", async () => {
  reset();
  saveConfig({ gscKeyFile: path.join(DIR, "missing.json") });
  assert.equal(ga.authMode(), "service");
  await assert.rejects(gsc("sites"), (e) => e.status === 400 && /^Search Console key file not found: .*missing\.json$/.test(e.message));
});

test("service mode builds a key-file client without any network call; oauth mode without a token stays on the service account", async () => {
  reset();
  const key = path.join(DIR, "sa.json");
  writeFileSync(key, JSON.stringify({ type: "service_account", client_email: "auditor@example.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n" }));
  saveConfig({ gscKeyFile: key, googleAuthMode: "oauth", googleOAuth: { clientId: CLIENT_ID, clientSecret: SECRET } });
  assert.equal(ga.authMode(), "service", "no refresh token saved yet");
  const c = await ga.googleClient(ga.SCOPES.gsc);
  assert.equal(c.constructor.name, "JWT");
  assert.equal(c.email, "auditor@example.iam.gserviceaccount.com");
  assert.equal(await ga.googleClient(ga.SCOPES.gsc), c, "cached per scope and key file");
  assert.notEqual(await ga.googleClient(ga.SCOPES.ga4, { service: "ga4" }), c, "a different scope gets its own client");
  saveConfig({ ga4KeyFile: path.join(DIR, "ga4-missing.json") });
  await assert.rejects(ga.googleClient(ga.SCOPES.ga4, { service: "ga4", label: "Google Analytics" }), /Google Analytics key file not found/);
  saveConfig({ ga4KeyFile: "" });
});

test("client settings: the secret is write-only, the client ID is checked, oauth mode needs a sign-in", () => {
  reset();
  assert.throws(() => ga.updateOAuth({ clientId: "not-a-client-id" }), /apps\.googleusercontent\.com/);
  assert.throws(() => ga.updateOAuth({ clientSecret: "short" }), /client secret/);
  const s = ga.updateOAuth({ clientId: CLIENT_ID, clientSecret: SECRET });
  assert.deepEqual([s.clientId, s.hasSecret, s.connected, s.mode], [CLIENT_ID, true, false, "service"]);
  assert.ok(!JSON.stringify(s).includes(SECRET));
  assert.equal(fileConfig().googleOAuth.clientSecret, SECRET);
  ga.updateOAuth({ clientSecret: "" });
  assert.equal(fileConfig().googleOAuth.clientSecret, SECRET, "empty secret keeps the saved one");
  assert.throws(() => ga.updateOAuth({ mode: "oauth" }), /Sign in with Google first/);
});

test("loopback sign-in: wrong state is rejected, the right one stores the token (never returned) and switches to oauth", async () => {
  reset();
  ga.updateOAuth({ clientId: CLIENT_ID, clientSecret: SECRET });
  const asked = [];
  const fetchFn = async (url, o) => { asked.push({ url, body: new URLSearchParams(o.body) }); return reply(200, { access_token: ACCESS, refresh_token: REFRESH, id_token: idToken("owner@example.com"), scope: "x" }); };
  const flow = await ga.startOAuth({ fetchFn });
  assert.match(flow.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/, "listener on 127.0.0.1 only");
  const auth = new URL(flow.url), p = auth.searchParams;
  assert.equal(auth.origin + auth.pathname, ga.AUTH_URL);
  assert.deepEqual([p.get("client_id"), p.get("redirect_uri"), p.get("access_type"), p.get("prompt"), p.get("code_challenge_method"), p.get("response_type")],
    [CLIENT_ID, flow.redirectUri, "offline", "consent", "S256", "code"]);
  assert.ok(p.get("scope").includes(ga.SCOPES.gsc) && p.get("scope").includes(ga.SCOPES.ga4) && p.get("scope").includes("email"));
  assert.ok(!flow.url.includes(SECRET));
  assert.equal(ga.oauthStatus().pending, true);

  const bad = await fetch(`${flow.redirectUri}?state=wrong-state&code=abc`);
  assert.equal(bad.status, 400);
  assert.equal(asked.length, 0, "no token exchange for a wrong state");
  assert.equal(ga.oauthStatus().pending, true, "the flow keeps waiting for the real callback");

  const good = await fetch(`${flow.redirectUri}?state=${encodeURIComponent(p.get("state"))}&code=the-auth-code`);
  assert.equal(good.status, 200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, ga.TOKEN_URL);
  const b = asked[0].body;
  assert.deepEqual([b.get("code"), b.get("client_id"), b.get("client_secret"), b.get("redirect_uri"), b.get("grant_type")], ["the-auth-code", CLIENT_ID, SECRET, flow.redirectUri, "authorization_code"]);
  assert.equal(createHash("sha256").update(b.get("code_verifier")).digest("base64url"), p.get("code_challenge"), "PKCE S256");

  const s = ga.oauthStatus();
  assert.deepEqual([s.connected, s.email, s.mode, s.pending, s.lastError], [true, "owner@example.com", "oauth", false, null]);
  const json = JSON.stringify(s);
  for (const secret of [SECRET, REFRESH, ACCESS]) assert.ok(!json.includes(secret));
  assert.equal(fileConfig().googleOAuth.refreshToken, REFRESH);
  await assert.rejects(fetch(flow.redirectUri), "the listener is closed after the sign-in");

  const c = await ga.googleClient(ga.SCOPES.gsc);
  assert.equal(c.constructor.name, "OAuth2Client");
  assert.equal(c.credentials.refresh_token, REFRESH);
});

test("Search Console calls go through the signed-in client; invalid_grant becomes 'sign in again'; tokens never in errors", async () => {
  assert.equal(ga.authMode(), "oauth");
  const c = await ga.googleClient(ga.SCOPES.gsc);
  const seen = [];
  c.request = async (o) => { seen.push(o); return { data: { siteEntry: [{ siteUrl: "sc-domain:example.com" }] } }; };
  assert.deepEqual(await gsc("sites"), { siteEntry: [{ siteUrl: "sc-domain:example.com" }] });
  assert.deepEqual(seen[0], { url: "https://searchconsole.googleapis.com/webmasters/v3/sites", method: "GET", data: undefined });
  c.request = async () => { throw Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } }); };
  await assert.rejects(gsc("sites"), (e) => e.message === ga.EXPIRED && e.status === 401);
  c.request = async () => { throw Object.assign(new Error(`bad request with ${REFRESH} and ${SECRET}`), { response: { status: 403 } }); };
  await assert.rejects(gsc("sites"), (e) => !e.message.includes(REFRESH) && !e.message.includes(SECRET) && e.response.status === 403);
});

test("token endpoint errors are redacted; a cancelled sign-in and a timeout are reported plainly", async () => {
  const fetchFn = async () => reply(400, { error: "invalid_client", error_description: `client ${SECRET} rejected` });
  let flow = await ga.startOAuth({ fetchFn });
  let st = new URL(flow.url).searchParams.get("state");
  assert.equal((await fetch(`${flow.redirectUri}?state=${encodeURIComponent(st)}&code=c1`)).status, 400);
  let s = ga.oauthStatus();
  assert.match(s.lastError, /Google refused the sign-in \(400\)/);
  assert.ok(!s.lastError.includes(SECRET));
  assert.equal(fileConfig().googleOAuth.refreshToken, REFRESH, "the earlier sign-in is kept");

  flow = await ga.startOAuth({ fetchFn });
  st = new URL(flow.url).searchParams.get("state");
  await fetch(`${flow.redirectUri}?state=${encodeURIComponent(st)}&error=access_denied`);
  assert.equal(ga.oauthStatus().lastError, "Sign-in was cancelled.");

  await ga.startOAuth({ fetchFn, timeoutMs: 30 });
  await new Promise((r) => setTimeout(r, 80));
  s = ga.oauthStatus();
  assert.equal(s.pending, false);
  assert.match(s.lastError, /timed out/);
});

test("disconnect revokes (best effort), forgets the token and returns to the service account", async () => {
  const asked = [];
  const s = await ga.disconnect({ fetchFn: async (url, o) => { asked.push({ url, body: o.body }); throw new Error("offline"); } });
  assert.equal(asked[0].url, ga.REVOKE_URL);
  assert.equal(new URLSearchParams(asked[0].body).get("token"), REFRESH);
  assert.deepEqual([s.connected, s.mode, s.hasSecret, s.email], [false, "service", true, ""]);
  assert.equal(fileConfig().googleOAuth.refreshToken, undefined);
  assert.equal(fileConfig().googleAuthMode, "service");
  // A new client ID drops a sign-in made with the old one.
  saveConfig({ googleAuthMode: "oauth", googleOAuth: { clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: REFRESH } });
  const after = ga.updateOAuth({ clientId: "999-other.apps.googleusercontent.com" });
  assert.deepEqual([after.connected, after.mode], [false, "service"]);
});
