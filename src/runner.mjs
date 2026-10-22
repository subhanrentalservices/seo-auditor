// Starts audits in the background (used by the API and the scheduler) and fans progress out to listeners.
import { all, get, run, projectSettings } from "./db.mjs";
import { runAudit, isRunning, stopAudit } from "./crawler.mjs";

const listeners = new Set();
export const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const busy = new Map(); // projectId -> auditId while crawl or after-audit steps run
export const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch {} } };

// Audits interrupted by closing the app can't resume; mark them so the UI doesn't show them as running forever.
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
  busy.set(projectId, auditId);
  emit({ type: "started", projectId, auditId });
  runAudit(auditId, project, settings, (p) => emit({ type: "progress", projectId, auditId, ...p }))
    .then(async () => {
      emit({ type: "crawled", projectId, auditId });
      const a = get("SELECT status FROM audits WHERE id=?", auditId);
      if (a?.status === "done") for (const hook of afterAudit) await hook(auditId, project, settings).catch((e) => console.error("after-audit:", e.message));
      busy.delete(projectId);
      emit({ type: "done", projectId, auditId });
    })
    .catch((e) => { busy.delete(projectId); console.error(`audit ${auditId} failed:`, e.message); emit({ type: "failed", projectId, auditId, message: e.message }); });
  return auditId;
}

/** Extra steps run after the crawl (CWV, Search Console, alerts). Each gets (auditId, project, settings). */
export const afterAudit = [];

export function stop(auditId) {
  if (isRunning(auditId)) stopAudit(auditId);
  else run("UPDATE audits SET status='stopped', finished_at=datetime('now') WHERE id=? AND status IN ('queued','running')", auditId);
}

export const runningAudits = () => all("SELECT id, project_id, pages_crawled, pages_queued FROM audits WHERE status='running'");
