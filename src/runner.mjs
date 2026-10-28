// Starts audits in the background (used by the API and the scheduler) and fans progress out to listeners.
import { all, get, run, projectSettings } from "./db.mjs";
import { runAudit, isRunning, stopAudit } from "./crawler.mjs";

const listeners = new Set();
export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const busy = new Map(); // projectId -> auditId while crawl or after-audit steps run
export const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch {} } };

// Audits interrupted by closing the app: marked so the UI doesn't show them as running forever; resumeAudit continues them.
run("UPDATE audits SET status='failed', message='Interrupted (app was closed)', finished_at=datetime('now') WHERE status IN ('running','queued')");

/** Shows a step name in the progress bar (e.g. "Measuring Core Web Vitals"). */
export const phase = (projectId, auditId, text) => emit({ type: "phase", projectId, auditId, phase: text });

export function activeAudit(projectId) {
  if (busy.has(projectId)) return busy.get(projectId);
  return get("SELECT id FROM audits WHERE project_id=? AND status IN ('running','queued') ORDER BY id DESC LIMIT 1", projectId)?.id ?? null;
}

/** Starts an audit unless one is already running for the project. Returns the audit id. */
export function startAudit(projectId, overrides = {}) {
  const project = get("SELECT * FROM projects WHERE id=?", projectId);
  if (!project) throw Object.assign(new Error("Project not found"), { status: 404 });
  const existing = activeAudit(projectId);
  if (existing) return existing;
  const settings = { ...projectSettings(project), ...overrides };
  const auditId = Number(run("INSERT INTO audits (project_id, settings) VALUES (?, ?)", projectId, JSON.stringify(settings)).lastInsertRowid);
  launch(auditId, project, settings);
  return auditId;
}

/** Continues the project's newest audit when it was stopped or interrupted (crash, app closed): pages it already
 *  stored aren't fetched again (recrawl.mjs). It keeps the settings it started with. Returns the audit id. */
export function resumeAudit(auditId) {
  const a = get("SELECT * FROM audits WHERE id=?", Number(auditId));
  if (!a) throw Object.assign(new Error("Audit not found"), { status: 404 });
  if (!["stopped", "failed"].includes(a.status)) throw Object.assign(new Error("Only a stopped or interrupted audit can be resumed"), { status: 400 });
  const newest = get("SELECT id FROM audits WHERE project_id=? ORDER BY id DESC LIMIT 1", a.project_id);
  if (newest?.id !== a.id) throw Object.assign(new Error("Only the project's newest audit can be resumed"), { status: 400 });
  if (activeAudit(a.project_id)) throw Object.assign(new Error("An audit is already running for this project"), { status: 409 });
  const project = get("SELECT * FROM projects WHERE id=?", a.project_id);
  const settings = { ...projectSettings(project), ...JSON.parse(a.settings || "{}") };
  launch(a.id, project, settings, { resume: true });
  return a.id;
}

function launch(auditId, project, settings, deps = {}) {
  const projectId = project.id;
  busy.set(projectId, auditId);
  emit({ type: "started", projectId, auditId });
  runAudit(auditId, project, settings, (p) => emit({ type: "progress", projectId, auditId, ...p }), deps)
    .then(async () => {
      emit({ type: "crawled", projectId, auditId });
      const a = get("SELECT status FROM audits WHERE id=?", auditId);
      if (a?.status === "done") for (const hook of afterAudit) await hook(auditId, project, settings).catch((e) => console.error("after-audit:", e.message));
      busy.delete(projectId);
      emit({ type: "done", projectId, auditId });
    })
    .catch((e) => { busy.delete(projectId); console.error(`audit ${auditId} failed:`, e.message); emit({ type: "failed", projectId, auditId, message: e.message }); });
}

/** Extra steps run after the crawl (CWV, Search Console, alerts). Each gets (auditId, project, settings). */
export const afterAudit = [];

export function stop(auditId) {
  if (isRunning(auditId)) stopAudit(auditId);
  else run("UPDATE audits SET status='stopped', finished_at=datetime('now') WHERE id=? AND status IN ('queued','running')", auditId);
}

export const runningAudits = () => all("SELECT id, project_id, pages_crawled, pages_queued FROM audits WHERE status='running'");
