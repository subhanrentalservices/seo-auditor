// Off-page audit from Search Console Links exports (owner reel 2026-11-06; a client site had 2 linking sites). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { csvLine, parseGscLinks, classifySite, offpageAudit } from "../src/gsc-links.mjs";

test("csvLine handles quotes and commas", () => {
  assert.deepEqual(csvLine('"a, b",c,"d ""e"""'), ["a, b", "c", 'd "e"']);
});

test("reads the Top linking sites export", () => {
  const rows = parseGscLinks("﻿Site,Linking pages,Target pages\nbirdeye.com,1,1\nwww.cylex-australia.com,\"1\",1\n");
  assert.deepEqual(rows.map((r) => [r.site, r.linkingPages]), [["birdeye.com", 1], ["cylex-australia.com", 1]]);
});

test("reads the Latest links export and groups pages by site", () => {
  const rows = parseGscLinks("Linking page,Last crawled\nhttps://news.example.org/a,2026-10-01\nhttps://news.example.org/b,2026-10-02\nhttps://dir.example.net/detail/123/,2026-10-03\n");
  assert.equal(rows[0].site, "news.example.org");
  assert.equal(rows[0].linkingPages, 2);
  assert.equal(classifySite(rows[1]).type, "spam", "numbered /detail/<id>/ network");
});

test("rejects files that aren't a links export", () => {
  assert.throws(() => parseGscLinks("Query,Clicks\nx,1\n"), /not a Search Console links export/);
});

test("classification: listings, spam patterns, editorial", () => {
  assert.equal(classifySite({ site: "birdeye.com", linkingPages: 1 }).type, "listing");
  assert.equal(classifySite({ site: "cylex-australia.com", linkingPages: 1 }).type, "listing");
  assert.equal(classifySite({ site: "best-backlinks-seo.xyz", linkingPages: 3 }).type, "spam");
  assert.equal(classifySite({ site: "sitewide.example.com", linkingPages: 450 }).type, "spam");
  assert.equal(classifySite({ site: "dandenongjournal.com.au", linkingPages: 2 }).type, "editorial");
});

test("a site with 2 linking sites is told the problem is too few links, not spam; competitor gap shown", () => {
  const r = offpageAudit([{ site: "birdeye.com", linkingPages: 1 }, { site: "cylex-australia.com", linkingPages: 1 }, { site: "example.com.au", linkingPages: 9 }],
    { site: "https://example.com.au/", competitors: [{ name: "Rival", sites: 205 }, { name: "Small", sites: 1 }] });
  assert.equal(r.total, 2, "own domain excluded");
  assert.match(r.verdict, /Only 2 other sites link to you\. The problem is too few links/);
  assert.deepEqual(r.gap, ["Rival: 205 linking sites vs your 2"]);
  assert.equal(r.spam, 0);
});

test("mostly spam profiles get the disavow caution, not a scare", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ site: `links${i}.xyz`, linkingPages: 1 }));
  assert.match(offpageAudit(rows).verdict, /Google usually ignores such links; disavow only if you bought them/);
});
