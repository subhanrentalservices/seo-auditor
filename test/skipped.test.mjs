// Visible failures (REQ-055 group 9): a check group that fails is recorded as "skipped: reason" (site_info.skipped,
// shown on the Overview) instead of silently counting as passed; after-audit steps that fail are listed the same way;
// the server's module loader logs and lists modules that fail to load, also missing ones. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { createSkips } = await import("../src/skipped.mjs");
const { afterAuditFailed } = await import("../src/runner.mjs");
const { loadModules } = await import("../src/server.mjs");
const { createProject } = await import("../src/api.mjs");
const { get, run } = await import("../src/db.mjs");

test("guard: the value when the group works, the fallback and a recorded reason when it fails", async () => {
  const s = createSkips({ redact: (x) => x.replace("s3cret", "[hidden]") });
  assert.deepEqual(await s.guard("Works", async () => [["x", "u", ""]], []), [["x", "u", ""]]);
  assert.deepEqual(await s.guard("Fails", async () => { throw new Error("connect ECONNREFUSED with s3cret\nstack line"); }, []), []);
  assert.deepEqual(await s.guard("Throws at once", () => { throw new TypeError("bad input"); }, { issues: [] }), { issues: [] });
  assert.deepEqual(await s.guard("Rejected promise", Promise.reject(new Error("gone")), null), null);
  s.note("Browser step", new Error("No browser found"));
  s.note("Browser step", new Error("reported once per step"));
  assert.deepEqual(s.summary(), [
    { step: "Fails", reason: "connect ECONNREFUSED with [hidden]" },
    { step: "Throws at once", reason: "bad input" },
    { step: "Rejected promise", reason: "gone" },
    { step: "Browser step", reason: "No browser found" },
  ]);
  assert.equal(createSkips().summary(), undefined, "nothing skipped: no site_info entry");
});

test("a failed after-audit step is added to the audit's skipped list, keeping what the crawl recorded", () => {
  const p = createProject({ start_url: "https://example.com/" });
  const id = Number(run("INSERT INTO audits (project_id, status, site_info) VALUES (?, 'done', ?)", p.id, JSON.stringify({ robotsTxt: true, skipped: [{ step: "Favicon check", reason: "timeout" }] })).lastInsertRowid);
  const errors = console.error; console.error = () => {};
  try {
    afterAuditFailed(id, Object.assign(() => {}, { label: "Lighthouse (Core Web Vitals lab data)" }), new Error("Chrome not found\nat x"));
    afterAuditFailed(id, () => {}, "plain string");
  } finally { console.error = errors; }
  const info = JSON.parse(get("SELECT site_info FROM audits WHERE id=?", id).site_info);
  assert.equal(info.robotsTxt, true);
  assert.deepEqual(info.skipped, [{ step: "Favicon check", reason: "timeout" }, { step: "Lighthouse (Core Web Vitals lab data)", reason: "Chrome not found" }, { step: "After-audit step", reason: "plain string" }]);
});

test("module loader: a missing module and a failing register are logged and listed; the rest still load", async () => {
  const registered = [], logs = [];
  const fake = {
    "./a.mjs": async () => ({ register: (ctx) => registered.push(["a", ctx.tag]) }),
    "./missing.mjs": async () => { throw Object.assign(new Error("Cannot find module 'x/missing.mjs'\nRequire stack"), { code: "ERR_MODULE_NOT_FOUND" }); },
    "./broken.mjs": async () => ({ register: () => { throw new Error("table locked"); } }),
    "./b.mjs": async () => ({}), // no register(): fine
    "./c.mjs": async () => ({ register: async () => registered.push(["c"]) }),
  };
  const failed = await loadModules(Object.keys(fake), { tag: 1 }, (m) => logs.push(m), (m) => fake[m]());
  assert.deepEqual(registered, [["a", 1], ["c"]]);
  assert.deepEqual(failed, [{ module: "./missing.mjs", reason: "not found (Cannot find module 'x/missing.mjs')" }, { module: "./broken.mjs", reason: "table locked" }]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /module \.\/missing\.mjs not loaded: not found/);
});

test("the real module list loads without failures", async () => {
  const { MODULES } = await import("../src/server.mjs");
  const skip = new Set(["./scheduler.mjs", "./backlinks.mjs", "./desktop.mjs", "./alerts.mjs", "./index-rotation.mjs"]); // timers and processes
  const failed = await loadModules(MODULES.filter((m) => !skip.has(m)), { routes: [], prefixes: [], cli: true }, () => {});
  assert.deepEqual(failed, []);
});
