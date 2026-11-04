// Google Analytics 4 (Data API, read-only): organic sessions and key events (GA4's current name for conversions) by
// landing page, the organic daily trend, and visits referred by AI assistants (ChatGPT, Perplexity, Gemini, Copilot,
// Claude) by landing page. Signs in like Search Console (google-auth.mjs: the service-account key file, optional
// ga4KeyFile, or the owner's Google account). Each report is fetched on its own: a failed one is recorded in meta
// ga4:<pid> (redacted) and keeps its previous rows. The daily trend keeps history; the other tables hold the last 28 days.
import { readFileSync } from "node:fs";
import { db, all, get, run, projectSettings } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";
import { googleRequest, SCOPES, authMode, serviceKeyFile, secretValues } from "./google-auth.mjs";
import { config } from "./gsc.mjs";
import { redact } from "./alert-channels.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS ga4_pages (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  landing_page TEXT NOT NULL, sessions INTEGER, engaged_sessions INTEGER, key_events REAL, users INTEGER, PRIMARY KEY (project_id, landing_page));
CREATE TABLE IF NOT EXISTS ga4_daily (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date TEXT NOT NULL, sessions INTEGER, engaged_sessions INTEGER, key_events REAL, users INTEGER, PRIMARY KEY (project_id, date));
CREATE TABLE IF NOT EXISTS ga4_key_events (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  landing_page TEXT NOT NULL, event_name TEXT NOT NULL, key_events REAL, PRIMARY KEY (project_id, landing_page, event_name));
CREATE TABLE IF NOT EXISTS ga4_ai (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL, landing_page TEXT NOT NULL, assistant TEXT, sessions INTEGER, engaged_sessions INTEGER, key_events REAL,
  PRIMARY KEY (project_id, source, landing_page));
CREATE TABLE IF NOT EXISTS ga4_channels (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, source TEXT NOT NULL, medium TEXT NOT NULL, campaign TEXT NOT NULL, sessions INTEGER, engaged_sessions INTEGER, key_events REAL,
  PRIMARY KEY (project_id, channel, source, medium, campaign));
`);

export const API = "https://analyticsdata.googleapis.com/v1beta";
export const AI_REGEX = "chatgpt\\.com|chat\\.openai\\.com|perplexity|gemini\\.google\\.com|bard\\.google\\.com|copilot|claude\\.ai";
const ASSISTANTS = [[/chatgpt\.com|openai\.com/i, "ChatGPT"], [/perplexity/i, "Perplexity"], [/gemini\.google|bard\.google/i, "Gemini"], [/copilot/i, "Copilot"], [/claude\.ai/i, "Claude"]];
export const assistantOf = (source) => ASSISTANTS.find(([re]) => re.test(source || ""))?.[1] || "Other";
const ORGANIC = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } };
const METRICS = ["sessions", "engagedSessions", "keyEvents", "totalUsers"].map((name) => ({ name }));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const iso = (d) => d.toISOString().slice(0, 10);

/** "properties/123456789" or "123456789" → "123456789"; anything else → null. */
export function propertyId(v) { const m = String(v || "").trim().match(/^(?:properties\/)?(\d{5,15})$/); return m ? m[1] : null; }

/** One runReport call (tests pass their own `call(propertyId, body)`). */
export const ga4Call = (property, body) => googleRequest(SCOPES.ga4, { url: `${API}/properties/${property}:runReport`, method: "POST", data: body }, { service: "ga4", label: "Google Analytics" });

/** A report paged 10,000 rows at a time up to `max`: rows → { d: [dimension values], m: [numbers] }. */
export async function runReport(property, body, call = ga4Call, max = 50000) {
  const out = [], limit = 10000;
  for (let offset = 0; offset < max; offset += limit) {
    const r = await call(property, { ...body, limit, offset });
    for (const row of r.rows || []) out.push({ d: (row.dimensionValues || []).map((v) => v.value), m: (row.metricValues || []).map((v) => Number(v.value) || 0) });
    if (!r.rows || r.rows.length < limit || out.length >= Number(r.rowCount || 0)) break;
  }
  return out;
}

/** Who needs Viewer access on the property: the service account's email, or the signed-in Google account. */
function accessHolder() {
  if (authMode() === "oauth") return config().googleOAuth?.email || "your signed-in Google account";
  try { return JSON.parse(readFileSync(serviceKeyFile("ga4"), "utf8")).client_email || "the service account"; } catch { return "the service account"; }
}

/** API error → a plain message with the fix (permission, API not enabled, wrong property). Never carries secrets. */
export function friendlyError(e, property) {
  const raw = e.response?.data?.error?.message || e.message || String(e), st = e.response?.data?.error?.status || "";
  let msg = raw;
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(raw)) msg = "Enable the “Google Analytics Data API” in Google Cloud console for the project that owns the key file or OAuth client, then refresh.";
  else if (e.response?.status === 403 || st === "PERMISSION_DENIED") msg = `No access to GA4 property ${property}: add ${accessHolder()} as a Viewer in GA4 Admin → Property access management. (${raw})`;
  else if (e.response?.status === 404 || st === "NOT_FOUND") msg = `GA4 property ${property} was not found: check the Property ID in Admin → Property settings.`;
  return redact(msg, secretValues()).slice(0, 500);
}

/** Fetches the five reports and saves them. call: runReport transport (tests mock it). */
export async function refreshGa4(project, { call = ga4Call, now = Date.now() } = {}) {
  const s = projectSettings(project), property = propertyId(s.ga4Property);
  if (!property) fail(400, "Enter this website's GA4 Property ID in Settings (GA4 Admin → Property settings → Property ID, digits only).");
  const end = new Date(now - 864e5), r28 = { startDate: iso(new Date(end - 27 * 864e5)), endDate: iso(end) }, r90 = { startDate: iso(new Date(end - 89 * 864e5)), endDate: iso(end) };
  const rep = (body, max) => runReport(property, body, call, max).catch((e) => ({ error: friendlyError(e, property) }));
  const [pages, daily, keyEvents, ai, channels] = await Promise.all([
    rep({ dateRanges: [r28], dimensions: [{ name: "landingPage" }], metrics: METRICS, dimensionFilter: ORGANIC, orderBys: [{ metric: { metricName: "sessions" }, desc: true }] }),
    rep({ dateRanges: [r90], dimensions: [{ name: "date" }], metrics: METRICS, dimensionFilter: ORGANIC }),
    rep({ dateRanges: [r28], dimensions: [{ name: "landingPage" }, { name: "eventName" }], metrics: [{ name: "keyEvents" }], dimensionFilter: ORGANIC,
      metricFilter: { filter: { fieldName: "keyEvents", numericFilter: { operation: "GREATER_THAN", value: { int64Value: "0" } } } } }),
    rep({ dateRanges: [r28], dimensions: [{ name: "sessionSource" }, { name: "landingPage" }], metrics: METRICS.slice(0, 3),
      dimensionFilter: { filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: AI_REGEX, caseSensitive: false } } } }),
    // Every channel, not only organic (2026-11-04): engagement and bounce rate per channel, and Google Ads clicks that
    // arrive without a campaign name (google / cpc, "(not set)"), i.e. Ads not linked to this property.
    rep({ dateRanges: [r28], dimensions: ["sessionDefaultChannelGroup", "sessionSource", "sessionMedium", "sessionCampaignName"].map((name) => ({ name })),
      metrics: METRICS.slice(0, 3) }),
  ]);
  const errors = {};
  db.exec("BEGIN");
  try {
    if (Array.isArray(pages)) {
      run("DELETE FROM ga4_pages WHERE project_id=?", project.id);
      const ins = db.prepare("INSERT OR REPLACE INTO ga4_pages (project_id, landing_page, sessions, engaged_sessions, key_events, users) VALUES (?,?,?,?,?,?)");
      for (const r of pages) ins.run(project.id, r.d[0], ...r.m);
    } else errors.pages = pages.error;
    if (Array.isArray(daily)) {
      const ins = db.prepare("INSERT OR REPLACE INTO ga4_daily (project_id, date, sessions, engaged_sessions, key_events, users) VALUES (?,?,?,?,?,?)");
      for (const r of daily) ins.run(project.id, r.d[0].replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"), ...r.m);
    } else errors.daily = daily.error;
    if (Array.isArray(keyEvents)) {
      run("DELETE FROM ga4_key_events WHERE project_id=?", project.id);
      const ins = db.prepare("INSERT OR REPLACE INTO ga4_key_events (project_id, landing_page, event_name, key_events) VALUES (?,?,?,?)");
      for (const r of keyEvents) ins.run(project.id, r.d[0], r.d[1], r.m[0]);
    } else errors.keyEvents = keyEvents.error;
    if (Array.isArray(ai)) {
      run("DELETE FROM ga4_ai WHERE project_id=?", project.id);
      const ins = db.prepare("INSERT OR REPLACE INTO ga4_ai (project_id, source, landing_page, assistant, sessions, engaged_sessions, key_events) VALUES (?,?,?,?,?,?,?)");
      for (const r of ai) ins.run(project.id, r.d[0], r.d[1], assistantOf(r.d[0]), ...r.m);
    } else errors.ai = ai.error;
    if (Array.isArray(channels)) {
      run("DELETE FROM ga4_channels WHERE project_id=?", project.id);
      const ins = db.prepare(`INSERT INTO ga4_channels (project_id, channel, source, medium, campaign, sessions, engaged_sessions, key_events) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT DO UPDATE SET sessions=sessions+excluded.sessions, engaged_sessions=engaged_sessions+excluded.engaged_sessions, key_events=key_events+excluded.key_events`);
      for (const r of channels) ins.run(project.id, ...r.d.map((v) => v || "(not set)"), ...r.m);
    } else errors.channels = channels.error;
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", `ga4:${project.id}`, JSON.stringify({ property, ...r28, trendStart: r90.startDate, fetchedAt: new Date(now).toISOString(), errors }));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return ga4Data(project.id);
}

/** Stored GA4 data for the Analytics screen. */
export function ga4Data(projectId) {
  const p = get("SELECT * FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const property = propertyId(projectSettings(p).ga4Property);
  const m = JSON.parse(get("SELECT value FROM meta WHERE key=?", `ga4:${projectId}`)?.value || "null");
  const out = { configured: Boolean(property), property, mode: authMode(), fetchedAt: m?.fetchedAt || null, startDate: m?.startDate || null, endDate: m?.endDate || null, errors: m?.errors || {} };
  if (!m) return { ...out, daily: [], pages: [], keyEvents: [], ai: { assistants: [], rows: [] }, channels: [], adsUnlinked: null, totals: null };
  // GA4: bounce rate = sessions that weren't engaged (engaged = over 10 s, a key event or 2+ page views) = 1 - engagement rate.
  const channels = all(`SELECT channel, SUM(sessions) sessions, SUM(engaged_sessions) engagedSessions, SUM(key_events) keyEvents
    FROM ga4_channels WHERE project_id=? GROUP BY channel ORDER BY sessions DESC`, projectId)
    .map((c) => ({ ...c, engagementRate: c.sessions ? c.engagedSessions / c.sessions : null, bounceRate: c.sessions ? 1 - c.engagedSessions / c.sessions : null }));
  const ads = get(`SELECT SUM(sessions) sessions, SUM(key_events) keyEvents FROM ga4_channels WHERE project_id=? AND lower(source)='google' AND lower(medium)='cpc'
    AND campaign LIKE '(%)'`, projectId); // GA4 placeholders: "(not set)", and "(organic)" seen on google / cpc when Ads isn't linked
  const totals = get(`SELECT SUM(sessions) sessions, SUM(engaged_sessions) engagedSessions, SUM(key_events) keyEvents, SUM(users) users FROM ga4_pages WHERE project_id=?`, projectId);
  return { ...out, totals, channels, adsUnlinked: ads?.sessions ? { sessions: ads.sessions, keyEvents: ads.keyEvents || 0 } : null,
    daily: all("SELECT date, sessions, engaged_sessions engagedSessions, key_events keyEvents, users FROM ga4_daily WHERE project_id=? ORDER BY date", projectId),
    pages: all("SELECT landing_page page, sessions, engaged_sessions engagedSessions, key_events keyEvents, users FROM ga4_pages WHERE project_id=? ORDER BY sessions DESC LIMIT 200", projectId),
    keyEvents: all("SELECT landing_page page, event_name event, key_events keyEvents FROM ga4_key_events WHERE project_id=? ORDER BY key_events DESC LIMIT 200", projectId),
    ai: { assistants: all(`SELECT assistant, SUM(sessions) sessions, SUM(engaged_sessions) engagedSessions, SUM(key_events) keyEvents, COUNT(DISTINCT landing_page) pages
            FROM ga4_ai WHERE project_id=? GROUP BY assistant ORDER BY sessions DESC`, projectId),
      rows: all("SELECT assistant, source, landing_page page, sessions, engaged_sessions engagedSessions, key_events keyEvents FROM ga4_ai WHERE project_id=? ORDER BY sessions DESC LIMIT 200", projectId) } };
}

const busy = new Set();
export function register({ routes }) {
  afterAudit.push(async (auditId, project) => {
    const p = get("SELECT * FROM projects WHERE id=?", project.id);
    if (!p || !propertyId(projectSettings(p).ga4Property)) return;
    const last = get("SELECT value FROM meta WHERE key=?", `ga4:${p.id}`);
    if (last && Date.now() - Date.parse(JSON.parse(last.value).fetchedAt) < 12 * 3600e3) return;
    phase(p.id, auditId, "Google Analytics");
    await refreshGa4(p).catch((e) => console.error("ga4:", redact(e.message, secretValues())));
  });
  routes.push(["GET", /^\/api\/projects\/(\d+)\/ga4$/, ([id]) => ({ ...ga4Data(Number(id)), running: busy.has(Number(id)) })]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/ga4$/, async ([id]) => {
    const p = get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
    if (busy.has(p.id)) fail(409, "Google Analytics is already being fetched");
    busy.add(p.id);
    try { return await refreshGa4(p); } finally { busy.delete(p.id); }
  }]);
}
