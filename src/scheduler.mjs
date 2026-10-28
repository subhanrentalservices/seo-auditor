// Scheduled audits (daily / weekly per project, while the app runs; scheduled-run.mjs does the same from Windows Task
// Scheduler or cron) and the Windows desktop alert (own idea I9), now sent through alerts.mjs as its "toast" channel.
import { execFile } from "node:child_process";
import { all, get, projectSettings } from "./db.mjs";
import { startAudit, activeAudit } from "./runner.mjs";

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

export function register() {
  // The after-audit Windows alert is now one channel of alerts.mjs (new errors, Site Health drop and more rules).
  setTimeout(tick, 60e3);
  setInterval(tick, CHECK_EVERY).unref?.();
}
