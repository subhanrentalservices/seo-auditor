// AI Overview gap (REQ-095, 2026-11-05): your page vs the AI Overview answer and every page it cites. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run } = await import("../src/db.mjs");
await import("../src/visibility.mjs"); // creates the ai_* tables
const { answerSentences, covered, aioGapReport, overviewSearches } = await import("../src/aio-gap.mjs");
const { words } = await import("../src/page2.mjs");

const page = (title, h2s, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>
<p>${body}</p>${h2s.map((x) => `<h2>${x}</h2><p>${body}</p>`).join("")}</main></body></html>`;
const mine = page("Accident replacement car Dandenong", ["How the replacement car works"],
  "If another driver hit you, we arrange a replacement car while your car is repaired. Bring your claim number.");
const rivalA = page("Not at fault car hire Victoria", ["Who pays for the hire car", "What documents do you need", "Delivery to your home or workplace"],
  "Not at fault drivers get a like-for-like car delivered to the home or workplace, paid by the at-fault driver's insurer. Updated 1 October 2026.");
const rivalB = page("Accident replacement vehicles", ["Who pays for the hire car", "Delivery to your home or workplace"],
  "The at-fault insurer pays for the replacement vehicle. We deliver it.");
const fake = (pages) => async (u) => pages[u] ? { status: 200, type: "text/html", body: pages[u], finalUrl: u } : { status: 404, type: "text/html", body: "" };
const PAGES = { "https://ss.example/car": mine, "https://rival-a.example/hire": rivalA, "https://rival-b.example/vehicles": rivalB };

test("answerSentences(): strips citation markers, links and markdown, keeps real sentences", () => {
  const s = answerSentences("If you were **not at fault**, a `hire company` can deliver a car.[[1]](https://a.example/)\n### Top providers\n- [Acme Hire](https://acme.example) delivers to your home in Dandenong.");
  assert.deepEqual(s, ["If you were not at fault , a hire company can deliver a car.", "Acme Hire delivers to your home in Dandenong."]);
});

test("covered(): share of a sentence's content words found on the page", () => {
  const have = new Set(words("we arrange a replacement car while your car is repaired"));
  assert.equal(covered("replacement car arrange while repaired", have), 1);
  assert.ok(covered("like-for-like car delivered to your workplace", have) < 0.5);
});

test("report: answer statements, headings shared by cited pages, and page-level differences most of them share", async () => {
  const r = await aioGapReport({ id: 1 }, {
    mine: "https://ss.example/car", keyword: "replacement car after an accident",
    sources: ["https://rival-a.example/hire", "https://rival-b.example/vehicles", "https://ss.example/other", "https://www.facebook.com/groups/1", "https://gone.example/x"],
    answer: "Not at fault drivers can get a like-for-like car delivered to their home or workplace.[[1]](https://rival-a.example/hire) We arrange a replacement car while your car is repaired.",
  }, { fetchPage: fake(PAGES) });
  assert.equal(r.from, "pasted");
  assert.equal(r.youCited, true, "own domain among the cited pages");
  assert.equal(r.skipped, 1, "facebook skipped; own page not fetched as a rival");
  assert.deepEqual(r.sources.map((s) => s.error ? `${s.url} ${s.error}` : s.url), ["https://rival-a.example/hire", "https://rival-b.example/vehicles", "https://gone.example/x HTTP 404"]);
  assert.equal(r.answerGaps.length, 1);
  assert.match(r.answerGaps[0], /like-for-like/);
  assert.equal(r.topicGaps[0].topic, "Who pays for the hire car");
  assert.equal(r.topicGaps[0].pages.length, 2, "shared by both cited pages, so listed first");
  assert.ok(r.topicGaps.some((t) => /documents/.test(t.topic)));
  assert.ok(!r.topicGaps.some((t) => /replacement car works/i.test(t.topic)), "my own heading is never a gap");
  assert.ok(r.structure.every((s) => s.pages >= 1 && s.of === 2));
});

test("uses the stored Google AI Overview for the search when no pages are pasted", async () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (7, 'SS', 'https://ss.example/')");
  const runId = Number(run("INSERT INTO ai_runs (project_id, status, platforms, prompts) VALUES (7, 'done', 'google', 1)").lastInsertRowid);
  const serp = { top: [{ pos: 1, url: "https://rival-b.example/vehicles", type: "article" }, { pos: 2, url: "https://google.com/goto?url=x", type: "business" },
    { pos: 3, url: "https://ss.example/car", type: "service" }, { pos: 4, url: "https://rival-a.example/hire", type: "article" }],
    paa: ["Who pays for a hire car after an accident?", "Can I get a replacement car while my car is repaired?"] };
  run("INSERT INTO ai_results (run_id, prompt, platform, present, sources, excerpt, serp) VALUES (?, ?, 'google', 1, ?, ?, ?)", runId, "Replacement car after an accident",
    JSON.stringify([{ domain: "rival-a.example", url: "https://rival-a.example/hire" }, { domain: "rival-a.example", url: "https://rival-a.example/hire" },
      { domain: "google.com", url: "https://www.google.com/searchviewer/10?svid=x" }]), "Not at fault drivers get a like-for-like car delivered to the workplace.", JSON.stringify(serp));
  assert.deepEqual(overviewSearches(7), ["Replacement car after an accident"]);
  const r = await aioGapReport({ id: 7 }, { mine: "https://ss.example/car", keyword: "replacement car AFTER an accident " }, { fetchPage: fake(PAGES) });
  assert.match(r.from, new RegExp(`^AI visibility run ${runId} `));
  // the cited page and the top-ranked results are read; Google's own business links and your page are not
  assert.deepEqual(r.sources.map((x) => [x.url, x.role]), [["https://rival-a.example/hire", "AI Overview + #4"], ["https://rival-b.example/vehicles", "#1"]]);
  assert.equal(r.ownPos, 3);
  assert.equal(r.aio, true);
  assert.equal(r.answerGaps.length, 1);
  assert.deepEqual(r.questionGaps, ["Who pays for a hire car after an accident?"], "the question my page already answers is not a gap");
  await assert.rejects(aioGapReport({ id: 7 }, { mine: "https://ss.example/car", keyword: "never searched" }, { fetchPage: fake(PAGES) }), /No Google result is stored/);
  await assert.rejects(aioGapReport({ id: 7 }, { mine: "ss.example/car", keyword: "x" }), /full address/);
});

test("noise is dropped: competitor contact lines, images, headings run together from menus, boilerplate and brand-only headings", async () => {
  const { topicHeading } = await import("../src/aio-gap.mjs");
  const s = answerSentences("### Top Providers Serving South-East Melbourne\n- Location: 18 Williams Rd, Dandenong South\n- Phone: 1300 100 121\n- Details: Offers door-to-door vehicle delivery and collection for every customer.\n![](https://lh3.example/img");
  assert.deepEqual(s, ["Offers door-to-door vehicle delivery and collection for every customer."]);
  assert.equal(topicHeading("MenuHome About JoinContact", "https://a.example/"), null);
  assert.equal(topicHeading("Final Thoughts", "https://a.example/"), null);
  assert.equal(topicHeading("Why Choose Melbourne Collision Repair Centre", "https://melbournecollisionrepaircentre.com.au/x"), null);
  assert.equal(topicHeading("Does Acorn cover all of Victoria?", "https://www.acornrentals.com.au/"), null);
  assert.equal(topicHeading("Step 5: Take Photos and\n Document Everything", "https://a.example/"), "Take Photos and Document Everything");
  assert.equal(topicHeading("Melbourne road rules after a crash", "https://melbournecollisionrepaircentre.com.au/x"), "Melbourne road rules after a crash");
});

test("page compare: a LocalBusiness subtype (AutoRepair) is not missing LocalBusiness markup", async () => {
  const { gaps, isLocalBusiness } = await import("../src/page-compare.mjs");
  const base = { titleUses: "exact", h1Uses: "exact", first100Uses: "exact", headingsUsing: 1, questionHeadings: 3, words: 900, descriptionUses: "exact", dated: true, author: true, contentLinksExternal: 1, imagesNoAlt: 0 };
  assert.ok(isLocalBusiness("AutoRepair") && isLocalBusiness("AutoBodyShop") && isLocalBusiness("LocalBusiness") && !isLocalBusiness("Article"));
  const g = gaps({ ...base, schemaTypes: ["AutoBodyShop", "AutoRepair", "FAQPage"] }, { ...base, schemaTypes: ["LocalBusiness", "Article", "PropertyValueSpecification"] });
  assert.deepEqual(g.map(([id, t]) => [id, t.replace(/;.*/, "")]), [["schema", "They mark up Article"]]);
  assert.equal(gaps({ ...base, schemaTypes: ["Article"] }, { ...base, schemaTypes: ["LocalBusiness"] })[0][0], "schema", "a page with no business markup still gets the gap");
});

test("business rating lines and paragraph-length headings are not gaps", async () => {
  const { topicHeading } = await import("../src/aio-gap.mjs");
  assert.deepEqual(answerSentences("Style Body Repairs 5.0 (306)Car repair and maintenance service in Dandenong South for everyone."), []);
  assert.equal(topicHeading("If vehicle is drivable, come and see us for an on-the-spot estimate. Your claim can be processed there and then", "https://a.example/"), null);
});

test("a search with no AI Overview still compares against the ranked results; the organic list is not treated as citations", async () => {
  const runId = Number(run("INSERT INTO ai_runs (project_id, status, platforms, prompts) VALUES (7, 'done', 'google', 1)").lastInsertRowid);
  run("INSERT INTO ai_results (run_id, prompt, platform, present, sources, excerpt, serp) VALUES (?, 'hire car dandenong', 'google', 0, ?, '', ?)", runId,
    JSON.stringify([{ domain: "rival-b.example", url: "https://rival-b.example/vehicles", organic: true }]),
    JSON.stringify({ top: [{ pos: 2, url: "https://rival-b.example/vehicles", type: "article" }], paa: [] }));
  const r = await aioGapReport({ id: 7 }, { mine: "https://ss.example/car", keyword: "hire car dandenong" }, { fetchPage: fake(PAGES) });
  assert.equal(r.aio, false);
  assert.equal(r.youCited, false);
  assert.deepEqual(r.sources.map((x) => x.role), ["#2"]);
  assert.deepEqual(r.answerGaps, []);
  assert.ok(r.topicGaps.some((t) => /hire car/i.test(t.topic)));
});

test("the brief for Claude: the reel's prompt, the AI answer without citation markers, every page's content and mine", async () => {
  const { gapBrief } = await import("../src/aio-gap.mjs");
  const b = gapBrief({ keyword: "hire car", answer: "Cars are delivered.[[1]](https://a.example/)", questions: ["Who pays?"],
    pages: [{ url: "https://a.example/", role: "AI Overview", title: "A", h2s: ["Who pays"], text: "word ".repeat(2000) }, { url: "https://b.example/", role: "#2", error: "HTTP 403" }],
    mine: { url: "https://ss.example/car", title: "Mine", h2s: [], text: "my text" } });
  assert.match(b, /^# Gap analysis brief: "hire car"/);
  assert.match(b, /Missing information: facts, figures/);
  assert.match(b, /Cars are delivered\.\n/);
  assert.ok(!b.includes("[[1]]"));
  assert.match(b, /## People also ask\n- Who pays\?/);
  assert.match(b, /## Page 1 \(AI Overview\): https:\/\/a\.example\/\nTitle: A\nHeadings: Who pays/);
  assert.match(b, /\[…\]/, "long page text is clipped");
  assert.ok(!b.includes("b.example"), "pages that couldn't be read are left out");
  assert.match(b, /## My page: https:\/\/ss\.example\/car\nTitle: Mine\n\nmy text$/);
});
