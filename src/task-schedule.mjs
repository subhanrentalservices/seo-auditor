// Optional (opt-in) daily scheduled task for audits, alerts and report delivery when the app is closed: in-app
// schedules only run while the app runs. Windows: a Task Scheduler task (like the link engine's daily run) that starts
// `node src/scheduled-run.mjs`; Mac/Linux: the crontab line to add yourself (nothing is changed for you there).
// Command execution is injectable so tests never touch the real Task Scheduler.
import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, DATA } from "./db.mjs";

export const TASK = "SEO Auditor scheduled run";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** Program, arguments and folder for the run. The desktop app's own executable runs scripts with ELECTRON_RUN_AS_NODE,
 *  which only an environment variable can set: on Windows through cmd.exe, in a crontab line as a prefix (env). */
export function taskAction({ execPath = process.execPath, electron = Boolean(process.versions.electron), root = ROOT, data = DATA, platform = process.platform } = {}) {
  const win = platform === "win32", script = (win ? path.win32 : path.posix).join(root, "src", "scheduled-run.mjs");
  // A double quote would end the argument; cmd.exe also treats % ^ & | < > specially; cron lines use single quotes.
  const bad = win && electron ? /["%^&|<>\r\n]/ : win ? /["\r\n]/ : /["'\r\n]/;
  if ([execPath, script, data].some((x) => bad.test(x))) fail(400, "The app's folder path has characters a scheduled task can't use");
  const args = `"${script}" --data "${data}"`;
  if (electron && win) return { command: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), args: `/d /s /c "set ELECTRON_RUN_AS_NODE=1&& "${execPath}" ${args}"`, workdir: root };
  return { command: execPath, args, workdir: root, ...(electron ? { env: "ELECTRON_RUN_AS_NODE=1" } : {}) };
}

export function taskXml(time, action) {
  if (!TIME.test(time)) fail(400, "Use a 24-hour time like 06:30");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>SEO Auditor: due audits, alerts and scheduled reports while the app is closed.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2026-01-01T${time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT6H</ExecutionTimeLimit><Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(action.command)}</Command><Arguments>${xmlEsc(action.args)}</Arguments><WorkingDirectory>${xmlEsc(action.workdir)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

/** The crontab line for Mac/Linux (minute hour * * *). */
export function cronLine(time, action = taskAction()) {
  if (!TIME.test(time)) fail(400, "Use a 24-hour time like 06:30");
  const [h, m] = time.split(":").map(Number);
  return `${m} ${h} * * * cd '${action.workdir}' && ${action.env ? action.env + " " : ""}'${action.command}' ${action.args.replace(/"/g, "'")}`;
}

const realExec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 30000, encoding: "utf8" },
  (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "", stderr: stderr || "" })));

/** deps: { exec(cmd, args) → {code, stdout, stderr}, platform, action } */
export async function installTask(time, { exec = realExec, platform = process.platform, action = taskAction() } = {}) {
  const xml = taskXml(time, action);
  if (platform !== "win32") return { installed: false, supported: false, cron: cronLine(time, action), message: "Add this line with crontab -e (nothing was changed)." };
  const file = path.join(os.tmpdir(), `seo-auditor-task-${process.pid}-${Date.now()}.xml`);
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  try {
    const r = await exec("schtasks", ["/Create", "/TN", TASK, "/XML", file, "/F"]);
    if (r.code !== 0) fail(500, `Could not create the scheduled task: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  } finally { try { unlinkSync(file); } catch {} }
  return taskStatus({ exec, platform });
}

export async function removeTask({ exec = realExec, platform = process.platform } = {}) {
  if (platform !== "win32") return { installed: false, supported: false, message: "Remove the line with crontab -e." };
  const r = await exec("schtasks", ["/Delete", "/TN", TASK, "/F"]);
  if (r.code !== 0 && !/cannot find|not exist/i.test(r.stderr + r.stdout)) fail(500, `Could not remove the scheduled task: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return { installed: false, supported: true };
}

/** { supported, installed, time } — the time comes from the task's XML, which is the same in every Windows language. */
export async function taskStatus({ exec = realExec, platform = process.platform } = {}) {
  if (platform !== "win32") return { supported: false, installed: false, cron: cronLine("06:00") };
  const r = await exec("schtasks", ["/Query", "/TN", TASK, "/XML"]);
  if (r.code !== 0) return { supported: true, installed: false };
  const time = /<StartBoundary>[^<]*T(\d\d:\d\d)/.exec(r.stdout)?.[1] || null;
  return { supported: true, installed: true, time, enabled: !/<Settings>[\s\S]*?<Enabled>false<\/Enabled>[\s\S]*?<\/Settings>/.test(r.stdout) };
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/alerts\/task$/, () => taskStatus()]);
  routes.push(["PUT", /^\/api\/alerts\/task$/, (p, q, b) => (b.install ? installTask(String(b.time || "06:00")) : removeTask())]);
}
