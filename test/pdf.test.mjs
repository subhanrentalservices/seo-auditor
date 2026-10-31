// The site's own PDFs (REQ-055 group 3 addition, Nov 2026): parsed in-process with unpdf (title, text, words,
// pages), stored as application/pdf pages with the page checks that make sense (missing title, few words,
// duplicates, broken links, unreadable), count and size capped, robots.txt obeyed, the audit's own user agent, and
// included in the content exports. PDFs are generated in the test; fetch is faked (example.com only). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parsePdf, pdfPage, pdfPageIssues, createPdfs, isPdfType, isPdfUrl } = await import("../src/pdf.mjs");
const { fetchOnce } = await import("../src/page-fetch.mjs");
const { runAudit } = await import("../src/crawler.mjs");
const { createProject, updateProject } = await import("../src/api.mjs");
const { all, get, run, projectSettings } = await import("../src/db.mjs");
const { jsonlExport, markdownExport } = await import("../src/page-content.mjs");

/** A minimal valid PDF: one text line per entry, one page per list, an optional document Title. */
function makePdf(pages, title) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null), font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  for (const lines of pages) {
    const stream = "BT /F1 12 Tf 72 720 Td 14 TL " + lines.map((l) => `(${l}) Tj T*`).join(" ") + " ET";
    const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${title ? " /Lang (en-AU)" : ""} >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
  const info = title ? add(`<< /Title (${title}) >>`) : null;
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const sentences = (seed, n) => Array.from({ length: n }, (_, i) => `${seed} sentence number ${i} about brake pads and repairs`);

test("parsePdf reads the title, text and page count; garbage is an error, not a crash", async () => {
  const r = await parsePdf(makePdf([["Brake guide", "Page one text."], ["Page two text."]], "Brake guide 2026"));
  assert.equal(r.pages, 2);
  assert.equal(r.info.Title, "Brake guide 2026");
  assert.deepEqual(r.text, ["Brake guide\nPage one text.", "Page two text."]);
  assert.ok((await parsePdf(Buffer.from("not a pdf at all"))).error);
  assert.equal((await parsePdf(makePdf([["a"], ["b"], ["c"]]), { maxPages: 2 })).text.length, 2);
  assert.ok(isPdfType("application/pdf") && isPdfType("application/x-pdf; qs=1") && !isPdfType("text/html"));
  assert.ok(isPdfUrl("https://example.com/a/Guide.PDF") && !isPdfUrl("https://example.com/pdf"));
});

test("pdfPage and its checks: missing or default title, few words, no text layer, unreadable", () => {
  const p = pdfPage({ pages: 2, info: { Title: "Brake guide", Language: "en-AU" }, text: ["Brake guide\nShort text.", ""] });
  assert.deepEqual([p.title, p.h1, p.words, p.data.lang, p.data.pdf.pages], ["Brake guide", "Brake guide", 4, "en-AU", 2]);
  assert.equal(p.markdown, "Brake guide\nShort text.");
  assert.deepEqual(pdfPageIssues({ ...p, indexable: 1 }), [["low_word_count", "4 words on 2 page(s)"]]);
  const def = pdfPage({ pages: 1, info: { Title: "Microsoft Word - guide.docx" }, text: [sentences("x", 40).join(". ")] });
  assert.equal(def.title, "");
  assert.ok(def.textHash, "over 50 words: duplicate text is checked");
  assert.match(pdfPageIssues({ ...def, indexable: 1 })[0][1], /default "Microsoft Word - guide\.docx"/);
  const scan = pdfPage({ pages: 3, info: {}, text: ["", "", ""] });
  assert.deepEqual(pdfPageIssues({ ...scan, indexable: 1 }).map((x) => x[0]), ["missing_title", "low_word_count"]);
  assert.match(pdfPageIssues({ ...scan, indexable: 1 })[1][1], /no text on 3 page\(s\)/);
  assert.deepEqual(pdfPageIssues(pdfPage({ error: "Invalid PDF structure." })), [["pdf_unreadable", "Invalid PDF structure."]]);
  assert.match(pdfPageIssues(pdfPage(null, { truncated: true, maxMb: 5 }))[0][1], /over the 5 MB PDF size limit/);
  assert.deepEqual(pdfPageIssues({ data: { pdf: { skipped: "over the limit" } } }), []);
});

test("fetchOnce reads a PDF's bytes only when asked, capped", async () => {
  const pdf = makePdf([["Hello"]], "Hi");
  const fetchFn = async () => new Response(pdf, { headers: { "content-type": "application/pdf" } });
  assert.equal((await fetchOnce("https://example.com/a.pdf", "UA", "GET", 5000, null, { fetchFn })).bytes, undefined);
  const r = await fetchOnce("https://example.com/a.pdf", "UA", "GET", 5000, null, { fetchFn, pdfBytes: () => 1024 * 1024 });
  assert.equal(Buffer.compare(r.bytes, pdf), 0);
  const cut = await fetchOnce("https://example.com/a.pdf", "UA", "GET", 5000, null, { fetchFn, pdfBytes: 100 });
  assert.ok(cut.truncated && cut.bytes.length === 100);
});

test("createPdfs: count cap on links and reads, off at 0", async () => {
  const x = createPdfs({ maxPdfs: 2, maxPdfMb: 1 }, { parse: async () => ({ pages: 1, info: { Title: "T" }, text: ["t"] }) });
  assert.deepEqual(["/a.pdf", "/b.html", "/c.pdf", "/d.pdf"].map((p) => x.link("https://example.com" + p)), [true, false, true, false]);
  assert.equal(x.bytes(), 1024 * 1024);
  await x.page({ bytes: Buffer.from("x") }); await x.page({ bytes: Buffer.from("x") });
  assert.equal(x.bytes(), 0, "both reads used");
  assert.match((await x.page({})).data.pdf.skipped, /over the limit of 2 PDFs/);
  assert.match((await x.page({ via: "curl" })).data.pdf.skipped, /read through curl/);
  const off = createPdfs({ maxPdfs: 0 });
  assert.equal(off.link("https://example.com/a.pdf"), false);
  assert.equal(off.bytes(), 0);
});

test("an audit reads the site's PDFs as pages: checks, duplicates, broken links, robots.txt, exports", async (t) => {
  const p = createProject({ start_url: "https://example.com/", settings: { checkExternalLinks: false, cwvPages: 0, concurrency: 2, maxPdfs: 5 } });
  updateProject(p.id, { settings: { maxPdfMb: 999 } });
  assert.equal(projectSettings(get("SELECT * FROM projects WHERE id=?", p.id)).maxPdfMb, 64, "clamped to Google's 64 MB");
  const body = sentences("guide", 40);
  const files = {
    "/guide.pdf": makePdf([body.slice(0, 20), body.slice(20)], "Brake guide"),
    "/copy.pdf": makePdf([body.slice(0, 20), body.slice(20)], "Brake guide"), // same title and text
    "/untitled.pdf": makePdf([["Price list", "Pads 120"]]),
    "/broken.pdf": null,
    "/private/secret.pdf": makePdf([["Secret"]], "Secret"),
    "/other.pdf": makePdf([["Over the count limit"]], "Other"),
  };
  const links = Object.keys(files).map((f) => `<a href="${f}">${f}</a>`).join(" ");
  const html = `<!doctype html><html lang="en"><head><title>Home of the example site</title></head><body><main><h1>Home</h1><p>${links} <a href="https://other.example.com/x.pdf">x</a></p></main></body></html>`;
  const log = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    log.push({ host: u.hostname, path: u.pathname, ua: init.headers?.["User-Agent"] });
    if (u.hostname !== "example.com") throw new TypeError("fetch failed");
    if (u.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /private/\n", { headers: { "content-type": "text/plain" } });
    if (u.pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    if (files[u.pathname]) return new Response(files[u.pathname], { headers: { "content-type": "application/pdf" } });
    return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const project = get("SELECT * FROM projects WHERE id=?", p.id), settings = projectSettings(project);
  const id = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", p.id, JSON.stringify(settings)).lastInsertRowid);
  await runAudit(id, project, settings, () => {}, { sleep: async () => {} });

  const pages = new Map(all("SELECT * FROM pages WHERE audit_id=?", id).map((r) => [new URL(r.url).pathname, { ...r, data: JSON.parse(r.data) }]));
  const g = pages.get("/guide.pdf");
  assert.deepEqual([g.status, g.content_type, g.title, g.indexable, g.data.pdf.pages, g.data.lang], [200, "application/pdf", "Brake guide", 1, 2, "en-AU"]);
  assert.equal(g.words, 360); // 40 sentences of 9 words
  assert.equal(pages.get("/broken.pdf").status, 404);
  assert.ok(pages.get("/private/secret.pdf").data.blockedByRobots, "robots.txt obeyed");
  assert.ok(!pages.has("/other.pdf"), "the sixth PDF link isn't fetched (maxPdfs 5)");
  assert.deepEqual(log.filter((r) => r.path.endsWith(".pdf") && (r.path.includes("secret") || r.host !== "example.com")), [], "no disallowed or other-site PDF fetched");
  assert.ok(log.filter((r) => r.path.endsWith(".pdf")).every((r) => r.ua === settings.userAgent), "the audit's own user agent");

  const issues = all("SELECT check_id, url, detail FROM issues WHERE audit_id=?", id).map((i) => [i.check_id, new URL(i.url).pathname, i.detail]);
  const has = (check, pathname) => issues.some(([c, u]) => c === check && u === pathname);
  assert.ok(has("missing_title", "/untitled.pdf"));
  assert.ok(has("low_word_count", "/untitled.pdf"));
  assert.ok(has("dup_title", "/guide.pdf") && has("dup_title", "/copy.pdf"));
  assert.ok(has("dup_content", "/copy.pdf"));
  assert.ok(has("http_4xx", "/broken.pdf") && issues.some(([c, , d]) => c === "broken_internal_link" && d.includes("/broken.pdf")));
  for (const html of ["missing_description", "missing_h1", "missing_viewport", "missing_canonical", "missing_og", "not_in_sitemap"]) assert.ok(!has(html, "/guide.pdf"), `${html} is an HTML check`);
  assert.ok(!issues.some(([c, u]) => c.startsWith("ai_") && u.endsWith(".pdf")));
  assert.deepEqual(JSON.parse(get("SELECT site_info FROM audits WHERE id=?", id).site_info).pdfs, { linked: 5, read: 3, unreadable: 0, skipped: 0 });

  const lines = [...jsonlExport(id)].map((l) => JSON.parse(l));
  const gl = lines.find((l) => l.url.endsWith("/guide.pdf"));
  assert.deepEqual([gl.content_type, gl.title, gl.pdf.pages], ["application/pdf", "Brake guide", 2]);
  assert.match(gl.markdown, /^guide sentence number 0 about brake pads/);
  assert.match([...markdownExport(id)].join(""), /## Brake guide\n\nURL: <https:\/\/example\.com\/guide\.pdf> \(PDF\)/);
});
