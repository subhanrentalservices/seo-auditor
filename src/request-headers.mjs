// Request headers and cookies for the project's own site (REQ-055 group 1, Oct 2026): e.g. a staging password
// (Authorization) or a bypass token or cookie the site's owner issued for audits. The values are secrets: they live in
// their own table, never in the project or audit settings (those keep only the names), are never returned by the API,
// never logged and are redacted from error messages. They are sent only to the project's own hosts: never to external
// links or third-party hosts, also not after a redirect (the crawler decides per request).
import { db, get, run } from "./db.mjs";

db.exec("CREATE TABLE IF NOT EXISTS project_request_headers (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, headers TEXT NOT NULL)");

export const MAX_HEADERS = 10;
// Set by the HTTP client or the connection, by another setting (User agent), or change what a page fetch means
// (ranges, conditional requests). Forwarding headers would fake the visitor's address; Sec-* and Proxy-* are the
// browser's and the proxy's own.
const FORBIDDEN = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect", "http2-settings",
  "user-agent", "accept-encoding", "content-encoding", "range", "if-range", "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
  "via", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "true-client-ip", "cf-connecting-ip"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/; // no line breaks or control characters; Latin-1 only, as HTTP allows
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

/** Validates the setting [{ name, value }] (at most 10). A row with a name and an empty value keeps the value saved
 *  for that name (the API never sends values back); a fully empty row is dropped. Returns [{ name, value }] with
 *  value null for "keep". Error messages name the header, never its value. */
export function cleanRequestHeaders(input) {
  if (input === null || input === undefined || input === "") return [];
  if (!Array.isArray(input)) fail("Request headers must be a list of names and values");
  const out = [], seen = new Set();
  for (const row of input) {
    const name = String(row?.name ?? "").trim(), value = row?.value === null || row?.value === undefined ? "" : String(row.value).trim();
    if (!name && !value) continue;
    if (!TOKEN.test(name)) fail(`"${name.slice(0, 40)}" isn't a valid header name`);
    const k = name.toLowerCase();
    if (FORBIDDEN.has(k) || k.startsWith("sec-") || k.startsWith("proxy-")) fail(`The ${name} header can't be set${k === "user-agent" ? " here: use the User agent setting" : ""}`);
    if (seen.has(k)) fail(`The ${name} header is listed twice`);
    if (value.length > 4096 || !VALUE.test(value)) fail(`The value of the ${name} header is too long or has characters a header can't carry`);
    seen.add(k);
    out.push({ name, value: value || null });
  }
  if (out.length > MAX_HEADERS) fail(`At most ${MAX_HEADERS} request headers`);
  return out;
}

/** The names only, as the settings and the API show them. */
export const maskHeaders = (list) => (Array.isArray(list) ? list : []).filter((h) => h && h.name).map((h) => ({ name: String(h.name), set: true }));

/** Saved values of a project: [{ name, value }]. */
export function requestHeaderValues(projectId) {
  const r = get("SELECT headers FROM project_request_headers WHERE project_id=?", Number(projectId));
  try { return r ? JSON.parse(r.headers) : []; } catch { return []; }
}

/** Saves a cleaned list (value null = keep the saved one) and returns the masked list for the settings. */
export function saveRequestHeaders(projectId, list) {
  const old = new Map(requestHeaderValues(projectId).map((h) => [h.name.toLowerCase(), h.value]));
  const out = list.map(({ name, value }) => ({ name, value: value ?? old.get(name.toLowerCase()) ?? fail(`Enter a value for the ${name} header`) }));
  if (out.length) run("INSERT OR REPLACE INTO project_request_headers (project_id, headers) VALUES (?, ?)", Number(projectId), JSON.stringify(out));
  else run("DELETE FROM project_request_headers WHERE project_id=?", Number(projectId));
  return maskHeaders(out);
}

/** url → the headers to add for that URL ({ name: value }), or null when it isn't one of the project's own hosts. */
export function headersFor(list, inScope) {
  if (!list?.length) return () => null;
  const obj = Object.fromEntries(list.map((h) => [h.name, h.value]));
  return (url) => (inScope(url) ? { ...obj } : null);
}

/** Replaces every saved value in a text (an error message) with [hidden], whole or as one cookie of a Cookie list. */
export function redact(text, list) {
  let s = String(text ?? "");
  const parts = (list || []).flatMap(({ value }) => [value, ...String(value || "").split(/;\s*/).map((p) => p.slice(p.indexOf("=") + 1))]);
  for (const v of [...new Set(parts)].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) s = s.split(v).join("[hidden]");
  return s;
}
