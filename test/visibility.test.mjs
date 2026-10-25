// AI visibility: Perplexity and Gemini answers (REQ-018, 2026-10-24). Fixtures follow the real DataForSEO response
// shapes (perplexity/llm_responses/live, gemini/llm_scraper/live/advanced). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { brandMatcher, listedNames, parsePerplexity, parseGemini, PLATFORMS, startRun, call, RETRY_WAITS } = await import("../src/visibility.mjs");

const b = brandMatcher({ start_url: "https://acmemotors.com.au/", name: "Acme Motors", settings: "{}" });

const perplexity = (text, urls) => ({ model_name: "sonar", items: [{ type: "message", sections: [{ type: "text", text, annotations: urls.map((url, i) => ({ title: "Source " + i, url })) }] }] });

test("Perplexity: named and cited, with its place in the list", () => {
  const r = parsePerplexity(perplexity("**Bolt Panels** appears to be the strongest choice.[1]\n\nOther options:\n\n- **Crash Co** — towing.[2]\n- **Acme Motors** — 5 Main St.[3]\n\nAsk for a written quote.",
    ["https://boltpanels.com.au/", "https://www.crashco.com.au/", "https://acmemotors.com.au/smash-repairs.html"]), b);
  assert.equal(r.present, 1);
  assert.equal(r.mentioned, 1);
  assert.equal(r.cited, 1);
  assert.equal(r.rank, 3);
  assert.deepEqual(r.brands, ["Bolt Panels", "Crash Co", "Acme Motors"]);
  assert.equal(r.sources[1].domain, "crashco.com.au");
});

test("Perplexity: a competitor-only answer is not a mention", () => {
  const r = parsePerplexity(perplexity("- **Crash Co** — towing.[1]", ["https://www.crashco.com.au/"]), b);
  assert.deepEqual([r.mentioned, r.cited, r.rank], [0, 0, null]);
});

test("Gemini: sources are de-duplicated without the #:~:text= fragment; cited without being named", () => {
  const url = "https://acmemotors.com.au/claims.html";
  const r = parseGemini({ model: "3.5 Flash-Lite", markdown: "You can choose your own repairer.[acmemotors.com.au](" + url + "#:~:text=a)\n\n* **Crash Co:** courtesy cars.",
    sources: [{ type: "gemini_source", domain: "acmemotors.com.au", url: url + "#:~:text=a", title: "Claims" }, { type: "gemini_source", domain: "acmemotors.com.au", url: url + "#:~:text=b", title: "Claims" }],
    items: [{ type: "gemini_text", markdown: "x", sources: null }] }, b);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].url, url);
  assert.deepEqual([r.cited, r.rank], [1, null]);
  assert.deepEqual(r.brands, ["Crash Co"]);
});

test("numbered steps and mid-sentence bold are not business names", () => {
  assert.deepEqual(listedNames("1. **Gather information:** photos.\nCall **000** first.\n- **Bolt Panels:** towing"), ["Bolt Panels"]);
});

test("ChatGPT: rank comes from the answer's numbered list when the business cards leave the brand out", async () => {
  const { parseChatGpt } = await import("../src/visibility.mjs");
  const md = "Here are good options:\n\n**1\\. Acme Motors — Springfield**\n5 Main St\n**Phone\\:** 03 0000 0000\n\n**2\\. Crash Co**\nTowing.";
  const r = parseChatGpt({ markdown: md, sources: [{ domain: "acmemotors.com.au", url: "https://acmemotors.com.au/?utm_source=chatgpt.com" }],
    items: [{ type: "chat_gpt_local_businesses", items: [{ title: "Crash Co", domain: "crashco.com.au" }] }] }, b);
  assert.deepEqual([r.mentioned, r.cited, r.rank], [1, 1, 1]);
  assert.deepEqual(listedNames(md), ["Acme Motors — Springfield", "Crash Co"]);
});

test("both platforms are offered with a cost estimate", () => {
  for (const k of ["perplexity", "gemini"]) assert.ok(PLATFORMS[k].cost > 0 && PLATFORMS[k].label);
});

test("server errors are retried up to three times; other errors are not", async () => {
  RETRY_WAITS.fill(0);
  let n = 0;
  const flaky = async () => { if (++n < 4) throw new Error("DataForSEO: Internal SE Server Error."); return { ok: 1 }; };
  assert.deepEqual(await call("x", {}, null, flaky), { ok: 1 });
  assert.equal(n, 4);
  n = 0;
  await assert.rejects(call("x", {}, null, async () => { n++; throw new Error("DataForSEO: Invalid Field"); }), /Invalid Field/);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(call("x", {}, null, async () => { n++; throw new Error("DataForSEO: Internal SE Server Error."); }), /Internal/);
  assert.equal(n, 4);
});

test("a run without a DataForSEO login stops before it starts", async () => {
  const { run } = await import("../src/db.mjs");
  run("INSERT INTO projects (id, name, start_url) VALUES (970, 'Acme Motors', 'https://acmemotors.com.au/')");
  run("INSERT INTO ai_prompts (project_id, prompt) VALUES (970, 'smash repairs near me')");
  await assert.rejects(startRun({ id: 970, name: "Acme Motors", start_url: "https://acmemotors.com.au/", settings: "{}" }, ["perplexity"]), /DataForSEO login not found/);
  const { all } = await import("../src/db.mjs");
  assert.equal(all("SELECT id FROM ai_runs WHERE project_id=970").length, 0);
});
