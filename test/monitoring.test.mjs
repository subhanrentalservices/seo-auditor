// Issue trends, the opt-in scheduled task and the scheduled run (REQ-055 group 5 items 3 and 6). The task is built and
// "installed" through an injected command runner (never the real Task Scheduler); the scheduled run is tested with
// the app check and the audit starter injected, so no server, crawl, mail or webhook is involved. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, get } = await import("../src/db.mjs");
const { issueTrends } = await import("../src/issue-trends.mjs");
const T = await import("../src/task-schedule.mjs");
const { scheduledRun } = await import("../src/scheduled-run.mjs");
const { emit } = await import("../src/runner.mjs");
const { updateConfig } = await import("../src/alert-channels.mjs");

test("issue trends: pages per check across audits (oldest first), sorted errors first, with the latest change", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme', 'https://acme.example/')");
  const audit = (id, health, ai, issues, status = "done") => {
    run("INSERT INTO audits (id, project_id, status, health, ai_readiness, finished_at) VALUES (?,1,?,?,?,datetime('now'))", id, status, health, ai);
    for (const [check, sev, url] of issues) run("INSERT INTO issues (audit_id, check_id, severity, url) VALUES (?,?,?,?)", id, check, sev, url);
  };
  audit(1, 80, 60, [["missing_title", "error", "/a"], ["missing_title", "error", "/b"], ["missing_description", "warning", "/a"]]);
  audit(2, 90, 65, [["missing_title", "error", "/a"], ["missing_description", "warning", "/a"], ["missing_description", "warning", "/a"]]); // same page twice = 1 page
  audit(3, 10, 10, [["missing_title", "error", "/x"]], "failed"); // not finished: left out
  const t = issueTrends(1);
  assert.deepEqual(t.audits.map((a) => [a.id, a.health, a.ai_readiness]), [[1, 80, 60], [2, 90, 65]]);
  assert.deepEqual(t.checks.map((c) => [c.id, c.severity, c.counts, c.change]), [["missing_title", "error", [2, 1], -1], ["missing_description", "warning", [1, 1], 0]]);
  assert.deepEqual(issueTrends(99), { audits: [], checks: [] });
});

test("scheduled task XML: daily trigger at the chosen time, runs when the PC was off, paths escaped", () => {
  const action = T.taskAction({ execPath: "C:\\Program Files\\nodejs\\node.exe", electron: false, root: "C:\\Apps\\R&D Auditor", data: "C:\\Data", platform: "win32" });
  assert.equal(action.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(action.args, '"C:\\Apps\\R&D Auditor\\src\\scheduled-run.mjs" --data "C:\\Data"');
  const xml = T.taskXml("06:30", action);
  assert.match(xml, /<StartBoundary>2026-01-01T06:30:00<\/StartBoundary>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<Arguments>&quot;C:\\Apps\\R&amp;D Auditor\\src\\scheduled-run.mjs&quot; --data &quot;C:\\Data&quot;<\/Arguments>/);
  assert.throws(() => T.taskXml("25:00", action), /24-hour/);
  assert.throws(() => T.taskAction({ execPath: "C:\\x\"y\\node.exe", electron: false, root: "C:\\r", data: "C:\\d", platform: "win32" }), /characters/);
  const mac = T.taskAction({ execPath: "/Applications/SEO Auditor.app/Contents/MacOS/SEO Auditor", electron: true, root: "/Applications/SEO Auditor.app/Contents/Resources/app", data: "/Users/me/data", platform: "darwin" });
  assert.equal(T.cronLine("05:00", mac), "0 5 * * * cd '/Applications/SEO Auditor.app/Contents/Resources/app' && ELECTRON_RUN_AS_NODE=1 '/Applications/SEO Auditor.app/Contents/MacOS/SEO Auditor' '/Applications/SEO Auditor.app/Contents/Resources/app/src/scheduled-run.mjs' --data '/Users/me/data'");
});

test("scheduled task: the desktop app's own executable runs the script through cmd with ELECTRON_RUN_AS_NODE", () => {
  const a = T.taskAction({ execPath: "C:\\Apps\\SEO Auditor\\SEO Auditor.exe", electron: true, root: "C:\\Apps\\SEO Auditor\\resources\\app", data: "C:\\Users\\me\\AppData\\Roaming\\SEO Auditor", platform: "win32" });
  assert.match(a.command, /cmd\.exe$/);
  assert.equal(a.args, '/d /s /c "set ELECTRON_RUN_AS_NODE=1&& "C:\\Apps\\SEO Auditor\\SEO Auditor.exe" "C:\\Apps\\SEO Auditor\\resources\\app\\src\\scheduled-run.mjs" --data "C:\\Users\\me\\AppData\\Roaming\\SEO Auditor""');
});

test("install / status / remove go through schtasks (injected); other systems get a crontab line and nothing changes", async () => {
  const calls = [];
  let xmlSeen = "";
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "/Create") xmlSeen = readFileSync(args[4]).toString("utf16le");
    if (args[0] === "/Query") return { code: 0, stdout: "<Task><Triggers><StartBoundary>2026-01-01T07:15:00</StartBoundary></Triggers><Settings><Enabled>true</Enabled></Settings></Task>", stderr: "" };
    return { code: 0, stdout: "SUCCESS", stderr: "" };
  };
  const action = { command: "C:\\node.exe", args: '"C:\\a\\src\\scheduled-run.mjs" --data "C:\\d"', workdir: "C:\\a" };
  const st = await T.installTask("07:15", { exec, platform: "win32", action });
  assert.deepEqual(calls[0].slice(0, 4), ["schtasks", "/Create", "/TN", "SEO Auditor scheduled run"]);
  assert.match(xmlSeen, /^\uFEFF<\?xml version="1.0" encoding="UTF-16"\?>/);
  assert.deepEqual(st, { supported: true, installed: true, time: "07:15", enabled: true });
  assert.deepEqual(await T.removeTask({ exec, platform: "win32" }), { installed: false, supported: true });
  assert.deepEqual(calls.at(-1), ["schtasks", "/Delete", "/TN", "SEO Auditor scheduled run", "/F"]);
  const failing = async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied." });
  await assert.rejects(T.installTask("07:15", { exec: failing, platform: "win32", action }), /Access is denied/);
  assert.deepEqual(await T.taskStatus({ exec: failing, platform: "win32" }), { supported: true, installed: false });
  const linux = await T.installTask("07:15", { exec: () => { throw new Error("must not run"); }, platform: "linux", action: { command: "/usr/bin/node", args: '"/opt/a/src/scheduled-run.mjs" --data "/d"', workdir: "/opt/a" } });
  assert.equal(linux.cron, "15 7 * * * cd '/opt/a' && '/usr/bin/node' '/opt/a/src/scheduled-run.mjs' --data '/d'");
  assert.equal(linux.installed, false);
});

test("scheduled run: does nothing while the app is open", async () => {
  const log = [];
  const r = await scheduledRun({ isAppRunning: async () => true, log: (m) => log.push(m), startAudit: () => { throw new Error("must not start"); } });
  assert.deepEqual(r, { skipped: "app running" });
  assert.match(log[0], /is open/);
});

test("scheduled run: due audits run and finish, then data alerts and due reports for every project", async () => {
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (2, 'Daily', 'https://daily.example/', '{\"schedule\":\"daily\"}')");
  run("INSERT INTO projects (id, name, start_url, settings) VALUES (3, 'Off', 'https://off.example/', '{\"schedule\":\"off\"}')");
  updateConfig({ webhook: { on: false }, slack: { on: false }, toast: { on: false }, email: { on: false } });
  const started = [];
  const startAudit = (pid) => {
    const id = Number(run("INSERT INTO audits (project_id, status, started_at) VALUES (?, 'done', datetime('now'))", pid).lastInsertRowid);
    started.push(pid);
    setTimeout(() => emit({ type: "done", projectId: pid, auditId: id }), 5);
    return id;
  };
  const log = [];
  const r = await scheduledRun({ isAppRunning: async () => false, loadModules: false, startAudit, log: (m) => log.push(m), deps: { toast: () => {}, fetchFn: async () => ({ ok: true }) } });
  assert.deepEqual(started, [2]);
  assert.deepEqual(r.audits.map((a) => [a.projectId, a.result]), [[2, "done"]]);
  assert.deepEqual(r.alerts.map((a) => a.projectId).sort(), [1, 2, 3]);
  assert.deepEqual(r.reports, []);
  assert.ok(log.some((l) => /alerts checked for 3 project/.test(l)));
  assert.ok(get("SELECT 1 x FROM audits WHERE project_id=2"));
});
