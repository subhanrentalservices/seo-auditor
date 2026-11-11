// AI-style signals in a page's main text (2026-11-10). No check can prove who wrote a text, and Google's guidance is
// that helpful content is fine however it's made. These are the habits of unedited AI drafts that readers notice:
// every sentence the same length, few short sentences, one word opening many sentences, "Label: text" bullet lists,
// three-item lists everywhere, stock phrases and the same phrasing said again. A careful human editor removes them.
// Calibrated on one site's blog: 26 AI-drafted posts averaged 75.6, the same posts after a surface rewrite 75.8,
// and the same posts rewritten by an editor to this standard 99-100. The page check flags scores under 85.

const STOCK = [
  /\bit'?s important to\b/gi, /\bmake sure\b/gi, /\bkeep in mind\b/gi, /\bin other words\b/gi, /\bthe good news\b/gi,
  /\bthe catch is\b/gi, /\bthe trade-?off\b/gi, /\bthat said\b/gi, /\bin practice\b/gi, /\bin short\b/gi,
  /\boverall\b/gi, /\bessentially\b/gi, /\bgenerally\b/gi, /\btypically\b/gi, /\bvarious\b/gi, /\ba range of\b/gi,
  /\ballows? you to\b/gi, /\bhelps? you\b/gi, /\bwhich means\b/gi, /\bthis means\b/gi, /\bkey\b/gi, /\bessential\b/gi,
  /\bstraightforward\b/gi, /\bpeace of mind\b/gi, /\bon the other hand\b/gi, /\bfor example\b/gi,
  /\bdelve\b/gi, /\bseamless(ly)?\b/gi, /\bleverag(e|es|ing)\b/gi, /\bin today'?s\b/gi, /\bwhen it comes to\b/gi,
];

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
export const AI_STYLE_MIN_WORDS = 300;
export const AI_STYLE_FLAG_BELOW = 85;

/**
 * Scores text from its parts. paragraphs: prose paragraph texts; items: list item texts; labelItems: how many list
 * items open with a bold label ("Speed: ..."); headings: H2-H4 texts. Returns null when there's too little prose.
 * Score 100 means none of the signals was found.
 */
export function aiStyle({ paragraphs = [], items = [], labelItems = 0, headings = [] }) {
  // Typographic apostrophes (can’t, it’s) count the same as straight ones, or every contraction check misses them.
  const prose = paragraphs.join(" ").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const words = prose ? prose.split(" ").length : 0;
  if (words < AI_STYLE_MIN_WORDS) return null;
  const sentences = prose.split(/(?<=[.?!])\s+(?=[A-Z0-9"(])/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
  const lens = sentences.map((s) => s.split(/\s+/).length);
  const per1k = (n) => (n * 1000) / words;
  const openers = new Map();
  for (const s of sentences) { const w = s.split(/\s+/)[0].toLowerCase().replace(/[^a-z']/g, ""); openers.set(w, (openers.get(w) || 0) + 1); }
  const [topOpener = "", topCount = 0] = [...openers.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const paraSent = paragraphs.map((p) => p.split(/(?<=[.?!])\s+/).length);
  // Only real three-item lists of short items ("speed, privacy and cost"), not any clause with a comma and an "and".
  const triplets = (prose.match(/(?:^|[\s(])[\w'-]+(?: [\w'-]+)?, [\w'-]+(?: [\w'-]+)?,? (?:and|or) [\w'-]+(?: [\w'-]+)?(?=[\s.,;:)]|$)/g) || []).length;
  const stock = STOCK.reduce((n, re) => n + (prose.match(re) || []).length, 0);
  const toks = prose.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
  const grams = new Map();
  for (let i = 0; i + 3 < toks.length; i++) { const g = toks.slice(i, i + 4).join(" "); grams.set(g, (grams.get(g) || 0) + 1); }
  const repeated = [...grams.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);

  const sig = {
    words,
    sentenceLenCV: +(sd(lens) / (mean(lens) || 1)).toFixed(2),
    shortSentShare: +(lens.filter((l) => l <= 8).length / (lens.length || 1)).toFixed(2),
    topOpener, topOpenerShare: +(topCount / (sentences.length || 1)).toFixed(2),
    paraLenSD: +sd(paraSent).toFixed(2),
    tripletsPer1k: +per1k(triplets).toFixed(1),
    labelItems, labelItemShare: +(labelItems / (items.length || 1)).toFixed(2),
    stockPer1k: +per1k(stock).toFixed(1),
    repeated4gramPer1k: +per1k(repeated).toFixed(1),
    questionHeadingShare: +(headings.filter((h) => /\?\s*$/.test(h)).length / (headings.length || 1)).toFixed(2),
  };
  const pen = [];
  const add = (cond, pts, why) => { if (cond) pen.push([pts, why]); };
  add(sig.sentenceLenCV < 0.42, 15, `sentence lengths too even (variation ${sig.sentenceLenCV}, want 0.42+)`);
  add(sig.shortSentShare < 0.12, 10, `few short sentences (${Math.round(sig.shortSentShare * 100)}% of 8 words or fewer, want 12%+)`);
  add(sig.topOpenerShare > 0.12, 10, `"${sig.topOpener}" starts ${Math.round(sig.topOpenerShare * 100)}% of sentences`);
  add(sig.paraLenSD < 0.8 && paragraphs.length > 6, 10, `paragraphs all the same size`);
  add(sig.tripletsPer1k > 6, 10, `"A, B and C" lists everywhere (${sig.tripletsPer1k} per 1,000 words)`);
  add(sig.labelItemShare > 0.35 && labelItems >= 4, 15, `${labelItems} "Label: text" bullets`);
  add(sig.stockPer1k > 5, 10, `stock phrases (${sig.stockPer1k} per 1,000 words)`);
  add(sig.repeated4gramPer1k > 14, 10, `the same phrasing repeated (${sig.repeated4gramPer1k} repeated 4-word runs per 1,000 words)`);
  add(sig.questionHeadingShare > 0.85 && headings.length >= 6, 5, `nearly every heading is a question`);
  return { score: Math.max(0, 100 - pen.reduce((s, [p]) => s + p, 0)), problems: pen.map(([, w]) => w), signals: sig, depth: depthOf(prose, words) };
}

/**
 * Depth: does the text think, or only describe? Heuristic signs of an expert writer: a clear recommendation, reasons
 * ("because", "which is why"), real numbers with units, and honest limits ("but", "unless", "won't"). They can't judge
 * whether the thinking is right; they flag text with little of it. Calibrated on the same 26 posts: AI drafts 4 of 26
 * at 75+, a surface rewrite 6 of 26, editor rewrites 16 of 26.
 */
export function depthOf(prose, words) {
  const per1k = (re) => ((prose.match(re) || []).length * 1000) / Math.max(words, 1);
  const d = {
    verdictsPer1k: +per1k(/\b(?:if|when|for)\b[^.?!]{3,140}?\b(?:use|choose|pick|go with|upload|convert|resize|compress|send|skip|keep|switch|attach|host|don'?t|do not|stick with|expect|leave|buy|delete|shoot|enter|add|avoid|turn)\b|\bI'?d\b|\b(?:my advice|I recommend|best bet)\b|\bthe (?:right|best|safe|simple) (?:choice|answer|move|option)\b/gi).toFixed(1),
    reasonsPer1k: +per1k(/\b(?:because|since|so that|which is why|that'?s why|the reason|this is why)\b/gi).toFixed(1),
    numbersPer1k: +per1k(/\b\d[\d,.]*\s?(?:%|KB|MB|GB|TB|px|pixels?|seconds?|ms|×|MP|megapixels?|kbps|Mbps|cm|mm|inches|in|DPI|PPI|fps|bytes?)(?![a-z])/gi).toFixed(1),
    limitsPer1k: +per1k(/\b(?:but|however|though|unless|except|the downside|the cost|won'?t|can'?t|doesn'?t|isn'?t|not always|instead|trade-?off)\b/gi).toFixed(1),
  };
  const pen = [];
  const add = (cond, why) => { if (cond) pen.push(why); };
  add(d.verdictsPer1k < 1, `no clear recommendations (${d.verdictsPer1k} per 1,000 words): say what to do and when`);
  add(d.reasonsPer1k < 1.5, `few reasons given (${d.reasonsPer1k} "because"-type links per 1,000 words): explain why`);
  add(d.numbersPer1k < 7, `few real numbers with units (${d.numbersPer1k} per 1,000 words): work an example`);
  add(d.limitsPer1k < 4, `few limits or trade-offs (${d.limitsPer1k} per 1,000 words): say where advice stops working`);
  return { score: 100 - pen.length * 25, problems: pen, signals: d };
}

/** Reads the parts aiStyle needs from a cheerio scope (the page's <main>, or <body>), leaving out navigation. */
export function aiStyleFromDom($, scope) {
  // The article itself when there is one: the largest <article> by text, so related-post cards (often their own small
  // <article> elements) and link blocks after it don't count as the page's writing.
  const arts = scope.find("article").toArray().map((a) => [a, $(a).text().replace(/\s+/g, " ").trim().length]).sort((a, b) => b[1] - a[1]);
  if (arts.length && arts[0][1] >= 1500) scope = $(arts[0][0]);
  const outside = (el) => !$(el).closest("nav, header, footer, aside, [role=navigation], table, blockquote").length && !$(el).closest("a").length;
  const paragraphs = scope.find("p").toArray().filter(outside).filter((p) => !$(p).closest("li").length)
    .map((p) => $(p).text().replace(/\s+/g, " ").trim()).filter((t) => t.split(" ").length >= 5);
  const lis = scope.find("li").toArray().filter(outside);
  const items = lis.map((li) => $(li).text().replace(/\s+/g, " ").trim()).filter(Boolean);
  const labelItems = lis.filter((li) => {
    const first = $(li).children("strong, b").first();
    if (!first.length) return false;
    const lead = first.text().trim();
    const after = ($(li).text().replace(/\s+/g, " ").trim()).slice($(li).text().replace(/\s+/g, " ").trim().indexOf(lead) + lead.length);
    return lead.length <= 60 && (/[:.]$/.test(lead) || /^\s*[:–-]/.test(after)) && $(li).text().trim().startsWith(lead);
  }).length;
  const headings = scope.find("h2, h3, h4").toArray().filter(outside).map((h) => $(h).text().trim()).filter(Boolean);
  return aiStyle({ paragraphs, items, labelItems, headings });
}
