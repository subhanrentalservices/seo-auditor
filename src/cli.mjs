// Command line: node src/cli.mjs add <url> [name] | list | audit <projectId> [--max N] [--js] | similar <projectId> [--min 0.2]
//   | link-ideas <projectId> | install [--autostart] | schedule install [--time 06:00] | schedule remove | schedule status | run-scheduled
//   | change <projectId> <yyyy-mm-dd> <kind> "<summary>" <url> [url...] [--ref <commit or ticket>] | changes <projectId>
import { all, get, run, projectSettings } from "./db.mjs";
import { runAudit } from "./crawler.mjs";

const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === "add") {
  const url = new URL(a1).href;
  const r = run("INSERT INTO projects (name, start_url) VALUES (?, ?)", a2 || new URL(url).hostname, url);
  console.log(`project ${r.lastInsertRowid}: ${url}`);
} else if (cmd === "list") {
  console.table(all("SELECT p.id, p.name, p.start_url, (SELECT health FROM audits a WHERE a.project_id=p.id AND a.status='done' ORDER BY id DESC LIMIT 1) health FROM projects p"));
} else if (cmd === "audit") {
  const project = get("SELECT * FROM projects WHERE id=?", Number(a1));
  if (!project) throw new Error("no such project");
  const settings = projectSettings(project);
  const max = process.argv.indexOf("--max"); if (max > 0) settings.maxPages = Number(process.argv[max + 1]);
  if (process.argv.includes("--js")) settings.renderJs = true;
  const audit = run("INSERT INTO audits (project_id) VALUES (?)", project.id).lastInsertRowid;
  const t0 = Date.now();
  const res = await runAudit(Number(audit), project, settings, ({ crawled, queued }) => process.stdout.write(`\rcrawled ${crawled}, queued ${queued}   `));
  const a = get("SELECT * FROM audits WHERE id=?", audit);
  console.log(`\naudit ${audit}: ${res.pages} pages in ${Math.round((Date.now() - t0) / 1000)} s, health ${a.health}, AI readiness ${a.ai_readiness}, errors ${a.errors}, warnings ${a.warnings}, notices ${a.notices}`);
  console.table(all("SELECT check_id, severity, COUNT(*) n FROM issues WHERE audit_id=? GROUP BY check_id ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n DESC", audit));
} else if (cmd === "similar" || cmd === "link-ideas") {
  // Uses the project's latest finished audit.
  const a = get("SELECT id FROM audits WHERE project_id=? AND status='done' ORDER BY id DESC LIMIT 1", Number(a1));
  if (!a) throw new Error("no finished audit for that project");
  if (cmd === "similar") {
    const { similarForAudit } = await import("./quality.mjs");
    const min = process.argv.indexOf("--min");
    const pairs = similarForAudit(a.id, { min: min > 0 ? Number(process.argv[min + 1]) : 0.2 });
    console.log(`audit ${a.id}: ${pairs.length} page pairs share ≥ ${min > 0 ? process.argv[min + 1] : 0.2} of their 5-word phrases (slug words masked)`);
    console.table(pairs.slice(0, 40).map((p) => ({ shared: Math.round(p.score * 100) + "%", a: p.a, b: p.b })));
  } else {
    const { linkOpportunities } = await import("./extras.mjs");
    const ideas = linkOpportunities(a.id);
    console.log(JSON.stringify(ideas, null, 1).slice(0, 20000));
  }
} else if (cmd === "change" || cmd === "changes") {
  // Change log (changes.mjs): record an SEO change, or list each one's Search Console before/after vs the rest of the site.
  const { addChange, changeLog, KINDS } = await import("./changes.mjs");
  try {
    if (cmd === "change") {
      const args = process.argv.slice(3), r = args.indexOf("--ref");
      const ref = r >= 0 ? args.splice(r, 2)[1] : undefined;
      const [pid, date, kind, summary, ...urls] = args;
      if (!urls.length) throw new Error(`usage: change <projectId> <yyyy-mm-dd> <${KINDS.join("|")}> "<summary>" <url> [url...] [--ref <text>]`);
      const c = addChange(Number(pid), { date, kind, summary, urls, ref });
      console.log(`change ${c.id} logged for project ${c.projectId}: ${c.date} ${c.kind}, ${c.urls.length} page(s)${c.impact.status === "too-early" ? `; impact from about ${c.impact.readyAround}` : ""}`);
    } else {
      const log = changeLog(Number(a1));
      const pc = (x) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}%`);
      const pts = (x) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))} pts`);
      const pos = (p) => (p === null ? "–" : p.toFixed(1));
      console.log(log.connected ? `Search Console page data ${log.firstDate} → ${log.lastDate}. "vs rest of site" = the pages' % change minus every other page's % change: how they did against the site's own trend, not proof the change caused it.`
        : "No Search Console page data yet: refresh Search Console in the app to measure impact.");
      if (log.error) console.log(`Last page-data fetch failed: ${log.error}`);
      if (!log.changes.length) console.log("No changes logged.");
      for (const c of log.changes) {
        console.log(`\n#${c.id} ${c.date} [${c.kind}] ${c.summary}${c.ref ? ` (ref ${c.ref})` : ""}\n  ${c.urls.join("\n  ")}`);
        const i = c.impact;
        if (i.status === "too-early") console.log(`  too early: ${i.afterDays} day(s) of data after the change, needs ${log.minAfterDays} (about ${i.readyAround})`);
        if (i.status !== "ok") continue;
        console.table(i.windows.map((w) => {
          const name = w.window === "since" ? `since (${w.days} d)` : w.window;
          if (w.pending) return { window: name, clicks: `complete around ${w.readyAround}` };
          if (w.noBefore) return { window: name, clicks: "no Search Console data before the change" };
          const x = w.changed, k = w.control;
          return { window: name, clicks: `${x.before.clicks} → ${x.after.clicks}`, "clicks Δ": pc(x.change.clicks),
            impressions: `${x.before.impressions} → ${x.after.impressions}`, "impr. Δ": pc(x.change.impressions),
            position: `${pos(x.before.position)} → ${pos(x.after.position)}`,
            "rest of site Δ": pc(k.change[w.vsControl.basis]) + " " + w.vsControl.basis,
            "vs rest of site": `${pts(w.vsControl[w.vsControl.basis])}${w.vsControl.label ? ` (${w.vsControl.label})` : ""}${w.small ? ", small numbers" : ""}` };
        }));
      }
    }
  } catch (e) { console.error(e.message); process.exitCode = 1; }
} else if (cmd === "schedule") {
  // Opt-in daily task for audits, alerts and reports while the app is closed (task-schedule.mjs).
  const t = await import("./task-schedule.mjs"), at = process.argv.indexOf("--time");
  try {
    const r = a1 === "install" ? await t.installTask(at > 0 ? process.argv[at + 1] : "06:00") : a1 === "remove" ? await t.removeTask() : await t.taskStatus();
    console.log(r.cron ? `${r.message || "On Mac or Linux, add this line with crontab -e:"}\n${r.cron}` : r.installed ? `"${t.TASK}" runs every day at ${r.time}.` : "No scheduled task.");
  } catch (e) { console.error(e.message); process.exitCode = 1; }
} else if (cmd === "run-scheduled") {
  const { scheduledRun } = await import("./scheduled-run.mjs");
  await scheduledRun();
  process.exit();
} else if (cmd === "install") {
  const { installDesktopShortcut, setAutostart } = await import("./desktop.mjs");
  console.log("desktop shortcut:", await installDesktopShortcut());
  if (process.argv.includes("--autostart")) console.log("start with Windows:", await setAutostart(true));
} else console.log("usage: add <url> [name] | list | audit <projectId> [--max N] [--js] | similar <projectId> [--min 0.2] | link-ideas <projectId> | install [--autostart] | change <projectId> <yyyy-mm-dd> <kind> \"<summary>\" <url> [url...] [--ref <text>] | changes <projectId> | schedule install [--time 06:00] | schedule remove | schedule status | run-scheduled");
