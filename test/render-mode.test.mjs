// JavaScript rendering like Google (REQ-055 group 2, Oct 2026): render mode "auto" (sample, decide, then all pages or
// the JavaScript-dependent ones), a phone viewport, media not downloaded, scrolling for lazy content, parallel renders
// in one browser. The browser and fetch are faked, so nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { renderModeOf, jsDependentReason, sampleNeedsJs, createRenderPlan, limiter } = await import("../src/render-mode.mjs");
const { renderPage, RENDER_VIEWPORT } = await import("../src/render-checks.mjs");
const { parseHtml, runAudit } = await import("../src/crawler.mjs");
const { createProject, updateProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");
const { GOOGLEBOT_SMARTPHONE_UA } = await import("../src/ua-parity.mjs");
const { schemaPageIssues } = await import("../src/schema.mjs");

const S = "https://example.com";
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const doc = (body, head = "") => `<!doctype html><html><head><title>T</title>${head}</head><body>${body}</body></html>`;
const parsed = (html, url = S + "/") => parseHtml(html, url);

test("render mode: true/false/\"auto\" are kept apart", () => {
  assert.deepEqual([true, "true", "auto", false, "false", undefined, 1].map(renderModeOf), [true, true, "auto", false, false, false, false]);
});

test("raw HTML that needs JavaScript: empty app roots, an enable-JavaScript notice on a short page, scripts and no text", () => {
  const cra = doc('<noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/static/js/main.js"></script>');
  assert.equal(jsDependentReason(cra, parsed(cra)), "empty app root (#root)");
  for (const id of ["app", "__next", "__nuxt", "___gatsby"]) assert.match(jsDependentReason(doc(`<div id="${id}"> <!-- app --> </div>`), { words: 0 }), new RegExp(id));
  assert.match(jsDependentReason(doc("<app-root></app-root>"), { words: 0 }), /app-root/);
  assert.match(jsDependentReason(doc("<noscript><p>Please enable JavaScript in your browser.</p></noscript><p>Loading</p>"), { words: 1 }), /noscript/);
  assert.match(jsDependentReason(doc('<p>Loading</p><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script>'), { words: 1 }), /3 script file/);
  assert.match(jsDependentReason(doc(`<script>${"x".repeat(25_000)}</script>`), { words: 0 }), /24 KB of inline script/);
  // Server-rendered pages are left alone: an SSR __next root with content, a long page with a noscript notice, JSON-LD.
  const ssr = doc(`<div id="__next"><h1>Hello</h1><p>${words(400)}</p></div><script src="/a.js"></script>`);
  assert.equal(jsDependentReason(ssr, parsed(ssr)), null);
  assert.equal(jsDependentReason(doc(`<noscript>Enable JavaScript for the map</noscript><p>${words(400)}</p>`), { words: 400 }), null);
  assert.equal(jsDependentReason(doc(`<p>Short page</p><script type="application/ld+json">${"{}".repeat(20_000)}</script>`), { words: 2 }), null);
});

test("a sampled page depends on JavaScript when rendering doubles its text or its internal links", () => {
  const raw = { words: 20, links: [] }, links = (n, host = "example.com") => Array.from({ length: n }, (_, i) => ({ to: `https://${host}/p${i}` }));
  assert.match(sampleNeedsJs(raw, { words: 300, links: [] }), /20 words in raw HTML, 300 rendered/);
  assert.equal(sampleNeedsJs({ words: 200, links: [] }, { words: 300, links: [] }), null);
  assert.match(sampleNeedsJs({ words: 300, links: links(2) }, { words: 300, links: links(8) }), /2 internal links in raw HTML, 8 rendered/);
  assert.equal(sampleNeedsJs({ words: 300, links: [] }, { words: 300, links: links(8, "other.org") }, (u) => u.includes("example.com")), null);
});

const fakeRender = (html) => async () => ({ html, url: S, docs: [S], requests: [], errors: [] });

test("auto: 5 sampled pages decide; most depend on JavaScript → every page is rendered; later pages wait for the decision", async () => {
  const plan = createRenderPlan({ mode: "auto", concurrency: 2 });
  const shell = doc('<div id="root"></div>'), full = doc(`<main><p>${words(300)}</p></main>`);
  const sample = (i, needs) => plan.render({ url: `${S}/s${i}`, home: i === 0, html: needs ? shell : full, raw: parsed(needs ? shell : full), parse: parseHtml, run: fakeRender(full) });
  const pending = [sample(0, true), sample(1, true), sample(2, true), sample(3, false), sample(4, false)];
  let lateDone = false;
  const late = plan.render({ url: S + "/late", html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) }).then((r) => { lateDone = true; return r; });
  await new Promise((r) => setImmediate(r));
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.reason), ["sample (home page)", "sample", "sample", "sample", "sample"]);
  const l = await late;
  assert.ok(lateDone && l.rendered);
  assert.equal(l.reason, "site depends on JavaScript", "a page after the sample waited for the decision");
  const after = await plan.render({ url: S + "/x", html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) });
  assert.equal(after.reason, "site depends on JavaScript");
  const sum = plan.summary();
  assert.deepEqual([sum.mode, sum.decision, sum.dependent], ["auto", "all", 3]);
});

test("auto: a site that doesn't depend on JavaScript renders only pages whose raw HTML is an app shell", async () => {
  const plan = createRenderPlan({ mode: "auto", sample: 3 });
  const full = doc(`<main><p>${words(300)}</p></main>`), shell = doc('<div id="app"></div>');
  for (let i = 0; i < 3; i++) await plan.render({ url: `${S}/s${i}`, html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) });
  let ran = 0;
  const plain = await plan.render({ url: S + "/plain", html: full, raw: parsed(full), parse: parseHtml, run: async () => { ran++; return null; } });
  assert.deepEqual([plain.rendered, plain.reason, ran], [null, null, 0]);
  const app = await plan.render({ url: S + "/app", html: shell, raw: parsed(shell), parse: parseHtml, run: fakeRender(full) });
  assert.equal(app.reason, "empty app root (#app)");
  assert.equal(plan.summary().decision, "selected");
  // A failed sample render doesn't count; a crawl with fewer pages than the sample decides at the end.
  const small = createRenderPlan({ mode: "auto" });
  await small.render({ url: S + "/", home: true, html: full, raw: parsed(full), parse: parseHtml, run: async () => null });
  small.finish();
  assert.deepEqual([small.summary().decision, small.summary().sampled, small.summary().samples[0].reason], ["selected", 0, "render failed"]);
});

test("render modes off/on, a browser that can't start, a decision kept from a resumed audit, and the render limit", async () => {
  const full = doc("<p>x</p>");
  const off = createRenderPlan({ mode: false });
  assert.deepEqual(await off.render({ url: S, html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) }), { rendered: null, reason: null });
  const on = createRenderPlan({ mode: true });
  assert.equal((await on.render({ url: S, html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) })).reason, "always");
  const broken = createRenderPlan({ mode: "auto" });
  broken.unavailable("No browser found for this feature.\nmore");
  assert.equal((await broken.render({ url: S, home: true, html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) })).rendered, null);
  assert.deepEqual([broken.summary().decision, broken.summary().error], ["unavailable", "No browser found for this feature."]);
  const resumed = createRenderPlan({ mode: "auto", decided: { mode: "auto", decision: "all", sampled: 5, dependent: 4, rendered: 7 } });
  assert.equal((await resumed.render({ url: S + "/z", html: full, raw: parsed(full), parse: parseHtml, run: fakeRender(full) })).reason, "site depends on JavaScript");
  assert.deepEqual([resumed.summary().rendered, resumed.summary().dependent], [8, 4]);
  const limit = limiter(2); let active = 0, peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => limit(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active--; })));
  assert.equal(peak, 2);
});

/** A fake Playwright browser: logs context options and routed requests, and renders `content(url)`. */
function fakeBrowser(content, log = { contexts: [], routed: [], scrolls: 0 }) {
  return {
    log,
    newContext: async (opts) => {
      log.contexts.push(opts);
      const handlers = {};
      let router = null, current = null;
      const page = {
        route: async (_, fn) => { router = fn; },
        on: (ev, fn) => { handlers[ev] = fn; },
        mainFrame: () => "main",
        goto: async (url, o) => {
          log.waitUntil = o.waitUntil;
          current = url;
          handlers.request?.({ isNavigationRequest: () => true, frame: () => "main", url: () => url, resourceType: () => "document" });
          if (router) for (const [u, type] of [[S + "/hero.jpg", "image"], [S + "/clip.mp4", "media"], [S + "/font.woff2", "font"], [S + "/app.js", "script"]]) {
            await router({ request: () => ({ url: () => u, resourceType: () => type }), abort: async () => log.routed.push(["abort", u]), continue: async () => log.routed.push(["continue", u]),
              fetch: async (o2 = {}) => { log.routed.push([o2.method || "GET", u]); return { status: () => (o2.method === "HEAD" ? 405 : 200) }; },
              fulfill: async (o2) => log.routed.push(["fulfill", u, o2.status]) });
          }
        },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn) => { if (!String(fn).includes("scrollBy")) throw new Error("not supported"); return [++log.scrolls >= 3, 3000]; },
        content: async () => content(current),
        url: () => current,
        close: async () => {},
      };
      return { newPage: async () => page, close: async () => { log.closed = (log.closed || 0) + 1; } };
    },
    close: async () => {},
  };
}

test("renderPage renders like Googlebot smartphone: 412 px phone viewport, no images or video, fonts by HEAD, scrolled to the bottom", async () => {
  const b = fakeBrowser(() => doc("<p>rendered</p>"));
  const r = await renderPage(b, S + "/a", GOOGLEBOT_SMARTPHONE_UA);
  assert.match(r.html, /rendered/);
  const ctx = b.log.contexts[0];
  assert.deepEqual([ctx.viewport, ctx.isMobile, ctx.hasTouch, ctx.userAgent], [RENDER_VIEWPORT, true, true, GOOGLEBOT_SMARTPHONE_UA]);
  assert.equal(RENDER_VIEWPORT.width, 412);
  assert.equal(b.log.waitUntil, "domcontentloaded");
  assert.deepEqual(b.log.routed, [["abort", S + "/hero.jpg"], ["abort", S + "/clip.mp4"], ["HEAD", S + "/font.woff2"], ["GET", S + "/font.woff2"], ["fulfill", S + "/font.woff2", 200], ["continue", S + "/app.js"]]);
  assert.equal(b.log.scrolls, 3, "scrolls until the bottom is reached");
  assert.equal(b.log.closed, 1, "one context per page: nothing carries over");
  assert.deepEqual(r.docs, [S + "/a"]);
});

test("settings: renderJs keeps auto, renderConcurrency 1-8, rendering user agent audit or googlebot", () => {
  const p = createProject({ start_url: "https://example.com/" });
  const s = (body) => projectSettings(get("SELECT * FROM projects WHERE id=?", updateProject(p.id, { settings: body }).id));
  assert.equal(s({ renderJs: "auto" }).renderJs, "auto");
  assert.equal(s({ renderJs: "true" }).renderJs, true);
  assert.equal(s({ renderJs: "nonsense" }).renderJs, false);
  assert.equal(s({ renderConcurrency: 99 }).renderConcurrency, 8);
  assert.equal(s({ renderUserAgent: "evil" }).renderUserAgent, "audit");
  assert.equal(s({ renderUserAgent: "googlebot" }).renderUserAgent, "googlebot");
  // The price hint asks for rendering only where the page wasn't rendered.
  const d = { schemaHidden: ["price 10"], schemaHiddenPrice: true };
  assert.match(schemaPageIssues(d, { renderJs: "auto" })[0][1], /enable rendering/);
  assert.doesNotMatch(schemaPageIssues({ ...d, rendered: true }, { renderJs: "auto" })[0][1], /enable rendering/);
});

test("an auto-render audit of a JavaScript site renders the sample, then every page, with the crawl's user agent", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, renderJs: "auto", concurrency: 2 } });
  const realFetch = globalThis.fetch;
  const shell = (path) => doc(`<div id="root"></div><script src="/app.js"></script>`).replace("<title>T</title>", `<title>Page ${path}</title>`);
  const app = (path) => doc(`<main><h1>Page ${path}</h1><p>${words(120)} ${path}</p>${Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">Link ${i}</a>`).join(" ")}</main>`).replace("<title>T</title>", `<title>Page ${path}</title>`);
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (/^\/(p\d)?$/.test(u.pathname)) return new Response(shell(u.pathname), { headers: { "content-type": "text/html" } });
    return new Response("nf", { status: 404, headers: { "content-type": "text/plain" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const log = { contexts: [], routed: [], scrolls: 0 };
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const auditId = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(auditId, project, settings, () => {}, { launchBrowser: async () => fakeBrowser((url) => app(new URL(url).pathname), log), sleep: async () => {} });
  const pages = all("SELECT url, words, data FROM pages WHERE audit_id=?", auditId).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  assert.equal(pages.length, 9);
  assert.ok(pages.every((x) => x.data.rendered && x.words > 100), "every page rendered");
  assert.equal(pages.filter((x) => /^sample/.test(x.data.renderReason)).length, 5);
  assert.equal(pages.filter((x) => x.data.renderReason === "site depends on JavaScript").length, 4);
  const info = JSON.parse(get("SELECT site_info FROM audits WHERE id=?", auditId).site_info);
  assert.deepEqual([info.renderJs, info.render.decision, info.render.sampled, info.render.dependent, info.render.rendered], ["auto", "all", 5, 5, 9]);
  assert.ok(log.contexts.filter((c) => c.viewport?.width === 412).every((c) => c.userAgent === settings.userAgent));
});
