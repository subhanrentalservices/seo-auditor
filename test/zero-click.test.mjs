// Near page 1 but never clicked (REQ-062, 2026-10-31): 0-click searches at positions 5–20 and whether the ranking
// page uses the search's exact words in a heading, in its text, only scattered, or not at all. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // creates gsc_queries
const { zeroClickGaps, searchStatus } = await import("../src/topics.mjs");

const S = "https://lensly.example";
run("INSERT INTO projects (id, name, start_url) VALUES (880, 'Lensly', 'https://lensly.example/')");
run("INSERT INTO audits (id, project_id, status) VALUES (881, 880, 'done')");
run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1, data) VALUES (881, ?, ?, 200, 1, 'text/html', 'Eyeglasses Care Guide', 'Eyeglasses care: keep your lenses clear', ?)",
  S + "/care", S + "/care", JSON.stringify({ h2s: ["How to store glasses", "Best glasses for round face?"] }));
run("INSERT INTO page_text (audit_id, url, text) VALUES (881, ?, ?)", S + "/care",
  "Your glasses work hard every day. Rinse lenses under lukewarm water. Store them in a hard case. Choosing frames for a round face is about contrast.");
const q = (query, impressions, position, clicks = 0) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (880, ?, ?, ?, ?, 0, ?)", query, S + "/care", clicks, impressions, position);
q("how to clean glasses safely", 2400, 8.4);  // missing: "clean", "safely" never used
q("best glasses for round face", 1850, 12.6); // already a heading
q("store them in a hard case", 40, 9);        // exact phrase in the text, not a heading
q("lenses lukewarm water rinse", 30, 14);     // all words close together, different order
q("prescription lens types", 920, 17.2);      // missing
q("glasses case lenses round", 25, 11);        // every word on the page, never together
q("eyeglass frames men", 3900, 4.2, 148);     // has clicks: ignored
q("glasses repair near me", 310, 31);         // beyond position 20: ignored
q("lensly glasses", 500, 6);                  // brand: ignored
q("blue light glasses", 3, 7);                // under 5 impressions: ignored

test("0-click searches at positions 5-20, biggest first, with how the page uses them", () => {
  const d = zeroClickGaps(881);
  assert.equal(d.connected, true);
  assert.equal(d.total, 6);
  assert.deepEqual(d.counts, { heading: 1, exact: 1, words: 1, scattered: 1, missing: 2 });
  assert.deepEqual(d.rows.map((r) => [r.query, r.status]), [
    ["how to clean glasses safely", "missing"], ["prescription lens types", "missing"],
    ["store them in a hard case", "exact"], ["lenses lukewarm water rinse", "words"], ["glasses case lenses round", "scattered"]]);
  assert.ok(d.rows[0].question, "a how-to search is a question");
  assert.deepEqual(d.rows[0].missing, ["clean", "safely"]);
});

test("searchStatus: a heading wins, then the exact phrase, then the words together", () => {
  const page = { title: "Brake repairs", h1: "Brake repairs in Springfield", headings: ["How much do brake pads cost?"], text: "We replace brake pads and discs the same day." };
  assert.equal(searchStatus("brake repairs in springfield", page), "heading");
  assert.equal(searchStatus("how much do brake pads cost", page), "heading");
  assert.equal(searchStatus("replace brake pads", page), "exact");
  assert.equal(searchStatus("brake disc replace", page), "words");
  assert.equal(searchStatus("brake pads springfield", page), "scattered", "service in one place, area in another");
  assert.equal(searchStatus("abs warning light", page), "missing");
});
