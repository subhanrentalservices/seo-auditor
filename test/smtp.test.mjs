// SMTP client (alert and report emails): message format, a full conversation with a fake local server, and the
// safety rules (no password over plain text to another host, STARTTLS required when chosen, no password in errors).
// Nothing is sent anywhere: the server is a fake on 127.0.0.1. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMail, buildMessage, validEmail, emailList } from "../src/smtp.mjs";
import { fakeSmtp, parts } from "./fake-smtp.mjs";

test("addresses: valid ones pass, lists split on commas, semicolons and spaces", () => {
  assert.ok(validEmail("alerts@example.com"));
  for (const bad of ["", "no-at.example.com", "a@b", "a b@example.com", "a@example.com\r\nBcc: x@example.com"]) assert.equal(validEmail(bad), false, bad);
  assert.deepEqual(emailList("a@example.com, b@example.com;c@example.com  d@example.com"), ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
});

test("message: headers can't be injected, non-ASCII subject is encoded, attachment is base64 with a safe file name", () => {
  const m = buildMessage({ from: "a@example.com", to: ["b@example.com"], subject: "Drop ✕\r\nBcc: evil@example.com", text: "hi", html: "<b>hi</b>",
    attachments: [{ filename: "../../report <1>.pdf", content: Buffer.from("%PDF-1.7"), type: "application/pdf" }] });
  const head = m.split("\r\n\r\n")[0];
  assert.doesNotMatch(head, /^Bcc:/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m, /filename="report-1-.pdf"/);
  const p = parts(m);
  assert.deepEqual(p.map((x) => x.type.split(";")[0]), ["text/plain", "text/html", "application/pdf"]);
  assert.equal(p[2].body.toString(), "%PDF-1.7");
});

test("a full conversation with a fake server: AUTH PLAIN, sender, recipients and the message body", async () => {
  const srv = await fakeSmtp();
  try {
    await sendMail({ host: "127.0.0.1", port: srv.port, security: "none", user: "me", pass: "s3cret-pass", from: "alerts@example.com",
      to: ["owner@example.com", "team@example.com"], subject: "Site Health 90 → 80", text: "Line one\n.\nLine with a dot" });
    const s = srv.sessions[0];
    assert.match(s.commands[0], /^EHLO /);
    assert.equal(s.commands[1], "AUTH PLAIN " + Buffer.from("\0me\0s3cret-pass").toString("base64"));
    assert.deepEqual(s.commands.filter((c) => /^(MAIL|RCPT)/.test(c)), ["MAIL FROM:<alerts@example.com>", "RCPT TO:<owner@example.com>", "RCPT TO:<team@example.com>"]);
    assert.equal(s.commands.at(-1), "QUIT");
    assert.equal(parts(s.data)[0].body.toString(), "Line one\n.\nLine with a dot");
    assert.match(s.data, /^Subject: =\?UTF-8\?B\?/m);
  } finally { await srv.close(); }
});

test("a rejected login names the server's reply but never the password", async () => {
  const srv = await fakeSmtp({ authReply: 535 });
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: srv.port, security: "none", user: "me", pass: "hunter2-secret", from: "a@example.com", to: ["b@example.com"], subject: "x", text: "x" }),
      (e) => /login refused: 535/.test(e.message) && !e.message.includes("hunter2") && !e.message.includes(Buffer.from("hunter2-secret").toString("base64")));
  } finally { await srv.close(); }
});

test("STARTTLS chosen but not offered: stops before the password is sent", async () => {
  const srv = await fakeSmtp({ starttls: false });
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: srv.port, security: "starttls", user: "me", pass: "pw-secret", from: "a@example.com", to: ["b@example.com"], subject: "x", text: "x" }), /does not offer STARTTLS/);
    assert.ok(!srv.sessions[0].commands.some((c) => /^AUTH/.test(c)));
  } finally { await srv.close(); }
});

test("STARTTLS offered: upgrades, says EHLO again, then logs in (upgrade injected: the fake has no certificate)", async () => {
  const srv = await fakeSmtp({ starttls: true });
  let upgraded = 0;
  try {
    await sendMail({ host: "127.0.0.1", port: srv.port, security: "starttls", user: "me", pass: "pw", from: "a@example.com", to: ["b@example.com"], subject: "x", text: "x" },
      { upgrade: (sock) => { upgraded++; return sock; } });
    assert.equal(upgraded, 1);
    assert.deepEqual(srv.sessions[0].commands.slice(0, 4).map((c) => c.split(" ")[0]), ["EHLO", "STARTTLS", "EHLO", "AUTH"]);
  } finally { await srv.close(); }
});

test("no password over an unencrypted link to another host; bad addresses fail before connecting", async () => {
  const connect = () => { throw new Error("must not connect"); };
  await assert.rejects(sendMail({ host: "smtp.example.com", port: 25, security: "none", user: "me", pass: "x", from: "a@example.com", to: ["b@example.com"] }, { connect }), /unencrypted/);
  await assert.rejects(sendMail({ host: "smtp.example.com", from: "not-an-address", to: ["b@example.com"] }, { connect }), /sender/);
  await assert.rejects(sendMail({ host: "smtp.example.com", from: "a@example.com", to: [] }, { connect }), /recipient/);
});
