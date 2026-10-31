// Pages a competitor has that you don't (REQ-062, 2026-10-31; from a "content gap: pages your competitors have that
// you don't" video, done without a paid tool). Reads the competitor's public XML sitemap (robots.txt Sitemap: lines or
// /sitemap.xml, indexes followed), takes each page's topic from its address, and matches it against your latest audit's
// pages (address, title, H1). Sections where most addresses are one template with a place, brand or insurer name
// swapped in are shown as "templated" and left out of the gaps: copying them is the doorway-page pattern Google's spam
// policies describe. What's left are topics worth a page or a section, written your own way, if you genuinely offer
// them. Nothing is copied from the competitor and their pages aren't crawled: only the sitemap is read, once.
import { all, get, projectSettings } from "./db.mjs";
import { fetchOnce } from "./page-fetch.mjs";
import { loadSitemaps } from "./sitemaps.mjs";
import { words } from "./page2.mjs";

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Address words that never describe a topic.
const NOISE = new Set(("html htm php aspx index page pages amp www com au uk co net org blog blogs post posts article articles news resources " +
  "resource category categories tag tags en au us p id").split(" "));
const MAX_URLS = 5000;

/** The section (first folder) and the topic words of a page address. */
export function topicOf(url) {
  let path = "";
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return { section: "", words: [], label: "" }; }
  const parts = path.split("/").filter(Boolean);
  const section = parts.length > 1 ? parts[0].toLowerCase() : "";
  const label = (parts.at(-1) || "").replace(/\.[a-z]{2,5}$/i, "").replace(/[-_.+]+/g, " ").trim().toLowerCase();
  const toks = words(label).filter((w) => !NOISE.has(w) && !/^\d+$/.test(w)); // stems, for matching
  return { section, words: [...new Set(toks)], label };
}

/** Sections built from one template: 15+ pages where a few words recur in most addresses and each page adds only one
 *  or two of its own (a suburb, a brand, an insurer). Returns a Set of section names. */
export function templatedSections(urls, { min = 15, share = 0.6 } = {}) {
  const bySection = new Map();
  for (const u of urls) { const t = topicOf(u); if (t.section) bySection.set(t.section, [...(bySection.get(t.section) || []), t.words]); }
  const out = new Set();
  for (const [section, list] of bySection) {
    if (list.length < min) continue;
    const freq = new Map();
    for (const ws of list) for (const w of ws) freq.set(w, (freq.get(w) || 0) + 1);
    const common = new Set([...freq].filter(([, n]) => n / list.length >= share).map(([w]) => w));
    // Every page in a section shares its folder name, so "same template" means: few words of its own per page and
    // little reuse of those words between pages (each page swaps in a different name).
    const own = list.map((ws) => ws.filter((w) => !common.has(w)));
    const short = own.filter((ws) => ws.length <= 2).length / list.length;
    const ownWords = own.flat();
    const distinct = ownWords.length ? new Set(ownWords).size / ownWords.length : 0;
    if (short >= 0.8 && distinct >= 0.6) out.add(section);
  }
  return out;
}

/** Competitor pages whose topic none of my pages covers. mine: [{ url, title, h1, headings }]. A topic counts as covered
 *  by a page (address + title + H1) or by one of its H2/H3 sections: each heading is matched on its own, so words from
 *  different sections never add up to a match. */
export function pageGap(theirUrls, mine, { limit = 150 } = {}) {
  const templated = templatedSections(theirUrls);
  const mineWords = mine.flatMap((p) => [new Set([...topicOf(p.url).words, ...words(p.title || ""), ...words(p.h1 || "")]),
    ...(p.headings || []).map((x) => new Set(words(x)))]);
  const sections = new Map(), gaps = [];
  let covered = 0, skipped = 0;
  for (const u of theirUrls) {
    const t = topicOf(u);
    const s = sections.get(t.section || "/") || { section: t.section || "/", pages: 0, templated: templated.has(t.section), gaps: 0, sample: u };
    s.pages++;
    sections.set(s.section, s);
    if (s.templated || t.words.length < 2) { skipped++; continue; } // templated, or too little in the address to tell
    const need = Math.max(2, Math.ceil(t.words.length * 0.6));
    const best = Math.max(0, ...mineWords.map((ws) => t.words.filter((w) => ws.has(w)).length));
    if (best >= need) { covered++; continue; }
    s.gaps++;
    gaps.push({ url: u, section: s.section, topic: t.label, closest: best });
  }
  return { pages: theirUrls.length, covered, skipped, sections: [...sections.values()].sort((a, b) => b.pages - a.pages), gaps: gaps.slice(0, limit), gapCount: gaps.length };
}

export async function competitorPages(projectId, domains, { ua, load = loadSitemaps, getRobots = (o) => fetchOnce(o + "/robots.txt", ua, "GET", 10000) } = {}) {
  const project = get("SELECT * FROM projects WHERE id=?", Number(projectId)) || fail(404, "Project not found");
  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", project.id) || fail(400, "Run an audit of your own site first");
  const mine = all("SELECT url, title, h1, data FROM pages WHERE audit_id=? AND status=200 AND indexable=1", a.id).map((p) => {
    let data = {};
    try { data = JSON.parse(p.data || "{}"); } catch { /* old row */ }
    return { url: p.url, title: p.title, h1: p.h1, headings: Array.isArray(data.h2s) ? data.h2s : [] };
  });
  const list = (Array.isArray(domains) ? domains : String(domains || "").split(/[\s,]+/)).map((d) => String(d).trim()).filter(Boolean).slice(0, 3);
  if (!list.length) fail(400, "Enter a competitor's website");
  const out = [];
  for (const d of list) {
    let origin;
    try { origin = new URL(/^https?:\/\//i.test(d) ? d : `https://${d}`).origin; } catch { out.push({ site: d, error: "Not a website address" }); continue; }
    const robots = await getRobots(origin).catch(() => ({ status: 0 }));
    const sm = await load(origin, robots.status === 200 ? robots.body : "", ua).catch((e) => ({ urls: [], error: e.message }));
    const urls = [...new Set([...(sm.urls || [])].filter((u) => { try { return new URL(u).origin === origin || new URL(u).host.replace(/^www\./, "") === new URL(origin).host.replace(/^www\./, ""); } catch { return false; } }))].slice(0, MAX_URLS);
    if (!urls.length) { out.push({ site: origin, error: sm.error || "No XML sitemap found (robots.txt Sitemap: lines or /sitemap.xml)" }); continue; }
    out.push({ site: origin, ...pageGap(urls, mine) });
  }
  return { auditId: a.id, myPages: mine.length, sites: out };
}

export function register({ routes }) {
  routes.push(["POST", /^\/api\/projects\/(\d+)\/competitor-pages$/, async ([id], _q, body) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    return competitorPages(p.id, body?.domains, { ua: projectSettings(p).userAgent });
  }]);
}
