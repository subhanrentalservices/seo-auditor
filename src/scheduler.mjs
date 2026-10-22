// Scheduled audits (daily / weekly per project, while the app runs) and Windows desktop alerts (own idea I9)
// when an audit finds new errors or Site Health drops.
import { execFile } from "node:child_process";
import { all, get, projectSettings } from "./db.mjs";
import { startAudit, activeAudit, afterAudit } from "./runner.mjs";

const PERIOD = { daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
const CHECK_EVERY = 10 * 60e3;

export function dueProjects(now = Date.now()) {
  return all("SELECT * FROM projects").filter((p) => {
    const s = projectSettings(p);
    if (!PERIOD[s.schedule] || activeAudit(p.id)) return false;
    const last = get("SELECT started_at FROM audits WHERE project_id=? AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1", p.id);
    return !last || now - Date.parse(last.started_at.replace(" ", "T") + "Z") >= PERIOD[s.schedule] - 5 * 60e3;
  });
}

function tick() {
  for (const p of dueProjects()) {
    try { const id = startAudit(p.id); console.log(`scheduled audit ${id} for ${p.name}`); } catch (e) { console.error("scheduler:", e.message); }
  }
}

/** Windows toast via the built-in WinRT API (no modules). Text goes through env vars, never into the script. */
export function notify(title, body) {
  if (process.platform !== "win32") return;
  const script = `$x=[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$t=$x.GetElementsByTagName('text');[void]$t.Item(0).AppendChild($x.CreateTextNode($env:SA_TITLE));[void]$t.Item(1).AppendChild($x.CreateTextNode($env:SA_BODY));
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { env: { ...process.env, SA_TITLE: String(title).slice(0, 120), SA_BODY: String(body).slice(0, 240) }, windowsHide: true, timeout: 20000 },
    (err) => { if (err) console.error("notify:", err.message); });
}

/** Message for a finished audit, or null when nothing got worse. */
export function alertFor(auditId) {
  const a = get("SELECT * FROM audits WHERE id=?", auditId);
  if (!a || a.status !== "done") return null;
  const prev = get("SELECT * FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", a.project_id, a.id);
  if (!prev) return null;
  const p = get("SELECT name FROM projects WHERE id=?", a.project_id);
  const newErrors = get(`SELECT COUNT(*) n FROM (SELECT DISTINCT check_id, url FROM issues WHERE audit_id=? AND severity='error'
    EXCEPT SELECT DISTINCT check_id, url FROM issues WHERE audit_id=? AND severity='error')`, a.id, prev.id).n;
  const drop = prev.health - a.health;
  if (newErrors === 0 && drop < 3) return null;
  return { title: `${p.name}: ${drop >= 3 ? `Site Health ${prev.health} → ${a.health}` : "new SEO errors"}`,
    body: `${newErrors} new error${newErrors === 1 ? "" : "s"} since the last audit. Open SEO Auditor to see what changed.` };
}

export function register() {
  afterAudit.push(async (auditId) => { const m = alertFor(auditId); if (m) notify(m.title, m.body); });
  setTimeout(tick, 60e3);
  setInterval(tick, CHECK_EVERY).unref?.();
}
