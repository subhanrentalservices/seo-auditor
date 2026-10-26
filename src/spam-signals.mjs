// Spam signals (REQ-044 build rows 10 and 26, Oct 2026), from Google's spam policies:
// - keyword_stuffing: "filling a web page with keywords or numbers in an attempt to manipulate rankings … Often these
//   keywords appear in a list or group, unnaturally, or out of context", with the examples "Blocks of text that list
//   cities and regions that a web page is trying to rank for" and "Repeating the same words or phrases so often that
//   it sounds unnatural". Google publishes no numbers: every threshold here is this tool's heuristic.
// - hacked_spam_signals: page and content injection by hackers (Google spam policies, "Hacked content"; Daniel
//   Waisberg and Aurora Morales, "Security issues explained", 2020): spam words in titles, headings, link text or
//   hidden text, Japanese keyword-hack titles on a non-Japanese site; new_external_script: a script host that appeared
//   on most pages since the last audit (code injection is often a script tag).
// Parse-time functions take a cheerio document; the site functions are pure (the crawler passes in the data).

// Items of a run-on list: commas, pipes, semicolons, bullets, line breaks, or a spaced dash or slash.
const SEP = /\s*(?:[,|;•·\n]|\s[-–—/]\s)\s*/;
const STOP = new Set("a an and or of to in on for with at by from is are be it this that your you we our as the near me my all any best top".split(" "));
// Elements that are lists by nature, or not part of the page's prose: never checked as a run-on list.
const SKIP_LIST = "nav, [role=navigation], table, select, datalist, address, header, form, [itemtype*=PostalAddress], [aria-label*=readcrumb i], [class*=crumb i], [class*=address i]";
const BLOCKS = "p, div, span, section, article, aside, footer, small, dd, font";
const INNER_BLOCK = "p, div, ul, ol, li, table, section, article, aside, footer, h1, h2, h3, h4, h5, h6, form, dl";

/** Text of an element with <br> and block boundaries as line breaks (cheerio's .text() joins them). */
function textWithBreaks($, el) {
  let s = "";
  const walk = (n) => {
    if (n.type === "text") s += n.data;
    else if (n.type === "tag" || n.type === "script" || n.type === "style") {
      if (/^(script|style|noscript|template|svg)$/i.test(n.name)) return;
      if (n.name === "br") { s += "\n"; return; }
      const block = /^(p|div|li|tr|section|article|h\d|dd|dt)$/i.test(n.name);
      if (block) s += "\n";
      for (const c of n.children || []) walk(c);
      if (block) s += "\n";
    }
  };
  walk(el);
  return s;
}

const capitalised = (item) => {
  const ws = item.split(/\s+/).filter(Boolean);
  return ws.length > 0 && ws.length <= 4 && ws.every((w) => /^[A-ZÀ-Þ]/.test(w) || /^\d{3,5}$/.test(w) || /^(of|upon|on|the|de|la|le|van|von)$/.test(w)) && ws.some((w) => /^[A-ZÀ-Þ]/.test(w));
};

/** One run-on list (a): ≥15 short items, over 60% of them capitalised names (places, the policy's example) or
 *  repeating one word. Returns { items, kind, example } or null. linkCount: links inside the element. */
export function listVerdict(text, linkCount = 0) {
  const items = String(text || "").split(SEP).map((x) => x.replace(/^(?:and|or)\s+/i, "").replace(/[.:!]+$/, "").trim()).filter(Boolean);
  if (items.length < 15) return null;
  if (linkCount >= items.length * 0.5) return null; // distinct items, each with its own link
  if (items.filter((x) => x.split(/\s+/).length <= 4).length < items.length * 0.8) return null; // sentences, not a keyword list
  const names = items.filter(capitalised).length;
  const freq = new Map();
  for (const it of items) for (const w of new Set(it.toLowerCase().split(/\s+/))) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) || 0) + 1);
  const [word, n] = [...freq].sort((a, b) => b[1] - a[1])[0] || ["", 0];
  const example = items.slice(0, 5).join(", ").slice(0, 120);
  if (n >= items.length * 0.6) return { items: items.length, kind: `"${word}" repeated in ${n} items`, example };
  if (names > items.length * 0.6) return { items: items.length, kind: `${names} capitalised names (places or terms)`, example };
  return null;
}

/** The longest run-on list on the page (main text and footer; menus, tables, forms, address blocks and breadcrumbs
 *  are skipped, as are <ul>/<ol> lists whose items carry their own links). */
export function stuffedList($) {
  let best = null;
  const consider = (el, text, links) => {
    const v = listVerdict(text, links);
    if (v && (!best || v.items > best.items)) best = v;
  };
  $("body").find(BLOCKS).each((_, el) => {
    const e = $(el);
    if (e.closest(SKIP_LIST).length || e.find(INNER_BLOCK).length) return; // leaf blocks only: no double counting
    consider(el, textWithBreaks($, el), e.find("a[href]").length);
  });
  $("body").find("ul, ol").each((_, el) => {
    const e = $(el);
    if (e.closest(SKIP_LIST).length) return;
    const li = e.children("li");
    if (li.length < 15) return;
    consider(el, li.map((_, x) => $(x).text().replace(/\s+/g, " ").trim()).get().join("\n"), li.filter((_, x) => $(x).find("a[href]").length > 0).length);
  });
  return best;
}

/** (b) 2–4-word phrases repeated ≥10 times that make up ≥4% of the main text's words (heuristic thresholds).
 *  Phrases that start or end with a stop word, or hold a number, are skipped. The 3 most repeated first (the longest
 *  kept when a longer phrase holds a shorter one with the same count). */
export function repeatedPhrases(text) {
  const w = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  if (w.length < 100) return [];
  const counts = new Map();
  for (let n = 2; n <= 4; n++) for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n);
    if (STOP.has(g[0]) || STOP.has(g[n - 1]) || g.some((x) => /\d/.test(x) || x.length < 2)) continue;
    const k = g.join(" ");
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const hits = [...counts].filter(([k, c]) => c >= 10 && (c * k.split(" ").length) / w.length >= 0.04)
    .map(([phrase, n]) => ({ phrase, n, share: +((n * phrase.split(" ").length) / w.length).toFixed(3) }));
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.n === h.n && o.phrase.length > h.phrase.length && o.phrase.includes(h.phrase)));
  return kept.sort((a, b) => b.n - a.n || b.phrase.length - a.phrase.length).slice(0, 3);
}

const compact = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const isBrand = (s, brands) => brands.some((b) => { const c = compact(b); return c.length >= 3 && (compact(s).includes(c) || c.includes(compact(s))); });

/** keyword_stuffing per page from data.stuffList / data.stuffPhrases; brand terms are ignored. */
export function keywordStuffingIssues(pages, { brandTerms = [] } = {}) {
  const out = [];
  for (const p of pages) {
    const d = p.data || {};
    if (p.status !== 200 || !p.indexable) continue;
    const parts = [];
    if (d.stuffList) parts.push(`a block of ${d.stuffList.items} list items, ${d.stuffList.kind}: "${d.stuffList.example}…"`);
    const ph = (d.stuffPhrases || []).find((x) => !isBrand(x.phrase, brandTerms));
    if (ph) parts.push(`"${ph.phrase}" ${ph.n} times (${Math.round(ph.share * 100)}% of the main text's words)`);
    if (parts.length) out.push(["keyword_stuffing", p.url, parts.join("; ")]);
  }
  return out;
}

// ---------------- Row 26: hacked content ----------------
// Vocabulary of injected spam (pharma, gambling, adult, essay, replica and loan spam). Ambiguous single words (escort,
// replica, slot) only count in their spam phrases.
const SPAM = /\b(viagra|cialis|levitra|kamagra|tramadol|xanax|online pharmacy|casino|slot (?:gacor|online|deposit)|judi (?:online|bola|slot)|togel|sbobet|payday loans?|replica (?:watch|watches|handbags?|bags?)|porn\w*|essay writing service|escort (?:service|agency|girls?)s?|buy (?:cheap )?(?:pills|followers))\b/gi;
const HIDDEN = /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![.\d])|(?:left|top|text-indent)\s*:\s*-\d{3,}px/i;
const terms = (s) => [...new Set([...String(s || "").matchAll(SPAM)].map((m) => m[1].toLowerCase()))];
const KANA = /[぀-ヿ]/g;

/** Spam vocabulary by where it appears: { title, h1, anchors, hidden, text } (only non-empty lists), Japanese kana in
 *  the title or H1 (kana), and the hosts of external scripts (scriptHosts, every HTML page, for new_external_script). */
export function spamFindings($, url) {
  const d = {}, spam = {};
  const put = (k, list) => { if (list.length) spam[k] = list.slice(0, 5); };
  const title = $("title").first().text(), h1 = $("h1").map((_, e) => $(e).text()).get().join(" ");
  put("title", terms(title));
  put("h1", terms(h1));
  put("anchors", terms($("a").map((_, a) => $(a).text()).get().join(" | ")));
  put("hidden", terms($("[style], [hidden]").filter((_, e) => $(e).is("[hidden]") || HIDDEN.test($(e).attr("style") || "")).map((_, e) => $(e).text()).get().join(" | ")));
  put("text", terms($("body").text()));
  if (Object.keys(spam).length) d.spam = spam;
  const kana = (title + " " + h1).match(KANA)?.length || 0;
  if (kana) d.kana = kana;
  const host = new URL(url).hostname;
  d.scriptHosts = [...new Set($("script[src]").map((_, e) => { try { return new URL($(e).attr("src"), url).hostname; } catch { return null; } }).get()
    .filter((h) => h && h !== host))].slice(0, 15);
  return d;
}

/** hacked_spam_signals and new_external_script. home: the start page record; prevUrls: URLs of the previous audit
 *  (null when there is none) — pages new since then are also checked in their body text; prevScriptHosts: Map host →
 *  pages in the previous audit (null when it recorded none). allow and brandTerms: terms never reported. */
export function hackedSpamIssues(pages, { home = null, allow = [], brandTerms = [], prevUrls = null, prevScriptHosts = null, prevAudit = null } = {}) {
  const out = [];
  const homeTerms = new Set(Object.values(home?.data?.spam || {}).flat());
  const ok = (t) => homeTerms.has(t) || allow.some((a) => a && t.includes(a.toLowerCase())) || isBrand(t, brandTerms);
  const siteLang = String(home?.data?.lang || "").toLowerCase();
  const japaneseSite = /^ja/.test(siteLang) || home?.data?.kana >= 4; // a Japanese home page without a lang attribute
  const live = pages.filter((p) => p.status === 200 && (p.content_type || "").includes("html"));
  for (const p of live) {
    const d = p.data || {}, found = [];
    const isNew = prevUrls && !prevUrls.has(p.url);
    for (const [where, label] of [["title", "title"], ["h1", "H1"], ["anchors", "link text"], ["hidden", "hidden text"], ...(isNew ? [["text", "text of a page new since the last audit"]] : [])]) {
      const t = (d.spam?.[where] || []).filter((x) => !ok(x));
      if (t.length) found.push(`${label}: ${t.join(", ")}`);
    }
    // Japanese keyword hack: Japanese titles on a site that isn't in Japanese (a real /ja/ version has hreflang).
    if (d.kana >= 4 && !japaneseSite && !(/^ja/i.test(d.lang || "") && d.hreflangAlts?.length)) found.push(`${d.kana} Japanese characters in the title or H1 of a site in "${siteLang || "unknown language"}" (Japanese keyword hack pattern)`);
    if (found.length) out.push(["hacked_spam_signals", p.url, found.join("; ")]);
  }
  if (prevScriptHosts && live.length >= 4) {
    const count = new Map();
    for (const p of live) for (const h of p.data?.scriptHosts || []) count.set(h, (count.get(h) || 0) + 1);
    for (const [h, n] of count) if (n >= live.length * 0.5 && !prevScriptHosts.get(h))
      out.push(["new_external_script", home?.url || live[0].url, `scripts from ${h} on ${n} of ${live.length} pages; on no page in audit #${prevAudit ?? "previous"}`]);
  }
  return out;
}
