// End-to-end (REQ-055 group 9): a full runAudit against a real local website (fixture-site.mjs on 127.0.0.1, random
// port), asserting the issues each part of the fixture must raise. Requests to any other host fail inside the test
// (and are listed), so nothing reaches the internet; curl and the fallback browser are stubbed. The JavaScript-render
// part runs only when a Chromium-family browser can start, and is skipped otherwise (CI). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFixture } from "./fixture-site.mjs";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { runAudit } = await import("../src/crawler.mjs");
const { createProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");

/** fetch limited to 127.0.0.1: anything else fails like an unknown host and is recorded. */
function localOnly(t) {
  const real = globalThis.fetch, outside = [];
  globalThis.fetch = async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    if (u.hostname !== "127.0.0.1") { outside.push(u.href); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }
    return real(input, init);
  };
  t.after(() => { globalThis.fetch = real; });
  return outside;
}

async function audit(origin, settings) {
  const p = createProject({ start_url: origin + "/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 2, maxConcurrency: 2, ...settings } });
  const project = get("SELECT * FROM projects WHERE id=?", p.id), s = projectSettings(project);
  const id = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(s)).lastInsertRowid);
  const deps = { sleep: async () => {}, curl: async () => { throw new Error("curl not used in tests"); }, browser: async () => { throw new Error("no fallback browser in tests"); } };
  await runAudit(id, project, s, () => {}, deps);
  const issues = all("SELECT check_id, url, detail FROM issues WHERE audit_id=?", id);
  const has = (check, pathname) => issues.some((i) => i.check_id === check && (pathname === undefined || new URL(i.url).pathname === pathname));
  return { id, a: get("SELECT * FROM audits WHERE id=?", id), pages: all("SELECT url, status, indexable, in_sitemap, words, data FROM pages WHERE audit_id=?", id), issues, has };
}

test("a full audit of the local fixture site finds what each part is there to show", async (t) => {
  const outside = localOnly(t);
  const site = await startFixture();
  t.after(site.close);
  const r = await audit(site.origin, { renderJs: false });

  assert.equal(r.a.status, "done", r.a.message || "");
  assert.ok(r.a.health >= 0 && r.a.health <= 100 && r.a.ai_readiness !== null);
  assert.equal(JSON.parse(r.a.site_info).skipped, undefined, "every check group ran");
  const byPath = new Map(r.pages.map((p) => [new URL(p.url).pathname, p]));
  for (const p of ["/", "/about", "/contact", "/copy", "/private", "/app", "/missing", "/old-page", "/temp", "/gone"]) assert.ok(byPath.has(p), `crawled ${p}`);
  // robots.txt: the blocked folder is never fetched, and the sitemap it declares is read.
  assert.ok(!site.requests.some((q) => q.path.startsWith("/blocked/")), "robots.txt Disallow obeyed");
  assert.ok(r.has("blocked_by_robots", "/blocked/secret"));
  assert.ok(site.requests.some((q) => q.path === "/sitemap.xml"));
  assert.ok(!r.has("no_robots_txt") && !r.has("no_sitemap") && !r.has("sitemap_not_in_robots"));
  assert.equal(byPath.get("/about").in_sitemap, 1);
  // Redirects: 301 and 302 reported, and the links that point at them.
  assert.ok(r.has("permanent_redirect", "/old-page"));
  assert.ok(r.has("temporary_redirect", "/temp"));
  assert.ok(r.issues.some((i) => i.check_id === "links_to_redirect" && /\/old-page/.test(i.detail)));
  // Broken link: the 404 page and the page linking to it.
  assert.ok(r.has("http_4xx", "/missing"));
  assert.ok(r.issues.some((i) => i.check_id === "broken_internal_link" && new URL(i.url).pathname === "/" && /\/missing/.test(i.detail)));
  // Sitemap: a dead URL and a noindex page listed in it.
  assert.ok(r.has("sitemap_bad_url", "/gone"));
  assert.ok(r.has("noindex_in_sitemap", "/private"));
  // noindex and canonical.
  assert.ok(r.has("noindex_page", "/private"));
  assert.equal(byPath.get("/private").indexable, 0);
  assert.ok(r.has("canonical_elsewhere", "/copy"));
  // The JavaScript page has no text in its raw HTML.
  assert.ok(byPath.get("/app").words < 20);
  assert.ok(r.issues.some((i) => new URL(i.url).pathname === "/app" && ["low_word_count", "ai_js_dependent", "ai_thin"].includes(i.check_id)));
  // Every request went to the fixture.
  assert.ok(site.requests.length > 10);
  assert.deepEqual(outside, [], "no request outside the fixture");
});

test("with a browser, the JavaScript page is rendered and its text counted (skipped without Chrome)", async (t) => {
  let probe;
  try { const { launchChromium } = await import("../src/browser.mjs"); probe = await launchChromium(); }
  catch { return t.skip("no Chromium-family browser on this computer"); }
  await probe.close();
  localOnly(t);
  const site = await startFixture();
  t.after(site.close);
  const r = await audit(site.origin, { renderJs: true });
  assert.equal(r.a.status, "done", r.a.message || "");
  const app = r.pages.find((p) => new URL(p.url).pathname === "/app");
  assert.ok(JSON.parse(app.data).rendered, "rendered");
  assert.ok(app.words > 200, `rendered words counted (${app.words})`);
});
