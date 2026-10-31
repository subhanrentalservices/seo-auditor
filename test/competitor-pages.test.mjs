// Pages a competitor has that you don't (REQ-062, 2026-10-31): topics from the competitor's sitemap addresses,
// templated (place/brand/insurer) sections set aside, the rest matched against my audited pages. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run } = await import("../src/db.mjs");
const { topicOf, templatedSections, pageGap, competitorPages } = await import("../src/competitor-pages.mjs");

const R = "https://www.rival.example";
const SUBURBS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo".split(" ");
const INSURERS = "aami allianz apia bingle budget coles gio huddle nrma qbe racv shannons westpac youi suncorp woolworths".split(" ");
const theirs = [
  ...SUBURBS.map((s) => `${R}/locations/${s}-smash-repairs`),
  ...SUBURBS.map((s) => `${R}/towing/${s}-towing`),
  ...INSURERS.map((i) => `${R}/insurance/${i}-smash-repairs`),
  `${R}/claims/choice-of-repairer`, `${R}/claims/uninsured-and-not-at-fault`,
  `${R}/resources/how-towing-works-with-insurance-after-an-accident`, `${R}/resources/what-is-a-panel-beater`,
  `${R}/panel-beaters/hail-damage-repair`, `${R}/panel-beaters/rear-bumper-repair`, `${R}/panel-beaters/paintless-dent-removal`, `${R}/panel-beaters/roof-scratch-removal`, `${R}/about-us`, `${R}/contact-us`,
];
const mine = [
  { url: "https://me.example/smash-repairs.html", title: "Smash Repairs & Panel Beaters", h1: "Smash repairs and panel beating" },
  { url: "https://me.example/bumper-dent-scratch-repairs.html", title: "Bumper, Dent & Scratch Repairs", h1: "Bumper repairs", headings: ["Paintless dent removal", "Scratch repairs"] },
  { url: "https://me.example/blog/towing-after-a-car-accident.html", title: "Towing after a car accident: who pays", h1: "Towing after an accident" },
];

test("topicOf: the folder and the words of the last part of the address", () => {
  assert.deepEqual(topicOf(`${R}/resources/what-is-a-panel-beater`), { section: "resources", words: ["panel", "beater"], label: "what is a panel beater" });
  assert.deepEqual(topicOf(`${R}/contact-us`), { section: "", words: ["contact"], label: "contact us" });
  assert.deepEqual(topicOf(`${R}/blog/2024/07/hail-damage.html`).words, ["hail", "damag"], "stems, for matching");
  assert.equal(topicOf(`${R}/blog/2024/07/hail-damage.html`).label, "hail damage", "as written, for display");
});

test("templated sections: one template with a place or insurer swapped in", () => {
  const t = templatedSections(theirs);
  assert.ok(t.has("locations") && t.has("towing") && t.has("insurance"));
  assert.ok(!t.has("resources") && !t.has("claims"));
  // 15+ genuinely different guides in one folder are not a template
  const guides = ["what-is-third-party-insurance", "how-long-does-a-claim-take", "who-pays-the-excess", "what-to-photograph-after-a-crash",
    "how-insurers-decide-fault", "towing-costs-explained", "hire-car-after-an-accident", "minor-accident-claim-or-pay", "hail-damage-repair-guide",
    "paint-matching-explained", "adas-calibration-after-repairs", "written-off-car-what-next", "uninsured-driver-hit-my-car", "parked-car-hit-what-to-do",
    "insurer-delaying-claim"].map((s) => `${R}/guides/${s}`);
  assert.ok(!templatedSections(guides).has("guides"));
});

test("pageGap: topics I have no page for, templated sections skipped", () => {
  const g = pageGap(theirs, mine);
  assert.equal(g.pages, theirs.length);
  const gapUrls = g.gaps.map((x) => x.url.replace(R, ""));
  assert.ok(gapUrls.includes("/claims/choice-of-repairer"));
  assert.equal(g.gaps.find((x) => x.url.endsWith("choice-of-repairer")).topic, "choice of repairer");
  assert.ok(gapUrls.includes("/panel-beaters/hail-damage-repair"));
  assert.ok(!gapUrls.includes("/panel-beaters/rear-bumper-repair"), "my bumper page covers it");
  assert.ok(!gapUrls.includes("/panel-beaters/paintless-dent-removal"), "a section (H2/H3) on my bumper page covers it");
  assert.ok(gapUrls.includes("/panel-beaters/roof-scratch-removal"), "words from different sections don't add up");
  assert.ok(!gapUrls.includes("/resources/what-is-a-panel-beater"), "my smash repairs page uses panel beater");
  assert.ok(!gapUrls.includes("/resources/how-towing-works-with-insurance-after-an-accident"), "my towing post covers towing after an accident");
  assert.ok(!gapUrls.some((u) => u.startsWith("/locations/") || u.startsWith("/towing/") || u.startsWith("/insurance/")));
  assert.equal(g.sections.find((s) => s.section === "locations").templated, true);
});

test("competitorPages: reads the sitemap from robots.txt and needs an audit of my own site", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (770, 'Me', 'https://me.example/')");
  await assert.rejects(competitorPages(770, ["rival.example"], { load: async () => ({ urls: theirs }), getRobots: async () => ({ status: 200, body: "" }) }), /audit/);
  run("INSERT INTO audits (id, project_id, status) VALUES (771, 770, 'done')");
  for (const p of mine) run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1) VALUES (771, ?, ?, 200, 1, 'text/html', ?, ?)", p.url, p.url, p.title, p.h1);
  let robotsSeen = null;
  const r = await competitorPages(770, "www.rival.example", { getRobots: async () => ({ status: 200, body: "Sitemap: https://www.rival.example/sm.xml" }),
    load: async (origin, robotsTxt) => { robotsSeen = robotsTxt; return { urls: new Set([...theirs, "https://elsewhere.example/x-y-z"]) }; } }); // loadSitemaps returns a Set
  assert.equal(robotsSeen, "Sitemap: https://www.rival.example/sm.xml");
  assert.equal(r.myPages, 3);
  assert.equal(r.sites[0].site, R);
  assert.equal(r.sites[0].pages, theirs.length, "other sites' addresses in the sitemap are ignored");
  const none = await competitorPages(770, ["empty.example"], { getRobots: async () => ({ status: 404 }), load: async () => ({ urls: [] }) });
  assert.match(none.sites[0].error, /No XML sitemap/);
  await assert.rejects(competitorPages(770, " "), /competitor/);
});
