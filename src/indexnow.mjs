// IndexNow (Bing, Yandex, Seznam, Naver and others share submissions): tells search engines which URLs changed. The key
// is public by design (the site hosts it at https://<host>/<key>.txt; hosting that file stays the owner's job), so it
// is a project setting. Only URLs on the project's exact host are sent; the rest are returned as rejected. Suggested
// URLs: indexable pages new in the latest finished audit or whose text or title changed since the one before.
import { db, all, get, run, projectSettings } from "./db.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS indexnow_log (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (datetime('now')), urls INTEGER, status INTEGER, message TEXT)`);

export const ENDPOINT = "https://api.indexnow.org/indexnow";
export const MAX_URLS = 10000;
const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const STATUS_TEXT = {
  200: "Submitted: the URLs were received.",
  202: "Received: the key is still being checked; the URLs are processed once the key file is confirmed.",
  400: "Bad request: the submission was not in a valid format.",
  403: "Key not valid: the key file was not found at the key location, or it does not contain the key.",
  422: "Rejected: a URL does not belong to the host, or the key does not match the protocol's format.",
  429: "Too many requests: wait before submitting again (possible spam signal).",
};

export const validKey = (k) => KEY_RE.test(String(k || ""));
const projectKey = (project) => String(projectSettings(project).indexNowKey || "").trim();

/** Splits URLs into those on the project's exact host (http/https, deduplicated, at most 10,000) and the rest with a reason. */
export function filterUrls(project, urls) {
  const host = new URL(project.start_url).hostname.toLowerCase();
  const accepted = [], rejected = [], seen = new Set();
  for (const raw of (Array.isArray(urls) ? urls : String(urls || "").split(/\s+/)).map((u) => String(u).trim()).filter(Boolean)) {
    let u; try { u = new URL(raw); } catch { rejected.push({ url: raw, reason: "not a full URL" }); continue; }
    if (!["http:", "https:"].includes(u.protocol)) { rejected.push({ url: raw, reason: "not http(s)" }); continue; }
    if (u.hostname.toLowerCase() !== host) { rejected.push({ url: raw, reason: `not on ${host}` }); continue; }
    u.hash = "";
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    if (accepted.length >= MAX_URLS) { rejected.push({ url: raw, reason: "over 10,000 URLs in one submission" }); continue; }
    accepted.push(u.href);
  }
  return { host, accepted, rejected };
}

/** Sends the URLs; logs the result. */
export async function submit(project, urls, { fetchFn = fetch } = {}) {
  const key = projectKey(project);
  if (!validKey(key)) fail(400, "Set an IndexNow key first (8–128 letters, digits or dashes) and host it at https://<your site>/<key>.txt.");
  const { host, accepted, rejected } = filterUrls(project, urls);
  if (!accepted.length) fail(400, rejected.length ? `No URL on ${host} to submit.` : "Enter at least one URL.");
  const origin = new URL(project.start_url).origin;
  let status = 0, message;
  try {
    const res = await fetchFn(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ host, key, keyLocation: `${origin}/${key}.txt`, urlList: accepted }) });
    status = res.status;
    message = STATUS_TEXT[status] || `IndexNow answered ${status}.`;
  } catch (e) { message = `IndexNow not reachable (${e.name === "TimeoutError" ? "timed out" : "network error"}).`; }
  run("INSERT INTO indexnow_log (project_id, urls, status, message) VALUES (?,?,?,?)", project.id, accepted.length, status, message);
  return { ok: status === 200 || status === 202, status, message, submitted: accepted.length, rejected };
}

/** Fetches https://<host>/<key>.txt and checks it holds exactly the key. */
export async function checkKeyFile(project, { fetchFn = fetch } = {}) {
  const key = projectKey(project);
  if (!validKey(key)) fail(400, "Set an IndexNow key first.");
  const url = `${new URL(project.start_url).origin}/${key}.txt`;
  try {
    const res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    const body = (await res.text()).trim();
    if (!res.ok) return { ok: false, url, message: `The key file answered ${res.status}: upload ${key}.txt to the site's root folder.` };
    return body === key ? { ok: true, url, message: "The key file is in place and holds the key." }
      : { ok: false, url, message: "The key file exists but does not contain exactly the key (one line, nothing else)." };
  } catch { return { ok: false, url, message: "The key file could not be fetched." }; }
}

/** Indexable pages new in the latest finished audit, or whose text or title changed since the previous one. */
export function changedUrls(projectId) {
  const [latest, prev] = all("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 2", projectId);
  if (!latest) return { auditId: null, previousAuditId: null, urls: [], note: "Run an audit first." };
  const pages = (id) => new Map(all("SELECT url, title, data FROM pages WHERE audit_id=? AND indexable=1 AND status=200", id)
    .map((r) => [r.url, { title: r.title || "", hash: JSON.parse(r.data || "{}").textHash || null }]));
  if (!prev) return { auditId: latest.id, previousAuditId: null, urls: [], note: "Changed pages are found from the second finished audit on. Paste URLs to submit them now." };
  const now = pages(latest.id), before = pages(prev.id), urls = [];
  for (const [url, p] of now) {
    const o = before.get(url);
    if (!o) urls.push({ url, reason: "new" });
    else if (p.hash !== o.hash) urls.push({ url, reason: "text changed" });
    else if (p.title !== o.title) urls.push({ url, reason: "title changed" });
  }
  return { auditId: latest.id, previousAuditId: prev.id, urls: urls.slice(0, MAX_URLS), note: null };
}

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/indexnow\/changed$/, ([id]) => {
    const p = project(id);
    return { ...changedUrls(p.id), key: projectKey(p), log: all("SELECT ts, urls, status, message FROM indexnow_log WHERE project_id=? ORDER BY id DESC LIMIT 20", p.id) };
  }]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/indexnow$/, ([id], q, b) => submit(project(id), b?.urls)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/indexnow\/check-key$/, ([id]) => checkKeyFile(project(id))]);
}
