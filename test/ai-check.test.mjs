// AI-wording check (owner rule 2026-11-11). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { tells, aiCheck, partsFromText, partsFromHtml } = await import("../src/ai-check.mjs");

const names = (t) => tells(t).map((h) => h.tell);

test("phrase tells are caught in short texts, with their line", () => {
  assert.ok(names("Repairs done right — every time.").includes("em dash"));
  assert.ok(names("It's not just a repair, it's peace of mind.").includes("it's not X, it's Y"));
  assert.ok(names("We offer not only towing but also repairs.").includes("not just X but Y"));
  assert.ok(names("No stress, no paperwork, no waiting.").includes("no X, no Y, no Z"));
  assert.ok(names("Moreover, the claim is quick.").includes("stiff connector"));
  assert.ok(names("When it comes to repairs, we deliver.").includes("stock opener"));
  assert.ok(names("Ultimately, the choice is yours.").includes("summary closer"));
  assert.ok(names("Unlock a seamless claim experience.").includes("hype word"));
  assert.ok(names("Rest assured we have it handled.").includes("stock phrase"));
  const h = tells("Line one is plain.\nThis line has a delve.");
  assert.equal(h[0].line, 2);
});

test("plain, specific copy passes", () => {
  const t = "Crash anywhere in Victoria that wasn't your fault? We handle the claim, arrange the tow to our Dandenong workshop and repair your car. Call 03 8774 5785.";
  assert.deepEqual(tells(t), []);
  assert.equal(aiCheck(t).pass, true);
  assert.equal(aiCheck(t).style, null, "under 300 words: phrase check only");
});

test("ordinary words that contain a tell are not flagged", () => {
  assert.deepEqual(names("The keys are in the key box. Our boat is moored at the marina."), []);
  assert.deepEqual(names("It's not raining. No parking here."), []);
});

test("Markdown and HTML are split into paragraphs, list items and headings", () => {
  const md = partsFromText("# Title\n\nFirst paragraph here.\nStill the first.\n\n- **Speed:** fast\n- plain item\n\nSecond paragraph.");
  assert.deepEqual(md.headings, ["Title"]);
  assert.equal(md.paragraphs.length, 2);
  assert.equal(md.items.length, 2);
  assert.equal(md.labelItems, 1);
  const html = partsFromHtml("<html><body><nav><p>Menu text</p></nav><main><h2>Why</h2><p>One.</p><ul><li><strong>Cost:</strong> low</li></ul></main></body></html>");
  assert.deepEqual(html.paragraphs, ["One."]);
  assert.equal(html.labelItems, 1);
  assert.deepEqual(html.headings, ["Why"]);
});

test("long text gets the ai-style score too and fails under 85", () => {
  const even = Array.from({ length: 60 }, (_, i) => `The workshop checks item number ${i} carefully before the car goes back to the customer.`).join(" ");
  const r = aiCheck(even);
  assert.ok(r.style && r.style.score < 85);
  assert.equal(r.pass, false);
});
