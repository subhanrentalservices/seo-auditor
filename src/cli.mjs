// Command line: node src/cli.mjs add <url> [name] | list | audit <projectId> [--max N] [--js] | similar <projectId> [--min 0.2]
//   | link-ideas <projectId> | install [--autostart]
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
} else if (cmd === "install") {
  const { installDesktopShortcut, setAutostart } = await import("./desktop.mjs");
  console.log("desktop shortcut:", await installDesktopShortcut());
  if (process.argv.includes("--autostart")) console.log("start with Windows:", await setAutostart(true));
} else console.log("usage: add <url> [name] | list | audit <projectId> [--max N] [--js] | similar <projectId> [--min 0.2] | link-ideas <projectId> | install [--autostart]");
