// Model-based AI detector: the text extraction and verdict parts (the Python models aren't loaded in tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { textFromHtml, textFromMarkdown, detectVerdict, AI_LIKELY, AI_PASS_BELOW } from "../src/ai-detect.mjs";

test("HTML text keeps the main content in document order and drops chrome", () => {
  const html = "<html><body><nav><p>Menu</p></nav><main><h1>Title</h1><p>First.</p><ul><li><p>Inner item.</p></li><li>Plain item</li></ul><button>Upload</button><p>Last.</p></main><footer><p>Foot</p></footer></body></html>";
  assert.equal(textFromHtml(html), "Title\n\nFirst.\n\nInner item.\n\nPlain item\n\nLast.");
});

test("Markdown text drops front matter, tables, images and code but keeps link text", () => {
  const md = "---\nslug: x\n---\n# Head\n\nSee [the guide](/blog/x) **now**.\n\n| a | b |\n|---|---|\n\n![alt](/i.png)\n\n```js\ncode()\n```\n- item one";
  const t = textFromMarkdown(md);
  assert.match(t, /^Head/);
  assert.match(t, /See the guide now\./);
  assert.match(t, /item one/);
  assert.doesNotMatch(t, /slug|\| a|alt|code\(\)/);
});

test("verdict: passes only when the page and every block are low", () => {
  const r = (ai, chunks) => ({ ai, chunks: chunks.map((c) => ({ ai: c })) });
  assert.equal(detectVerdict(r(0.05, [0.04, 0.1])).pass, true);
  assert.equal(detectVerdict(r(0.15, [0.05, AI_LIKELY])).pass, false, "one AI-like block fails the page");
  assert.equal(detectVerdict(r(AI_PASS_BELOW, [0.1])).pass, false);
  assert.equal(detectVerdict(r(0.8, [0.8])).label, "likely AI");
  assert.equal(detectVerdict(r(0.3, [0.3])).label, "mixed");
});

test("detect.py reads its JSON input as UTF-8, not the Windows code page (\"·\" arrived as \"Â·\")", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../detector/detect.py", import.meta.url), "utf8");
  assert.match(src, /sys\.stdin\.buffer\.read\(\)\.decode\("utf-8"\)/);
  assert.doesNotMatch(src, /json\.load\(sys\.stdin\)/);
});
