// A fake SMTP server on 127.0.0.1 (random port) for tests: records each conversation and message, sends nothing.
// opts: { starttls: advertise STARTTLS, authReply: reply code to AUTH (235 = ok) }.
import net from "node:net";

export async function fakeSmtp({ starttls = false, authReply = 235 } = {}) {
  const sessions = [];
  const server = net.createServer((sock) => {
    const s = { commands: [], data: null }; sessions.push(s);
    let buf = "", inData = false, login = 0;
    sock.write("220 fake.example ESMTP\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (inData) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end < 0) return;
        s.data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
        sock.write("250 queued\r\n");
      }
      let i;
      while (!inData && (i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        s.commands.push(line);
        if (login) { login = login === 1 ? 2 : 0; sock.write(login ? "334 UGFzc3dvcmQ6\r\n" : `${authReply} auth\r\n`); continue; }
        if (/^EHLO/i.test(line)) sock.write(`250-fake.example\r\n${starttls ? "250-STARTTLS\r\n" : ""}250-AUTH PLAIN LOGIN\r\n250 OK\r\n`);
        else if (/^AUTH PLAIN/i.test(line)) sock.write(authReply === 235 ? "235 ok\r\n" : `${authReply} 5.7.8 Authentication credentials invalid\r\n`);
        else if (/^AUTH LOGIN/i.test(line)) { login = 1; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (/^STARTTLS/i.test(line) && starttls) sock.write("220 ready\r\n");
        else if (/^(MAIL|RCPT)/i.test(line)) sock.write("250 ok\r\n");
        else if (/^DATA/i.test(line)) { inData = true; sock.write("354 go ahead\r\n"); }
        else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("502 not implemented\r\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, sessions, close: () => new Promise((r) => server.close(r)) };
}

/** Decodes the base64 parts of a recorded message: [{type, headers, body (Buffer)}]. */
export function parts(data) {
  const out = [];
  for (const chunk of data.split(/\r\n--=_seo_auditor_[^\r\n]*/)) {
    const m = /Content-Type: ([^\r\n]+)[\s\S]*?Content-Transfer-Encoding: base64(?:\r\n[^\r\n]+)*\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(chunk);
    if (m) out.push({ type: m[1], headers: chunk, body: Buffer.from(m[2].replace(/\r\n/g, ""), "base64") });
  }
  return out;
}
