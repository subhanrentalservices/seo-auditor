// Main content as Markdown, for AI tools and content exports (REQ-055 group 3, Nov 2026). Our own converter (cheerio,
// no extra dependency): headings, paragraphs, lists, tables, links, code, quotes and image alt text from the page's
// main content. The scope follows the crawler's main-content detection (parseHtml): <main> (or role="main") when
// the page has one, else <body>; inside it the template is dropped the same way: nav, aside, ARIA navigation /
// banner / contentinfo landmarks, a header or footer that isn't part of an article or section, plus scripts, forms'
// controls, hidden elements, "skip to content" links and cookie / consent banners.
import * as cheerio from "cheerio";

export const MAX_MARKDOWN = 100 * 1024; // characters stored per page; longer pages are cut at a line and marked

const DROP = "script, style, noscript, template, svg, canvas, iframe, object, embed, input, select, textarea, button, option, datalist, [hidden], [aria-hidden=true], dialog:not([open])";
const CHROME = "nav, aside, [role=navigation], [role=banner], [role=contentinfo], [role=search]";
// Cookie / consent banners by their id, class or label (vendors: OneTrust, Cookiebot, CookieYes, Didomi, Usercentrics…).
const CONSENT = /(?:^|[\s_-])(?:cookies?|consent|gdpr|ccpa|cmp|onetrust|cookiebot|cookieyes|didomi|usercentrics|truste|osano|iubenda)(?:$|[\s_-])/i;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i;
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody",
  "tfoot", "tr", "td", "th", "pre", "blockquote", "hr", "dl", "dt", "dd", "figure", "figcaption", "details", "summary", "address", "form", "fieldset", "legend", "caption", "body", "center"]);

/** The element holding the page's main content, with the template, hidden parts and banners removed (mutates $). */
export function mainContent($) {
  const scope = $("main").first().length ? $("main").first() : $("[role=main]").first().length ? $("[role=main]").first() : $("body");
  scope.find(DROP).remove();
  scope.find(CHROME).remove();
  scope.find("header, footer").filter((_, e) => !$(e).parents("article, section").length).remove();
  scope.find("[style]").filter((_, e) => HIDDEN_STYLE.test($(e).attr("style") || "")).remove();
  scope.find("[id], [class], [aria-label]").filter((_, e) => {
    const x = $(e);
    if (x.is("main, article, body")) return false;
    return CONSENT.test(x.attr("id") || "") || CONSENT.test(x.attr("class") || "") || CONSENT.test(x.attr("aria-label") || "");
  }).remove();
  scope.find("a[href^='#']").filter((_, e) => /^skip\b/i.test($(e).text().trim())).remove();
  return scope;
}

// Backslash-escapes the characters that would turn plain text into Markdown syntax.
const escText = (s) => s.replace(/([\\`*[\]<])/g, "\\$1").replace(/(^|[\s(])_|_(?=[\s).,;:!?]|$)/g, (m) => m.replace("_", "\\_"));
const escStart = (s) => s.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s)/, "$1\\$2"); // a paragraph that would read as a heading, quote or list
const absUrl = (href, base) => { try { const u = new URL(href, base); return /^(https?|mailto|tel):$/.test(u.protocol) ? u.href : null; } catch { return null; } };
const linkUrl = (u) => (/[\s()<>]/.test(u) ? `<${u.replace(/[<>]/g, encodeURIComponent)}>` : u);

/** Converts the main content of an HTML page. Returns { markdown, truncated }. */
export function htmlToMarkdown(html, url, { max = MAX_MARKDOWN } = {}) {
  const $ = cheerio.load(String(html || ""));
  return { ...capMarkdown(elementToMarkdown($, mainContent($), url), max) };
}

/** Markdown for one element (already cleaned with mainContent, or any element of a loaded document). */
export function elementToMarkdown($, el, base) {
  const inline = (node) => {
    let out = "";
    for (const c of node.children || []) {
      if (c.type === "text") { out += escText(c.data.replace(/\s+/g, " ")); continue; }
      if (c.type !== "tag") continue;
      const name = c.name;
      if (name === "br") { out += "\n"; continue; }
      if (name === "img") {
        const alt = ($(c).attr("alt") || "").replace(/\s+/g, " ").trim(), src = absUrl($(c).attr("src") || "", base);
        if (alt) out += src ? `![${alt.replace(/[[\]\\]/g, "\\$&")}](${linkUrl(src)})` : alt;
        continue;
      }
      const text = inline(c);
      if (name === "a") {
        const href = absUrl(($(c).attr("href") || "").trim(), base), label = text.replace(/\s+/g, " ").trim();
        out += href && label && !/^#/.test(($(c).attr("href") || "").trim()) ? `[${label}](${linkUrl(href)})` : text;
      } else if (/^(strong|b)$/.test(name) && text.trim()) out += `**${text.trim()}**`;
      else if (/^(em|i)$/.test(name) && text.trim()) out += `*${text.trim()}*`;
      else if (name === "code" && text.trim()) out += "`" + $(c).text().replace(/`/g, "'") + "`";
      else out += BLOCK.has(name) ? ` ${text} ` : text;
    }
    return out;
  };
  const clean = (s) => s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").trim();
  const cellText = (c) => clean(inline(c)).replace(/\n+/g, " ").replace(/\|/g, "\\|");

  const table = (t) => {
    const rows = $(t).find("tr").filter((_, r) => $(r).closest("table")[0] === t).toArray()
      .map((r) => $(r).children("th, td").toArray().map(cellText));
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    if (!width) return "";
    const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || "").join(" | ")} |`;
    return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
  };

  const list = (l, depth) => {
    const ordered = l.name === "ol";
    let n = Number($(l).attr("start")) || 1;
    const out = [];
    for (const li of $(l).children("li").toArray()) {
      const marker = ordered ? `${n++}.` : "-", pad = "  ".repeat(depth);
      const subs = [], rest = { children: [] };
      for (const c of li.children || []) (c.type === "tag" && /^(ul|ol)$/.test(c.name) ? subs : rest.children).push(c);
      const body = blocks(rest).replace(/\n{2,}/g, "\n").split("\n").map((x, i) => (i ? pad + "   " + x : x)).join("\n");
      out.push(`${pad}${marker} ${body}`.trimEnd());
      for (const s of subs) out.push(list(s, depth + 1));
    }
    return out.filter(Boolean).join("\n");
  };

  // Block-level rendering: consecutive inline content becomes one paragraph.
  const blocks = (node) => {
    const parts = [];
    let para = { children: [] };
    const flush = () => { const t = clean(inline(para)); if (t) parts.push(escStart(t)); para = { children: [] }; };
    for (const c of node.children || []) {
      if (c.type !== "tag" || !BLOCK.has(c.name)) { para.children.push(c); continue; }
      flush();
      const name = c.name;
      if (/^h[1-6]$/.test(name)) { const t = clean(inline(c)).replace(/\n+/g, " "); if (t) parts.push(`${"#".repeat(+name[1])} ${t}`); }
      else if (name === "ul" || name === "ol") { const t = list(c, 0); if (t) parts.push(t); }
      else if (name === "table") { const t = table(c); if (t) parts.push(t); }
      else if (name === "pre") { const t = $(c).text().replace(/\n+$/, ""); if (t.trim()) parts.push("```\n" + t.replace(/```/g, "'''") + "\n```"); }
      else if (name === "blockquote") { const t = blocks(c); if (t) parts.push(t.split("\n").map((x) => (x ? "> " + x : ">")).join("\n")); }
      else if (name === "hr") parts.push("---");
      else if (name === "dt") { const t = clean(inline(c)); if (t) parts.push(`**${t}**`); }
      else if (name === "figcaption" || name === "caption") { const t = clean(inline(c)); if (t) parts.push(`*${t}*`); }
      else if (name === "p" || name === "dd" || name === "summary" || name === "legend") { const t = clean(inline(c)); if (t) parts.push(escStart(t)); }
      else { const t = blocks(c); if (t) parts.push(t); } // containers: div, section, article, figure, details, li…
    }
    flush();
    return parts.join("\n\n");
  };
  return blocks(el[0] || el).replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts text longer than max characters at the last line break before it and says so. */
export function capMarkdown(markdown, max = MAX_MARKDOWN) {
  const s = String(markdown || "");
  if (s.length <= max) return { markdown: s, truncated: false };
  const cut = s.lastIndexOf("\n", max - 40);
  return { markdown: s.slice(0, cut > max / 2 ? cut : max - 40).trimEnd() + "\n\n[… cut: page over the size limit]", truncated: true };
}

/** Shifts every ATX heading down by n levels (max H6), outside fenced code: a page's H1 becomes ### under its section. */
export function demoteHeadings(markdown, n = 2) {
  let fenced = false;
  return String(markdown || "").split("\n").map((line) => {
    if (/^```/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(/^(#{1,6}) /, (_, h) => "#".repeat(Math.min(6, h.length + n)) + " ");
  }).join("\n");
}
