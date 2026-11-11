// AI-wording check for any text before it is published or sent (owner rule 2026-11-11: "every text you write will be
// passed from ai check to eliminate ai wording"). Two parts:
//   1. tells(text): phrase-level habits of unedited AI drafts that show even in a short text (a meta description, a
//      social post, an email): em dashes, "it's not X, it's Y", "not just X but Y", "no X, no Y, no Z" lists, stiff
//      connectors, stock openers and closers, hype words and the stock phrases ai-style.mjs counts. Each hit is listed
//      with its line so it can be rewritten. Zero hits = pass.
//   2. aiStyle (ai-style.mjs) for texts of 300+ words of prose: sentence rhythm, list habits, repeated phrasing.
// No check can prove who wrote a text; Google's guidance is that helpful content is fine however it's made. These are
// the habits readers notice and a careful editor removes.
import * as cheerio from "cheerio";
import { aiStyle, AI_STYLE_FLAG_BELOW, AI_STYLE_MIN_WORDS } from "./ai-style.mjs";

const TELLS = [
  ["em dash", /—/g],
  ["it's not X, it's Y", /\b(it|this|that)'?s not (just |only |merely )?[^.!?\n]{1,50}[,;—–-]\s*(it'?s|but)\b/gi],
  ["not just X but Y", /\bnot (just|only|merely)\b[^.!?\n]{1,50}\bbut( also)?\b/gi],
  ["no X, no Y, no Z", /\bno [^,.!?\n]{1,25}, no [^,.!?\n]{1,25}, (and |or )?no\b/gi],
  ["stiff connector", /(^|[.!?]\s+)(moreover|furthermore|additionally|consequently|subsequently|notably|importantly),/gim],
  ["stock opener", /\b(in today'?s (fast-paced |digital )?(world|landscape|age)|when it comes to|in the world of|let'?s dive in|let'?s explore|whether you'?re a|here'?s the thing|picture this|imagine this|are you tired of|look no further)\b/gi],
  ["summary closer", /\b(in conclusion|in summary|to sum up|at the end of the day|all in all)\b|\bultimately,/gi],
  ["hype word", /\b(delve|tapestry|testament|realm|bustling|game-?changer|unlock(s|ing)?|elevate(s|d)?|seamless(ly)?|robust|leverag(e|es|ing)|cutting-edge|state-of-the-art|unparalleled|revolutioni[sz]e|supercharge|empower(s|ing)?|navigat(e|ing) the (complexities|world|landscape)|nestled|boasts?|holistic|synergy|myriad|plethora|embark)\b/gi],
  ["stock phrase", /\b(it'?s important to (note|remember)|keep in mind|peace of mind|the good news is|rest assured|look no further|we'?ve got you covered|take (it|your \w+) to the next level|a wide (range|variety) of|second to none|one-stop shop|tailored to your (needs|unique needs))\b/gi],
  ["rhetorical question then answer", /\b(the result|the answer|the best part|the catch|the secret)\?\s/gi],
];

/** Phrase-level AI tells in a text. Returns [{ tell, match, line }]. */
export function tells(text) {
  const out = [];
  const lines = String(text || "").replace(/[‘’]/g, "'").split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const [tell, re] of TELLS) for (const m of ln.matchAll(re)) out.push({ tell, match: m[0].trim().slice(0, 80), line: i + 1 });
  });
  return out;
}

/** Paragraphs, list items and headings from Markdown or plain text. */
export function partsFromText(text) {
  const paragraphs = [], items = [], headings = [];
  let labelItems = 0;
  for (const block of String(text || "").split(/\r?\n\s*\r?\n/)) {
    for (const raw of block.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (/^#{1,6}\s/.test(l)) { headings.push(l.replace(/^#+\s*/, "")); continue; }
      if (/^([-*+]|\d+[.)])\s+/.test(l)) {
        const it = l.replace(/^([-*+]|\d+[.)])\s+/, "");
        items.push(it.replace(/\*\*/g, ""));
        if (/^\*\*[^*]{1,40}\*\*\s*[:.–—-]/.test(it) || /^\*\*[^*]{1,40}[:.]\*\*/.test(it) || /^[A-Z][^:]{1,30}:\s/.test(it)) labelItems++;
        continue;
      }
    }
    const prose = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/.test(l)).join(" ");
    if (prose) paragraphs.push(prose.replace(/[*_`]/g, ""));
  }
  return { paragraphs, items, labelItems, headings };
}

/** Paragraphs, list items and headings from HTML (main content if there is a <main>). */
export function partsFromHtml(html) {
  const $ = cheerio.load(html);
  const scope = $("main").length ? $("main") : $("body").length ? $("body") : $.root();
  scope.find("script,style,nav,header,footer,noscript,svg").remove();
  const t = (e) => $(e).text().replace(/\s+/g, " ").trim();
  const paragraphs = scope.find("p").map((_, e) => t(e)).get().filter(Boolean);
  const items = scope.find("li").map((_, e) => t(e)).get().filter(Boolean);
  const labelItems = scope.find("li").filter((_, e) => /^(strong|b)$/i.test($(e).children().first().prop("tagName") || "") && /^[^:]{1,40}[:.–—-]/.test(t(e))).length;
  const headings = scope.find("h2,h3,h4").map((_, e) => t(e)).get().filter(Boolean);
  return { paragraphs, items, labelItems, headings, text: [...headings, ...paragraphs, ...items].join("\n") };
}

/** Full check. kind: "html" or "text". Pass = no phrase tells and (if long enough) an ai-style score of 85+. */
export function aiCheck(input, kind = "text") {
  const parts = kind === "html" ? partsFromHtml(input) : { ...partsFromText(input), text: String(input || "") };
  const hits = tells(parts.text);
  const style = aiStyle(parts);
  const pass = hits.length === 0 && (!style || style.score >= AI_STYLE_FLAG_BELOW);
  return { pass, hits, style: style ? { score: style.score, problems: style.problems } : null, minWords: AI_STYLE_MIN_WORDS };
}
