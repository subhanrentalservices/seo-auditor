// Internal link ideas (REQ-016, 2026-10-23): text links only, whole words, no overlap with an existing link, no junk
// phrases, no pointing another page's keyword (or the source's own) at the target, home page not a target. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
const { linkOpportunities } = await import("../src/extras.mjs");

const S = "https://y.com";
run("INSERT INTO projects (id, name, start_url) VALUES (960, 'Acme Motors', 'https://y.com/')");
run("INSERT INTO audits (id, project_id, status) VALUES (961, 960, 'done')");
const page = (p, title, text) => {
  run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1, inlinks) VALUES (961,?,?,200,1,'text/html',?,?,40)", S + p, S + p, title, title.split(" | ")[0]);
  run("INSERT INTO page_text (audit_id, url, text) VALUES (961,?,?)", S + p, text);
};
const link = (from, to, anchor, placement = "content") => run("INSERT INTO links (audit_id, from_url, to_url, anchor, internal, nofollow, kind, placement) VALUES (961,?,?,?,1,0,'a',?)", S + from, S + to, anchor, placement);
page("/", "Acme Motors | Car Repairs Springfield", "Car repairs, roadworthy certificate checklist help and more.");
page("/roadworthy.html", "Roadworthy Certificate Springfield | Acme Motors", "We arrange your roadworthy certificate.");
page("/blog/rwc-checklist.html", "Roadworthy certificate checklist before you sell | Acme Motors", "What the checklist covers.");
page("/blog/excess.html", "Insurance excess: you're not at fault | Acme Motors", "Excess explained.");
page("/blog/trip-check.html", "Summer car check before a road trip | Acme Motors", "Check tyres and coolant.");
page("/tyres.html", "Tyres Springfield | Acme Motors", "Tyres are on the roadworthy certificate checklist, and worn tread fails it. You're not alone if yours are worn.");
page("/brakes.html", "Brakes Springfield | Acme Motors", "Brakes are on the Victorian roadworthy certificate checklist too. Have the car checked again after repairs.");
page("/smash.html", "Smash repairs Springfield | Acme Motors", "Smash repairs and panel beating. Our smash repairs come with a warranty.");
page("/about.html", "About Acme Motors", "We do smash repairs too.");
for (const p of ["/roadworthy.html", "/blog/rwc-checklist.html", "/blog/excess.html", "/blog/trip-check.html", "/tyres.html", "/brakes.html", "/smash.html", "/about.html"])
  for (const from of ["/", "/tyres.html", "/brakes.html"]) if (from !== p) link(from, p, "menu", "nav");
link("/tyres.html", "/roadworthy.html", "roadworthy certificate"); // "the [roadworthy certificate] checklist"
for (const from of ["/about.html", "/smash.html"]) link(from, "/roadworthy.html", "our roadworthy page");

const ideas = Object.fromEntries(linkOpportunities(961).map((t) => [t.target.replace(S, ""), t]));
const on = (target) => (ideas[target]?.suggestions || []).map((s) => [s.from.replace(S, ""), s.anchor]);

test("menu links don't count: pages are ranked by links from other pages' text", () => {
  assert.equal(ideas["/blog/rwc-checklist.html"].textInlinks, 0);
});

test("whole phrases only, never overlapping an existing link, never the source's own keyword", () => {
  // tyres: "roadworthy certificate" is already a link there, so neither that nor "certificate checklist" may be used.
  // brakes: free text, so the full phrase is suggested. The home page owns "roadworthy certificate checklist" in text only.
  assert.deepEqual(on("/blog/rwc-checklist.html").sort(), [["/", "roadworthy certificate checklist"], ["/brakes.html", "roadworthy certificate checklist"]]);
});

test("another service page's keyword is not pointed at a blog post", () => {
  // "roadworthy certificate" alone belongs to /roadworthy.html, so it is never suggested for the checklist post.
  assert.ok(!on("/blog/rwc-checklist.html").some(([, a]) => a === "roadworthy certificate"));
});

test("contractions are not a topic and part-words don't match", () => {
  assert.ok(!(ideas["/blog/excess.html"]?.suggestions || []).some((s) => /you're|not/.test(s.anchor)));
  assert.ok(!on("/blog/trip-check.html").some(([from]) => from === "/brakes.html"), "\"car checked\" is not \"car check\"");
});

test("the home page is never a target", () => {
  assert.equal(ideas["/"], undefined);
});
