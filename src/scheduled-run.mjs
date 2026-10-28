// One scheduled run outside the app (the opt-in Windows task or cron line from task-schedule.mjs): audits that are
// due (projects set to daily or weekly), their after-audit steps (Lighthouse, Search Console, alerts), then the
// data alert rules and due report deliveries for every project. When the app is running it does nothing: the app's
// own scheduler and timers already do the same, and two processes must not crawl one project at once.
//   node src/scheduled-run.mjs [--data <data folder>]
// No database module is imported at the top: --data has to set SEO_AUDITOR_DATA first.
import net from "node:net";
import path from "node:path";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when something answers on the app's port on this PC (a TCP connect only; no request is sent). */
export function appRunning(port = Number(process.env.SEO_AUDITOR_PORT) || 4560) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false)); s.once("connect", () => done(true)); s.once("error", () => done(false));
  });
}

// Modules not loaded here: the in-app audit timer, the link engine (starts a Python process) and desktop shortcuts.
const SKIP = new Set(["./scheduler.mjs", "./backlinks.mjs", "./desktop.mjs"]);

/** deps (tests): isAppRunning, loadModules (false = don't register the app's modules), startAudit, deps for alerts/reports. */
export async function scheduledRun({ isAppRunning = appRunning, log = console.log, loadModules = true, startAudit, deps } = {}) {
  if (await isAppRunning()) { log("SEO Auditor is open, and its own scheduler runs audits, alerts and reports. Nothing to do."); return { skipped: "app running" }; }
  if (loadModules) {
    const { MODULES } = await import("./server.mjs");
    for (const m of MODULES.filter((x) => !SKIP.has(x)))
      await import(m).then((x) => x.register?.({ routes: [], prefixes: [], cli: true })).catch((e) => { if (e.code !== "ERR_MODULE_NOT_FOUND") log(`${m}: ${e.message}`); });
  }
  const runner = await import("./runner.mjs");
  const { dueProjects } = await import("./scheduler.mjs");
  const { checkAll } = await import("./alerts.mjs");
  const { deliverDueReports } = await import("./report-delivery.mjs");
  const start = startAudit || runner.startAudit;
  const audits = [];
  for (const p of dueProjects()) {
    const finished = new Promise((resolve) => { const off = runner.onEvent((ev) => { if (ev.projectId === p.id && (ev.type === "done" || ev.type === "failed")) { off(); resolve(ev); } }); });
    const id = start(p.id);
    log(`audit ${id} started for ${p.name}`);
    const ev = await finished;
    audits.push({ projectId: p.id, auditId: id, result: ev.type, message: ev.message });
    log(`audit ${id} ${ev.type}${ev.message ? `: ${ev.message}` : ""}`);
  }
  const alerts = await checkAll({ deps });
  const reports = await deliverDueReports({ deps });
  for (const r of reports) log(r.ok ? `report for project ${r.projectId} delivered` : `report for project ${r.projectId} failed: ${r.error}`);
  log(`alerts checked for ${alerts.length} project(s); ${alerts.reduce((t, a) => t + (a.sent || 0), 0)} sent`);
  return { audits, alerts, reports };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--data");
  if (i > 0 && process.argv[i + 1]) process.env.SEO_AUDITOR_DATA = path.resolve(process.argv[i + 1]);
  const { DATA } = await import("./db.mjs");
  const { redact } = await import("./alert-channels.mjs");
  const logFile = path.join(DATA, "scheduled-run.log");
  const log = (m) => { const line = `${new Date().toISOString()} ${redact(m)}`; console.log(line); try { appendFileSync(logFile, line + "\n"); } catch {} };
  try { await scheduledRun({ log }); }
  catch (e) { log(`failed: ${e.message}`); process.exitCode = 1; }
  process.exit(); // the after-audit modules leave no work behind; don't wait for idle sockets
}
