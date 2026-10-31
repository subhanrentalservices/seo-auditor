// Main-content Markdown and the content exports (REQ-055 group 3, Nov 2026): the converter keeps headings, lists,
// tables, links and image alt text and drops the template; an audit stores indexable pages only, size-capped; the
// Markdown and JSONL downloads stream from the local server and carry no secrets. fetch is faked (example.com only);
// the test server listens on port 4574. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
process.env.SEO_AUDITOR_PORT = "4574"; // never the app's own 4560
const { htmlToMarkdown, capMarkdown, demoteHeadings } = await import("../src/markdown.mjs");
const { createContentStore, markdownExport, jsonlExport, jsonldText, MAX_JSONLD } = await import("../src/page-content.mjs");
const { runAudit } = await import("../src/crawler.mjs");
const { createProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");
const server = await import("../src/server.mjs");

const md = (html, url = "https://example.com/a/") => htmlToMarkdown(html, url).markdown;

test("markdown: headings, paragraphs, inline formatting, absolute links and image alt text", () => {
  const out = md(`<main><h1>Brake repairs in <em>Dandenong</em></h1><p>We fix <strong>brakes</strong>. See <a href="../prices?x=1">our prices</a>,
    <a href="tel:0390000000">call</a> or <a href="#faq">jump</a>.<br>Next line.</p><p><img src="/car.jpg" alt="Red car on a hoist"><img src="/s.gif" alt=""></p>
    <h3>Small heading</h3><p>5 * 3 = [15] and a snake_case_name</p><p># not a heading</p></main>`);
  assert.match(out, /^# Brake repairs in \*Dandenong\*$/m);
  assert.match(out, /We fix \*\*brakes\*\*\. See \[our prices\]\(https:\/\/example\.com\/prices\?x=1\), \[call\]\(tel:0390000000\) or jump\.\nNext line\./);
  assert.match(out, /!\[Red car on a hoist\]\(https:\/\/example\.com\/car\.jpg\)/);
  assert.ok(!out.includes("s.gif"), "decorative images (empty alt) are left out");
  assert.match(out, /^### Small heading$/m);
  assert.match(out, /5 \\\* 3 = \\\[15\\\] and a snake_case_name/);
  assert.match(out, /^\\# not a heading$/m);
});

test("markdown: nested and ordered lists, tables, code, quotes and definition lists", () => {
  const out = md(`<main><ul><li>One <a href="/one">link</a></li><li>Two<ul><li>Two point one</li></ul></li></ul><ol start="3"><li><p>Third</p></li><li>Fourth</li></ol>
    <table><thead><tr><th>Service</th><th>Time</th></tr></thead><tbody><tr><td>Brakes | pads</td><td>1 h</td></tr><tr><td>Tyres</td></tr></tbody></table>
    <pre><code>const a = 1;\n  indented();</code></pre><blockquote><p>Great service</p><p>Sam</p></blockquote><dl><dt>ABN</dt><dd>61 650</dd></dl></main>`);
  assert.match(out, /^- One \[link\]\(https:\/\/example\.com\/one\)\n- Two\n  - Two point one$/m);
  assert.match(out, /^3\. Third\n4\. Fourth$/m);
  assert.match(out, /^\| Service \| Time \|\n\| --- \| --- \|\n\| Brakes \\\| pads \| 1 h \|\n\| Tyres \|  \|$/m);
  assert.match(out, /^```\nconst a = 1;\n {2}indented\(\);\n```$/m);
  assert.match(out, /^> Great service\n>\n> Sam$/m);
  assert.match(out, /^\*\*ABN\*\*\n\n61 650$/m);
});

test("markdown: the template, hidden parts, forms and cookie banners are dropped", () => {
  const page = `<html><body><header><nav><a href="/">Home</a> <a href="/about">About us</a></nav></header>
    <div id="cookie-notice">We use cookies. <button>Accept all</button></div><div class="cc-consent-banner">Manage consent</div>
    <a href="#c" class="skip">Skip to content</a><div id="c"><h1>Title</h1><p>Body text stays.</p>
    <div style="display: none">Hidden text</div><p hidden>Also hidden</p><aside>Related posts</aside>
    <form><label>Your name <input name="n"></label><button>Send</button></form>
    <article><header><h2>Article header stays</h2></header><p>Article body.</p><footer>Article footer stays</footer></article></div>
    <footer>Copyright 2026</footer><script>var secret = 1</script></body></html>`;
  const out = md(page);
  for (const gone of ["Home", "About us", "cookies", "Accept", "consent", "Skip to", "Hidden text", "Also hidden", "Related posts", "Send", "Copyright", "secret"])
    assert.ok(!out.includes(gone), `${gone} is dropped`);
  for (const kept of ["# Title", "Body text stays.", "Your name", "## Article header stays", "Article body.", "Article footer stays"]) assert.ok(out.includes(kept), `${kept} is kept`);
  // With a <main>, everything outside it is template.
  assert.equal(md("<body><div>Promo bar</div><main><p>Only this.</p></main><div>Sidebar</div></body>"), "Only this.");
});

test("size caps: Markdown cut at a line and marked; JSON-LD over the cap not stored; headings demoted outside code", () => {
  const long = Array.from({ length: 200 }, (_, i) => `Line ${i} with some words`).join("\n");
  const c = capMarkdown(long, 1000);
  assert.ok(c.truncated && c.markdown.length <= 1000 && /\[… cut: page over the size limit\]$/.test(c.markdown));
  assert.deepEqual(capMarkdown("short", 1000), { markdown: "short", truncated: false });
  assert.equal(jsonldText([{ "@type": "Thing", name: "x".repeat(MAX_JSONLD) }]).text, null);
  assert.equal(jsonldText([{ "@type": "Thing" }]).text, '[{"@type":"Thing"}]');
  assert.equal(demoteHeadings("# A\n```\n# code\n```\n###### F", 2), "### A\n```\n# code\n```\n###### F");
});

test("the store caps an audit's total, redacts secrets and copies reused pages", () => {
  const pid = Number(run("INSERT INTO projects (name, start_url) VALUES ('cap', 'https://example.com/')").lastInsertRowid);
  const a = Number(run("INSERT INTO audits (project_id) VALUES (?)", pid).lastInsertRowid), b = Number(run("INSERT INTO audits (project_id) VALUES (?)", pid).lastInsertRowid);
  const s = createContentStore({ auditId: a, redact: (x) => x.split("tok-123456").join("[hidden]"), maxTotal: 60 });
  assert.equal(s.save("https://example.com/1", { markdown: "Token tok-123456 here", jsonld: [{ "@type": "Thing", name: "tok-123456" }] }), true);
  assert.equal(s.save("https://example.com/2", { markdown: "x".repeat(50) }), false, "over the audit total");
  const row = get("SELECT markdown, jsonld FROM page_content WHERE audit_id=? AND url=?", a, "https://example.com/1");
  assert.equal(row.markdown, "Token [hidden] here");
  assert.ok(!row.jsonld.includes("tok-123456"));
  assert.deepEqual(s.summary(), { pages: 1, chars: row.markdown.length + row.jsonld.length, truncated: 0, skipped: 1 });
  const r = createContentStore({ auditId: b, reuseFrom: a });
  r.reuse("https://example.com/1");
  assert.equal(get("SELECT markdown FROM page_content WHERE audit_id=? AND url=?", b, "https://example.com/1").markdown, "Token [hidden] here");
});

const SECRET = "bypass-secret-998877";
const page = (title, body, head = "") => `<!doctype html><html lang="en-AU"><head><title>${title}</title><meta name="description" content="About ${title}, a page of the example site used in tests.">${head}</head>
  <body><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/private">Private</a></nav><main><h1>${title}</h1>${body}</main><footer>Footer text</footer></body></html>`;
const SITE = {
  "/": page("Home of the example site", `<p>Welcome to the example. <a href="/services">Our services</a>.</p>`,
    `<script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoRepair","name":"Example Repairs"}</script>`),
  "/services": page("Services of the example site", "<h2>Brakes</h2><ul><li>Pads</li><li>Discs</li></ul><table><tr><th>Job</th><th>Time</th></tr><tr><td>Pads</td><td>1 h</td></tr></table>"),
  "/private": page("Private page", `<p>Not for search. The page echoes the token ${SECRET} by mistake.</p>`, '<meta name="robots" content="noindex">'),
};
function fakeSite(log) {
  return async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    log.push({ path: u.pathname, headers: init.headers || {} });
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    const html = SITE[u.pathname];
    if (!html) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(u.pathname === "/services" ? html.replace("Pads</li>", `Pads ${SECRET}</li>`) : html, { headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

test("an audit stores Markdown and JSON-LD for indexable pages; exports stream from the server without secrets", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { requestHeaders: [{ name: "X-Bypass-Token", value: SECRET }], checkExternalLinks: false, cwvPages: 0, concurrency: 2 } });
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const id = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  const log = [], realFetch = globalThis.fetch;
  globalThis.fetch = fakeSite(log);
  t.after(() => { globalThis.fetch = realFetch; });
  await runAudit(id, project, settings, () => {}, { sleep: async () => {} });
  assert.ok(log.some((r) => r.headers["X-Bypass-Token"] === SECRET), "the header was sent to the own site");

  const stored = new Map(all("SELECT url, markdown, jsonld FROM page_content WHERE audit_id=?", id).map((r) => [new URL(r.url).pathname, r]));
  assert.deepEqual([...stored.keys()].sort(), ["/", "/services"], "noindex pages keep no content");
  assert.match(stored.get("/services").markdown, /^# Services of the example site\n\n## Brakes\n\n- Pads \[hidden\]\n- Discs\n\n\| Job \| Time \|/);
  assert.ok(!stored.get("/").markdown.includes("Footer text") && !stored.get("/").markdown.includes("Home ["), "nav and footer are left out");
  assert.deepEqual(JSON.parse(stored.get("/").jsonld), [{ "@context": "https://schema.org", "@type": "AutoRepair", name: "Example Repairs" }]);
  assert.equal(JSON.parse(get("SELECT site_info FROM audits WHERE id=?", id).site_info).content.pages, 2);

  const mdText = [...markdownExport(id)].join("");
  assert.match(mdText, /^# example\.com: page content\n\nAudit #\d+ of https:\/\/example\.com\//);
  assert.match(mdText, /\n## Services of the example site\n\nURL: <https:\/\/example\.com\/services>\n\n### Services of the example site\n\n#### Brakes\n/);
  const lines = [...jsonlExport(id)].map((l) => JSON.parse(l));
  const home = lines.find((l) => l.url === "https://example.com/");
  assert.deepEqual(Object.keys(home), ["url", "final_url", "status", "content_type", "title", "description", "h1", "canonical", "lang", "words", "indexable", "jsonld", "markdown"]);
  assert.equal(home.lang, "en-AU");
  assert.equal(home.jsonld[0]["@type"], "AutoRepair");
  const priv = lines.find((l) => l.url.endsWith("/private"));
  assert.equal(priv.indexable, false);
  assert.equal(priv.markdown, null);

  // The real routes, through the local server (port 4574): streamed downloads, no secret anywhere.
  server.routes.length = 0; // only this module's routes matter here
  (await import("../src/page-content.mjs")).register({ routes: server.routes });
  const srv = server.createServer();
  await new Promise((r) => srv.listen(4574, "127.0.0.1", r));
  t.after(() => srv.close());
  for (const [kind, type, file] of [["markdown", /^text\/markdown/, `audit-${id}-content.md`], ["jsonl", /^application\/x-ndjson/, `audit-${id}-pages.jsonl`]]) {
    const res = await realFetch(`http://localhost:4574/api/audits/${id}/export/${kind}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), type);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="${file}"`);
    const body = await res.text();
    assert.ok(body.length > 200);
    assert.ok(!body.includes(SECRET) && !body.includes("X-Bypass-Token"), `${kind}: no request header names or values`);
  }
  assert.equal((await realFetch("http://localhost:4574/api/audits/99999/export/jsonl")).status, 404);
});

test("incremental re-crawl: a page reused on 304 keeps its stored Markdown", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 2, incremental: true } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input)), h = init.headers || {};
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    if (!SITE[u.pathname] || u.pathname === "/private") return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (h["If-None-Match"] === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    return new Response(SITE[u.pathname], { headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const audit = async () => {
    const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
    const id = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
    await runAudit(id, project, settings, () => {}, { sleep: async () => {} });
    return id;
  };
  const a1 = await audit(), a2 = await audit();
  const row = get("SELECT data FROM pages WHERE audit_id=? AND url=?", a2, "https://example.com/services");
  assert.ok(JSON.parse(row.data).reused304, "the page was reused");
  const md = (id) => get("SELECT markdown FROM page_content WHERE audit_id=? AND url=?", id, "https://example.com/services")?.markdown;
  assert.ok(md(a1));
  assert.equal(md(a2), md(a1));
});
