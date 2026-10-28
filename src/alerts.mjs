// Alert rules per project (each on/off, sensible defaults): after an audit — new errors, Site Health drop, robots.txt
// changed, pages turned non-indexable, new 5xx; from stored data — Search Console clicks/impressions drop (week vs the
// week before), more pages "not indexed" in URL Inspection, rank drops. Alerts are deduplicated (the same alert at most
// once per period), logged, and sent as one message per project per run through alert-channels.mjs.
//
// Data the rules read from other modules goes through `feeds` (a small interface; each is projectId → rows or null).
// Defaults read today's tables; the rank tracker (REQ-055 group 4) plugs in with provideFeed("rankEvents", fn), and a
// longer daily Search Console history with provideFeed("gscDaily", fn). A missing feed skips its rule with a reason.
import { db, all, get, run } from "./db.mjs";
import { CHECKS } from "./checks.mjs";
import { afterAudit } from "./runner.mjs";
import { deliver, channelConfig, redact } from "./alert-channels.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS monitor_settings (project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS alert_log (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule TEXT NOT NULL, fingerprint TEXT NOT NULL, title TEXT, detail TEXT, severity TEXT, audit_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), delivery TEXT);
CREATE INDEX IF NOT EXISTS idx_alert_log ON alert_log(project_id, rule, fingerprint);
`);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const DAY = 864e5;
const plural = (n, w, ws = w + "s") => `${n.toLocaleString("en-AU")} ${n === 1 ? w : ws}`;

// ---------------------------------------------------------------- feeds (interface for data other modules own)
/** Daily site totals [{date, clicks, impressions}] from the stored Search Console data, or null when there is none. */
export function storedGscDaily(projectId) {
  const rows = all("SELECT date, clicks, impressions FROM gsc_daily WHERE project_id=? ORDER BY date", projectId);
  if (rows.length) return rows;
  const t = all("SELECT date, clicks, impressions FROM gsc_trend WHERE project_id=? AND segment='all' ORDER BY date", projectId);
  return t.length ? t : null;
}
/** URL Inspection runs, newest first: [{id, at, counts: {kind: n}}] (indexing.mjs stores counts per finished run). */
export function storedIndexRuns(projectId) {
  const rows = all("SELECT id, finished_at at, counts FROM index_runs WHERE project_id=? AND counts IS NOT NULL ORDER BY id DESC LIMIT 2", projectId);
  return rows.length ? rows.map((r) => ({ ...r, counts: JSON.parse(r.counts) })) : null;
}
const safe = (fn) => (id) => { try { return fn(id); } catch { return null; } }; // a table a module didn't create yet = no data
export const feeds = { gscDaily: safe(storedGscDaily), indexRuns: safe(storedIndexRuns),
  rankEvents: null }; // [{type: "drop"|"lost_top10"|"new_top3", query, from, to, impressions, page?, date?}] — rank tracker
export function provideFeed(name, fn) { if (!(name in feeds)) throw new Error(`Unknown feed ${name}`); feeds[name] = fn ? safe(fn) : null; }

// ---------------------------------------------------------------- pure rule logic (tested with fixtures)
const iso = (t) => new Date(t).toISOString().slice(0, 10);
/** Last 7 days vs the 7 before, from daily rows. Days missing inside the 14 count as 0 (Search Console leaves out
 *  days with no data); needs rows reaching back 14 days. Returns per metric {from, to, change} or null. */
export function weekOverWeek(rows) {
  if (!rows?.length) return null;
  const last = rows.reduce((m, r) => (r.date > m ? r.date : m), "");
  const lastT = Date.parse(last + "T00:00:00Z"), cutPrev = iso(lastT - 13 * DAY), cutCur = iso(lastT - 6 * DAY);
  if (!rows.some((r) => r.date <= cutPrev)) return null;
  const sum = (from, to, k) => rows.filter((r) => r.date >= from && r.date <= to).reduce((t, r) => t + (Number(r[k]) || 0), 0);
  const out = { start: cutCur, end: last, prevStart: cutPrev, prevEnd: iso(lastT - 7 * DAY) };
  for (const k of ["clicks", "impressions"]) {
    const from = sum(cutPrev, out.prevEnd, k), to = sum(cutCur, last, k);
    out[k] = { from, to, change: from ? (to - from) / from : null };
  }
  return out;
}
/** Not-indexed pages in one run's counts (every kind except the indexed ones). */
export const notIndexed = (counts) => Object.entries(counts || {}).filter(([k]) => !["indexed", "indexed_blocked", "indexed_no_content"].includes(k)).reduce((t, [, n]) => t + n, 0);
/** robots.txt line sets: what was added and removed (comments and blank lines ignored, case kept). */
export function robotsDiff(before, after) {
  const lines = (s) => new Set(String(s || "").split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean));
  const a = lines(before), b = lines(after);
  return { added: [...b].filter((l) => !a.has(l)), removed: [...a].filter((l) => !b.has(l)) };
}

// ---------------------------------------------------------------- rules
// scope "audit": evaluated once per finished audit (fingerprint = audit id). scope "data": evaluated after audits and
// on a timer; periodHours = how long the same alert stays quiet.
export const RULES = {
  new_errors: { scope: "audit", label: "New errors after an audit", defaults: { on: true },
    help: "Error-level issues on pages that didn't have them in the previous audit." },
  health_drop: { scope: "audit", label: "Site Health drops", defaults: { on: true, min: 3 }, fields: { min: "points" },
    help: "Site Health is this tool's score, not a Google metric." },
  robots_changed: { scope: "audit", label: "robots.txt changed", defaults: { on: true },
    help: "Any change in robots.txt rules between two audits (comments ignored). Google usually re-reads robots.txt within about a day." },
  noindex: { scope: "audit", label: "Pages turned non-indexable", defaults: { on: true, min: 1 }, fields: { min: "pages" },
    help: "Pages that were indexable in the previous audit and now aren't (noindex, canonical elsewhere, error or redirect)." },
  new_5xx: { scope: "audit", label: "New 5xx server errors", defaults: { on: true },
    help: "Pages answering with a server error that didn't in the previous audit." },
  gsc_drop: { scope: "data", periodHours: 7 * 24, label: "Search Console clicks or impressions drop", defaults: { on: true, pct: 30, minClicks: 20, minImpressions: 200 },
    fields: { pct: "% drop", minClicks: "min. clicks the week before", minImpressions: "min. impressions the week before" },
    help: "Last 7 days of Search Console data vs the 7 days before. Search Console's data is about 2–3 days behind, and weekly swings are normal for small sites, hence the minimums." },
  index_rise: { scope: "data", periodHours: 24 * 3650, label: "More pages not indexed (URL Inspection)", defaults: { on: true, min: 10 }, fields: { min: "pages" },
    help: "Compares the last two Index status runs: wanted pages Google reports as not indexed." },
  rank_drop: { scope: "data", periodHours: 7 * 24, label: "Rank drops (rank tracker)", defaults: { on: true },
    help: "Target keywords whose average position got worse, or that left the top 10, as reported by the rank tracker." },
  rank_gain: { scope: "data", periodHours: 7 * 24, label: "New top-3 rankings (rank tracker)", defaults: { on: false },
    help: "Good news: a target keyword reached the top 3." },
};

const issueSet = (auditId, where) => new Set(all(`SELECT DISTINCT check_id || char(0) || url k FROM issues WHERE audit_id=? AND ${where}`, auditId).map((r) => r.k));
const CHECK = {
  new_errors(ctx) {
    const prev = issueSet(ctx.prev.id, "severity='error'"), added = [...issueSet(ctx.audit.id, "severity='error'")].filter((k) => !prev.has(k));
    if (!added.length) return [];
    const by = new Map(); for (const k of added) { const c = k.split("\0")[0]; by.set(c, (by.get(c) || 0) + 1); }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${CHECKS[c]?.[1] || c} (${n})`);
    return [{ title: `${plural(added.length, "new error")} since the last audit`, detail: top.join("; "), severity: "error", urls: [...new Set(added.map((k) => k.split("\0")[1]))].slice(0, 10) }];
  },
  health_drop(ctx, s) {
    const drop = (ctx.prev.health ?? 0) - (ctx.audit.health ?? 0);
    return drop >= s.min ? [{ title: `Site Health ${ctx.prev.health} → ${ctx.audit.health}`, detail: `Down ${drop} points since the previous audit (this tool's score, not a Google metric).`, severity: "warning" }] : [];
  },
  robots_changed(ctx) {
    let rows; try { rows = all("SELECT audit_id, status, body FROM audit_robots WHERE audit_id IN (?,?)", ctx.audit.id, ctx.prev.id); } catch { return { skipped: "robots.txt history not stored" }; }
    const cur = rows.find((r) => r.audit_id === ctx.audit.id), old = rows.find((r) => r.audit_id === ctx.prev.id);
    if (!cur || !old) return { skipped: "robots.txt not stored for both audits" };
    const d = robotsDiff(old.status === 200 ? old.body : "", cur.status === 200 ? cur.body : "");
    if (!d.added.length && !d.removed.length && (old.status === 200) === (cur.status === 200)) return [];
    const detail = old.status !== cur.status && (old.status === 200 || cur.status === 200) ? `robots.txt answered HTTP ${old.status} before, HTTP ${cur.status} now.`
      : `${plural(d.added.length, "line")} added, ${plural(d.removed.length, "line")} removed.`;
    return [{ title: "robots.txt changed", detail, severity: d.added.some((l) => /^disallow\s*:\s*\S/i.test(l)) ? "error" : "warning",
      urls: [...d.added.map((l) => "+ " + l), ...d.removed.map((l) => "− " + l)].slice(0, 10) }];
  },
  noindex(ctx, s) {
    const urls = all(`SELECT c.url FROM pages c JOIN pages p ON p.audit_id=? AND p.url=c.url WHERE c.audit_id=? AND p.indexable=1 AND c.indexable=0 ORDER BY c.url`, ctx.prev.id, ctx.audit.id).map((r) => r.url);
    return urls.length >= s.min ? [{ title: `${plural(urls.length, "page")} turned non-indexable`, detail: "Indexable in the previous audit, not any more. Check that this was intended.", severity: "error", urls: urls.slice(0, 10) }] : [];
  },
  new_5xx(ctx) {
    const prev = issueSet(ctx.prev.id, "check_id='http_5xx'"), added = [...issueSet(ctx.audit.id, "check_id='http_5xx'")].filter((k) => !prev.has(k)).map((k) => k.split("\0")[1]);
    return added.length ? [{ title: `${plural(added.length, "new page")} with a 5xx server error`, detail: "The server failed to return these pages during the audit.", severity: "error", urls: added.slice(0, 10) }] : [];
  },
  gsc_drop(ctx, s) {
    const rows = feeds.gscDaily?.(ctx.project.id);
    if (!rows) return { skipped: "No Search Console data yet" };
    const w = weekOverWeek(rows);
    if (!w) return { skipped: "Needs 14 days of Search Console data" };
    const out = [];
    for (const [k, min] of [["clicks", s.minClicks], ["impressions", s.minImpressions]]) {
      const m = w[k];
      if (m.from >= min && m.change !== null && -m.change * 100 >= s.pct) out.push({ fingerprint: k, severity: "warning",
        title: `Search Console ${k} down ${Math.round(-m.change * 100)}% week on week`,
        detail: `${m.from.toLocaleString("en-AU")} (${w.prevStart} to ${w.prevEnd}) → ${m.to.toLocaleString("en-AU")} (${w.start} to ${w.end}).` });
    }
    return out;
  },
  index_rise(ctx, s) {
    const runs = feeds.indexRuns?.(ctx.project.id);
    if (!runs || runs.length < 2) return { skipped: "Needs two Index status runs" };
    const [cur, prev] = runs, a = notIndexed(prev.counts), b = notIndexed(cur.counts);
    return b - a >= s.min ? [{ fingerprint: `run:${cur.id}`, severity: "warning", title: `${plural(b - a, "more page")} not indexed`,
      detail: `URL Inspection: ${a} → ${b} wanted pages not indexed between the last two Index status runs.` }] : [];
  },
  rank_drop: (ctx) => rankItems(ctx, ["drop", "lost_top10"]),
  rank_gain: (ctx) => rankItems(ctx, ["new_top3"]),
};
function rankItems(ctx, types) {
  if (!feeds.rankEvents) return { skipped: "Rank tracker data not available" };
  const ev = feeds.rankEvents(ctx.project.id);
  if (!ev) return { skipped: "No rank tracker data yet" };
  const pos = (p) => (p === null || p === undefined ? "–" : Number(p).toFixed(1));
  return ev.filter((e) => types.includes(e.type)).map((e) => ({ fingerprint: `${e.type}:${e.query}`, severity: e.type === "new_top3" ? "notice" : "warning",
    title: e.type === "new_top3" ? `"${e.query}" reached the top 3` : e.type === "lost_top10" ? `"${e.query}" left the top 10` : `"${e.query}" dropped ${pos(e.from)} → ${pos(e.to)}`,
    detail: `Average position ${pos(e.from)} → ${pos(e.to)}${e.impressions ? `, ${e.impressions.toLocaleString("en-AU")} impressions` : ""}${e.page ? ` · ${e.page}` : ""}.` }));
}

// ---------------------------------------------------------------- per-project settings
export const readSettings = (projectId) => JSON.parse(get("SELECT data FROM monitor_settings WHERE project_id=?", projectId)?.data || "{}");
export const writeSettings = (projectId, data) => run("INSERT OR REPLACE INTO monitor_settings (project_id, data) VALUES (?,?)", projectId, JSON.stringify(data));
export function projectAlerts(projectId) {
  const s = readSettings(projectId), rules = {};
  for (const [id, r] of Object.entries(RULES)) rules[id] = { ...r.defaults, ...(s.rules?.[id] || {}) };
  return { rules, mute: s.mute === true, emailTo: s.emailTo || "" };
}
export function updateProjectAlerts(projectId, b = {}) {
  const s = readSettings(projectId);
  s.rules ||= {};
  for (const [id, x] of Object.entries(b.rules || {})) {
    const r = RULES[id]; if (!r || typeof x !== "object") continue;
    const next = { ...(s.rules[id] || {}) };
    if (x.on !== undefined) next.on = Boolean(x.on);
    for (const k of Object.keys(r.fields || {})) if (x[k] !== undefined) { const n = Number(x[k]); if (!(n >= 0 && n <= 1e7)) fail(400, `${r.label}: enter a number`); next[k] = n; }
    s.rules[id] = next;
  }
  if (b.mute !== undefined) s.mute = Boolean(b.mute);
  if (b.emailTo !== undefined) {
    const list = String(b.emailTo).split(/[,;\s]+/).filter(Boolean);
    if (list.length > 20 || !list.every((e) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e))) fail(400, "Recipients: valid email addresses, separated by commas");
    s.emailTo = list.join(", ");
  }
  writeSettings(projectId, s);
  return projectAlerts(projectId);
}

// ---------------------------------------------------------------- evaluate, dedupe, log, send
/** Rule results for a project, without sending: { items: [{rule, fingerprint, title, detail, severity, urls}], skipped: [{rule, reason}] }. */
export function evaluate(projectId, { auditId, scope = "all" } = {}) {
  const project = get("SELECT * FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const audit = auditId ? get("SELECT * FROM audits WHERE id=? AND status='done'", auditId) : get("SELECT * FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  const prev = audit && get("SELECT * FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", projectId, audit.id);
  const settings = projectAlerts(projectId), items = [], skipped = [];
  for (const [id, r] of Object.entries(RULES)) {
    const s = settings.rules[id];
    if (!s.on || (scope !== "all" && r.scope !== scope)) continue;
    if (r.scope === "audit" && !audit) { skipped.push({ rule: id, reason: "No finished audit yet" }); continue; }
    if (r.scope === "audit" && !prev) { skipped.push({ rule: id, reason: "First audit: nothing to compare with yet" }); continue; }
    let res;
    try { res = CHECK[id]({ project, audit, prev }, s); } catch (e) { skipped.push({ rule: id, reason: redact(e.message) }); continue; }
    if (!Array.isArray(res)) { skipped.push({ rule: id, reason: res.skipped }); continue; }
    for (const it of res) items.push({ ...it, rule: id, auditId: r.scope === "audit" ? audit.id : null,
      fingerprint: r.scope === "audit" ? `audit:${audit.id}` : String(it.fingerprint || id) });
  }
  return { project, items, skipped };
}

function alreadySent(projectId, it) {
  const r = RULES[it.rule];
  if (r.scope === "audit") return Boolean(get("SELECT 1 x FROM alert_log WHERE project_id=? AND rule=? AND fingerprint=?", projectId, it.rule, it.fingerprint));
  const hours = Math.max(r.periodHours || 0, channelConfig().dedupHours);
  return Boolean(get("SELECT 1 x FROM alert_log WHERE project_id=? AND rule=? AND fingerprint=? AND created_at > datetime('now', ?)", projectId, it.rule, it.fingerprint, `-${hours} hours`));
}

/** Evaluates, drops alerts already sent in their period, logs the rest and sends them as one message. */
export async function runAlerts(projectId, { auditId, scope = "all", deps } = {}) {
  const { project, items, skipped } = evaluate(projectId, { auditId, scope });
  const fresh = items.filter((it) => !alreadySent(projectId, it));
  const settings = projectAlerts(projectId);
  let delivery = null;
  if (fresh.length && !settings.mute) delivery = await deliver({ project, items: fresh, emailTo: settings.emailTo || undefined }, { deps });
  const ins = db.prepare("INSERT INTO alert_log (project_id, rule, fingerprint, title, detail, severity, audit_id, delivery) VALUES (?,?,?,?,?,?,?,?)");
  for (const it of fresh) ins.run(projectId, it.rule, it.fingerprint, it.title, it.detail || null, it.severity, it.auditId, JSON.stringify(settings.mute ? { muted: true } : delivery || {}));
  run("DELETE FROM alert_log WHERE project_id=? AND id NOT IN (SELECT id FROM alert_log WHERE project_id=? ORDER BY id DESC LIMIT 500)", projectId, projectId);
  return { sent: fresh.length, duplicates: items.length - fresh.length, skipped, delivery, muted: settings.mute };
}

export function alertLog(projectId, limit = 50) {
  return all("SELECT id, rule, title, detail, severity, audit_id, created_at, delivery FROM alert_log WHERE project_id=? ORDER BY id DESC LIMIT ?", projectId, limit)
    .map((r) => ({ ...r, delivery: JSON.parse(r.delivery || "{}") }));
}

/** Data rules (and due reports, see report-delivery.mjs) for every project; the in-app timer and the scheduled task call it. */
export async function checkAll({ deps } = {}) {
  const out = [];
  for (const p of all("SELECT id FROM projects")) out.push({ projectId: p.id, ...(await runAlerts(p.id, { scope: "data", deps }).catch((e) => ({ error: redact(e.message) }))) });
  return out;
}

const CHECK_EVERY = 30 * 60e3;
export function register({ routes, cli } = {}) {
  afterAudit.push((auditId, project) => runAlerts(project.id, { auditId })); // channel errors are caught and logged in deliver()
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/alerts$/, ([id]) => {
    const p = project(id), feedState = { gscDaily: Boolean(feeds.gscDaily?.(p.id)), indexRuns: Boolean(feeds.indexRuns?.(p.id)), rankEvents: Boolean(feeds.rankEvents && feeds.rankEvents(p.id)) };
    return { ...projectAlerts(p.id), catalog: Object.entries(RULES).map(([rid, r]) => ({ id: rid, label: r.label, help: r.help, scope: r.scope, fields: r.fields || {} })), feeds: feedState, log: alertLog(p.id) };
  }]);
  routes.push(["PUT", /^\/api\/projects\/(\d+)\/alerts$/, ([id], q, b) => updateProjectAlerts(project(id).id, b)]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/alerts\/run$/, ([id]) => runAlerts(project(id).id)]);
  if (cli) return;
  setTimeout(() => checkAll().catch(() => {}), 2 * 60e3).unref?.();
  setInterval(() => checkAll().catch(() => {}), CHECK_EVERY).unref?.();
}
