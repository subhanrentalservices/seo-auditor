// Scheduled report delivery: the project's latest report (HTML, or PDF via Playwright) emailed through the SMTP server
// in App settings, or saved to a folder, weekly or monthly per project. Runs while the app runs (checked every 30 min)
// and from the scheduled task (scheduled-run.mjs). Also serves the report branding settings (branding.mjs).
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { all, get, run } from "./db.mjs";
import { buildReport, reportPdf } from "./report.mjs";
import { channelConfig, redact } from "./alert-channels.mjs";
import { sendMail, emailList, validEmail } from "./smtp.mjs";
import { readSettings, writeSettings, projectAlerts } from "./alerts.mjs";
import { cleanBranding, appBranding, saveAppBranding, projectBranding, brandingFor } from "./branding.mjs";

export const REPORT_DEFAULTS = { schedule: "off", format: "pdf", delivery: "email", to: "", folder: "" };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const DAY = 864e5;

export const reportSettings = (projectId) => ({ ...REPORT_DEFAULTS, ...(readSettings(projectId).report || {}) });
export function updateReportSettings(projectId, b = {}) {
  const s = readSettings(projectId), r = { ...REPORT_DEFAULTS, ...(s.report || {}) };
  if (b.schedule !== undefined) { if (!["off", "weekly", "monthly"].includes(b.schedule)) fail(400, "Schedule: off, weekly or monthly"); r.schedule = b.schedule; }
  if (b.format !== undefined) { if (!["pdf", "html"].includes(b.format)) fail(400, "Format: pdf or html"); r.format = b.format; }
  if (b.delivery !== undefined) { if (!["email", "folder"].includes(b.delivery)) fail(400, "Delivery: email or folder"); r.delivery = b.delivery; }
  if (b.to !== undefined) { const l = emailList(b.to); if (l.length > 20 || !l.every(validEmail)) fail(400, "Recipients: valid email addresses, separated by commas"); r.to = l.join(", "); }
  if (b.folder !== undefined) {
    r.folder = String(b.folder).trim().slice(0, 500);
    if (r.folder && (!path.isAbsolute(r.folder) || !existsSync(r.folder) || !statSync(r.folder).isDirectory())) fail(400, "Folder: the full path of an existing folder on this PC");
  }
  if (r.schedule !== "off" && r.delivery === "folder" && !r.folder) fail(400, "Choose the folder to save reports in");
  writeSettings(projectId, { ...s, report: r });
  return r;
}
export function updateProjectBranding(projectId, b) {
  const s = readSettings(projectId);
  writeSettings(projectId, { ...s, branding: { ...(s.branding || {}), ...cleanBranding(b) } });
  return projectBranding(projectId);
}

const lastSent = (projectId) => JSON.parse(get("SELECT value FROM meta WHERE key=?", `report-sent:${projectId}`)?.value || "null");
/** Weekly: 7 days since the last one; monthly: one calendar month. An hour of slack so a timer tick doesn't skip a turn. */
export function reportDue(schedule, lastAt, now = Date.now()) {
  if (schedule === "off") return false;
  if (!lastAt) return true;
  const last = new Date(lastAt);
  const next = schedule === "weekly" ? last.getTime() + 7 * DAY : new Date(last).setUTCMonth(last.getUTCMonth() + 1);
  return now >= next - 3600e3;
}

/** Builds and delivers the latest report now. deps: { pdf(auditId) → Buffer, smtp: {connect, upgrade}, now } for tests. */
export async function deliverReport(projectId, { deps = {} } = {}) {
  const p = get("SELECT * FROM projects WHERE id=?", projectId) || fail(404, "Project not found");
  const r = reportSettings(projectId), now = deps.now ?? Date.now();
  const a = get("SELECT * FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", projectId);
  if (!a) fail(400, "Run an audit first: the report is made from the latest finished audit");
  const day = new Date(now).toISOString().slice(0, 10), slug = String(p.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "site";
  const filename = `seo-report-${slug}-${day}.${r.format}`;
  // okAt = last successful delivery (the schedule counts from it); at/error = the last attempt.
  const record = (x) => { const at = new Date(now).toISOString();
    run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", `report-sent:${projectId}`, JSON.stringify({ at, okAt: x.error ? lastSent(projectId)?.okAt || null : at, auditId: a.id, ...x })); };
  try {
    const content = r.format === "pdf" ? await (deps.pdf || reportPdf)(a.id) : Buffer.from(buildReport(a.id), "utf8");
    if (r.delivery === "folder") {
      if (!r.folder || !existsSync(r.folder)) fail(400, "The report folder doesn't exist any more");
      const file = path.join(r.folder, filename);
      await writeFile(file, content);
      record({ to: file, error: null });
      return { ok: true, file };
    }
    const c = channelConfig().email, to = emailList(r.to || projectAlerts(projectId).emailTo || c.to);
    if (!c.host || !c.from) fail(400, "Set up the SMTP server in App settings → Alerts first");
    const b = brandingFor(projectId), by = b.whiteLabel ? (b.name ? ` by ${b.name}` : "") : " by SEO Auditor";
    const text = `SEO report for ${p.name} (${p.start_url}), from the audit of ${a.finished_at} UTC.\n\nSite Health ${a.health}, AI Readiness ${a.ai_readiness ?? "–"}, `
      + `${a.errors} errors, ${a.warnings} warnings, ${a.pages_crawled} pages crawled.\nThe full report is attached.\n\nPrepared${by}.`;
    await sendMail({ host: c.host, port: c.port, security: c.security, user: c.user, pass: c.password, from: c.from, to, subject: `SEO report — ${p.name} (${day})`, text,
      attachments: [{ filename, content, type: r.format === "pdf" ? "application/pdf" : "text/html; charset=utf-8" }] }, deps.smtp);
    record({ to: to.join(", "), error: null });
    return { ok: true, to };
  } catch (e) {
    const msg = redact(e.message).slice(0, 300);
    record({ error: msg });
    throw Object.assign(new Error(msg), { status: e.status || 502 });
  }
}

/** Every project whose report is due: deliver it. A failed delivery is recorded and tried again a day later. */
export async function deliverDueReports({ deps = {} } = {}) {
  const out = [], now = deps.now ?? Date.now();
  for (const { id } of all("SELECT id FROM projects")) {
    const r = reportSettings(id), l = lastSent(id);
    if (!reportDue(r.schedule, l?.okAt, now) || (l?.error && now - Date.parse(l.at) < DAY)) continue;
    out.push(await deliverReport(id, { deps }).then((x) => ({ projectId: id, ...x }), (e) => ({ projectId: id, ok: false, error: e.message })));
  }
  return out;
}

export function register({ routes, cli } = {}) {
  const project = (id) => get("SELECT * FROM projects WHERE id=?", Number(id)) || fail(404, "Project not found");
  routes.push(["GET", /^\/api\/projects\/(\d+)\/report-delivery$/, ([id]) => {
    const p = project(id), c = channelConfig().email;
    return { report: reportSettings(p.id), last: lastSent(p.id), branding: projectBranding(p.id), smtpReady: Boolean(c.host && c.from) };
  }]);
  routes.push(["PUT", /^\/api\/projects\/(\d+)\/report-delivery$/, ([id], q, b) => {
    const p = project(id);
    return { report: b.report ? updateReportSettings(p.id, b.report) : reportSettings(p.id), branding: b.branding ? updateProjectBranding(p.id, b.branding) : projectBranding(p.id) };
  }]);
  routes.push(["POST", /^\/api\/projects\/(\d+)\/report-delivery\/send$/, ([id]) => deliverReport(project(id).id)]);
  routes.push(["GET", /^\/api\/branding$/, () => appBranding()]);
  routes.push(["PUT", /^\/api\/branding$/, (p, q, b) => saveAppBranding(b)]);
  if (cli) return;
  setInterval(() => deliverDueReports().catch((e) => console.error("reports:", redact(e.message))), 30 * 60e3).unref?.();
}
