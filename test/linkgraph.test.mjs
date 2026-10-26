// Internal link graph (REQ-040 gaps #8 and #9, 2026-10-26): internal PageRank, strong pages → money pages, and
// hub-and-spoke reciprocity. Any site type. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { pagerank, buildGraph, hubAndSpoke, analyse, linkGraph, indexText, findMention } = await import("../src/linkgraph.mjs");
const { mention } = await import("../src/page2.mjs");
const { run } = await import("../src/db.mjs");

const S = "https://acme.example";
const page = (p, title = "", data = {}) => ({ url: S + p, final_url: S + p, status: 200, indexable: 1, content_type: "text/html", title, h1: "", data });
const link = (from, to, placement = "content") => ({ from_url: S + from, to_url: S + to, nofollow: 0, placement });

test("PageRank: the home page is strongest, and a page the home links to beats the page it passes value on to", () => {
  const nodes = ["/", "/a", "/b", "/c", "/d"];
  const pr = pagerank(nodes, [["/", "/a"], ["/", "/c"], ["/", "/d"], ["/a", "/b"], ["/a", "/"], ["/b", "/"], ["/c", "/"], ["/d", "/"]]);
  assert.equal(pr.get("/"), 100);
  assert.ok(pr.get("/a") > pr.get("/b"), `A ${pr.get("/a")} should beat B ${pr.get("/b")}`);
  assert.ok([...pr.values()].every((v) => v >= 0 && v <= 100));
  // Dangling pages spread their rank instead of leaking it: an all-dangling graph is flat.
  assert.deepEqual([...pagerank(["/x", "/y"], []).values()], [100, 100]);
});

test("redirected URLs resolve to their page; nofollow and self links pass nothing; pre-placement audits count every link as text", () => {
  const pages = [page("/"), page("/a"), { ...page("/old"), final_url: S + "/a" }];
  const g = buildGraph(pages, [link("/", "/old"), { ...link("/", "/"), placement: "content" }, { ...link("/a", "/"), nofollow: 1 }]);
  assert.deepEqual(g.edges, [{ from: S, to: S + "/a", text: true }]);
  assert.equal(g.oldAudit, false);
  const old = buildGraph(pages, [{ ...link("/", "/a"), placement: null }]);
  assert.equal(old.oldAudit, true);
  assert.equal(old.edges[0].text, true);
});

test("topic matching on an indexed text gives the same answer as page2.mjs mention()", () => {
  const far = "Your car " + "word ".repeat(40) + "after an accident " + "word ".repeat(40) + "repairs.";
  const cases = [["We do car accident repairs in Springfield.", "car accident repairs", ["car", "accident", "repair"]],
    ["Repairs after an accident to your car are our job.", "car accident repairs", ["car", "accident", "repair"]],
    [far, "car accident repairs", ["car", "accident", "repair"]], ["Volkswagen servicing done right", "volkswagen service", ["volkswagen", "servic"]],
    ["Brakes, then tyres; brakes again", "tyre fitting", ["tyr", "fitt"]], ["", "x", ["x"]]];
  for (const [text, q, core] of cases) assert.deepEqual(findMention(indexText(text), q, core), mention(text, q, core), q + " in " + text.slice(0, 30));
});

// Home and a blog post are the strong pages; /services/brakes gets a body link from home, /services/tyres only a menu
// link, /pricing nothing (but the blog post talks about pricing plans).
const site = () => {
  const pages = [page("/", "Acme Garage"), page("/services/brakes", "Brakes | Acme Garage"), page("/services/tyres", "Tyres | Acme Garage"),
    page("/pricing", "Pricing plans | Acme Garage"), page("/blog/winter-tips", "Winter tips | Acme Garage"), page("/privacy", "Privacy | Acme Garage")];
  const links = [link("/", "/services/brakes"), link("/", "/blog/winter-tips"), link("/", "/services/tyres", "nav"), link("/", "/privacy", "nav"),
    link("/blog/winter-tips", "/"), link("/services/brakes", "/"), link("/services/tyres", "/", "nav"), link("/pricing", "/", "nav"), link("/privacy", "/", "nav")];
  const texts = { [S + "/blog/winter-tips"]: "Check your tyres before winter. Our pricing plans cover a winter check.", [S + "/"]: "Welcome to Acme Garage." };
  return { pages, links, start: S + "/", brand: "Acme Garage", textOf: (p) => texts[p.final_url] || null };
};

test("money pages without a body link from the strongest pages are flagged; a menu-only link doesn't count", () => {
  const r = analyse(site());
  const t = Object.fromEntries(r.targets.map((x) => [x.url.replace(S, ""), x]));
  assert.deepEqual(Object.keys(t).sort(), ["/pricing", "/services/brakes", "/services/tyres"], "home, articles and legal pages are not money pages");
  assert.equal(t["/services/brakes"].flagged, false);
  assert.deepEqual(t["/services/brakes"].linkedFromTop, [S + "/"]);
  assert.equal(t["/services/tyres"].flagged, true, "the home page links it from the menu only");
  assert.equal(t["/pricing"].flagged, true);
  assert.equal(r.targets[0].flagged, true, "flagged pages come first");
  // Candidates: strong pages that mention the topic without a body link (the menu link is reported as such).
  assert.deepEqual(t["/pricing"].candidates.map((c) => [c.from, c.match]), [[S + "/blog/winter-tips", "exact"]]);
  assert.match(t["/pricing"].candidates[0].context, /pricing plans/);
  assert.deepEqual(t["/services/tyres"].candidates.map((c) => c.from), [S + "/blog/winter-tips"]);
  assert.equal(t["/services/brakes"].candidates.length, 0, "no strong page mentions brakes");
  // Text-only PageRank ignores menus; the all-links score doesn't.
  const pr = Object.fromEntries(r.pages.map((p) => [p.url.replace(S, ""), p]));
  assert.equal(pr["/"].pr, 100);
  assert.ok(pr["/services/tyres"].prAll > pr["/services/tyres"].pr);
  assert.ok(pr["/services/brakes"].pr > pr["/services/tyres"].pr);
});

test("pages at Search Console positions 5-20 are checked too, articles included", () => {
  const s = site();
  const r = analyse({ ...s, gsc: [{ url: S + "/blog/winter-tips/", position: 7.24, impressions: 120, clicks: 3 }, { url: S + "/services/brakes", position: 2, impressions: 900 }] });
  const blog = r.targets.find((x) => x.url === S + "/blog/winter-tips");
  assert.deepEqual([blog.reasons, blog.gsc], [["gsc"], { position: 7.2, impressions: 120, clicks: 3 }]);
  assert.equal(blog.flagged, false, "the home page links it from its text");
  assert.equal(r.targets.find((x) => x.url === S + "/services/brakes").gsc, null, "position 2 is outside 5-20");
});

test("hub /guides/ linking 3 of 4 children, one child without a link back: two findings", () => {
  const kids = ["a", "b", "c", "d"];
  const pages = [page("/"), page("/guides/"), ...kids.map((k) => page(`/guides/${k}`))];
  const links = [link("/", "/guides/", "nav"), ...["a", "b", "c"].map((k) => link("/guides/", `/guides/${k}`)),
    link("/guides/a", "/guides/", "nav"), link("/guides/b", "/guides/"), link("/guides/d", "/guides/", "nav"), link("/guides/c", "/")];
  const hubs = hubAndSpoke(buildGraph(pages, links), { start: S + "/" });
  assert.equal(hubs.length, 1);
  assert.deepEqual([hubs[0].hub, hubs[0].children, hubs[0].linkedCount, hubs[0].notLinked, hubs[0].noLinkBack],
    [S + "/guides/", 4, 3, [S + "/guides/d"], [S + "/guides/c"]]);
  assert.equal(analyse({ pages, links, start: S + "/" }).clusterFindings, 2);
});

test("a flat site has no hubs and no findings; the home page is never a hub", () => {
  const pages = [page("/", "", { childLinks: 9 }), ...["a", "b", "c", "d"].map((k) => page(`/${k}.html`))];
  const links = ["a", "b", "c", "d"].map((k) => link("/", `/${k}.html`, "nav"));
  const r = analyse({ pages, links, start: S + "/" });
  assert.deepEqual([r.hubs, r.clusterFindings], [[], 0]);
});

test("nested folders, .html hubs and paginated listings (/page/2 and ?page=3)", () => {
  const pages = [page("/"), page("/shop.html"), page("/shop/shoes.html"), page("/shop/shoes/red.html"), page("/shop/shoes/blue.html"),
    page("/shop/hats.html"), page("/blog/"), page("/blog/page/2"), page("/blog/?page=3"), page("/blog/x"), page("/blog/y"), page("/blog/z")];
  const links = [link("/shop.html", "/shop/shoes.html"), link("/shop.html", "/shop/hats.html"), link("/shop/shoes.html", "/shop/shoes/red.html"),
    link("/shop/shoes.html", "/shop/shoes/blue.html"), link("/blog/", "/blog/x"), link("/blog/", "/blog/page/2"), link("/blog/page/2", "/blog/y"), link("/blog/?page=3", "/blog/z"),
    ...["/shop/shoes.html", "/shop/hats.html"].map((u) => link(u, "/shop.html", "nav")), ...["red", "blue"].map((k) => link(`/shop/shoes/${k}.html`, "/shop/shoes.html", "nav")),
    ...["x", "y", "z"].map((k) => link(`/blog/${k}`, "/blog/", "nav"))];
  const hubs = Object.fromEntries(hubAndSpoke(buildGraph(pages, links), { start: S + "/" }).map((x) => [x.hub.replace(S, ""), [x.children, x.notLinkedCount, x.noLinkBackCount]]));
  assert.deepEqual(hubs, { "/shop.html": [2, 0, 0], "/shop/shoes.html": [2, 0, 0], "/blog/": [3, 0, 0] }, "/blog/page/2 and /blog/?page=3 link the rest for the hub");
});

test("API: reads the audit's pages, links, page text and Search Console rows", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (960, 'Acme Garage', 'https://acme.example/')");
  run("INSERT INTO audits (id, project_id, status) VALUES (961, 960, 'done')");
  const s = site();
  for (const p of s.pages) run("INSERT INTO pages (audit_id, url, final_url, status, indexable, content_type, title, h1, data) VALUES (961,?,?,?,?,?,?,?,?)",
    p.url, p.final_url, p.status, p.indexable, p.content_type, p.title, p.h1, JSON.stringify(p.data));
  for (const l of s.links) run("INSERT INTO links (audit_id, from_url, to_url, anchor, internal, nofollow, kind, placement) VALUES (961,?,?,'x',1,0,'a',?)", l.from_url, l.to_url, l.placement);
  run("INSERT INTO page_text (audit_id, url, text) VALUES (961, ?, ?)", S + "/blog/winter-tips", "Our pricing plans cover a winter check.");
  run("INSERT INTO gsc (project_id, url, clicks, impressions, position) VALUES (960, ?, 1, 40, 11.5)", S + "/blog/winter-tips");
  const r = linkGraph(961);
  assert.equal(r.gscConnected, true);
  assert.equal(r.pages[0].url, S + "/");
  assert.equal(r.targets.find((x) => x.url === S + "/pricing").candidates[0].from, S + "/blog/winter-tips");
  assert.deepEqual(r.targets.find((x) => x.url === S + "/blog/winter-tips").reasons, ["gsc"]);
  assert.throws(() => linkGraph(999999), /Audit not found/);
});

test("legal and contact pages that link only to each other don't become 'strong' sources or targets; the home page is never a target", () => {
  const pages = [page("/", "Acme"), page("/services/brakes", "Brakes"), page("/services/tyres", "Tyres"), page("/privacy.html", "Privacy"), page("/terms.html", "Terms"), page("/contact", "Contact")];
  const links = [link("/", "/services/brakes"), link("/", "/services/tyres"), link("/", "/privacy.html", "nav"), link("/", "/contact", "nav"),
    link("/privacy.html", "/terms.html"), link("/terms.html", "/privacy.html"), link("/contact", "/privacy.html")];
  const r = analyse({ pages, links, start: S + "/", gsc: [{ url: S + "/", position: 8, impressions: 50 }, { url: S + "/contact", position: 9, impressions: 20 }] });
  assert.ok(r.pages.find((p) => p.url === S + "/privacy.html").pr > r.pages.find((p) => p.url === S + "/services/brakes").pr, "the legal loop does pool rank");
  assert.ok(!r.strong.some((u) => /privacy|terms|contact/.test(u)), "but it is never offered as a link source");
  assert.deepEqual(r.targets.map((t) => t.url.replace(S, "")).sort(), ["/services/brakes", "/services/tyres"]);
  assert.equal(r.pages.find((p) => p.url === S + "/terms.html").side, true);
});
