// Incremental re-crawls and resuming audits (REQ-055 group 2, Oct 2026): ETag / Last-Modified sent back, 304 pages
// copied with their links and still checked, reuse only from the same code and settings; a stopped audit resumes
// without fetching its stored pages again and ends with the same findings as a fresh audit. fetch is faked, so
// nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { runAudit, stopAudit } = await import("../src/crawler.mjs");
const { createProject, updateProject } = await import("../src/api.mjs");
const { resumeAudit } = await import("../src/runner.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");
const { conditionalHeaders, reuseSource, CODE_HASH } = await import("../src/recrawl.mjs");

const text = (seed) => Array.from({ length: 80 }, (_, i) => `${seed}${i % 9} sentence part ${i}`).join(" ");
const page = (title, body, desc = "A description of this page that is long enough for the length check to pass, mostly.") =>
  `<!doctype html><html lang="en"><head><title>${title}</title>${desc ? `<meta name="description" content="${desc}">` : ""}<meta name="viewport" content="width=device-width"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** A small site: paths → { etag, html }. Answers 304 to a matching If-None-Match and logs every request. */
function site(pages, log) {
  return async (input, init = {}) => {
    const u = new URL(String(input)), h = init.headers || {};
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    log.push({ path: u.pathname, inm: h["If-None-Match"] || null, ims: h["If-Modified-Since"] || null, method: init.method || "GET" });
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    const pg = pages[u.pathname];
    if (!pg) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (pg.hook) pg.hook();
    if (h["If-None-Match"] && h["If-None-Match"] === pg.etag) return new Response(null, { status: 304, headers: { etag: pg.etag } });
    return new Response(pg.html, { headers: { "content-type": "text/html; charset=utf-8", etag: pg.etag, "last-modified": "Tue, 27 Oct 2026 10:00:00 GMT" } });
  };
}
const newAudit = (projectId) => {
  const project = get("SELECT * FROM projects WHERE id=?", projectId), settings = projectSettings(project);
  return { project, settings, id: Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", projectId, JSON.stringify(settings)).lastInsertRowid) };
};
const pagesOf = (id) => new Map(all("SELECT * FROM pages WHERE audit_id=?", id).map((r) => [new URL(r.url).pathname, { ...r, data: JSON.parse(r.data) }]));
const issueKeys = (id) => all("SELECT check_id, url, detail FROM issues WHERE audit_id=? ORDER BY check_id, url, detail", id).map((i) => `${i.check_id} ${i.url} ${i.detail}`);

test("conditional headers and the reuse source: same code and settings only", () => {
  assert.deepEqual(conditionalHeaders({ etag: '"v1"', lastModified: "Tue, 27 Oct 2026 10:00:00 GMT" }), { "If-None-Match": '"v1"', "If-Modified-Since": "Tue, 27 Oct 2026 10:00:00 GMT" });
  assert.equal(conditionalHeaders(null), null);
  const p = createProject({ start_url: "https://example.com/" });
  const s = projectSettings(get("SELECT * FROM projects WHERE id=?", p.id));
  assert.match(reuseSource(p.id, 999, s).reason, /no earlier finished audit/);
  const done = Number(run("INSERT INTO audits (project_id, status, settings, site_info) VALUES (?, 'done', ?, ?)", p.id, JSON.stringify(s), JSON.stringify({ codeHash: "old" })).lastInsertRowid);
  assert.match(reuseSource(p.id, done + 1, s).reason, /the tool changed/);
  run("UPDATE audits SET site_info=? WHERE id=?", JSON.stringify({ codeHash: CODE_HASH }), done);
  assert.deepEqual(reuseSource(p.id, done + 1, s), { auditId: done });
  assert.match(reuseSource(p.id, done + 1, { ...s, renderJs: true }).reason, /settings changed .*renderJs/);
  assert.match(reuseSource(p.id, done + 1, { ...s, requestHeaders: [{ name: "Cookie", set: true }] }).reason, /requestHeaders/);
});

test("incremental: unchanged pages (304) are copied with their links and still take part in every check", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 2, incremental: true } });
  const pages = {
    "/": { etag: '"h1"', html: page("Home page of the example site", `<p>${text("home")}</p><a href="/a">A</a> <a href="/b">B</a> <a href="/c">C</a>`) },
    "/a": { etag: '"a1"', html: page("Page A of the example site", `<p>${text("same")}</p><img src="/a.png">`, "") },
    "/b": { etag: '"b1"', html: page("Page B of the example site", `<p>${text("bee")}</p>`) },
    "/c": { etag: '"c1"', html: page("Page C of the example site", `<p>${text("same")}</p><a href="/d">D</a>`) },
    "/d": { etag: '"d1"', html: page("Page D of the example site", `<p>${text("dee")}</p>`) },
  };
  const log = [], realFetch = globalThis.fetch;
  globalThis.fetch = site(pages, log);
  t.after(() => { globalThis.fetch = realFetch; });
  const a1 = newAudit(p.id);
  await runAudit(a1.id, a1.project, a1.settings, () => {}, { sleep: async () => {} });
  const first = pagesOf(a1.id);
  assert.deepEqual([first.get("/a").data.etag, first.get("/a").data.lastModified], ['"a1"', "Tue, 27 Oct 2026 10:00:00 GMT"]);
  assert.ok(!log.some((r) => r.inm), "nothing to send back on the first audit");

  pages["/b"] = { etag: '"b2"', html: page("Page B changed", `<p>${text("new")}</p>`) };
  log.length = 0;
  const a2 = newAudit(p.id);
  await runAudit(a2.id, a2.project, a2.settings, () => {}, { sleep: async () => {} });
  const second = pagesOf(a2.id);
  const sent = (pathname) => log.find((r) => r.path === pathname && r.method === "GET");
  assert.equal(sent("/").inm, null, "the start page is always fetched in full");
  assert.deepEqual([sent("/a").inm, sent("/a").ims], ['"a1"', "Tue, 27 Oct 2026 10:00:00 GMT"]);
  assert.deepEqual([second.get("/a").data.reused304, second.get("/c").data.reused304, second.get("/d").data.reused304], [{ audit: a1.id }, { audit: a1.id }, { audit: a1.id }]);
  assert.equal(second.get("/b").data.reused304, undefined);
  assert.equal(second.get("/b").title, "Page B changed");
  for (const k of ["/a", "/c", "/d"]) {
    const [x, y] = [first.get(k), second.get(k)];
    assert.deepEqual([y.status, y.title, y.words, y.bytes, y.indexable, y.outlinks, y.content_type], [x.status, x.title, x.words, x.bytes, x.indexable, x.outlinks, x.content_type], k);
  }
  assert.ok(second.has("/d"), "a page linked only from a reused page is still crawled");
  // Links copied once, images still checked, and the checks see reused pages like fetched ones.
  const links = (id, from) => all("SELECT to_url, kind FROM links WHERE audit_id=? AND from_url=? ORDER BY to_url", id, "https://example.com" + from);
  assert.deepEqual(links(a2.id, "/c"), links(a1.id, "/c"));
  assert.deepEqual(links(a2.id, "/a"), links(a1.id, "/a"));
  assert.equal(second.get("/d").inlinks, 1);
  const issues = issueKeys(a2.id);
  assert.ok(issues.some((i) => i.startsWith("missing_description https://example.com/a")));
  const ofPage = (i) => i.split(" ")[1];
  const unchanged = (id) => issueKeys(id).filter((i) => ["/a", "/c", "/d"].some((x) => ofPage(i) === "https://example.com" + x));
  assert.deepEqual(unchanged(a2.id), unchanged(a1.id), "reused pages get the same findings as when they were fetched");
  assert.ok(issues.some((i) => i.startsWith("near_duplicate https://example.com/c")), "near-duplicates found across reused pages");
  assert.ok(issues.some((i) => i.startsWith("broken_internal_image https://example.com/a")), "a reused page's image is still checked");
  const info = JSON.parse(get("SELECT site_info FROM audits WHERE id=?", a2.id).site_info);
  assert.deepEqual([info.incremental.from, info.incremental.reused], [a1.id, 3]);

  // Another user agent: nothing is reused, and the reason is recorded.
  updateProject(p.id, { settings: { userAgent: "Mozilla/5.0 (compatible; Other/1.0)" } });
  log.length = 0;
  const a3 = newAudit(p.id);
  await runAudit(a3.id, a3.project, a3.settings, () => {}, { sleep: async () => {} });
  assert.ok(!log.some((r) => r.inm));
  assert.match(JSON.parse(get("SELECT site_info FROM audits WHERE id=?", a3.id).site_info).incremental.reason, /settings changed .*userAgent/);
});

test("resume: a stopped audit continues without fetching stored pages again and ends like a fresh audit", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 1, maxConcurrency: 1 } });
  let stopId = null;
  const pages = { "/": { etag: '"h"', html: page("Home page of the example site", `<p>${text("home")}</p>${[1, 2, 3, 4, 5, 6].map((i) => `<a href="/p${i}">P${i}</a>`).join(" ")}`) } };
  for (let i = 1; i <= 6; i++) pages[`/p${i}`] = { etag: `"p${i}"`, html: page(`Page ${i} of the example site`, `<p>${text(i === 6 ? "p1" : `p${i}`)}</p><a href="/q${i}">Q${i}</a><img src="/img${i}.png">`, i === 2 ? "" : undefined) };
  for (let i = 1; i <= 6; i++) pages[`/q${i}`] = { etag: `"q${i}"`, html: page(`Deeper page ${i} of the example site`, `<p>${text(`q${i}`)}</p>`) };
  pages["/p6"].html = pages["/p1"].html; // an exact duplicate of a page the first run stored (so /q6 isn't linked)
  delete pages["/q6"];
  pages["/p3"].hook = () => { if (stopId) stopAudit(stopId); };
  const log = [], realFetch = globalThis.fetch;
  globalThis.fetch = site(pages, log);
  t.after(() => { globalThis.fetch = realFetch; });

  const a = newAudit(p.id);
  stopId = a.id;
  await runAudit(a.id, a.project, a.settings, () => {}, { sleep: async () => {} });
  stopId = null;
  assert.equal(get("SELECT status FROM audits WHERE id=?", a.id).status, "stopped");
  const firstRun = [...pagesOf(a.id).keys()];
  assert.ok(firstRun.length >= 3 && firstRun.length < 12, `stopped part-way (${firstRun.length} pages)`);
  assert.throws(() => resumeAudit(a.id + 100), /not found/);

  log.length = 0;
  await runAudit(a.id, a.project, a.settings, () => {}, { sleep: async () => {}, resume: true });
  const fetchedAgain = log.filter((r) => r.method === "GET" && firstRun.includes(r.path) && r.path !== "/");
  assert.deepEqual(fetchedAgain, [], "stored pages aren't fetched again");
  const resumed = pagesOf(a.id);
  assert.equal(resumed.size, 12);
  assert.equal(get("SELECT status FROM audits WHERE id=?", a.id).status, "done");

  // The same site audited from scratch gives the same pages and findings.
  const fresh = newAudit(p.id);
  await runAudit(fresh.id, fresh.project, fresh.settings, () => {}, { sleep: async () => {} });
  const full = pagesOf(fresh.id);
  for (const [k, x] of full) {
    const y = resumed.get(k);
    assert.deepEqual([y.status, y.depth, y.inlinks, y.outlinks, y.words, y.indexable], [x.status, x.depth, x.inlinks, x.outlinks, x.words, x.indexable], k);
  }
  assert.deepEqual(issueKeys(a.id), issueKeys(fresh.id));
  assert.equal(get("SELECT COUNT(*) n FROM links WHERE audit_id=?", a.id).n, get("SELECT COUNT(*) n FROM links WHERE audit_id=?", fresh.id).n, "no link stored twice");
  assert.ok(issueKeys(a.id).some((i) => i.startsWith("dup_content https://example.com/p6 same text as https://example.com/p1")), "a duplicate of a page stored by the first run is found");
  assert.throws(() => resumeAudit(a.id), /newest audit|stopped or interrupted/);
});
