// Pages reachable only through JavaScript navigation (REQ-055 group 2, Oct 2026): route paths read from the site's own
// scripts (never run), filtered, checked once each with robots.txt obeyed, and reported as js_only_routes without being
// crawled as links. fetch is faked, so nothing touches the network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { extractRoutes, routeCandidate, jsOnlyRouteIssues, inlineScripts, MAX_VERIFY } = await import("../src/js-routes.mjs");
const { parseHtml, runAudit } = await import("../src/crawler.mjs");
const { textFingerprint } = await import("../src/google-signals.mjs");
const { CHECKS, CRAWL } = await import("../src/checks.mjs");
const { createProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");

const S = "https://example.com";
const BUNDLE = `const routes=[{path:"/pricing",element:x},{path:'/about/team',component:y},{path:"/user/:id"},{path:"*"},{path:"/blog/[slug]"}];
e.createElement("a",{href:"/contact"},"Contact");o.jsx(Link,{to:"/careers"});navigate("/checkout?step=1");router.push('/press');history.replace(\`/legal\`);
fetch("/api/items");const s={path:"/"};const c={path:"/static/app.js"};cookie({path:"/"});x={href:"//cdn.example.org/a"};y={to:"/_next/data"};`;
const page = (title, body = "<p>Some real content here for the page.</p>", head = "") => `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;

test("route paths are read from router configs, link props and navigation calls; parameters, files and APIs are left out", () => {
  const r = extractRoutes(BUNDLE);
  assert.deepEqual([...r.keys()].sort(), ["/about/team", "/careers", "/checkout", "/contact", "/legal", "/press", "/pricing"]);
  assert.equal(r.get("/pricing"), 'path: "/pricing"');
  assert.equal(r.get("/checkout"), 'navigate("/checkout?step=1")');
  for (const bad of ["/", "/user/:id", "/blog/[slug]", "/api/items", "/static/app.js", "//cdn.example.org/a", "/a b", "/x.png", "/_next/data", "/wp-admin/x"]) assert.equal(routeCandidate(bad), false, bad);
  for (const ok of ["/pricing", "/about/team/", "/old-page.html", "/caf%C3%A9"]) assert.equal(routeCandidate(ok), true, ok);
  assert.deepEqual(inlineScripts('<script>router.push("/inline")</script><script type="application/ld+json">{"path":"/no"}</script><script src="/a.js"></script>').map((x) => x.text), ['router.push("/inline")']);
});

/** Fake site: /app.js holds the routes; pages answer as given (status, html, finalUrl). */
function fakes(pages, log) {
  const fetchFn = async (u) => { log.push(String(u)); return String(u).endsWith("/app.js") ? new Response(BUNDLE, { headers: { "content-type": "application/javascript" } }) : new Response("nf", { status: 404 }); };
  const fetchPage = async (u) => { log.push(u); const x = pages[new URL(u).pathname]; return x ? { type: "text/html", finalUrl: u, ...x } : { status: 404, type: "text/plain", body: "", finalUrl: u }; };
  return { fetchFn, fetchPage };
}

test("candidates are checked once each: real unlinked pages are reported; missing, redirected, shells, noindex and disallowed ones aren't", async () => {
  const shell = page("App");
  const log = [], { fetchFn, fetchPage } = fakes({
    "/pricing": { status: 200, body: page("Pricing plans") },
    "/about/team": { status: 200, body: page("Team"), finalUrl: S + "/team" }, // redirects to a page the crawl knows
    "/careers": { status: 200, body: shell }, // the same shell the not-found probe got
    "/press": { status: 200, body: page("Press", "<p>x</p>", '<meta name="robots" content="noindex">') },
    "/checkout": { status: 200, body: page("Checkout") },
  }, log);
  const out = await jsOnlyRouteIssues({ origin: S, scripts: [S + "/app.js", S + "/private/b.js"], known: new Set([S + "/team", S + "/contact/"]), ua: "UA",
    blocked: (u) => u.includes("/private/") || u.endsWith("/checkout"), fetchFn, fetchPage, parse: parseHtml, fingerprint: textFingerprint,
    notFound: textFingerprint(parseHtml(shell, S + "/x").text) });
  assert.deepEqual(out.issues, [["js_only_routes", S + "/pricing", `found in ${S}/app.js as path: "/pricing"; HTTP 200, "Pricing plans"; no <a href> to it in the crawled pages' HTML (rendering was off: a link added by JavaScript wouldn't show)`]]);
  assert.ok(!log.some((u) => u.includes("/private/") || u.endsWith("/checkout")), "robots.txt-disallowed scripts and pages are never fetched");
  assert.ok(!log.some((u) => u.endsWith("/contact")), "a linked page (trailing slash aside) isn't checked");
  assert.deepEqual([out.stats.scripts, out.stats.catchAll, out.stats.blocked, out.stats.found], [1, 1, 2, 1]);
  assert.deepEqual([CHECKS.js_only_routes[0], CRAWL.has("js_only_routes")], ["notice", true]);
});

test("at most 20 candidates are checked", async () => {
  const js = Array.from({ length: 40 }, (_, i) => `{path:"/r${String(i).padStart(2, "0")}"}`).join(",");
  let checked = 0;
  const out = await jsOnlyRouteIssues({ origin: S, inline: [{ label: "inline", text: js }], ua: "UA", parse: parseHtml, fingerprint: textFingerprint,
    fetchPage: async (u) => { checked++; return { status: 404, type: "text/plain", body: "", finalUrl: u }; } });
  assert.equal(checked, MAX_VERIFY);
  assert.equal(out.stats.candidates, 40);
});

test("an audit reports a page only its JavaScript reaches, without crawling it, and obeys robots.txt", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0 } });
  const log = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    log.push(u.pathname);
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /secret\n", { headers: { "content-type": "text/plain" } });
    if (u.pathname === "/") return new Response(page("Home page of the example site", '<a href="/contact">Contact</a><script src="/app.js"></script>'), { headers: { "content-type": "text/html" } });
    if (u.pathname === "/app.js") return new Response('r=[{path:"/pricing"},{path:"/contact"},{path:"/secret"}]', { headers: { "content-type": "text/javascript" } });
    if (u.pathname === "/pricing" || u.pathname === "/contact") return new Response(page(`Page ${u.pathname}`), { headers: { "content-type": "text/html" } });
    return new Response("nf", { status: 404, headers: { "content-type": "text/plain" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const auditId = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(auditId, project, settings, () => {}, { sleep: async () => {} });
  const issues = all("SELECT url, detail FROM issues WHERE audit_id=? AND check_id='js_only_routes'", auditId);
  assert.deepEqual(issues.map((i) => i.url), [S + "/pricing"]);
  assert.match(issues[0].detail, /app\.js as path: "\/pricing"/);
  assert.ok(!get("SELECT 1 x FROM pages WHERE audit_id=? AND url=?", auditId, S + "/pricing"), "not crawled as a page");
  assert.ok(!log.includes("/secret"));
  assert.equal(JSON.parse(get("SELECT site_info FROM audits WHERE id=?", auditId).site_info).jsRoutes.found, 1);
});
