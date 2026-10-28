// Alert channels (REQ-055 group 5 item 1): settings with write-only secrets, webhook / Slack payloads, the toast,
// rate limit, test-send and redaction. Every sender is injected: no mail, webhook or toast leaves the test.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = DATA; // keep the real database and config untouched
const { run } = await import("../src/db.mjs");
const ch = await import("../src/alert-channels.mjs");
const { fakeSmtp, parts } = await import("./fake-smtp.mjs");

run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme', 'https://acme.example/')");
const HOOK = "https://hooks.slack.com/services/T000/B000/XXXXsecretTOKEN";
const WEBHOOK = "https://alerts.example.com/in?token=abc123secret";
const project = { id: 1, name: "Acme", start_url: "https://acme.example/" };
const items = [{ rule: "health_drop", title: "Site Health 90 → 80", detail: "Down 10 points.", severity: "warning" }, { rule: "new_5xx", title: "2 new pages with a 5xx server error", severity: "error", urls: ["https://acme.example/a"] }];
const clearSends = () => run("DELETE FROM alert_sends");
function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status }; };
  return Object.assign(fn, { calls });
}

test("settings: secrets are write-only (masked on read, kept when the field is left empty, cleared on request)", () => {
  ch.updateConfig({ email: { on: false, host: "smtp.example.com", port: 465, security: "tls", user: "me", password: "pw-secret-1", from: "alerts@example.com", to: "a@example.com; b@example.com" },
    webhook: { on: true, url: WEBHOOK }, slack: { on: true, url: HOOK } });
  const pub = ch.publicConfig(), json = JSON.stringify(pub);
  for (const secret of ["pw-secret-1", "XXXXsecretTOKEN", "abc123secret"]) assert.ok(!json.includes(secret), secret);
  assert.equal(pub.email.hasPassword, true);
  assert.equal(pub.slack.saved, "https://hooks.slack.com/…");
  assert.equal(pub.email.to, "a@example.com, b@example.com");
  ch.updateConfig({ email: { password: "" }, slack: { url: "" } }); // empty = keep
  assert.equal(ch.channelConfig().email.password, "pw-secret-1");
  assert.equal(ch.channelConfig().slack.url, HOOK);
  ch.updateConfig({ email: { clearPassword: true } });
  assert.equal(ch.channelConfig().email.password, "");
  assert.ok(JSON.parse(readFileSync(path.join(DATA, "config.json"), "utf8")).alerts, "stored in data/config.json");
});

test("settings: bad values are refused with a clear message", () => {
  assert.throws(() => ch.updateConfig({ slack: { url: "http://hooks.slack.com/x" } }), /https/);
  assert.throws(() => ch.updateConfig({ webhook: { url: "ftp://x.example.com" } }), /http/);
  assert.throws(() => ch.updateConfig({ email: { port: 70000 } }), /port/);
  assert.throws(() => ch.updateConfig({ email: { to: "not an address" } }), /Recipients/);
  assert.throws(() => ch.updateConfig({ email: { host: "smtp.example.com\r\nX" } }), /host/);
  assert.throws(() => ch.updateConfig({ maxPerHour: 0 }), /per hour/);
});

test("redact removes saved secrets, webhook tokens, URL passwords and token query strings", () => {
  ch.updateConfig({ email: { password: "pw-secret-2" } });
  const other = "https://hooks.slack.com/services/T1/B1/notSavedToken"; // a hook that isn't the saved one
  const out = ch.redact(`failed: pw-secret-2 at ${HOOK} and ${other} https://user:pass@x.example.com/a?token=zzz&x=1 ${Buffer.from("pw-secret-2").toString("base64")}`);
  for (const s of ["pw-secret-2", "XXXXsecretTOKEN", "notSavedToken", "user:pass", "zzz", Buffer.from("pw-secret-2").toString("base64")]) assert.ok(!out.includes(s), s);
  assert.match(out, /hooks\.slack\.com\/services\/\[hidden\]/);
});

test("deliver: webhook gets JSON with every alert, Slack gets text, the toast gets a title; off channels are skipped", async () => {
  clearSends();
  ch.updateConfig({ webhook: { on: true }, slack: { on: true }, toast: { on: true }, email: { on: false } });
  const fetchFn = fakeFetch(), toasts = [];
  const r = await ch.deliver({ project, items }, { deps: { fetchFn, toast: (t, b) => toasts.push([t, b]) } });
  assert.deepEqual(Object.keys(r).sort(), ["slack", "toast", "webhook"]);
  assert.ok(Object.values(r).every((x) => x.ok));
  const hook = fetchFn.calls.find((c) => c.url === WEBHOOK), slack = fetchFn.calls.find((c) => c.url === HOOK);
  assert.equal(hook.body.source, "seo-auditor");
  assert.equal(hook.body.project.name, "Acme");
  assert.deepEqual(hook.body.alerts.map((a) => a.rule), ["health_drop", "new_5xx"]);
  assert.equal(hook.init.redirect, "error");
  assert.match(slack.body.text, /^\*Acme: 2 SEO alerts\*\n• Site Health 90 → 80 — Down 10 points\./);
  assert.equal(toasts[0][0], "Acme: 2 SEO alerts");
});

test("deliver: a failing channel reports a redacted error and the others still send", async () => {
  clearSends();
  const fetchFn = async (url) => { if (url === WEBHOOK) throw new Error(`connect ECONNREFUSED ${WEBHOOK}`); return { ok: false, status: 404 }; };
  const r = await ch.deliver({ project, items }, { deps: { fetchFn, toast: () => {} } });
  assert.equal(r.webhook.ok, false);
  assert.ok(!r.webhook.error.includes("abc123secret"));
  assert.match(r.slack.error, /HTTP 404/);
  assert.equal(r.toast.ok, true);
});

test("rate limit: at most maxPerHour sends per channel per hour; the next hour sends again", async () => {
  clearSends();
  ch.updateConfig({ maxPerHour: 2, webhook: { on: true }, slack: { on: false }, toast: { on: false } });
  const fetchFn = fakeFetch(), now = Date.parse("2026-10-28T10:00:00Z");
  const send = (t) => ch.deliver({ project, items }, { deps: { fetchFn, now: t } });
  assert.equal((await send(now)).webhook.ok, true);
  assert.equal((await send(now + 60e3)).webhook.ok, true);
  const third = await send(now + 120e3);
  assert.equal(third.webhook.rateLimited, true);
  assert.equal(fetchFn.calls.length, 2);
  assert.equal((await send(now + 3700e3)).webhook.ok, true);
  ch.updateConfig({ maxPerHour: 10 });
});

test("test-send: one sample alert on the chosen channel, even when it is switched off", async () => {
  clearSends();
  ch.updateConfig({ slack: { on: false } });
  const fetchFn = fakeFetch();
  const r = await ch.testSend("slack", { fetchFn });
  assert.deepEqual(Object.keys(r), ["slack"]);
  assert.equal(r.slack.ok, true);
  assert.match(fetchFn.calls[0].body.text, /Test alert/);
  await assert.rejects(async () => ch.testSend("pager"), /Unknown channel/);
});

test("email channel: one message with the alerts as text and HTML, through the SMTP settings", async () => {
  clearSends();
  const srv = await fakeSmtp();
  try {
    ch.updateConfig({ email: { on: true, host: "127.0.0.1", port: srv.port, security: "none", user: "", from: "alerts@example.com", to: "owner@example.com" },
      webhook: { on: false }, slack: { on: false }, toast: { on: false } });
    const r = await ch.deliver({ project, items: [{ ...items[0], detail: "<script>x</script>" }] }, { deps: {} });
    assert.equal(r.email.ok, true);
    const [text, html] = parts(srv.sessions[0].data);
    assert.match(text.body.toString(), /Site Health 90 → 80/);
    assert.match(html.body.toString(), /&lt;script&gt;/);
    assert.ok(!html.body.toString().includes("<script>"));
  } finally { await srv.close(); ch.updateConfig({ email: { on: false } }); }
});
