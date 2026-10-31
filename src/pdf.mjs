// PDFs (REQ-055 group 3 addition, Nov 2026). Google indexes PDFs, so the crawl reads the site's own: PDF links on
// its pages (and PDF URLs in its sitemap) are fetched like pages, on the site's hosts only, with robots.txt obeyed
// and the audit's own user agent; at most `maxPdfs` per audit (default 50, 0 = off) and `maxPdfMb` each (default
// 20 MB; Googlebot reads up to 64 MB of a PDF). Each one is stored as a page of type application/pdf with its title
// (the document's Title property), first line of text (in the H1 column), text, word count and page count, so the
// page checks that make sense for a document apply: broken (4xx/5xx and broken links to it), missing title, under 200
// words (no text layer = scanned pages), duplicate title and duplicate text, and it goes into the Markdown and JSONL
// exports. Parsing uses unpdf (MIT; a server build of Mozilla's pdf.js, Apache-2.0) inside this process: nothing is
// sent anywhere. It is loaded only when the first PDF is read, with font eval off and a time limit per file.
import { createHash } from "node:crypto";

export const PDF_TIMEOUT_MS = 20000; // per file
export const MAX_PDF_PAGES = 300;    // pages whose text is read (the page count is always the real one)
export const MAX_PDF_TEXT = 1_000_000; // characters of text kept per file

export const PDF_CHECKS = {
  pdf_unreadable: ["notice", "PDF could not be read", "This tool couldn't read the PDF's text: it is damaged, encrypted, not really a PDF, or over this audit's size limit. When Google can't read a PDF's text either, it can't index or show it for searches about its content (Google indexes the text of PDFs, up to the first 64 MB).", "Open the file in a PDF reader to confirm it works. Re-export it from the source document as a standard, unencrypted PDF with real text (not only scanned images), ideally a few MB. For a file over the audit's limit, raise PDF size limit in Settings if you want it checked."],
};

export const isPdfType = (type) => /^application\/(x-)?pdf\b/i.test(String(type || "").trim());
export const isPdfUrl = (u) => { try { return /\.pdf$/i.test(new URL(u).pathname); } catch { return false; } };

/** Reads a PDF: { pages, info: { Title, Author, Language… }, text: [per page] } or { error }. */
export async function parsePdf(bytes, { timeoutMs = PDF_TIMEOUT_MS, maxPages = MAX_PDF_PAGES } = {}) {
  let doc = null, timer = null;
  const work = (async () => {
    const { getDocumentProxy, getMeta } = await import("unpdf");
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
    const { info } = await getMeta(doc).catch(() => ({ info: {} }));
    const text = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i), tc = await page.getTextContent();
      text.push(tc.items.map((x) => (x.str || "") + (x.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n"));
      page.cleanup?.();
    }
    return { pages: doc.numPages, info: info || {}, text };
  })();
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: `not read within ${timeoutMs / 1000} s` }), timeoutMs); });
  try {
    return await Promise.race([work.catch((e) => ({ error: String(e?.message || e).split("\n")[0].slice(0, 120) || "not a readable PDF" })), limit]);
  } finally {
    clearTimeout(timer);
    work.finally(() => doc?.destroy?.().catch?.(() => {})).catch(() => {});
  }
}

// A document title that is only the authoring tool's default or a file name: Google won't show it usefully.
const JUNK_TITLE = /^(untitled|document\s*\d*|presentation\s*\d*|book\s*\d*|microsoft (word|powerpoint|excel) - .*|.*\.(docx?|pptx?|xlsx?|indd|pdf|rtf|odt|pages))$/i;

/** A parsed PDF as a crawled page (the shape parseHtml returns) plus its Markdown. */
export function pdfPage(parsed, { truncated = false, maxMb = 20 } = {}) {
  const empty = { title: "", description: "", h1: "", canonical: null, links: [], imgs: [], res: [], words: 0, text: "", textHash: null, markdown: "" };
  if (truncated) return { ...empty, data: { pdf: { error: `over the ${maxMb} MB PDF size limit of this audit: not read` } } };
  if (!parsed || parsed.error) return { ...empty, data: { pdf: { error: parsed?.error || "not read" } } };
  const pagesText = parsed.text.map((t) => t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim());
  let all = pagesText.join("\n\n");
  if (all.length > MAX_PDF_TEXT) all = all.slice(0, MAX_PDF_TEXT);
  const text = all.replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").length : 0;
  const info = parsed.info || {}, rawTitle = String(info.Title || "").replace(/\s+/g, " ").trim();
  const junk = rawTitle && JUNK_TITLE.test(rawTitle);
  const firstLine = (all.split("\n").map((l) => l.trim()).find(Boolean) || "").slice(0, 150);
  const pdf = { pages: parsed.pages };
  if (junk) pdf.defaultTitle = rawTitle.slice(0, 150);
  if (info.Author) pdf.author = String(info.Author).slice(0, 100);
  if (parsed.text.length < parsed.pages) pdf.textPages = parsed.text.length;
  const data = { pdf };
  if (info.Language) data.lang = String(info.Language).slice(0, 20);
  return { ...empty, title: junk ? "" : rawTitle.slice(0, 300), h1: firstLine, words, text,
    textHash: words > 50 ? createHash("md5").update(text.toLowerCase()).digest("hex") : null,
    markdown: pagesText.filter(Boolean).join("\n\n---\n\n"), data };
}

/** Page checks for a stored PDF (200): unreadable, missing title, few words. Returns [[checkId, detail]]. */
export function pdfPageIssues(p) {
  const x = p.data?.pdf;
  if (!x || x.skipped) return [];
  if (x.error) return [["pdf_unreadable", x.error]];
  const out = [];
  if (!p.title) out.push(["missing_title", x.defaultTitle ? `PDF title is the default "${x.defaultTitle}"; set Title in the document's properties`
    : `PDF has no Title in its document properties; Google makes one from the text${p.h1 ? `, e.g. "${p.h1.slice(0, 60)}"` : ""}`]);
  if (p.words < 200 && p.indexable) out.push(["low_word_count", p.words ? `${p.words} words on ${x.pages} page(s)` : `no text on ${x.pages} page(s): scanned images without a text layer?`]);
  return out;
}

/** The PDF part of one audit: which links to follow, how many bytes to read, and the stored page for a response. */
export function createPdfs({ maxPdfs = 50, maxPdfMb = 20 } = {}, { parse = parsePdf } = {}) {
  const max = Math.max(0, Number(maxPdfs) || 0), maxBytes = Math.max(1, Number(maxPdfMb) || 20) * 1024 * 1024;
  const stats = { linked: 0, read: 0, unreadable: 0, skipped: 0 };
  return {
    /** A same-site link to a .pdf the crawl should fetch (the caller checks scope and robots.txt). */
    link(url) { if (!max || stats.linked >= max || !isPdfUrl(url)) return false; stats.linked++; return true; },
    /** Bytes a PDF response may read: none once the audit's PDFs are used up. */
    bytes: () => (max && stats.read < max ? maxBytes : 0),
    /** The stored page for a 200 application/pdf response (r.bytes from fetchOnce). */
    async page(r) {
      if (!r.bytes) { stats.skipped++; return { ...pdfPage({ pages: 0, text: [] }), data: { pdf: { skipped: max ? (r.via && r.via !== "fetch" && r.via !== "retry" ? `read through ${r.via}: text not extracted` : `over the limit of ${max} PDFs per audit`) : "PDF reading is off (maxPdfs = 0)" } } }; }
      stats.read++;
      const p = r.truncated ? pdfPage(null, { truncated: true, maxMb: maxBytes / 1048576 }) : pdfPage(await parse(r.bytes));
      if (p.data.pdf.error) stats.unreadable++;
      return p;
    },
    summary: () => (stats.linked || stats.read || stats.skipped ? { ...stats } : null),
  };
}
