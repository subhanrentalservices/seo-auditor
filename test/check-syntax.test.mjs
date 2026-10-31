// The lint step (scripts/check-syntax.mjs, run by CI): it must see the app's files in every folder and skip
// node_modules. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jsFiles } from "../scripts/check-syntax.mjs";

test("jsFiles lists .js/.mjs/.cjs under the given folders and leaves node_modules out", () => {
  const root = mkdtempSync(path.join(tmpdir(), "seo-auditor-lint-"));
  for (const d of ["src/sub", "public/js", "public/node_modules/x"]) mkdirSync(path.join(root, d), { recursive: true });
  for (const f of ["src/a.mjs", "src/sub/b.cjs", "public/js/app.js", "public/node_modules/x/i.js", "src/readme.md"]) writeFileSync(path.join(root, f), "");
  assert.deepEqual(jsFiles(root, ["src", "public", "missing"]).map((f) => path.relative(root, f).replace(/\\/g, "/")), ["public/js/app.js", "src/a.mjs", "src/sub/b.cjs"]);
});

test("the real app: server, web app and tests are all covered", () => {
  const rel = jsFiles().map((f) => f.replace(/\\/g, "/"));
  for (const f of ["src/server.mjs", "public/js/app.js", "public/lvui/core.js", "desktop/main.mjs", "test/e2e.test.mjs"]) assert.ok(rel.some((x) => x.endsWith(f)), f);
});
