// Search clusters (REQ-055 group 6, item 2): co-ranking pages and shared words, hubs, best page and gaps. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { run } = await import("../src/db.mjs");
await import("../src/gsc.mjs");
const { leaderClusters, clusterReport } = await import("../src/clusters.mjs");

const S = "https://northwind.example";
run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Northwind Supplies', ?)", S + "/");
const q = (query, page, impressions, clicks = 0, position = 6) => run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (1,?,?,?,?,0,?)", query, S + page, clicks, impressions, position);
q("espresso machine repair", "/repair", 100, 10);
q("espresso machine repair", "/blog/old-post", 5); // under 10% of the search's impressions: not one of its pages
q("coffee machine service", "/repair", 60, 4);
q("descale kettle", "/kettle", 50, 2);
q("kettle descaling guide", "/kettle", 20, 1);
q("milk frother cleaning", "/frother-a", 25);
q("cleaning milk frother", "/frother-b", 5);
q("grinder burr size", "/", 30, 3);
q("burr size chart", "/", 10);
q("northwind supplies", "/", 500, 200); // brand: left out

run("INSERT INTO audits (id, project_id, status) VALUES (1, 1, 'done')");
for (const [url, title, h1] of [["/", "Northwind Supplies: grinder burr size guide and coffee gear", "Coffee gear"], ["/repair", "Espresso Machine Repair", "Espresso machine repairs"],
  ["/kettle", "Kettle descaling", "Descale a kettle"]])
  run("INSERT INTO pages (audit_id, url, status, indexable, content_type, title, h1) VALUES (1,?,200,1,'text/html',?,?)", S + url, title, h1);

test("leaderClusters: pages beat words; sharing only a hub page also needs a shared word", () => {
  const it = (key, pages, words, weight) => ({ key, pages: new Set(pages), words: new Set(words), weight });
  const c = leaderClusters([it("a", ["/x"], ["a"], 10), it("b", ["/x"], ["b"], 5), it("c", ["/hub"], ["c"], 9), it("d", ["/hub"], ["d"], 4), it("e", ["/hub"], ["c", "e"], 3)], { hubs: new Set(["/hub"]) });
  const of = (k) => c.find((x) => x.members.some((m) => m.item.key === k)).leader.key;
  assert.equal(of("b"), "a", "same page");
  assert.equal(of("d"), "d", "only the hub in common and no shared word: its own cluster");
  assert.equal(of("e"), "c", "hub plus a shared word");
  const w = leaderClusters([it("milk frother cleaning", [], ["milk", "froth", "clean"], 2), it("cleaning milk frother", [], ["clean", "milk", "froth"], 1)]);
  assert.equal(w.length, 1);
  assert.equal(w[0].members[1].how, "words");
});

test("clusterReport: totals, best page, how joined, gaps", () => {
  const r = clusterReport(1);
  assert.equal(r.connected, true);
  assert.equal(r.queries, 8, "brand search left out");
  const by = (head) => r.clusters.find((c) => c.head === head);
  const repair = by("espresso machine repair");
  assert.equal(repair.size, 2);
  assert.equal(repair.impressions, 165);
  assert.equal(repair.clicks, 14);
  assert.equal(repair.bestPage, S + "/repair");
  assert.equal(repair.joined.pages, 1);
  assert.equal(repair.gap, null);
  assert.equal(r.clusters[0].head, "espresso machine repair", "biggest first");
  assert.equal(by("descale kettle").gap, null, "descaling = descale, stemmed");
  const frother = by("milk frother cleaning");
  assert.equal(frother.size, 2);
  assert.equal(frother.joined.words, 1);
  assert.match(frother.gap, /no page/);
  const burr = by("grinder burr size");
  assert.equal(burr.bestIsHome, true);
  assert.match(burr.gap, /home page/);
  assert.ok(!r.clusters.some((c) => c.head === "burr size chart"), "co-ranks on the home page and shares words with the leader");
  assert.equal(r.gaps, 2);
});

test("clusterReport: unknown project and no data", () => {
  assert.throws(() => clusterReport(99), (e) => e.status === 404);
  run("INSERT INTO projects (id, name, start_url) VALUES (2, 'Empty', 'https://empty.example/')");
  assert.deepEqual(clusterReport(2), { connected: true, queries: 0, clusters: [] });
});
