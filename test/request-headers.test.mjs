// Own-site request headers and cookies (REQ-055 group 1, Oct 2026): validation, secret storage (names only in the
// settings and the API, values never in audit rows), headers only to the project's own hosts, and one full crawl over
// a fake site with a Cloudflare challenge, a 429 and a robots.txt-blocked folder. fetch, curl, the browser and
// sleeping are faked, so nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { cleanRequestHeaders, saveRequestHeaders, requestHeaderValues, headersFor, redact, maskHeaders, MAX_HEADERS } = await import("../src/request-headers.mjs");
const { createProject, updateProject, getProject, listProjects, getAudit } = await import("../src/api.mjs");
const { runAudit } = await import("../src/crawler.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");

const SECRET = "s3cret-token-123";
const status = (fn) => { try { fn(); } catch (e) { return [e.status, e.message]; } return null; };

test("cleanRequestHeaders validates names and values and never echoes a value", () => {
  assert.deepEqual(cleanRequestHeaders([{ name: " Authorization ", value: " Basic abc " }, { name: "", value: "" }, { name: "Cookie", value: "" }]),
    [{ name: "Authorization", value: "Basic abc" }, { name: "Cookie", value: null }]);
  assert.deepEqual(cleanRequestHeaders(undefined), []);
  for (const name of ["Host", "content-length", "Connection", "Transfer-Encoding", "Sec-Fetch-Mode", "Proxy-Authorization", "X-Forwarded-For", "Accept-Encoding"])
    assert.equal(status(() => cleanRequestHeaders([{ name, value: "x" }]))?.[0], 400, name);
  assert.match(status(() => cleanRequestHeaders([{ name: "User-Agent", value: "x" }]))[1], /User agent setting/);
  assert.match(status(() => cleanRequestHeaders([{ name: "Bad Name", value: "x" }]))[1], /valid header name/);
  assert.match(status(() => cleanRequestHeaders([{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }]))[1], /listed twice/);
  const bad = status(() => cleanRequestHeaders([{ name: "X-Token", value: `${SECRET}\r\nHost: evil` }]));
  assert.equal(bad[0], 400);
  assert.ok(!bad[1].includes(SECRET));
  const many = Array.from({ length: MAX_HEADERS + 1 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
  assert.match(status(() => cleanRequestHeaders(many))[1], /At most 10/);
  assert.equal(status(() => cleanRequestHeaders("Cookie: a=1"))?.[0], 400);
});

test("headersFor sends values only to the project's own hosts; redact hides them in messages", () => {
  const own = [{ name: "Cookie", value: "bypass=abcdef; region=au" }, { name: "X-Token", value: SECRET }];
  const inScope = (u) => new URL(u).hostname.replace(/^www\./, "") === "example.com";
  const forUrl = headersFor(own, inScope);
  assert.deepEqual(forUrl("https://www.example.com/a"), { Cookie: "bypass=abcdef; region=au", "X-Token": SECRET });
  assert.equal(forUrl("https://cdn.example.net/a.js"), null);
  assert.equal(headersFor([], inScope)("https://example.com/"), null);
  assert.equal(redact(`fetch failed: bad header ${SECRET} and cookie abcdef`, own), "fetch failed: bad header [hidden] and cookie [hidden]");
  assert.deepEqual(maskHeaders([{ name: "X-Token", value: SECRET }]), [{ name: "X-Token", set: true }]);
});

// ---------------- API: names only, values kept on an empty field ----------------
test("the API stores values outside the settings and returns names only", () => {
  const p = createProject({ start_url: "https://example.com/", settings: { requestHeaders: [{ name: "X-Bypass-Token", value: SECRET }], blockedFallback: "sideways", cwvPages: 0 } });
  assert.deepEqual(p.settings.requestHeaders, [{ name: "X-Bypass-Token", set: true }]);
  assert.equal(p.settings.blockedFallback, "browser"); // an unknown mode falls back to the default
  assert.ok(!JSON.stringify(p).includes(SECRET));
  assert.ok(!JSON.stringify(listProjects()).includes(SECRET));
  assert.ok(!get("SELECT settings FROM projects WHERE id=?", p.id).settings.includes(SECRET));
  assert.deepEqual(requestHeaderValues(p.id), [{ name: "X-Bypass-Token", value: SECRET }]);
  // An empty value keeps the saved one; a new name needs a value; invalid names are refused before anything is saved.
  updateProject(p.id, { settings: { requestHeaders: [{ name: "X-Bypass-Token", value: "" }, { name: "Cookie", value: "bypass=abcdef" }], blockedFallback: "curl" } });
  assert.deepEqual(requestHeaderValues(p.id), [{ name: "X-Bypass-Token", value: SECRET }, { name: "Cookie", value: "bypass=abcdef" }]);
  assert.equal(getProject(p.id).settings.blockedFallback, "curl");
  assert.equal(status(() => updateProject(p.id, { settings: { requestHeaders: [{ name: "X-New", value: "" }] } }))?.[0], 400);
  assert.equal(status(() => updateProject(p.id, { settings: { requestHeaders: [{ name: "Host", value: "x" }] } }))?.[0], 400);
  assert.equal(requestHeaderValues(p.id).length, 2);
  // Saving other settings leaves the headers alone; an empty list removes them.
  updateProject(p.id, { settings: { maxPages: 5 } });
  assert.equal(requestHeaderValues(p.id).length, 2);
  updateProject(p.id, { settings: { requestHeaders: [] } });
  assert.deepEqual(requestHeaderValues(p.id), []);
  assert.deepEqual(getProject(p.id).settings.requestHeaders, []);
  assert.equal(status(() => createProject({ start_url: "https://example.org/", settings: { requestHeaders: [{ name: "X-A", value: "" }] } }))?.[0], 400);
  assert.equal(saveRequestHeaders(p.id, []).length, 0);
});

// ---------------- One crawl over a fake site ----------------
const html = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title><meta name="viewport" content="width=device-width"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;

test("a crawl reads a walled page through curl, waits out a 429, obeys robots.txt and keeps the secret on the site", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { requestHeaders: [{ name: "X-Bypass-Token", value: SECRET }], cwvPages: 0, checkExternalLinks: false, concurrency: 4 } });
  const requests = [];
  let slowHits = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    requests.push({ url: u.href, headers: { ...(init.headers || {}) } });
    const H = { "content-type": "text/html" };
    if (u.hostname === "other.example.org") return new Response(html("Elsewhere", "<p>other site</p>"), { status: 200, headers: H });
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    if (u.protocol === "http:") return new Response(null, { status: 301, headers: { location: "https://example.com" + u.pathname } });
    switch (u.pathname) {
      case "/robots.txt": return new Response("User-agent: *\nDisallow: /private/\n", { status: 200, headers: { "content-type": "text/plain" } });
      case "/": return new Response(html("Home page of the example site", '<p>Welcome</p><a href="/walled">Walled</a> <a href="/slow">Slow</a> <a href="/private/x">Private</a> <a href="/out">Out</a>'), { status: 200, headers: H });
      case "/walled": return new Response(CHALLENGE, { status: 403, headers: { ...H, "cf-mitigated": "challenge", "cf-ray": "8a1-SYD", server: "cloudflare" } });
      case "/slow": return ++slowHits === 1 ? new Response("Too many", { status: 429, headers: { "retry-after": "2", "content-type": "text/plain" } }) : new Response(html("Slow page", "<p>ok</p>"), { status: 200, headers: H });
      case "/out": return new Response(null, { status: 302, headers: { location: "https://other.example.org/landing" } });
      default: return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const curlLog = [], browserLog = [], slept = [];
  const deps = {
    sleep: async (ms) => { slept.push(ms); },
    curl: async (u, o) => { curlLog.push([u, o.headers]); return { status: 200, headers: new Headers({ "content-type": "text/html", "x-robots-tag": "noindex" }), type: "text/html", body: html("Walled page", "<p>the real content</p>"), wallBody: "", location: null, ms: 700 }; },
    browser: async (u) => { browserLog.push(u); return { status: 0, headers: new Headers(), body: "" }; },
  };
  const project = get("SELECT * FROM projects WHERE id=?", p.id);
  const settings = projectSettings(project);
  const auditId = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(auditId, project, settings, () => {}, deps);

  const pages = new Map(all("SELECT * FROM pages WHERE audit_id=?", auditId).map((r) => [new URL(r.url).pathname, { ...r, data: JSON.parse(r.data) }]));
  const walled = pages.get("/walled");
  assert.equal(walled.status, 200);
  assert.equal(walled.title, "Walled page");
  assert.equal(walled.response_ms, null);
  assert.equal(walled.indexable, 0); // X-Robots-Tag from the fallback still counts
  assert.deepEqual([walled.data.fetchedVia, walled.data.directStatus, walled.data.fallbackMs], ["curl", 403, 700]);
  assert.deepEqual(walled.data.botWall, { vendor: "Cloudflare", kind: "challenge", status: 403 });
  assert.equal(pages.get("/slow").data.fetchedVia, "retry");
  assert.equal(pages.get("/slow").status, 200);
  assert.deepEqual(slept, [2000]);
  assert.equal(pages.get("/").data.fetchedVia, "fetch");
  assert.equal(pages.get("/private/x").data.blockedByRobots, true);
  assert.deepEqual(browserLog, []);
  assert.deepEqual(curlLog.map(([u, h]) => [u, h?.["X-Bypass-Token"]]), [["https://example.com/walled", SECRET]]);

  // Nothing fetched /private/, and the secret went to example.com only.
  assert.ok(!requests.some((r) => r.url.includes("/private/")));
  assert.ok(requests.some((r) => r.url === "https://example.com/" && r.headers["X-Bypass-Token"] === SECRET));
  assert.ok(requests.some((r) => r.url === "https://other.example.org/landing"));
  assert.ok(requests.filter((r) => !r.url.startsWith("https://example.com/")).every((r) => !JSON.stringify(r.headers).includes(SECRET)));

  const issues = all("SELECT check_id, url, detail FROM issues WHERE audit_id=?", auditId);
  const has = (id, u) => issues.find((i) => i.check_id === id && (!u || i.url === u));
  assert.match(has("bot_wall_blocked", "https://example.com/walled").detail, /Cloudflare challenge page \(HTTP 403\); the page loaded via curl/);
  assert.ok(has("fetched_via_fallback", "https://example.com/walled"));
  assert.match(has("crawl_rate_limited").detail, /HTTP 429 ×1/);
  assert.ok(!has("http_4xx", "https://example.com/walled"));

  // The secret is in no audit, page, issue or project row, and the API's audit view has names only.
  const dump = JSON.stringify([all("SELECT * FROM audits"), all("SELECT url, data FROM pages"), all("SELECT * FROM issues"), all("SELECT * FROM projects")]);
  assert.ok(!dump.includes(SECRET));
  const view = getAudit(auditId);
  assert.ok(!JSON.stringify(view).includes(SECRET));
  assert.deepEqual(view.audit.settings.requestHeaders, [{ name: "X-Bypass-Token", set: true }]);
  assert.equal(view.audit.site_info.fetchLadder.via.curl, 1);
});
