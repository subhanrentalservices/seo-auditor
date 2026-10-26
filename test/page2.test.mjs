// Page 2 → page 1 (REQ-015, 2026-10-23): text links vs menu links, "site:" style mentions, brand queries, and the
// report for a page on Google's second page. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { mention, brandTest, page2Opportunities } = await import("../src/page2.mjs");
const { run } = await import("../src/db.mjs");

test("links in menus, header, footer, breadcrumbs or outside <main> are template links", () => {
  const html = `<html><body><header><a href="/a">A</a></header><div class="drawer"><a href="/b">B</a></div>
    <main><nav aria-label="Breadcrumb"><a href="/c">C</a></nav><p>Read about <a href="/d">car accident repairs</a>.</p></main>
    <footer><a href="/e">E</a></footer></body></html>`;
  const by = Object.fromEntries(parseHtml(html, "https://x.com/p").links.map((l) => [new URL(l.to).pathname, l.placement]));
  assert.deepEqual(by, { "/a": "nav", "/b": "nav", "/c": "nav", "/d": "content", "/e": "nav" });
});

test("without <main>, only header/nav/footer/aside links are template links", () => {
  const { links } = parseHtml(`<html><body><nav><a href="/a">A</a></nav><p><a href="/b">B</a></p></body></html>`, "https://x.com/p");
  assert.deepEqual(links.map((l) => l.placement), ["nav", "content"]);
});

test("a mention is the exact phrase, or every core word close together; scattered words are not", () => {
  assert.equal(mention("We do car accident repairs in Springfield.", "car accident repairs", ["car", "accident", "repair"]).match, "exact");
  assert.equal(mention("Repairs after an accident to your car are our job.", "car accident repairs", ["car", "accident", "repair"]).match, "words");
  const far = "Your car " + "word ".repeat(40) + "after an accident " + "word ".repeat(40) + "repairs.";
  assert.equal(mention(far, "car accident repairs", ["car", "accident", "repair"]), null);
  assert.equal(mention("Volkswagen servicing done right", "volkswagen service", ["volkswagen", "servic"]).match, "words");
});

test("brand queries are recognised from the business name and domain", () => {
  const isBrand = brandTest("AB Motors", "https://abmotors.example/");
  assert.ok(isBrand("ab motors springfield") && isBrand("abmotors") && isBrand("ab autos"));
  assert.ok(!isBrand("car accident repairs springfield") && !isBrand("motors repairs near me"));
});

test("report: without Search Console data there is nothing to show, and no crash", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (940, 'Empty', 'https://e.com/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (941, 940, 'done')");
  assert.deepEqual(page2Opportunities(941), { range: null, targets: [], connected: false });
});

test("report: related pages without a text link, link words and title for a page on page 2", async () => {
  await import("../src/gsc.mjs"); // creates the Search Console tables, as the app does at start
  const S = "https://x.com";
  run("INSERT INTO projects (id, name, start_url) VALUES (950, 'Acme Motors', 'https://x.com/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (951, 950, 'done')");
  const page = (p, title, inlinks = 3, data = "{}") => run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, inlinks, data) VALUES (951,?,?,200,1,'text/html',?,?,?)", S + p, S + p, title, inlinks, data);
  page("/", "Acme Motors Springfield"); page("/accident.html", "Accident Claims Springfield | Acme Motors");
  page("/smash.html", "Smash Repairs Springfield | Acme Motors"); page("/blog/crash.html", "What to do after a crash | Acme Motors");
  page("/brakes.html", "Brakes Springfield | Acme Motors"); page("/book.html", "Book | Acme Motors", 3, '{"formShare":0.6}');
  const text = (p, t) => run("INSERT INTO page_text (audit_id, url, text) VALUES (951, ?, ?)", S + p, t);
  text("/", "Welcome to Acme Motors in Springfield."); text("/accident.html", "Car accident repairs and claims.");
  text("/smash.html", "From dents to full car accident repairs, panel beating in our booth.");
  text("/blog/crash.html", "After a crash, the repairs to your car depend on the accident damage.");
  text("/brakes.html", "Brake pads and rotors."); text("/book.html", "Service: car accident repairs, brakes, tyres");
  const link = (from, to, anchor, placement) => run("INSERT INTO links (audit_id, from_url, to_url, anchor, internal, nofollow, kind, placement) VALUES (951,?,?,?,1,0,'a',?)", S + from, S + to, anchor, placement);
  for (const p of ["/", "/smash.html", "/blog/crash.html", "/brakes.html", "/book.html"]) link(p, "/accident.html", "Accident claims", "nav");
  link("/smash.html", "/accident.html", "not-at-fault claims", "content");
  run("INSERT INTO gsc (project_id, url, start_date, end_date) VALUES (950, ?, '2026-09-22', '2026-10-19')", S + "/accident.html");
  const q = (query, p, impressions, position) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (950,?,?,0,?,0,?)", query, S + p, impressions, position);
  q("car accident repairs springfield", "/accident.html", 17, 12.2); q("acme motors", "/", 40, 9); q("brakes springfield", "/brakes.html", 30, 4);

  const r = page2Opportunities(951);
  assert.deepEqual({ ...r.range }, { start_date: "2026-09-22", end_date: "2026-10-19" });
  assert.equal(r.targets.length, 1, "brand query and page-1 query are left out");
  const t = r.targets[0];
  assert.equal(t.target, S + "/accident.html");
  assert.deepEqual(t.sources.map((s) => [s.from.replace(S, ""), s.linked, s.match]), [["/blog/crash.html", "menu", "words"], ["/smash.html", "body", "exact"]]);
  assert.equal(t.toLink, 1, "the blog post links only from its menu; the booking form page is skipped");
  assert.equal(t.anchorGap, true, "no text link says car accident repairs");
  assert.deepEqual(t.anchors, [{ text: "not-at-fault claims", n: 1 }], "menu anchors are not counted");
  assert.deepEqual(t.titleMissing, ["car", "repairs"]);
});

test("report: a brand search on a suburb page points to the brand page instead of the suburb page's title (REQ-036)", () => {
  const S = "https://y.com";
  run("INSERT INTO projects (id, name, start_url) VALUES (960, 'Bolt Garage', 'https://y.com/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (961, 960, 'done')");
  const page = (p, title, inlinks = 3) => run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, inlinks, data) VALUES (961,?,?,200,1,'text/html',?,?,'{}')", S + p, S + p, title, inlinks);
  page("/", "Bolt Garage"); page("/riverside.html", "Mechanic Riverside | Bolt Garage"); page("/mercedes.html", "Mercedes-Benz Service | Bolt Garage", 9);
  page("/logbook.html", "Logbook Service | Bolt Garage"); page("/booking-tips.html", "Book Your Service Early | Bolt Garage");
  for (const p of ["/", "/riverside.html", "/mercedes.html", "/logbook.html", "/booking-tips.html"]) run("INSERT INTO page_text (audit_id, url, text) VALUES (961, ?, 'Servicing and repairs.')", S + p);
  const link = (from, to, placement) => run("INSERT INTO links (audit_id, from_url, to_url, anchor, internal, nofollow, kind, placement) VALUES (961,?,?,'x',1,0,'a',?)", S + from, S + to, placement);
  link("/riverside.html", "/mercedes.html", "nav");
  run("INSERT INTO gsc (project_id, url, start_date, end_date) VALUES (960, ?, '2026-09-26', '2026-10-23')", S + "/riverside.html");
  const q = (query, p, impressions, position) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (960,?,?,0,?,0,?)", query, S + p, impressions, position);
  q("mercedes mechanic riverside", "/riverside.html", 24, 17.4); q("log book service", "/logbook.html", 9, 14.4);

  const r = page2Opportunities(961), by = Object.fromEntries(r.targets.map((t) => [t.target.replace(S, ""), t]));
  assert.deepEqual(by["/riverside.html"].titleMissing, ["mercedes"]);
  assert.deepEqual({ ...by["/riverside.html"].betterPage, inlinks: undefined }, { url: S + "/mercedes.html", title: "Mercedes-Benz Service | Bolt Garage", covers: ["mercedes"], inlinks: undefined, linked: "menu" });
  assert.equal(by["/logbook.html"].betterPage, null, "“Book your service” is not the page about “log book”");
});

test("brand: a shortened or plural form of the brand counts as brand; a different business sharing a word does not", async () => {
  const { brandTest } = await import("../src/page2.mjs");
  const isBrand = brandTest("Acme Widgets", "https://acmewidgets.example/");
  for (const q of ["acme widg", "acmewidget", "acme widgets reviews", "acme widgets"]) assert.equal(isBrand(q), true, q);
  for (const q of ["acme tools", "widgets near me", "acmewidgetry"]) assert.equal(isBrand(q), false, q);
});
