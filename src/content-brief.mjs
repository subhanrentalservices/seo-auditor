// Content brief (REQ-055 group 6, item 5), paid and opt-in: one DataForSEO Google SERP call for a topic (the owner's
// button; the monthly budget is checked against the estimate first) gives the top-10 results, People Also Ask and
// related searches. Then the free polite reader (robots.txt obeyed, the tool's own user agent) reads those 10 pages for
// their H2/H3 headings only, and the headings are merged by their stemmed words with how many pages use each. Added:
// the site's own Search Console searches containing the topic's words, questions first. An outline of what searchers
// and the ranking pages cover; no text is generated and nothing from those pages is copied beyond their headings.
import * as cheerio from "cheerio";
import { db, all, get, run, projectSettings } from "./db.mjs";
import { words } from "./page2.mjs";
import { isQuestion } from "./queries.mjs";
import { leaderClusters } from "./clusters.mjs";
import { createPolite, startJob, jobStatus } from "./polite-fetch.mjs";
import { dfs, budget, spentThisMonth } from "./dataforseo.mjs";
import { call } from "./visibility.mjs";

db.exec(`CREATE TABLE IF NOT EXISTS content_briefs (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), status TEXT, data TEXT)`);

export const SERP_COST = 0.002; // serp/google/organic/live/advanced, first 10 results (USD, DataForSEO price list)
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** The parts of a SERP answer a brief uses. */
export function parseSerp(items = []) {
  const organic = items.filter((i) => i?.type === "organic" && (!i.rank_group || i.rank_group <= 10)).slice(0, 10)
    .map((i) => ({ pos: i.rank_group ?? null, url: i.url || "", domain: host(i.url || i.domain), title: String(i.title || "").slice(0, 200) })).filter((x) => /^https?:\/\//.test(x.url));
  const paa = [...new Set(items.filter((i) => i?.type === "people_also_ask").flatMap((i) => i.items || []).map((x) => String(x.title || "").trim()).filter(Boolean))].slice(0, 12);
  const related = [...new Set(items.filter((i) => i?.type === "related_searches").flatMap((i) => i.items || []).map((x) => String(typeof x === "string" ? x : x?.title || "").trim()).filter(Boolean))].slice(0, 12);
  return { organic, paa, related };
}

/** H2 and H3 texts of a page (outside nav, header, footer and aside), up to 40. */
export function headingsOf(html) {
  const $ = cheerio.load(String(html || ""));
  $("nav, header, footer, aside, script, style, noscript").remove();
  const out = [];
  $("h2, h3").each((_, e) => { const t = $(e).text().replace(/\s+/g, " ").trim(); if (t && t.length <= 150 && out.length < 40) out.push({ level: e.tagName.toLowerCase(), text: t }); });
  return out;
}

/** Headings from several pages merged by stemmed words: [{ text, pages, variants }], most pages first. */
export function mergeHeadings(perPage) {
  const items = [];
  perPage.forEach((hs, i) => { for (const hd of hs) { const ws = new Set(words(hd.text)); if (ws.size) items.push({ key: `${i}:${hd.text}`, page: i, text: hd.text, pages: new Set(), words: ws, weight: 1 }); } });
  return leaderClusters(items, { wordJ: 0.6 }).map((c) => {
    const ms = c.members.map((m) => m.item);
    const texts = [...new Set(ms.map((m) => m.text))];
    return { text: texts.sort((a, b) => a.length - b.length)[0], pages: new Set(ms.map((m) => m.page)).size, variants: texts.slice(0, 5) };
  }).sort((a, b) => b.pages - a.pages || a.text.localeCompare(b.text)).slice(0, 60);
}

/** The site's Search Console searches containing every word of the topic (stemmed): questions first, then impressions. */
export function siteSearches(projectId, topic) {
  if (!get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gsc_queries'")) return [];
  const need = words(topic);
  const rows = all("SELECT query, SUM(impressions) impressions, SUM(clicks) clicks FROM gsc_queries WHERE project_id=? GROUP BY query", projectId)
    .filter((r) => { const w = new Set(words(r.query)); return need.every((x) => w.has(x)); });
  return rows.map((r) => ({ ...r, question: isQuestion(r.query) })).sort((a, b) => b.question - a.question || b.impressions - a.impressions).slice(0, 30);
}

export function cleanTopic(t) {
  const s = String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (s.length < 2 || s.length > 100 || !words(s).length) fail(400, "Enter a topic or search of 2 to 100 characters");
  return s;
}

/** Paid step (on the owner's button): one SERP call, stored as a brief. Then the free headings job starts. */
export async function createBrief(project, topicIn, { send = dfs, spent = spentThisMonth, cap = budget, background = true, ...pol } = {}) {
  const topic = cleanTopic(topicIn);
  if (spent() + SERP_COST > cap()) fail(402, `This would cost about $${SERP_COST.toFixed(3)} and pass the monthly DataForSEO budget of $${cap().toFixed(2)} ($${spent().toFixed(2)} spent). Raise it in Settings if you want more.`);
  if (jobStatus("brief", project.id)?.running) fail(409, "A brief is still reading pages: wait for it to finish");
  const s = projectSettings(project);
  const r = await call("serp/google/organic/live/advanced", { keyword: topic, location_code: Number(s.aiLocation) || Number(s.dfsLocation) || 2036, language_code: s.dfsLanguage || "en", device: "desktop", depth: 10 }, project.id, send);
  const serp = parseSerp(r.items || []);
  const data = { ...serp, headings: [], pagesRead: [], siteSearches: siteSearches(project.id, topic) };
  const id = Number(run("INSERT INTO content_briefs (project_id, topic, status, data) VALUES (?,?,?,?)", project.id, topic, "reading", JSON.stringify(data)).lastInsertRowid);
  const job = startJob("brief", project.id, (progress) => readHeadings(id, progress, pol));
  if (!background) await job;
  return { id, topic, status: background ? "reading" : get("SELECT status FROM content_briefs WHERE id=?", id).status };
}

/** Free step: the top-10 pages' H2/H3 through the polite reader. */
export async function readHeadings(id, progress = () => {}, pol = {}) {
  const b = get("SELECT * FROM content_briefs WHERE id=?", id);
  const data = JSON.parse(b.data);
  const polite = createPolite(pol);
  const per = [];
  try {
    for (const [i, o] of data.organic.entries()) {
      progress(i, data.organic.length, o.domain);
      const r = await polite.page(o.url);
      const hs = r.status === 200 && /html/i.test(r.type || "text/html") ? headingsOf(r.body) : [];
      data.pagesRead.push({ url: o.url, status: r.blocked ? "disallowed by robots.txt" : r.status === 200 ? `${hs.length} headings` : r.error || `HTTP ${r.status}` });
      per.push(hs);
    }
    data.headings = mergeHeadings(per);
    run("UPDATE content_briefs SET status='done', data=? WHERE id=?", JSON.stringify(data), id);
  } catch (e) {
    run("UPDATE content_briefs SET status=?, data=? WHERE id=?", `failed: ${e.message}`.slice(0, 200), JSON.stringify(data), id);
    throw e;
  }
  progress(data.organic.length, data.organic.length, "done");
}

const shape = (b) => b && { id: b.id, topic: b.topic, createdAt: b.created_at, status: b.status, ...JSON.parse(b.data || "{}") };

export function register({ routes }) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/briefs$/, ([id]) => {
    const p = project(id);
    return { cost: SERP_COST, job: jobStatus("brief", p.id), briefs: all("SELECT id, topic, created_at, status FROM content_briefs WHERE project_id=? ORDER BY id DESC LIMIT 50", p.id).map((b) => ({ id: b.id, topic: b.topic, createdAt: b.created_at, status: b.status })) };
  }]);
  routes.push(["GET", /^\/api\/projects\/(\d+)\/briefs\/(\d+)$/, ([id, bid]) => shape(get("SELECT * FROM content_briefs WHERE id=? AND project_id=?", Number(bid), project(id).id)) || fail(404, "Brief not found")]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/briefs$/, ([id], _q, body) => createBrief(project(id), body?.topic)]);
  routes.push(["DELETE", /^\/api\/projects\/(\d+)\/briefs\/(\d+)$/, ([id, bid]) => {
    const p = project(id);
    if (!run("DELETE FROM content_briefs WHERE id=? AND project_id=?", Number(bid), p.id).changes) fail(404, "Brief not found");
    return { ok: true };
  }]);
}
