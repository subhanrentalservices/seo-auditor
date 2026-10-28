// Minimal SMTP client for alert and report emails, so no mail library is needed: implicit TLS (port 465), STARTTLS
// (587) or plain (a relay on this PC only), AUTH PLAIN or LOGIN, one message with optional attachments. The
// connection is injectable: tests talk to a fake server on 127.0.0.1 and never send real mail. The password never
// appears in errors (they carry the server's reply only) and is refused over an unencrypted link to another host.
import net from "node:net";
import tls from "node:tls";
import os from "node:os";

const ADDRESS = /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/;
export const validEmail = (s) => ADDRESS.test(String(s ?? "").trim()) && String(s).length <= 254;
/** "a@x.com, b@y.com; c@z.com" → ["a@x.com", "b@y.com", "c@z.com"] */
export const emailList = (s) => String(s ?? "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").trim(); // no header injection
const header = (s) => (/^[\x20-\x7e]*$/.test(oneLine(s)) ? oneLine(s) : `=?UTF-8?B?${Buffer.from(oneLine(s)).toString("base64")}?=`);
const base64 = (buf) => Buffer.from(buf).toString("base64").replace(/.{76}/g, "$&\r\n");
const fileName = (s) => String(s || "file").replace(/[^\w.-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "").slice(0, 100) || "file";
const boundary = (tag) => `=_seo_auditor_${tag}_${Math.random().toString(36).slice(2, 12)}`;

/** The whole message (headers + MIME body, CRLF line ends). Every part is base64, so no line can start with a dot
 *  and no line is too long. */
export function buildMessage({ from, to, subject, text = "", html, attachments = [], date = new Date() }) {
  const part = (type, body) => [`Content-Type: ${type}`, "Content-Transfer-Encoding: base64", "", base64(body)].join("\r\n");
  const multipart = (sub, parts) => { const b = boundary(sub); return [`multipart/${sub}; boundary="${b}"`, parts.map((p) => `--${b}\r\n${p}`).join("\r\n") + `\r\n--${b}--`]; };
  let [type, body] = html
    ? multipart("alternative", [part("text/plain; charset=utf-8", text), part("text/html; charset=utf-8", html)])
    : ["text/plain; charset=utf-8", null];
  if (attachments.length) {
    const first = body ? `Content-Type: ${type}\r\n\r\n${body}` : part("text/plain; charset=utf-8", text);
    [type, body] = multipart("mixed", [first, ...attachments.map((a) => [`Content-Type: ${a.type || "application/octet-stream"}; name="${fileName(a.filename)}"`,
      "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${fileName(a.filename)}"`, "", base64(a.content)].join("\r\n"))]);
  }
  const domain = String(from).split("@")[1] || "localhost";
  const head = [`From: ${oneLine(from)}`, `To: ${to.map(oneLine).join(", ")}`, `Subject: ${header(subject)}`, `Date: ${date.toUTCString()}`,
    `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${oneLine(domain)}>`, "MIME-Version: 1.0"];
  if (body === null) return [...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64(text)].join("\r\n");
  return [...head, `Content-Type: ${type}`, "", body].join("\r\n");
}

/** Reads SMTP replies: a reply ends at the line whose code is followed by a space ("250 OK", after "250-…" lines). */
function replies(socket) {
  let buf = "", waiting = null, failed = null;
  const lines = [];
  const take = () => {
    const end = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end < 0 || !waiting) return;
    const got = lines.splice(0, end + 1), w = waiting; waiting = null;
    w.resolve({ code: Number(got.at(-1).slice(0, 3)), text: got.map((l) => l.slice(4)).join(" ").trim(), lines: got });
  };
  const onData = (d) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); } take(); };
  const onEnd = (e) => { failed = e || new Error("connection closed"); if (waiting) { const w = waiting; waiting = null; w.reject(failed); } };
  const onClose = () => onEnd();
  const attach = (s) => { s.on("data", onData); s.on("error", onEnd); s.on("close", onClose); };
  const detach = (s) => { s.off("data", onData); s.off("error", onEnd); s.off("close", onClose); };
  attach(socket);
  return { attach, detach, next: () => new Promise((resolve, reject) => { if (failed && !lines.length) return reject(failed); waiting = { resolve, reject }; take(); }) };
}

function defaultConnect({ host, port, secure, timeout }) {
  return new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(timeout, () => s.destroy(new Error("timed out")));
    s.once(secure ? "secureConnect" : "connect", () => resolve(s));
    s.once("error", reject);
  });
}
function defaultUpgrade(socket, host, timeout) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host });
    s.setTimeout(timeout, () => s.destroy(new Error("timed out")));
    s.once("secureConnect", () => resolve(s)); s.once("error", reject);
  });
}

/**
 * Sends one message. opts: host, port, security ("tls" | "starttls" | "none"), user, pass, from, to (array), subject,
 * text, html, attachments [{filename, content: Buffer, type}]. deps: { connect, upgrade, timeout } for tests.
 */
export async function sendMail(opts, { connect = defaultConnect, upgrade = defaultUpgrade, timeout = 30000 } = {}) {
  const { host, port, security = "starttls", user, pass, from, to = [] } = opts;
  if (!host) throw new Error("No SMTP server set");
  if (!validEmail(from)) throw new Error("The sender address is not a valid email address");
  if (!to.length || !to.every(validEmail)) throw new Error("Add at least one valid recipient email address");
  if (user && security === "none" && !LOCAL_HOSTS.has(String(host).toLowerCase()))
    throw new Error("Refusing to send the SMTP password unencrypted: choose TLS or STARTTLS");
  let socket = await connect({ host, port: Number(port) || (security === "tls" ? 465 : 587), secure: security === "tls", timeout });
  const r = replies(socket);
  const write = (line) => socket.write(line + "\r\n");
  const expect = async (stage, ok) => {
    const res = await r.next();
    if (!ok.includes(res.code)) throw Object.assign(new Error(`SMTP ${stage} refused: ${res.code} ${res.text}`.slice(0, 300)), { smtpCode: res.code });
    return res;
  };
  const say = async (stage, line, ok) => { write(line); return expect(stage, ok); };
  try {
    await expect("greeting", [220]);
    const me = oneLine(os.hostname()).replace(/[^\w.-]/g, "") || "localhost";
    let ehlo = await say("EHLO", `EHLO ${me}`, [250]);
    if (security === "starttls") {
      if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new Error("The SMTP server does not offer STARTTLS; choose TLS (port 465) or check the port");
      await say("STARTTLS", "STARTTLS", [220]);
      r.detach(socket);
      socket = await upgrade(socket, host, timeout);
      r.attach(socket);
      ehlo = await say("EHLO", `EHLO ${me}`, [250]);
    }
    if (user) {
      const auth = ehlo.lines.find((l) => /AUTH/i.test(l)) || "";
      if (/PLAIN/i.test(auth) || !/LOGIN/i.test(auth)) await say("login", `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass ?? ""}`).toString("base64")}`, [235]);
      else {
        await say("login", "AUTH LOGIN", [334]);
        await say("login", Buffer.from(String(user)).toString("base64"), [334]);
        await say("login", Buffer.from(String(pass ?? "")).toString("base64"), [235]);
      }
    }
    await say("MAIL FROM", `MAIL FROM:<${oneLine(from)}>`, [250]);
    for (const t of to) await say("RCPT TO", `RCPT TO:<${oneLine(t)}>`, [250, 251]);
    await say("DATA", "DATA", [354]);
    const data = buildMessage({ ...opts, to }).replace(/\r\n\./g, "\r\n.."); // dot-stuffing (RFC 5321 4.5.2)
    await say("message", data + "\r\n.", [250]);
    await say("QUIT", "QUIT", [221]).catch(() => {}); // the message is accepted already; a server that just hangs up is fine
    return { ok: true };
  } finally {
    socket.end();
  }
}
