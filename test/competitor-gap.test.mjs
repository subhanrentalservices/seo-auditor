// Competitor content gap (REQ-055 group 6, item 3): robots.txt + sitemaps through the polite reader, titles/H1s of
// allowed pages only, templated sections set aside, topics grouped across competitors and matched against our pages
// and searches. Injected fetch: no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run, get, all } = await import("../src/db.mjs");
await import("../src/gsc.mjs");
const G = await import("../src/competitor-gap.mjs");
const { fakeWeb } = await import("./fake-web.mjs");

const R = "https://www.rival.example", O = "https://other.example";
const SUBURBS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
const urlset = (urls) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const html = (title, h1) => `<html><head><title>${title}</title></head><body><h1>${h1}</h1><p>Body text is never read.</p></body></html>`;
const rivalUrls = [`${R}/services/hail-damage-repair`, `${R}/services/bumper-repair`, `${R}/guides/choice-of-repairer`, `${R}/private/secret-plans`,
  `${R}/services/windscreen-replacement`, ...SUBURBS.map((s) => `${R}/locations/${s}-smash-repairs`)];
const site = {
  [`${R}/robots.txt`]: [200, `User-agent: *\nDisallow: /private/\nSitemap: ${R}/sitemap.xml\n`, "text/plain"],
  [`${R}/sitemap.xml`]: [200, urlset(rivalUrls), "application/xml"],
  [`${R}/services/hail-damage-repair`]: [200, html("Hail Damage Repair | Rival Smash", "Hail damage repair")],
  [`${R}/services/bumper-repair`]: [200, html("Bumper Repair | Rival Smash", "Bumper repair")],
  [`${R}/guides/choice-of-repairer`]: [200, html("Your choice of repairer | Rival Smash", "Choice of repairer")],
  [`${R}/services/windscreen-replacement`]: [200, html("Windscreen Replacement | Rival Smash", "Windscreen replacement")],
  [`${R}/private/secret-plans`]: [200, html("Secret", "Secret")],
  [`${O}/robots.txt`]: [404],
  [`${O}/sitemap.xml`]: [200, urlset([`${O}/hail-damage-repairs-melbourne`, `${O}/about`]), "text/xml"],
  [`${O}/hail-damage-repairs-melbourne`]: [200, html("Hail damage repairs - Other Panel", "Hail damage repairs")],
  [`${O}/about`]: [200, html("About us - Other Panel", "About us")],
};
for (const s of SUBURBS) site[`${R}/locations/${s}-smash-repairs`] = [200, html(`${s} smash repairs`, `${s} smash repairs`)];

run("INSERT INTO projects (id, name, start_url, settings) VALUES (1, 'Me', 'https://me.example/', ?)",
  JSON.stringify({ competitorDomains: "rival.example\nhttps://other.example/blog, not a domain!, me.example" }));
run("INSERT INTO audits (id, project_id, status) VALUES (1, 1, 'done')");
run("INSERT INTO pages (audit_id, url, status, indexable, content_type, title, h1, data) VALUES (1, 'https://me.example/bumpers', 200, 1, 'text/html', 'Bumper repairs', 'Bumper repairs', ?)",
  JSON.stringify({ h2s: ["About us"] }));
run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (1, 'windscreen replacement cost', 'https://me.example/', 0, 12, 0, 9)");
const project = get("SELECT * FROM projects WHERE id=1");

test("parseDomains: up to 5 origins, invalid and own site dropped, duplicates merged", () => {
  assert.deepEqual(G.parseDomains("rival.example\nhttps://other.example/blog, not a domain!, me.example", "me.example"), ["https://rival.example", "https://other.example"]);
  assert.equal(G.parseDomains("a.example b.example c.example d.example e.example f.example").length, 5);
  assert.deepEqual(G.parseDomains("www.a.example, a.example"), ["https://www.a.example"]);
});

test("titleAndH1 and spread", () => {
  assert.deepEqual(G.titleAndH1("<title> A \n B </title><h1>C</h1><h1>D</h1>"), { title: "A B", h1: "C" });
  const s = G.spread(["https://x.example/a/1", "https://x.example/a/2", "https://x.example/a/3", "https://x.example/b/1"], 2);
  assert.deepEqual(s, ["https://x.example/a/1", "https://x.example/b/1"]);
});

test("runGap + gapReport: allowed pages only, titles not body, templated set aside, topics across competitors", async () => {
  const w = fakeWeb(site);
  // the setting holds rival.example; its sitemap lists www. addresses: both are the same site
  run("UPDATE projects SET settings=? WHERE id=1", JSON.stringify({ competitorDomains: "www.rival.example\nother.example" }));
  const p = get("SELECT * FROM projects WHERE id=1");
  await G.runGap(p, w);
  assert.ok(!w.calls.some((c) => c.url.includes("/private/")), "a robots-disallowed page is never fetched");
  assert.ok(!w.calls.some((c) => c.url.includes("/locations/")), "templated pages are not read");
  assert.ok(w.calls.every((c) => /SEOAuditor/.test(c.ua)));
  const pages = all("SELECT url, title, h1 FROM comp_pages WHERE project_id=1 ORDER BY url");
  assert.ok(!pages.some((x) => x.url.includes("/private/")), "nor listed");
  assert.equal(pages.find((x) => x.url.endsWith("hail-damage-repair")).h1, "Hail damage repair");
  const r = G.gapReport(p);
  const rival = r.sites.find((s) => s.origin === "https://www.rival.example");
  assert.deepEqual(rival.templated, ["locations"]);
  assert.equal(rival.blocked, 1);
  assert.equal(rival.read, 4);
  const hail = r.gaps.find((g) => g.core.includes("hail"));
  assert.equal(hail.competitors.length, 2, "grouped across both competitors");
  assert.equal(r.gaps[0], hail, "topics more competitors cover first");
  assert.ok(r.gaps.some((g) => g.examples[0].title === "Choice of repairer"));
  assert.ok(!r.gaps.some((g) => g.core.includes("bumper")), "my bumper page covers it");
  assert.ok(!r.gaps.some((g) => g.core.includes("windscreen")), "my Search Console search covers it");
  assert.ok(!r.gaps.some((g) => g.core.includes("rival") || g.core.includes("smash")), "brand and site-wide title words left out");
  assert.ok(!r.gaps.some((g) => g.core.includes("about")), "my H2 covers 'about us'");
  // a second run is served from the cache
  const w2 = fakeWeb({});
  await G.runGap(p, w2);
  assert.equal(w2.calls.length, 0);
});

test("routes: no competitors saved = 400; unknown project = 404", () => {
  const routes = [];
  G.register({ routes });
  run("INSERT INTO projects (id, name, start_url) VALUES (2, 'Empty', 'https://empty.example/')");
  const post = routes.find(([m]) => m === "POST")[2];
  assert.throws(() => post(["2"]), (e) => e.status === 400);
  assert.throws(() => post(["99"]), (e) => e.status === 404);
  assert.equal(routes.find(([m]) => m === "GET")[2](["2"]).gapCount, 0);
});
