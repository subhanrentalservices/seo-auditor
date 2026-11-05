// AI Overview gap (REQ-095, 2026-11-05; from an owner reel: "search the keyword, open every page the AI Overview
// cites, give the AI answer, their pages and yours to Claude and ask what you're missing"). Uses the AI Overview the
// AI visibility run already stored for the search (answer text + cited pages, no new paid call), or pages the owner
// pastes. Fetches your page and each cited page once (up to 8) and reports:
//   1. statements in the AI answer your page doesn't cover (most of the sentence's words missing from your page),
//   2. sections (headings) the cited pages have that your page doesn't cover, most-shared first,
//   3. page-level differences most cited pages share (direct answer at the top, question headings, date, author,
//      sources, structured data), from the page-compare checks.
// Google says no special optimisation is needed for AI features: the same SEO best practices apply, and pages must be
// indexed and eligible for a snippet ("AI features and your website"). Use the gaps as a coverage checklist; write
// your own answer from your own facts and never copy their text (spam policies: scraped / rewritten content).
import { all, get, projectSettings } from "./db.mjs";
import { fetchFollow } from "./page-fetch.mjs";
import { parseHtml } from "./crawler.mjs";
import { words } from "./page2.mjs";
import { signals, gaps as pageGaps } from "./page-compare.mjs";

const MAX_SOURCES = 8;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const host = (u) => { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };

/** Plain sentences from an AI Overview answer (markdown with [[1]](url) citations, bullets and headings). */
export function answerSentences(md) {
  const text = String(md || "")
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, " ")          // images (and a truncated one at the end)
    .replace(/\[\[\d+\]\]\([^)]*\)/g, " ")          // [[1]](https://…) citation markers
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")         // [text](url) links
    .replace(/[`*_#>]+/g, " ");
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/^\s*[-•\d.)]+\s*/, "").replace(/^details\s*:\s*/i, "").replace(/\s+/g, " ").trim())
    // a business's own contact line (location, phone, hours…) is about them, not a topic; a short line with no full
    // stop is a heading or a list label
    .filter((s) => words(s).length >= 4 && !/^(location|address|phone|tel|website|hours|email|rating)\s*:/i.test(s) && !/https?:\/\//.test(s) && !/\d\.\d\s*\(\d[\d,]*\)/.test(s)
      && (/[.!?]$/.test(s) || words(s).length >= 8));
}

const GENERIC = /^(final thoughts|related (posts|articles)|recent posts|conclusion|summary|contact( us)?|get in touch|menu|share( this)?|leave a (reply|comment)|categories|about( us)?|follow us|why choose\b|our (team|story|services))/i;
/** A heading worth reporting as a topic: not menu text run together, not boilerplate, not just the site's own brand. */
export function topicHeading(heading, url) {
  const hd = String(heading || "").replace(/\s+/g, " ").replace(/^\s*step\s*\d+\s*[:.)-]\s*/i, "").trim();
  if (!hd || hd.length > 90 || /[a-z][A-Z]/.test(hd) || GENERIC.test(hd)) return null; // > 90: a paragraph styled as a heading     // "MenuHome AboutContact" = nav text joined
  const label = (host(url).split(".")[0] || "").replace(/-/g, "");
  const ws = hd.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < ws.length; i++) {
    if (ws[i].length >= 5 && label.startsWith(ws[i]) && label.length - ws[i].length <= 8) return null; // "Acorn" on acornrentals
    if (i + 1 < ws.length && label.includes(ws[i] + ws[i + 1]) && (ws[i] + ws[i + 1]).length >= 8) return null;
  }
  return hd;
}

/** Share of a text's content words (stemmed, stop words removed) found in a word set. */
export function covered(text, have) {
  const w = [...new Set(words(text))];
  return w.length ? w.filter((x) => have.has(x)).length / w.length : 1;
}

/**
 * The gap report from already-read pages. mine / sources: { url, title, text, h2s, signals } (signals from page-compare);
 * answer: the AI Overview text. Pure: no fetching, so it can be tested directly.
 */
export function aioGaps({ mine, sources, answer, keyword }) {
  const have = new Set(words(`${mine.title} ${mine.h1 || ""} ${(mine.h2s || []).join(" ")} ${mine.text}`));
  const answerGaps = answerSentences(answer).filter((s) => covered(s, have) < 0.5).slice(0, 12);
  const topics = new Map();
  for (const s of sources) {
    for (const raw of s.h2s || []) {
      const hd = topicHeading(raw, s.url);
      if (!hd) continue;
      const w = [...new Set(words(hd))];
      if (w.length < 2 || covered(hd, have) >= 0.6) continue;
      const key = [...w].sort().join(" ");
      const t = topics.get(key) || { topic: hd, pages: new Set() };
      t.pages.add(s.url);
      topics.set(key, t);
    }
  }
  const topicGaps = [...topics.values()].map((t) => ({ topic: t.topic, pages: [...t.pages] }))
    .sort((a, b) => b.pages.length - a.pages.length).slice(0, 15);
  const counts = new Map();
  const bump = (key, text) => { const c = counts.get(key) || { id: key, text, pages: 0 }; c.pages += 1; counts.set(key, c); };
  for (const s of sources) for (const [id, text] of pageGaps(mine.signals, s.signals)) {
    // "They mark up A, B; you don't": count each type on its own, so the count and the wording match
    const types = id === "schema" ? (text.match(/mark up (.+?); you don't/) || [])[1] : null;
    if (types) for (const t of types.split(", ")) bump(`schema:${t}`, `They mark up ${t}; you don't. Add it only if your page really shows that content.`);
    else bump(id, text);
  }
  const need = Math.max(1, Math.ceil(sources.length / 2));
  const structure = [...counts.values()].filter((c) => c.pages >= need).sort((a, b) => b.pages - a.pages).map((c) => ({ ...c, of: sources.length }));
  return { keyword, answerGaps, topicGaps, structure };
}

/** Latest stored Google AI Overview for this search (exact prompt, any case) from the AI visibility runs. */
export function storedOverview(projectId, keyword) {
  const r = get(`SELECT r.run_id, r.sources, r.excerpt, u.started_at FROM ai_results r JOIN ai_runs u ON u.id = r.run_id
    WHERE u.project_id = ? AND r.platform = 'google' AND r.present = 1 AND lower(trim(r.prompt)) = lower(trim(?))
    ORDER BY r.run_id DESC LIMIT 1`, projectId, keyword);
  if (!r) return null;
  let sources = [];
  try { sources = JSON.parse(r.sources || "[]"); } catch { /* bad row */ }
  return { runId: r.run_id, date: r.started_at, answer: r.excerpt || "", sources: sources.map((s) => s.url).filter(Boolean) };
}

/** Searches with a stored AI Overview (for the form's list), newest run first. */
export function overviewSearches(projectId) {
  return all(`SELECT r.prompt, MAX(r.run_id) AS run_id FROM ai_results r JOIN ai_runs u ON u.id = r.run_id
    WHERE u.project_id = ? AND r.platform = 'google' AND r.present = 1 GROUP BY lower(trim(r.prompt)) ORDER BY run_id DESC, r.prompt`, projectId)
    .map((r) => r.prompt);
}

export async function aioGapReport(project, { mine, keyword, sources, answer } = {}, { ua = "Mozilla/5.0 (compatible; SEOAuditor/1.0; +local)", fetchPage = (u) => fetchFollow(u, ua) } = {}) {
  mine = String(mine || "").trim();
  keyword = String(keyword || "").trim();
  if (!/^https?:\/\/[^\s/]+/i.test(mine)) fail(400, "Enter your page's full address (https://…)");
  if (!keyword) fail(400, "Enter the search");
  let from = "pasted";
  let urls = (Array.isArray(sources) ? sources : String(sources || "").split(/[\s,]+/)).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
  answer = String(answer || "");
  if (!urls.length) {
    const s = storedOverview(project.id, keyword);
    if (!s) fail(400, "No Google AI Overview is stored for this search. Run AI visibility with “Google: AI Overview” for it, or paste the pages the AI Overview cites.");
    urls = s.sources;
    if (!answer) answer = s.answer;
    from = `AI visibility run ${s.runId} (${String(s.date).slice(0, 10)})`;
  }
  const ownHost = host(mine);
  const cited = [...new Set(urls)];
  const youCited = cited.some((u) => host(u) === ownHost);
  const theirs = cited.filter((u) => host(u) !== ownHost && !/(^|\.)(facebook|instagram|youtube|reddit|tiktok|x|twitter)\.com$/.test(host(u))).slice(0, MAX_SOURCES);
  const read = async (u) => {
    const r = await fetchPage(u);
    if (r.status !== 200 || (!/html/i.test(r.type || "") && !/<html|<body/i.test(r.body || ""))) return { url: u, error: r.error || `HTTP ${r.status || "error"}` };
    const final = r.finalUrl || u;
    const p = parseHtml(r.body, final);
    return { url: final, title: p.title || "", h1: p.h1 || "", text: p.text || "", h2s: p.data?.h2s || [], words: p.words || 0, signals: signals(p, final, keyword) };
  };
  const me = await read(mine);
  if (me.error) fail(400, `Couldn't read your page: ${me.error}`);
  const pages = [];
  for (const u of theirs) pages.push(await read(u));
  const ok = pages.filter((p) => !p.error);
  const report = ok.length || answer ? aioGaps({ mine: me, sources: ok, answer, keyword }) : { keyword, answerGaps: [], topicGaps: [], structure: [] };
  return {
    ...report, from, youCited, answer: answer.slice(0, 1500),
    mine: { url: me.url, title: me.title, words: me.words },
    sources: pages.map((p) => p.error ? { url: p.url, error: p.error } : { url: p.url, title: p.title, words: p.words }),
    skipped: cited.length - theirs.length - (youCited ? 1 : 0),
  };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/aio-gap\/searches$/, async ([id]) => ({ searches: overviewSearches(Number(id)) })]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/aio-gap$/, async ([id], _q, body) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    return aioGapReport(p, body || {}, { ua: projectSettings(p).userAgent });
  }]);
}
