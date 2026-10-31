// Page content for AI tools (REQ-055 group 3, Nov 2026): each indexable page's main content as Markdown
// (markdown.mjs) and its JSON-LD blocks, stored per audit with a size cap, and two downloads:
//   GET /api/audits/:id/export/markdown  one .md file, a section per page with its URL and title;
//   GET /api/audits/:id/export/jsonl     one JSON object per crawled page: url, final_url, status, content type,
//                                        title, description, h1, canonical, lang, words, JSON-LD, markdown, extract.
// Exports carry only what the pages themselves publish: never request headers, cookies, keys or settings. The
// project's own request header values are also replaced with [hidden] before anything is stored, in case a page
// echoes one back. Exports are streamed a page at a time, so a large site doesn't build one huge string.
import { db, get } from "./db.mjs";
import { htmlToMarkdown, demoteHeadings, capMarkdown, MAX_MARKDOWN } from "./markdown.mjs";

export const MAX_JSONLD = 64 * 1024;              // characters of JSON-LD kept per page
export const MAX_AUDIT_CONTENT = 300 * 1024 * 1024; // characters stored per audit; pages after that keep no Markdown

db.exec(`CREATE TABLE IF NOT EXISTS page_content (audit_id INTEGER NOT NULL REFERENCES audits(id) ON DELETE CASCADE, url TEXT NOT NULL,
  markdown TEXT, jsonld TEXT, truncated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (audit_id, url))`);

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const CUT_MD = 1, CUT_LD = 2; // truncated: bit flags

/** JSON-LD blocks as stored: the JSON text, or null with the CUT_LD flag when over MAX_JSONLD. */
export function jsonldText(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return { text: null, cut: 0 };
  const s = JSON.stringify(blocks);
  return s.length > MAX_JSONLD ? { text: null, cut: CUT_LD } : { text: s, cut: 0 };
}

/** The content store for one audit. redact(text): hides the project's request header values. reuseFrom: the audit
 *  an incremental re-crawl copies unchanged pages from. */
export function createContentStore({ auditId, redact = (s) => s, reuseFrom = null, maxTotal = MAX_AUDIT_CONTENT }) {
  const ins = db.prepare("INSERT OR REPLACE INTO page_content (audit_id, url, markdown, jsonld, truncated) VALUES (?,?,?,?,?)");
  const copy = db.prepare("INSERT OR REPLACE INTO page_content (audit_id, url, markdown, jsonld, truncated) SELECT ?, url, markdown, jsonld, truncated FROM page_content WHERE audit_id=? AND url=?");
  const stats = { pages: 0, chars: 0, truncated: 0, skipped: 0 };
  const room = (n) => { if (stats.chars + n > maxTotal) { stats.skipped++; return false; } stats.chars += n; return true; };
  return {
    /** Stores Markdown (already converted, e.g. a PDF's text) and JSON-LD blocks for a page. */
    save(url, { markdown = "", jsonld = null } = {}) {
      const md = capMarkdown(redact(markdown), MAX_MARKDOWN), ld = jsonldText(jsonld);
      const ldText = ld.text && redact(ld.text);
      if (!room(md.markdown.length + (ldText?.length || 0))) return false;
      const cut = (md.truncated ? CUT_MD : 0) | ld.cut;
      if (cut & CUT_MD) stats.truncated++;
      ins.run(auditId, url, md.markdown, ldText, cut);
      stats.pages++;
      return true;
    },
    /** Converts an HTML page's main content and stores it. */
    saveHtml(url, html, baseUrl, jsonld) { return this.save(url, { markdown: htmlToMarkdown(html, baseUrl, { max: Infinity }).markdown, jsonld }); },
    /** A page copied unchanged (304) from an earlier audit keeps that audit's content. */
    reuse(url) { if (reuseFrom && copy.run(auditId, reuseFrom, url).changes) stats.pages++; },
    summary: () => ({ ...stats }),
  };
}

// ---------------- Exports ----------------
const audit = (id) => get("SELECT a.*, p.name, p.start_url FROM audits a JOIN projects p ON p.id=a.project_id WHERE a.id=?", Number(id)) || fail(404, "Audit not found");
const safeJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

/** The Markdown export: a header, then one section per page that has content, in crawl order. Yields text chunks. */
export function* markdownExport(auditId) {
  const a = audit(auditId);
  const n = get("SELECT COUNT(*) n FROM page_content WHERE audit_id=? AND markdown IS NOT NULL", a.id).n;
  yield `# ${a.name}: page content\n\nAudit #${a.id} of ${a.start_url}${a.finished_at ? `, finished ${a.finished_at} UTC` : ""}. Main content of ${n} indexable page${n === 1 ? "" : "s"} as Markdown (menus, headers, footers and cookie banners left out; headings shifted two levels down).\n`;
  const rows = db.prepare(`SELECT p.url, p.final_url, p.title, p.content_type, c.markdown, c.truncated FROM page_content c JOIN pages p ON p.audit_id=c.audit_id AND p.url=c.url
    WHERE c.audit_id=? AND c.markdown IS NOT NULL ORDER BY p.id`).iterate(a.id);
  for (const r of rows) {
    const title = (r.title || r.final_url || r.url).replace(/\s+/g, " ").replace(/^#+\s*/, "");
    yield `\n---\n\n## ${title}\n\nURL: <${r.final_url || r.url}>${/pdf/i.test(r.content_type || "") ? " (PDF)" : ""}${r.truncated & CUT_MD ? " (cut at the size limit)" : ""}\n\n${demoteHeadings(r.markdown, 2)}\n`;
  }
}

/** The JSONL export: one JSON object per crawled page, in crawl order. Yields one line per page. */
export function* jsonlExport(auditId) {
  const a = audit(auditId);
  const rows = db.prepare(`SELECT p.url, p.final_url, p.status, p.content_type, p.title, p.description, p.h1, p.canonical, p.indexable, p.words,
      json_extract(p.data, '$.lang') lang, json_extract(p.data, '$.extract') extract, json_extract(p.data, '$.pdf') pdf, c.markdown, c.jsonld, c.truncated
    FROM pages p LEFT JOIN page_content c ON c.audit_id=p.audit_id AND c.url=p.url WHERE p.audit_id=? ORDER BY p.id`).iterate(a.id);
  for (const r of rows) {
    const o = { url: r.url, final_url: r.final_url || r.url, status: r.status, content_type: r.content_type || null, title: r.title || "", description: r.description || "",
      h1: r.h1 || "", canonical: r.canonical || null, lang: r.lang || null, words: r.words ?? 0, indexable: Boolean(r.indexable),
      jsonld: safeJson(r.jsonld) || [], markdown: r.markdown ?? null };
    const extract = safeJson(r.extract), pdf = safeJson(r.pdf);
    if (extract) o.extract = extract;
    if (pdf) o.pdf = pdf;
    if (r.truncated) o.truncated = { markdown: Boolean(r.truncated & CUT_MD), jsonld: Boolean(r.truncated & CUT_LD) };
    yield JSON.stringify(o) + "\n";
  }
}

const stream = (gen, type, file) => ({ __stream: gen, type, headers: { "Content-Disposition": `attachment; filename="${file}"` } });

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/export\/markdown$/, ([id]) => { const a = audit(id); return stream(markdownExport(a.id), "text/markdown; charset=utf-8", `audit-${a.id}-content.md`); }]);
  routes.push(["GET", /^\/api\/audits\/(\d+)\/export\/jsonl$/, ([id]) => { const a = audit(id); return stream(jsonlExport(a.id), "application/x-ndjson; charset=utf-8", `audit-${a.id}-pages.jsonl`); }]);
}
