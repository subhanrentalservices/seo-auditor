// Issue trends: each check's page count across a project's finished audits, plus Site Health and AI Readiness per
// audit, for the Issue trends screen and the Overview chart. Read-only over the audits and issues tables.
import { all, get } from "./db.mjs";
import { CHECKS } from "./checks.mjs";
import "./ai-checks.mjs"; // adds the AI checks to CHECKS

const SEV = { error: 0, warning: 1, notice: 2 };

/** { audits: [{id, finished_at, health, ai_readiness, errors, warnings, notices, pages_crawled}] oldest first,
 *    checks: [{id, title, severity, counts: [pages per audit, same order], latest, change}] } */
export function issueTrends(projectId, limit = 30) {
  const audits = all(`SELECT id, finished_at, health, ai_readiness, errors, warnings, notices, pages_crawled FROM audits
    WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT ?`, projectId, Math.min(Math.max(Number(limit) || 30, 2), 200)).reverse();
  if (!audits.length) return { audits, checks: [] };
  const index = new Map(audits.map((a, i) => [a.id, i]));
  const rows = all(`SELECT audit_id, check_id, COUNT(DISTINCT url) n FROM issues WHERE audit_id IN (${audits.map(() => "?").join(",")}) GROUP BY audit_id, check_id`, ...audits.map((a) => a.id));
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.check_id)) by.set(r.check_id, Array(audits.length).fill(0));
    by.get(r.check_id)[index.get(r.audit_id)] = r.n;
  }
  const checks = [...by].map(([id, counts]) => {
    const [severity, title] = CHECKS[id] || ["notice", id];
    const latest = counts.at(-1), before = counts.length > 1 ? counts.at(-2) : null;
    return { id, title, severity, ai: id.startsWith("ai_"), counts, latest, change: before === null ? null : latest - before, peak: Math.max(...counts) };
  }).sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.latest - a.latest || b.peak - a.peak);
  return { audits, checks };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/projects\/(\d+)\/issue-trends$/, ([id], q) => {
    if (!get("SELECT 1 x FROM projects WHERE id=?", Number(id))) throw Object.assign(new Error("Project not found"), { status: 404 });
    return issueTrends(Number(id), q.limit);
  }]);
}
