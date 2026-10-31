// Polite reader for research (REQ-055 group 6): Google Autocomplete, competitor robots.txt, sitemaps and pages, and the
// headings of top-10 results for a content brief. One request at a time per host with a gap between them, a timeout,
// a size cap, the tool's own honest user agent (never a browser or Googlebot disguise, whatever the crawl setting
// says), and a cache in the database so a repeat run asks nobody again. Page reads obey robots.txt (Google's rules: a
// 4xx robots.txt allows everything; a 5xx or no answer means "don't crawl"). A host that answers 429 or 503 is left
// alone for the rest of the run. No CAPTCHA solving, no retries around a block. fetchFn and sleep are injectable:
// tests never touch the network.
import robotsParser from "robots-parser";
import { db, get, run } from "./db.mjs";
import { readCapped, AUDITOR_UA } from "./fetch-ladder.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS research_cache (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, status INTEGER, type TEXT, body TEXT)`);

export const RESEARCH_UA = AUDITOR_UA; // "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)": names the tool
export const ROBOTS_TOKEN = "SEOAuditor"; // the group robots.txt rules are matched against (then "*")
export const DEFAULTS = { gapMs: 1500, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024, ttlHours: 24 * 7 };
const ROBOTS_TTL_H = 24;

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

async function readBytes(res, max) {
  if (!res.body) return Buffer.from(await res.arrayBuffer?.() ?? []);
  const reader = res.body.getReader(), parts = [];
  let n = 0;
  try { while (n < max) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; } }
  finally { reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).subarray(0, max);
}

/** A reader with its own per-host pacing. get(url) answers { status, type, body, cached, error }; with { binary: true }
 *  also `bytes` (a Buffer: gzip sitemaps). page(url) checks robots.txt first and answers { status: 0, blocked: "robots" }
 *  for a disallowed URL. */
export function createPolite({ fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ua = RESEARCH_UA;
  const last = new Map(); // host -> time of the last request
  const cooled = new Set(); // hosts that answered 429/503: not asked again by this reader
  const robots = new Map(); // origin -> Promise<robots parser | "deny" | "allow">
  const stats = { requests: 0, cached: 0, blocked: 0, errors: 0, limited: 0 };

  async function pace(host) {
    const wait = (last.get(host) || 0) + o.gapMs - now();
    if (wait > 0) await sleep(wait);
    last.set(host, now());
  }

  async function getUrl(url, { accept = "*/*", ttlHours = o.ttlHours, binary = false, maxBytes = o.maxBytes } = {}) {
    const key = `${ua}\u0000${binary ? "b:" : ""}${url}`;
    const hit = get("SELECT fetched_at, status, type, body FROM research_cache WHERE key=?", key);
    const wrap = (r) => binary ? { ...r, bytes: Buffer.from(r.body || "", "base64"), body: "" } : r;
    if (hit && now() - hit.fetched_at < ttlHours * 3600e3) { stats.cached++; return wrap({ status: hit.status, type: hit.type || "", body: hit.body || "", cached: true }); }
    const host = hostOf(url);
    if (!host) return { status: 0, type: "", body: "", error: "not a web address" };
    if (cooled.has(host)) { stats.limited++; return { status: 429, type: "", body: "", error: "the site asked us to slow down earlier in this run" }; }
    await pace(host);
    stats.requests++;
    let out;
    try {
      const res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs), headers: { "User-Agent": ua, Accept: accept } });
      const type = (typeof res.headers?.get === "function" ? res.headers.get("content-type") : "") || "";
      let body = "";
      if (res.status === 200) body = binary ? (await readBytes(res, maxBytes)).toString("base64") : res.body ? await readCapped(res, maxBytes) : await res.text();
      else res.body?.cancel?.().catch?.(() => {});
      out = { status: res.status, type, body };
    } catch (e) {
      stats.errors++;
      return { status: 0, type: "", body: "", error: e.name === "TimeoutError" ? "timeout" : e.cause?.code || e.message };
    }
    if (out.status === 429 || out.status === 503) cooled.add(host);
    // Server errors and rate limits are not cached: the next run tries again.
    if (out.status < 500 && out.status !== 429) run("INSERT OR REPLACE INTO research_cache (key, fetched_at, status, type, body) VALUES (?,?,?,?,?)", key, now(), out.status, out.type, out.body);
    return wrap({ ...out, cached: false });
  }

  function robotsFor(origin) {
    if (!robots.has(origin)) robots.set(origin, getUrl(origin + "/robots.txt", { accept: "text/plain,*/*;q=0.5", ttlHours: ROBOTS_TTL_H }).then((r) =>
      r.status === 200 ? robotsParser(origin + "/robots.txt", r.body) : r.status >= 400 && r.status < 500 && r.status !== 429 ? "allow" : "deny"));
    return robots.get(origin);
  }

  /** True when robots.txt lets this tool read the URL (its own group, else "*"). */
  async function allowed(url) {
    let origin; try { origin = new URL(url).origin; } catch { return false; }
    const r = await robotsFor(origin);
    if (r === "allow") return true;
    if (r === "deny") return false;
    return r.isAllowed(url, ROBOTS_TOKEN) !== false;
  }

  async function page(url, opt = {}) {
    if (!(await allowed(url))) { stats.blocked++; return { status: 0, type: "", body: "", blocked: "robots" }; }
    return getUrl(url, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", ...opt });
  }

  return { get: getUrl, page, allowed, robotsFor, stats, ua };
}

// Background research jobs (they take minutes at a polite pace): one per project and kind; the screen polls status.
const jobs = new Map();
export function jobStatus(kind, projectId) {
  const j = jobs.get(`${kind}:${projectId}`);
  return j ? { running: j.running, done: j.done, total: j.total, note: j.note, error: j.error, startedAt: j.startedAt, finishedAt: j.finishedAt } : null;
}
/** Starts fn(progress) unless the same job is running; progress(done, total, note) updates the status. Returns the
 *  promise (tests await it; the API returns at once). */
export function startJob(kind, projectId, fn) {
  const key = `${kind}:${projectId}`;
  if (jobs.get(key)?.running) throw Object.assign(new Error("Already running: wait for it to finish"), { status: 409 });
  const j = { running: true, done: 0, total: 0, note: "", error: null, startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(key, j);
  const progress = (done, total, note = "") => Object.assign(j, { done, total, note });
  return Promise.resolve().then(() => fn(progress))
    .catch((e) => { j.error = e.message; })
    .finally(() => { j.running = false; j.finishedAt = new Date().toISOString(); });
}

/** Removes cached answers older than `days` (called after research runs so the table can't grow without end). */
export function pruneCache(days = 30, now = Date.now()) {
  run("DELETE FROM research_cache WHERE fetched_at < ?", now - days * 864e5);
}
