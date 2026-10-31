// docs/api.md (REQ-055 group 9): generated from the routes the server registers; every route needs a parameter note
// in scripts/api-docs.mjs, and the committed file must match. Run: npm test (fix: node scripts/api-docs.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { apiDoc, pathOf, DOC } = await import("../scripts/api-docs.mjs");

test("route regexes become readable paths", () => {
  assert.equal(pathOf(/^\/api\/projects\/(\d+)\/visibility\/runs\/(\d+)\/resume$/), "/api/projects/:projectId/visibility/runs/:runId/resume");
  assert.equal(pathOf(/^\/api\/audits\/(\d+)\/issues\/([a-z0-9_]+)$/), "/api/audits/:auditId/issues/:checkId");
  assert.equal(pathOf(/^\/api\/compare\/(\d+)\/(\d+)$/), "/api/compare/:a/:b");
  assert.equal(pathOf(/^\/api\/projects\/(\d+)\/disavow\.txt$/), "/api/projects/:projectId/disavow.txt");
});

test("every route has a note, and docs/api.md is current", async () => {
  const { text, missing, routes } = await apiDoc();
  assert.deepEqual(missing, [], "add these to NOTES in scripts/api-docs.mjs");
  assert.ok(routes.length > 100);
  assert.equal(new Set(routes.map((r) => `${r.method} ${r.path}`)).size, routes.length, "no route registered twice");
  assert.equal(readFileSync(DOC, "utf8").replace(/\r\n/g, "\n"), text, "run node scripts/api-docs.mjs");
});
