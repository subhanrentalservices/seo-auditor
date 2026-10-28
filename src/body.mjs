// Response bodies (REQ-055 group 2, Oct 2026): read as a byte stream with a size cap, then decoded with the page's
// own character encoding. res.text() assumed UTF-8, which garbled windows-1252, Shift_JIS or GBK pages, and read
// any size into memory. The order follows the HTML standard's encoding sniffing, as browsers and Google do:
//   1. a byte order mark (it wins even over the Content-Type header),
//   2. the Content-Type header's charset,
//   3. <meta charset> / <meta http-equiv="Content-Type"> (or an XML declaration) in the first 1,024 bytes,
//   4. UTF-8.
// TextDecoder knows every WHATWG encoding label (Node ships full ICU); an unknown label is skipped.

export const MAX_HTML = 15 * 1024 * 1024; // one page; Googlebot reads only the first 2 MB (large_html checks the true size)
export const PRESCAN = 1024;              // bytes searched for a meta charset, as in the HTML standard

const BOMS = [[[0xef, 0xbb, 0xbf], "utf-8"], [[0xff, 0xfe], "utf-16le"], [[0xfe, 0xff], "utf-16be"]];

/** The encoding a WHATWG label names (e.g. "latin1" → "windows-1252"), or null when TextDecoder doesn't know it. */
export function encodingOf(label) {
  const l = String(label || "").trim().replace(/^["']|["']$/g, "");
  if (!l) return null;
  try { return new TextDecoder(l).encoding; } catch { return null; }
}

/** The charset parameter of a Content-Type header value, or null. */
export const headerCharset = (type) => /;\s*charset\s*=\s*["']?([^"';\s,]+)/i.exec(String(type || ""))?.[1] || null;

/** Encoding named by a byte order mark at the start of buf, or null. */
export function bomOf(buf) {
  for (const [bytes, enc] of BOMS) if (buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b)) return enc;
  return null;
}

/** Encoding declared in the first `scan` bytes: <meta charset>, <meta http-equiv content="…; charset=…">, or an XML
 *  declaration. A meta tag naming UTF-16 means UTF-8 (the bytes were already read as ASCII), and x-user-defined means
 *  windows-1252, as in the HTML standard. Returns the encoding or null. */
export function declaredCharset(buf, scan = PRESCAN) {
  const head = Buffer.from(buf.subarray(0, scan)).toString("latin1").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  const xml = /^\s*<\?xml\s[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(head);
  if (xml) return encodingOf(xml[1]);
  for (const m of head.matchAll(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = m[0], attr = (name) => (new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag) || []).slice(1).find((x) => x !== undefined);
    // <meta charset="…">, or charset= inside content on an http-equiv="Content-Type" tag (not on any other meta).
    const label = attr("charset") ?? (/^content-type$/i.test(attr("http-equiv") || "") ? /charset\s*=\s*["']?([^"'\s;]+)/i.exec(attr("content") || "")?.[1] : null);
    const enc = encodingOf(label);
    if (!enc) continue;
    if (/^utf-16/.test(enc)) return "utf-8";
    return enc === "x-user-defined" ? "windows-1252" : enc;
  }
  return null;
}

/** Decodes a response body. Returns { text, charset, source } with source "bom" | "header" | "meta" | "default". */
export function decodeBody(bytes, type = "") {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const pick = () => {
    const bom = bomOf(buf);
    if (bom) return [bom, "bom"];
    const h = encodingOf(headerCharset(type));
    if (h) return [h, "header"];
    const m = /html|xml/i.test(type) || !type ? declaredCharset(buf) : null;
    if (m) return [m, "meta"];
    return ["utf-8", "default"];
  };
  const [charset, source] = pick();
  return { text: new TextDecoder(charset).decode(buf), charset, source }; // TextDecoder drops a matching BOM itself
}

/** Reads a fetch Response body as bytes, at most max: { buf, size, truncated }. A longer body stops at max and the rest
 *  is never downloaded, so one huge response can't exhaust memory; size is then the bytes read (at least max). */
export async function readBody(res, max = MAX_HTML) {
  if (!res.body) return { buf: Buffer.alloc(0), size: 0, truncated: false };
  const reader = res.body.getReader(), parts = [];
  let n = 0, truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value)); n += value.length;
      if (n > max) { truncated = true; break; }
    }
  } finally { if (truncated) reader.cancel().catch(() => {}); }
  const buf = Buffer.concat(parts);
  return { buf: truncated ? buf.subarray(0, max) : buf, size: n, truncated };
}
