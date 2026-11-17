// Human Writer loop with Claude and the detector replaced by stubs. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
process.env.SEO_AUDITOR_DATA = tmp;
// a small skill so the test doesn't depend on the owner's copy
const skill = path.join(tmp, "skill");
mkdirSync(path.join(skill, "references"), { recursive: true });
writeFileSync(path.join(skill, "SKILL.md"), "# s\n\n## 1. What\n\nHonesty rules come first and never bend:\n- Never invent.\n\n## 2. Data\n\nd\n\n## 3. Levers\n\nJoin sentences.\n\n## 4. Never use\n\nHere's what.\n\n## 8. Short\n\nshort\n\n## 9. Limits\n\nx\n");
writeFileSync(path.join(skill, "references", "examples.md"), "examples");
process.env.SEO_AUDITOR_HUMAN_VOICE_SKILL = skill;

const W = await import("../src/human-writer.mjs");

// detector stub: a block reads as AI when it contains the word "draftish"
W.setDetector(async (texts) => texts.map((t) => (/draftish/.test(t) ? 0.95 : 0.04)));
const calls = [];
let blockReply = (p) => p;
W.setClaude(async (prompt) => {
  calls.push(prompt);
  if (prompt.includes("List every fact")) return { text: "- 5 MB limit\n- link to /help", cost: 0.01, tokensIn: 100, tokensOut: 10 };
  if (prompt.includes("Compare the ORIGINAL")) return { text: '{"ok": true, "issues": []}', cost: 0.01, tokensIn: 100, tokensOut: 10 };
  if (prompt.includes("PARAGRAPHS TO REWRITE")) return { text: blockReply(prompt), cost: 0.02, tokensIn: 500, tokensOut: 50 };
  // whole-text write: second paragraph still sounds like a draft, colour in US text gets fixed by fixVariant
  return { text: `<text>## Upload\n\n${P1.replace("can be", "is")}\n\n${P2}\n</text>`, cost: 0.05, tokensIn: 1000, tokensOut: 200 };
});

const words = (n, w = "word") => Array.from({ length: n }, () => w).join(" ");
const P1 = `The colour of a file can be anything, and Notion takes files up to 5 MB on the free plan, see [help](/help). ${words(150)}.`;
const P2 = `This draftish paragraph keeps the **Upload** label and ${words(150, "text")}.`;
const SOURCE = `## Upload\n\n${P1}\n\n${P2}\n`;

test("segments and blocks: prose only, 150+ word blocks, short leftovers join the block before", () => {
  const { segs } = W.segments(`---\ntitle: x\n---\n## H\n\n${words(160)}.\n\n- a list item here\n\n${words(30)} short tail here.`);
  assert.equal(segs.filter((s) => s.prose).length, 2);
  assert.deepEqual(W.blocksOf(segs), [[1, 3]]);
});

test("a run rewrites, re-detects, fixes only the flagged block and passes with every fact kept", async () => {
  blockReply = () => `<text>[1] The **Upload** label stays, and ${words(150, "text")}.</text>`;
  const { id } = W.startRun({ text: SOURCE, variant: "us", purpose: "blog", maxRounds: 4 });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.status, "passed", r.message);
  assert.deepEqual(r.facts, ["5 MB limit", "link to /help"]);
  assert.equal(r.rounds[0].label, "Source");
  assert.ok(r.rounds[0].blocks.some((b) => b.ai >= 0.2));
  assert.ok(r.rounds[1].blocks.some((b) => b.ai >= 0.2), "Claude's first text still had a flagged block");
  assert.ok(r.rounds.at(-1).blocks.every((b) => b.ai < 0.2));
  assert.match(r.output, /color of a file/, "American spelling applied");
  assert.match(r.output, /5 MB/);
  assert.match(r.output, /\]\(\/help\)/);
  assert.deepEqual(r.final.verify.fail, []);
  assert.equal(r.meaning.ok, true);
  assert.ok(Math.abs(r.cost - (0.01 + 0.05 + 0.02 + 0.01)) < 1e-9);
  // the block prompt names the flagged block only and carries the skill text and the variant rules
  const bp = calls.find((c) => c.includes("PARAGRAPHS TO REWRITE"));
  assert.match(bp, /draftish/);
  assert.doesNotMatch(bp.split("PARAGRAPHS TO REWRITE")[1], /colou?r of a file/);
  assert.match(bp, /Join sentences/);
  assert.match(bp, /Write in American English/);
});

test("a rewrite that drops a number is not passed and the failure is listed", async () => {
  W.setClaude(async (prompt) => {
    if (prompt.includes("List every fact")) return { text: "- 5 MB", cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("Compare the ORIGINAL")) return { text: '{"ok": false, "issues": [{"problem": "5 MB dropped"}]}', cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("PARAGRAPHS TO REWRITE")) return { text: "nothing usable", cost: 0, tokensIn: 0, tokensOut: 0 };
    return { text: `<text>## Upload\n\n${P1.replace("5 MB", "a few megabytes")}\n\n${P2.replace("draftish ", "")}\n</text>`, cost: 0, tokensIn: 0, tokensOut: 0 };
  });
  const { id } = W.startRun({ text: SOURCE, variant: "us", maxRounds: 2 });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.status, "done");
  assert.ok(r.rounds.at(-1).factFails.some((f) => f.includes("5mb")));
  assert.equal(r.meaning.ok, false);
});

test("the monthly Claude limit stops runs before they spend more", async () => {
  W.saveSettings({ monthlyCapUsd: 0 });
  const { id } = W.startRun({ text: SOURCE });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.status, "failed");
  assert.match(r.message, /limit/);
  await assert.rejects(() => W.makeFacts("some text", "blog"), /limit/);
  W.saveSettings({ monthlyCapUsd: 25 });
});

test("export as Markdown, plain text and Word", () => {
  const id = W.listRuns().runs.find((r) => r.status === "passed").id;
  assert.match(W.exportRun(id, "md").body, /\[help\]\(\/help\)/);
  const txt = W.exportRun(id, "txt").body;
  assert.match(txt, /help \(\/help\)/);
  assert.doesNotMatch(txt, /\*\*|##/);
  const docx = W.exportRun(id, "docx");
  assert.equal(docx.body.subarray(0, 2).toString(), "PK");
  assert.match(docx.headers["Content-Disposition"], /\.docx"/);
});

test("checkText scores blocks without Claude and reports variant spelling", async () => {
  const r = await W.checkText(SOURCE, "us");
  assert.equal(r.pass, false);
  assert.equal(r.blocks.length, 2);
  assert.deepEqual(r.variant.hits.map((h) => h.word), ["colour"]);
});

test("hotspots rank the sentence that pushes the score up", async () => {
  const h = await W.hotspots("This one is fine. This draftish one is not. Another fine one.");
  assert.equal(h.sentences.sort((a, b) => b.drop - a.drop)[0].text, "This draftish one is not.");
});

test("batch reads a folder, never writes to it, and saves results in data/writer-out", async () => {
  W.setClaude(async (prompt) => (prompt.includes("List every fact") ? { text: "- x", cost: 0, tokensIn: 0, tokensOut: 0 }
    : prompt.includes("Compare the ORIGINAL") ? { text: '{"ok":true,"issues":[]}', cost: 0, tokensIn: 0, tokensOut: 0 }
      : { text: `<text>${words(160, "plain")}.</text>`, cost: 0, tokensIn: 0, tokensOut: 0 }));
  const dir = path.join(tmp, "posts");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "a.md"), `${words(160, "draftish")}.`);
  writeFileSync(path.join(dir, "b.txt"), `${words(160, "draftish")}.`);
  writeFileSync(path.join(dir, "skip.json"), "{}");
  const b = await W.startBatch({ folder: dir, variant: "uk", mode: "rewrite", maxRounds: 1 });
  assert.equal(b.runs, 2);
  await W.idle();
  assert.ok(existsSync(path.join(b.out, "a.md")));
  assert.ok(existsSync(path.join(b.out, "b.txt.md")));
  assert.equal(readFileSync(path.join(dir, "a.md"), "utf8"), `${words(160, "draftish")}.`);
  assert.equal(W.listRuns({ batch: b.batch }).runs.length, 2);
});

test("a text too short for the detector passes on facts and phrases alone, with a note", async () => {
  W.setClaude(async (prompt) => (prompt.includes("List every fact") ? { text: "- free", cost: 0, tokensIn: 0, tokensOut: 0 }
    : prompt.includes("Compare the ORIGINAL") ? { text: '{"ok":true,"issues":[]}', cost: 0, tokensIn: 0, tokensOut: 0 }
      : { text: "<text>Turn any picture into a link you can share, free and with no sign-up.</text>", cost: 0, tokensIn: 0, tokensOut: 0 }));
  const { id } = W.startRun({ text: "Upload an image and get a shareable link instantly, free.", purpose: "meta" });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.status, "passed");
  assert.match(r.message, /Too short for the detector/);
});

test("batch from URLs reads each page's main content, obeys robots.txt and lists what it skipped", async () => {
  W.setFetch(async (url) => {
    const html = url.endsWith("/robots.txt") ? ["User-agent: *", "Disallow: /private"].join(String.fromCharCode(10)) :`<html><body><nav>menu</nav><main><h1>Title</h1><p>${words(160, "draftish")}.</p></main></body></html>`;
    return { status: 200, headers: { get: () => (url.endsWith(".txt") ? "text/plain" : "text/html") }, text: async () => html,
      arrayBuffer: async () => new TextEncoder().encode(html).buffer, body: null, url };
  });
  const b = await W.startBatch({ urls: "https://example.com/blog/a-post/ https://example.com/private/x not-a-url", maxRounds: 1 });
  assert.equal(b.runs, 1);
  assert.deepEqual(b.skipped.map((s) => s.why), ["robots.txt"]);
  await W.idle();
  const r = W.getRun(b.ids[0]);
  assert.equal(r.name, "blog_a-post");
  assert.match(r.input, /# Title/);
  assert.doesNotMatch(r.input, /menu/);
});

test("edit mode tells Claude to keep the writer's skeleton and still checks facts", async () => {
  const seen = [];
  W.setClaude(async (prompt) => {
    seen.push(prompt);
    if (prompt.includes("List every fact")) return { text: "- 5 MB", cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("Compare the ORIGINAL")) return { text: '{"ok":true,"issues":[]}', cost: 0, tokensIn: 0, tokensOut: 0 };
    return { text: `<text>${SOURCE.replace("draftish ", "")}</text>`, cost: 0, tokensIn: 0, tokensOut: 0 };
  });
  const { id } = W.startRun({ text: SOURCE, mode: "edit", variant: "uk" });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.options.mode, "edit");
  assert.match(seen.find((p) => p.includes("THE TASK")), /keep their order of ideas/);
  assert.deepEqual(r.final.verify.fail, []);
  assert.equal(r.status, "passed");
});

test("a meaning change found by Claude blocks a pass", async () => {
  W.setClaude(async (prompt) => (prompt.includes("List every fact") ? { text: "- x", cost: 0, tokensIn: 0, tokensOut: 0 }
    : prompt.includes("Compare the ORIGINAL") ? { text: '{"ok":false,"issues":[{"problem":"instruction became first person"}]}', cost: 0, tokensIn: 0, tokensOut: 0 }
      : { text: `<text>${SOURCE.replace("draftish ", "")}</text>`, cost: 0, tokensIn: 0, tokensOut: 0 }));
  const { id } = W.startRun({ text: SOURCE, mode: "edit" });
  await W.idle();
  const r = W.getRun(id);
  assert.equal(r.status, "done");
  assert.match(r.message, /Meaning check: 1 change/);
});

test("translate mode asks for a faithful translation and shows Claude the person's original when fixing a block", async () => {
  const seen = [];
  let first = true;
  W.setClaude(async (prompt) => {
    seen.push(prompt);
    if (prompt.includes("List every fact")) return { text: "- 5 MB", cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("Compare the ORIGINAL")) return { text: '{"ok":true,"issues":[]}', cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("PARAGRAPHS TO REWRITE")) return { text: `<text>[1] Plain ${words(150, "text")}.</text>`, cost: 0, tokensIn: 0, tokensOut: 0 };
    const out = first ? `${P1}\n\n${P2}` : `${P1}\n\n${P2.replace("draftish ", "")}`;
    first = false;
    return { text: `<text>## Upload\n\n${out}\n</text>`, cost: 0, tokensIn: 0, tokensOut: 0 };
  });
  const urdu = `## Upload\n\n${P1}\n\n${P2}\n\nYeh mera apna note hai, jaisa likha waisa rakhna.`;
  const { id } = W.startRun({ text: urdu, mode: "translate", maxRounds: 2 });
  await W.idle();
  const task = seen.find((p) => p.includes("THE TASK") && !p.includes("PARAGRAPHS TO REWRITE"));
  assert.match(task, /Translate the person's text below/);
  const block = seen.find((p) => p.includes("PARAGRAPHS TO REWRITE"));
  assert.match(block, /THE PERSON'S ORIGINAL TEXT/);
  assert.match(block, /Yeh mera apna note hai/);
  assert.equal(W.getRun(id).options.mode, "translate");
});

test("with a live page, facts and links are checked against it and Claude is told to keep its structure", async () => {
  const seen = [];
  W.setClaude(async (prompt) => {
    seen.push(prompt);
    if (prompt.includes("List every fact")) return { text: "- 5 MB", cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("Compare the ORIGINAL")) return { text: '{"ok":true,"issues":[]}', cost: 0, tokensIn: 0, tokensOut: 0 };
    return { text: `<text>${SOURCE.replace("draftish ", "").replace("](/help)", "](/other)")}</text>`, cost: 0, tokensIn: 0, tokensOut: 0 };
  });
  const { id } = W.startRun({ text: "Notion mein 5 MB tak ki file chalti hai, help dekho.", reference: SOURCE, mode: "translate", maxRounds: 1 });
  await W.idle();
  const r = W.getRun(id);
  assert.match(seen.find((p) => p.includes("THE TASK")), /LIVE PAGE: the person's text replaces the prose/);
  assert.ok(seen.find((p) => p.includes("List every fact")).includes("[help](/help)"), "facts come from the live page");
  assert.ok(r.final.verify.fail.some((f) => f.includes("link dropped: /help")), "checked against the live page");
  assert.notEqual(r.status, "passed");
});

test("the output is the best round, not the last: lowest score without fact problems, later round on a tie", async () => {
  const { pickBestRound } = await import("../src/human-writer.mjs");
  const r = (round, ai, factFails = []) => ({ round, ai, factFails });
  assert.equal(pickBestRound([r(0, 0.81), r(1, 0.99), r(2, 0.72), r(3, 0.55), r(4, 0.59)]).round, 3);
  assert.equal(pickBestRound([r(0, 0.1), r(1, 0.5), r(2, 0.3, ["number 26 missing"])]).round, 1);
  assert.equal(pickBestRound([r(0, 0.9), r(1, 0.4), r(2, 0.4)]).round, 2);
  assert.equal(pickBestRound([r(0, 0.9)]), null);
});

test("a low round with a lost fact is repaired instead of thrown away, and a meaning change is repaired too", async () => {
  let meaningCalls = 0;
  const seen = [];
  W.setClaude(async (prompt) => {
    seen.push(prompt);
    const z = { cost: 0, tokensIn: 0, tokensOut: 0 };
    if (prompt.includes("List every fact")) return { text: "- 5 MB limit", ...z };
    if (prompt.includes("Compare the ORIGINAL")) return { text: ++meaningCalls === 1 ? '{"ok":false,"issues":[{"original":"a","rewrite":"b","problem":"changed"}]}' : '{"ok":true,"issues":[]}', ...z };
    if (prompt.includes("Fix only these problems")) return { text: `<text>## Upload\n\n${P1}\n\n${P2.replace("draftish ", "")}\n</text>`, ...z };
    // the whole-text write reads human but drops the 5 MB limit
    return { text: `<text>## Upload\n\n${P1.replace("5 MB", "a few")}\n\n${P2.replace("draftish ", "")}\n</text>`, ...z };
  });
  const { id } = W.startRun({ text: SOURCE, maxRounds: 1 });
  await W.idle();
  const r = W.getRun(id);
  assert.deepEqual(r.rounds.map((x) => x.label), ["Source", "Written by Claude", "Fact repair", "Meaning repair"]);
  assert.ok(r.rounds[1].factFails.length, "round 1 lost a fact");
  assert.match(r.output, /5 MB/);
  assert.equal(r.meaning.ok, true);
  assert.equal(r.status, "passed", r.message);
  assert.equal(seen.filter((p) => p.includes("Fix only these problems")).length, 2);
});
