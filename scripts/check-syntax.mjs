// Light lint (REQ-055 group 9): `node --check` on every JavaScript file of the app (server, web app, desktop shell,
// scripts, tests), so a syntax error fails CI before any test runs. No dependencies. Run: npm run lint
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "public", "desktop", "scripts", "test"];

/** Every .js/.mjs/.cjs file under the folders, sorted. */
export function jsFiles(root = ROOT, dirs = DIRS) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== "node_modules") walk(p);
      else if (e.isFile() && /\.(m|c)?js$/.test(e.name)) out.push(p);
    }
  };
  for (const d of dirs) walk(path.join(root, d));
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = jsFiles();
  const bad = files.filter((f) => {
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) process.stderr.write(`${path.relative(ROOT, f)}\n${r.stderr}\n`);
    return r.status !== 0;
  });
  console.log(`node --check: ${files.length - bad.length} of ${files.length} files OK`);
  process.exitCode = bad.length ? 1 : 0;
}
