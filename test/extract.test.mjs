// Custom extraction (REQ-055 group 3, Nov 2026): rule validation (max 20, names, selectors, patterns), the
// catastrophic-backtracking guards (nested quantifiers refused, input capped, 100 ms vm timeout), values per page in
// data.extract, Pages table filter/sort, pages CSV and JSONL. fetch is faked (example.com only). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { nestedQuantifier, cleanExtractRules, createExtractor, MAX_RULES, REGEX_INPUT } = await import("../src/extract.mjs");
const { runAudit } = await import("../src/crawler.mjs");
const { createProject, updateProject, getProject, listPages, exportCsv } = await import("../src/api.mjs");
const { get, run, projectSettings } = await import("../src/db.mjs");
const { jsonlExport } = await import("../src/page-content.mjs");

const status = (fn) => { try { fn(); return null; } catch (e) { return [e.status, e.message]; } };

test("nested quantifiers are recognised; ordinary patterns pass", () => {
  for (const p of ["(a+)+", "(\\w*)*$", "(?:x+y?){2,}", "((a)+)+", "(?<n>[a-z]+)*", "(a|b+)+", "(.*?,){3}"]) assert.ok(nestedQuantifier(p), p);
  for (const p of ["(a+)?", "(?:ab)+", "[a+]+", "\\(a+\\)+", "a{1,3}", "(a{2})?", "gtag\\('config', '([^']+)'", "\"price\":\\s*\"?([\\d.]+)", "(\\d+)-(\\d+)"])
    assert.equal(nestedQuantifier(p), null, p);
});

test("rules are validated: names, types, selectors, patterns, flags, attributes, at most 20", () => {
  assert.deepEqual(cleanExtractRules([
    { name: "Price", type: "css", selector: " .price ", output: "text" },
    { name: "Author", type: "css", selector: "meta[name=author]", output: "attr", attr: "content" },
    { name: "GA id", type: "regex", pattern: "gtag\\('config', '([^']+)'", flags: "i" },
    { name: "", selector: "" }, // empty rows from the form are dropped
  ]), [
    { name: "Price", type: "css", selector: ".price", output: "text" },
    { name: "Author", type: "css", selector: "meta[name=author]", output: "attr", attr: "content" },
    { name: "GA id", type: "regex", pattern: "gtag\\('config', '([^']+)'", flags: "i" },
  ]);
  assert.deepEqual(cleanExtractRules(undefined), []);
  const bad = (rules) => status(() => cleanExtractRules(rules));
  assert.match(bad(Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ name: `r${i}`, type: "css", selector: "p" })))[1], /At most 20/);
  assert.match(bad([{ name: 'bad"name', type: "css", selector: "p" }])[1], /letters, digits/);
  assert.match(bad([{ name: "A", type: "css", selector: "p" }, { name: "a", type: "css", selector: "h1" }])[1], /Two extraction rules/);
  assert.match(bad([{ name: "A", type: "css", selector: "p[" }])[1], /invalid CSS selector/);
  assert.match(bad([{ name: "A", type: "css", selector: "meta", output: "attr" }])[1], /attribute/);
  assert.match(bad([{ name: "A", type: "regex", pattern: "x".repeat(201) }])[1], /over 200/);
  assert.match(bad([{ name: "A", type: "regex", pattern: "(a+)+b" }])[1], /nested quantifier/);
  assert.match(bad([{ name: "A", type: "regex", pattern: "(unclosed" }])[1], /Invalid regular expression/);
  assert.match(bad([{ name: "A", type: "regex", pattern: "a", flags: "g" }])[1], /flags/);
  assert.match(bad([{ name: "A", type: "xpath", selector: "//p" }])[1], /css or regex/);
  assert.match(bad("p")[1], /must be a list/);
  assert.equal(bad([{ name: "A", type: "regex", pattern: "(a+)+b" }])[0], 400);
});

const HTML = `<html><head><meta name="author" content="Ahsan"><script>gtag('config', 'G-ABC123');</script></head><body>
  <h1>Brakes</h1><p class="price"> $120 </p><p class="price">$90</p><div class="box"><b>Bold</b> text</div><a href="/a">A</a><a href="/b">B</a></body></html>`;

test("the extractor: CSS text, inner HTML, attributes and counts; regex groups; secrets hidden", () => {
  const rules = cleanExtractRules([
    { name: "Price", type: "css", selector: ".price", output: "text" }, { name: "Box", type: "css", selector: ".box", output: "html" },
    { name: "Links", type: "css", selector: "a", output: "attr", attr: "href" }, { name: "Price count", type: "css", selector: ".price", output: "count" },
    { name: "Missing", type: "css", selector: ".nope", output: "text" }, { name: "None", type: "css", selector: ".nope", output: "count" },
    { name: "GA", type: "regex", pattern: "gtag\\('config', '([^']+)'" }, { name: "Whole", type: "regex", pattern: "G-[A-Z0-9]+" },
    { name: "Author", type: "regex", pattern: "name=\"author\" content=\"([^\"]+)\"" }, { name: "No match", type: "regex", pattern: "zzz(\\d)" },
  ]);
  const x = createExtractor(rules, { redact: (s) => s.replace("Ahsan", "[hidden]") });
  assert.deepEqual(x.run(HTML), { extract: { Price: "$120 | $90", Box: "<b>Bold</b> text", Links: "/a | /b", "Price count": 2, Missing: "", None: 0,
    GA: "G-ABC123", Whole: "G-ABC123", Author: "[hidden]", "No match": "" } });
  // CSS reads the page as crawled (rendered DOM), regex the raw HTML.
  assert.deepEqual(createExtractor(cleanExtractRules([{ name: "H1", type: "css", selector: "h1" }, { name: "Raw", type: "regex", pattern: "<h1>(\\w+)" }]))
    .run("<h1>Raw</h1>", "<h1>Rendered</h1>").extract, { H1: "Rendered", Raw: "Raw" });
  assert.deepEqual(createExtractor([]).run(HTML), {});
  assert.equal(createExtractor([]).summary(), null);
  assert.equal(createExtractor(cleanExtractRules([{ name: "Long", type: "css", selector: "p" }])).run(`<p>${"x".repeat(900)}</p>`).extract.Long.length, 500);
});

test("time guard: a catastrophic pattern is stopped and skipped for the rest of the audit; input is capped", () => {
  // Built directly (not through cleanExtractRules, which refuses it) to prove the vm timeout holds on its own.
  const x = createExtractor([{ name: "Bad", type: "regex", pattern: "(a+)+$", flags: "" }, { name: "Ok", type: "regex", pattern: "(b)" }], { timeoutMs: 50 });
  const t0 = Date.now();
  const first = x.run("a".repeat(40) + "!b");
  assert.ok(Date.now() - t0 < 2000, "stopped by the timeout");
  assert.equal(first.extract.Bad, null);
  assert.equal(first.extract.Ok, "b", "other rules still run");
  assert.match(first.extractErrors.Bad, /timed out after 50 ms; skipped/);
  const t1 = Date.now();
  assert.equal(x.run("a".repeat(40) + "!").extract.Bad, null);
  assert.ok(Date.now() - t1 < 40, "not searched again");
  assert.deepEqual(x.summary(), { rules: 2, pages: 2, timeouts: 1, disabled: ["Bad"] });
  const tail = createExtractor(cleanExtractRules([{ name: "Tail", type: "regex", pattern: "END(\\d)" }]));
  assert.equal(tail.run("x".repeat(REGEX_INPUT) + "END1").extract.Tail, "", "only the first 2 MB is searched");
});

test("an audit stores the values per page; Pages filter and sort by them; CSV and JSONL include them", async (t) => {
  assert.equal(status(() => createProject({ start_url: "https://example.org/", settings: { extract: [{ name: "A", type: "regex", pattern: "(x*)*" }] } }))[0], 400);
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 2,
    extract: [{ name: "Price", type: "css", selector: ".price" }, { name: "SKU", type: "regex", pattern: "data-sku=\"([^\"]+)\"" }] } });
  assert.deepEqual(getProject(p.id).settings.extract.map((r) => r.name), ["Price", "SKU"]);
  const site = {
    "/": `<html><head><title>Shop home</title></head><body><a href="/p1">One</a> <a href="/p2">Two</a></body></html>`,
    "/p1": `<html><head><title>Product one</title></head><body><p class="price">$120</p><div data-sku="SKU-1"></div></body></html>`,
    "/p2": `<html><head><title>Product two</title></head><body><p class="price">$90</p><div data-sku="SKU-2"></div></body></html>`,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "content-type": "text/plain" } });
    return site[u.pathname] ? new Response(site[u.pathname], { headers: { "content-type": "text/html" } }) : new Response("no", { status: 404, headers: { "content-type": "text/plain" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const id = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(id, project, settings, () => {}, { sleep: async () => {} });

  const all = listPages(id, { sort: "url" }).rows;
  assert.deepEqual(all.find((r) => r.url.endsWith("/p1")).extract, { Price: "$120", SKU: "SKU-1" });
  assert.deepEqual(all.find((r) => r.url === "https://example.com/").extract, { Price: "", SKU: "" });
  assert.deepEqual(listPages(id, { x: "SKU", xv: "SKU-2" }).rows.map((r) => r.url), ["https://example.com/p2"]);
  assert.deepEqual(listPages(id, { x: "Price", xop: "empty" }).rows.map((r) => r.url), ["https://example.com/"]);
  assert.equal(listPages(id, { x: "Price", xop: "filled" }).total, 2);
  assert.equal(listPages(id, { x: 'Price"); DROP TABLE pages; --', xv: "1" }).total, 3, "an invalid rule name is ignored, never put in SQL");
  assert.deepEqual(listPages(id, { x: "Price", xop: "filled", sort: "x:Price", dir: "asc" }).rows.map((r) => r.extract.Price), ["$120", "$90"]);
  assert.deepEqual(listPages(id, { x: "Price", xop: "filled", sort: "x:Price", dir: "desc" }).rows.map((r) => r.extract.Price), ["$90", "$120"]);

  const csv = exportCsv(id, "pages").split("\r\n");
  assert.match(csv[0], /,extract: Price,extract: SKU$/);
  assert.ok(csv.some((l) => l.startsWith("https://example.com/p1,") && l.endsWith(",$120,SKU-1")));
  const lines = [...jsonlExport(id)].map((l) => JSON.parse(l));
  assert.deepEqual(lines.find((l) => l.url.endsWith("/p2")).extract, { Price: "$90", SKU: "SKU-2" });
  assert.deepEqual(JSON.parse(get("SELECT site_info FROM audits WHERE id=?", id).site_info).extract, { rules: 2, pages: 3, timeouts: 0, disabled: [] });

  updateProject(p.id, { settings: { extract: [] } });
  assert.deepEqual(getProject(p.id).settings.extract, []);
});
