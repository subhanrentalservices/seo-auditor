// Lost-URL reclamation (REQ-040, 2026-10-27): gone pages and deep redirects to the home page that had value, each with
// the closest live page as its 301 target and a ready Apache line; pages that did not load are "could not be checked".
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs"); // Search Console tables
await import("../src/dataforseo.mjs"); // bl_snapshots
const { suggestTarget, apacheLine, lostWords, isHome, lostUrls, register } = await import("../src/reclaim.mjs");

const S = "https://www.example.com";
run("INSERT INTO projects (id, name, start_url) VALUES (981, 'Example Co', ?)", S + "/");
run("INSERT INTO audits (id, project_id, status, started_at, finished_at) VALUES (982, 981, 'done', '2026-09-01 10:00:00', '2026-09-01 10:05:00')");
run("INSERT INTO audits (id, project_id, status, started_at, finished_at) VALUES (983, 981, 'done', '2026-10-20 10:00:00', '2026-10-20 10:05:00')");
const page = (audit, p, status, title = "", o = {}) => run(
  "INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, in_sitemap, inlinks, data) VALUES (?,?,?,?,?,?,?,?,?,?)",
  audit, S + p, o.final ? S + o.final : S + p, status, status === 200 && !o.redirect ? 1 : 0, "text/html", title, o.sitemap ? 1 : 0, o.inlinks || 0, JSON.stringify(o.data || {}));
const link = (audit, from, to) => run("INSERT INTO links (audit_id, from_url, to_url, anchor, internal, nofollow, kind) VALUES (?,?,?,'',1,0,'a')", audit, S + from, S + to);

// Earlier audit: the brake page and an offers page were live.
page(982, "/", 200, "Example Co");
page(982, "/services/brakes.html", 200, "Brake services | Example Co", { sitemap: true });
page(982, "/services/tyres.html", 200, "Tyre services | Example Co");
page(982, "/old-deep/page", 200, "Spring offers | Example Co");
page(982, "/retired.html", 200, "Retired page | Example Co");
// Latest audit.
page(983, "/", 200, "Example Co", { inlinks: 4 });
page(983, "/brake-repairs.html", 200, "Brake repairs | Example Co", { inlinks: 2 });
page(983, "/services/tyres.html", 200, "Tyre services | Example Co", { inlinks: 3 });
page(983, "/contact.html", 200, "Contact | Example Co", { inlinks: 3 });
page(983, "/services/brakes.html", 404);                                              // had value: lost
page(983, "/random-404", 404);                                                        // no history at all: not listed
page(983, "/about-us.html", 404, "", { inlinks: 1 });                                 // never seen before, but the site links to it
page(983, "/old-deep/page", 200, "Example Co", { final: "/", redirect: true, sitemap: true, inlinks: 4,
  data: { redirect: { hops: 1, to: S + "/", firstStatus: 301, finalStatus: 200 } } }); // deep path 301 to the home page
page(983, "/flaky.html", 0, "", { sitemap: true, data: { error: "timeout" } });       // did not load: unchecked, never lost
for (const from of ["/", "/brake-repairs.html", "/services/tyres.html", "/contact.html"]) link(983, from, "/");
link(983, "/contact.html", "/about-us.html");
run("INSERT INTO gsc (project_id, url, clicks, impressions, ctr, position) VALUES (981, ?, 12, 340, 0.035, 7.5)", S + "/services/brakes.html");
run("INSERT INTO bl_snapshots (project_id, backlinks, ref_domains, data) VALUES (981, 5, 2, ?)",
  JSON.stringify({ brokenBacklinks: 3, pages: [{ url: S + "/services/brakes.html", backlinks: 3 }] }));

test("the target is the live page sharing the most weighted words; ties go to more inlinks; no overlap means no target", () => {
  assert.deepEqual([...lostWords(S + "/services/brakes.html", "Brake services")], [["servic", 2], ["brak", 3]]);
  const live = [{ url: S + "/services/tyres.html", title: "Tyre services", inlinks: 9 }, { url: S + "/brake-repairs.html", title: "Brake repairs", inlinks: 1 }];
  assert.equal(suggestTarget(S + "/services/brakes.html", "Brake services", live).url, S + "/brake-repairs.html", "the page's own word beats the folder word");
  const tie = [{ url: S + "/a/brake-pads", title: "", inlinks: 1 }, { url: S + "/b/brake-discs", title: "", inlinks: 5 }];
  assert.equal(suggestTarget(S + "/brake", "", tie).url, S + "/b/brake-discs");
  assert.equal(suggestTarget(S + "/old-deep/page", "Spring offers", live), null, "never a page with nothing in common");
  assert.equal(suggestTarget(S + "/example-brakes", "", live, new Set(["brak"])), null, "ignored (site-wide) words don't count");
  assert.equal(apacheLine(S + "/services/brakes.html", S + "/brake-repairs.html"), `Redirect 301 /services/brakes.html ${S}/brake-repairs.html`);
  assert.equal(apacheLine(S + "/page?id=4", S + "/x"), null, "Redirect can't match a query string");
  assert.ok(isHome(S + "/") && isHome(S + "/index.html") && !isHome(S + "/old-deep/page"));
});

test("lost pages are listed with evidence and a 301 target; no-history 404s are not; status 0 is unchecked", () => {
  const r = lostUrls(981);
  assert.equal(r.audit.date, "2026-10-20");
  const by = Object.fromEntries(r.lost.map((x) => [x.url.replace(S, ""), x]));
  assert.deepEqual(Object.keys(by).sort(), ["/about-us.html", "/old-deep/page", "/services/brakes.html"]);
  assert.equal(r.lost[0].url, S + "/services/brakes.html", "the page with clicks comes first");

  const b = by["/services/brakes.html"];
  assert.equal(b.status, 404); assert.equal(b.kind, "gone");
  assert.deepEqual(b.evidence.lastSeen, { auditId: 982, date: "2026-09-01", title: "Brake services | Example Co", inSitemap: true });
  assert.equal(b.evidence.clicks, 12); assert.equal(b.evidence.impressions, 340); assert.equal(b.evidence.backlinks, 3); assert.equal(b.evidence.inSitemap, true);
  assert.equal(b.target.url, S + "/brake-repairs.html");
  assert.equal(b.redirect, `Redirect 301 /services/brakes.html ${S}/brake-repairs.html`);

  const home = by["/old-deep/page"];
  assert.equal(home.kind, "home-redirect"); assert.equal(home.status, 301); assert.equal(home.redirectsTo, S + "/");
  assert.equal(home.evidence.inlinks, 0, "links to the home page are not links to the old URL");
  assert.equal(home.evidence.inSitemap, false, "the home page being in the sitemap says nothing about the old URL");
  assert.equal(home.target, null, "no word overlap: no suggestion, and never the home page");
  assert.equal(home.redirect, null);

  assert.equal(by["/about-us.html"].evidence.inlinks, 1, "an internal-link target that 404s is listed");
  assert.equal(by["/about-us.html"].evidence.lastSeen, null);

  assert.ok(!r.lost.some((x) => x.url.endsWith("/flaky.html")), "status 0 is never called lost");
  const u = Object.fromEntries(r.unchecked.map((x) => [x.url.replace(S, ""), x]));
  assert.deepEqual(Object.keys(u).sort(), ["/flaky.html", "/retired.html"]);
  assert.equal(u["/flaky.html"].status, 0); assert.equal(u["/flaky.html"].reason, "timeout");
  assert.equal(u["/retired.html"].status, null, "200 last time, not reached this time: unknown, not lost");
  assert.deepEqual(r.lines, [b.redirect]);
  assert.deepEqual(r.backlinks, { fetched: true, perPage: true, brokenBacklinks: 3 });
});

test("the route answers per project and 404s for an unknown one", () => {
  const routes = []; register({ routes });
  const [method, re, fn] = routes[0];
  assert.equal(method, "GET");
  const m = "/api/projects/981/lost-urls".match(re);
  assert.equal(fn(m.slice(1)).lost.length, 3);
  assert.throws(() => fn(["99999"]), (e) => e.status === 404);
  run("INSERT INTO projects (id, name, start_url) VALUES (984, 'Empty', 'https://empty.example/')");
  assert.deepEqual(fn(["984"]).lost, [], "no audit yet: nothing to report");
});
