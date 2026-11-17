// Mechanical fact check of a rewrite against its original (same rules as humanizer/verify_rewrite.py, used by the
// Human Writer tab after every round). It finds what can be found without reading: numbers, links, images, tables,
// code, bold labels, front matter. Meaning is checked separately (Claude's meaning check in human-writer.mjs).

export function splitFrontMatter(md) {
  const s = String(md || "").replace(/\r\n/g, "\n");
  const m = s.match(/^---\n([\s\S]*?)\n---\n/);
  return m ? [m[1], s.slice(m[0].length)] : ["", s];
}
const fmDict = (fm) => Object.fromEntries([...fm.matchAll(/^([A-Za-z_]+):\s*(.*)$/gm)].map((m) => [m[1], m[2]]));

function tables(body) {
  const out = [];
  let cur = [];
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("|")) cur.push(line.trim());
    else if (cur.length) { out.push(cur.join("\n")); cur = []; }
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}
const codeBlocks = (body) => body.match(/```[\s\S]*?```/g) || [];
export const prose = (body) => body.replace(/```[\s\S]*?```/g, " ").split("\n").filter((l) => !l.trimStart().startsWith("|")).join("\n");

const NUM = /(?<![\w.])(?:[$£€₹]\s?)?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|px|kb|mb|gb|tb|mp|dpi|ppi|x\d+|×\d+|k\b|m\b))?/gi;
export function numbers(text) {
  const t = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\]\([^)]*\)/g, "]");
  return (t.match(NUM) || []).map((n) => n.toLowerCase().replace(/\s+/g, "").replace(/,/g, ""));
}
export const links = (t) => [...t.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]);
const images = (t) => [...t.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)].map((m) => [m[1], m[2]]);
const headings = (t) => [...t.matchAll(/^(#{2,4})\s+(.+?)\s*$/gm)].map((m) => `${m[1]} ${m[2]}`);
const codeSpans = (t) => [...t.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const bolds = (t) => [...t.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => m[1]);
const count = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
/** Items of a that occur fewer times in b. */
function missing(a, b) {
  const ca = count(a), cb = count(b);
  return [...ca.keys()].filter((k) => (cb.get(k) || 0) < ca.get(k)).sort();
}

/**
 * { fail: [string], warn: [string], stats } for a rewrite. allowMissing: numbers the owner accepts losing.
 * keyword: a phrase whose count must not drop (the post's primaryKeyword or the tab's keyword field).
 */
export function verifyRewrite(original, rewrite, { allowMissing = [], keyword = "" } = {}) {
  const [fo, bo] = splitFrontMatter(original), [fn, bn] = splitFrontMatter(rewrite);
  const fail = [], warn = [];
  if (fo.trim() !== fn.trim()) {
    const a = fmDict(fo), b = fmDict(fn);
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[k] !== b[k]) fail.push(`front matter "${k}" changed`);
    }
  }
  const lo = links(bo), ln = links(bn);
  for (const u of missing(lo, ln)) fail.push(`link dropped: ${u}`);
  for (const u of [...new Set(ln)].filter((u) => !lo.includes(u))) fail.push(`link added: ${u}`);
  const io = images(bo), inew = images(bn).map((x) => x.join("\u0001"));
  for (const [alt, src] of io) if (!inew.includes(alt + "\u0001" + src)) fail.push(`image dropped or alt text changed: ${src}`);
  for (const [kind, f] of [["table", tables], ["code block", codeBlocks]]) {
    const a = f(bo), b = f(bn);
    for (const x of a) if (!b.includes(x)) fail.push(`${kind} changed or dropped: ${x.split("\n")[0].slice(0, 80)}`);
    for (const x of b) if (!a.includes(x)) fail.push(`${kind} added: ${x.split("\n")[0].slice(0, 80)}`);
  }
  const po = prose(bo), pn = prose(bn);
  const allow = new Set(allowMissing.map((x) => String(x).toLowerCase()));
  for (const n of missing(numbers(po), numbers(pn))) if (!allow.has(n)) fail.push(`number missing: ${n}`);
  for (const c of missing(codeSpans(po), codeSpans(pn))) fail.push(`code missing: \`${c}\``);
  const bn2 = new Set(bolds(pn));
  for (const b of [...new Set(bolds(po))].filter((b) => !bn2.has(b)).sort()) fail.push(`bold label missing: **${b}**`);

  const ho = headings(bo), hn = new Set(headings(bn));
  for (const h of ho) if (!hn.has(h)) warn.push(`heading changed: ${h}`);
  const wo = po.split(/\s+/).filter(Boolean).length, wn = pn.split(/\s+/).filter(Boolean).length;
  const kw = String(keyword || fmDict(fo).primaryKeyword || "").trim().replace(/^"|"$/g, "").toLowerCase();
  let ko = 0, kn = 0;
  if (kw) {
    const c = (t) => t.toLowerCase().split(kw).length - 1;
    ko = c(po); kn = c(pn);
    if (kn < ko) warn.push(`keyword "${kw}" used ${kn} times, original ${ko}`);
  }
  return { fail, warn, stats: { wordsBefore: wo, wordsAfter: wn, links: lo.length, numbers: numbers(po).length, keyword: kw, keywordBefore: ko, keywordAfter: kn } };
}
