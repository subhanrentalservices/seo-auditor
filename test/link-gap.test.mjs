// Link gap (REQ-086): sites linking to 2+ competitors but not to you. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { linkGap, cleanDomain, rootOf, kindOf, runLinkGap } = await import("../src/link-gap.mjs");

test("domains are cleaned and grouped by registrable part", () => {
  assert.equal(cleanDomain("https://www.Example.com.au/page"), "example.com.au");
  assert.equal(cleanDomain("not a domain"), "");
  assert.equal(rootOf("www.aussieweb.com.au"), "aussieweb.com.au");
  assert.equal(rootOf("victoria.localitylist.com.au"), "localitylist.com.au");
  assert.equal(rootOf("news.example.org"), "example.org");
});

test("kinds: listings to join, spam to leave, the rest earned", () => {
  assert.equal(kindOf("aussieweb.com.au", 0), "listing");
  assert.equal(kindOf("nationaldirectory.com.au", 0), "listing");
  assert.equal(kindOf("global-website.pages.dev", 0), "spam");
  assert.equal(kindOf("dailybulletin.com.au", 45), "spam");
  assert.equal(kindOf("dailybulletin.com.au", 0), "site");
});

const lists = {
  "rival-one.com.au": [{ domain: "www.aussieweb.com.au", rank: 42 }, { domain: "autoyas.com", rank: 47 }, { domain: "yably.biz", rank: 20 }, { domain: "global-website.pages.dev", rank: 20, spam: 35 }, { domain: "www.truelocal.com.au", rank: 76 }],
  "rival-two.com.au": [{ domain: "aussieweb.com.au", rank: 40 }, { domain: "www.autoyas.com", rank: 48 }, { domain: "yably.biz", rank: 20 }, { domain: "rivaltwo.blogspot.com", rank: 8 }],
  "rival-three.com.au": [{ domain: "www.aussieweb.com.au", rank: 42 }, { domain: "global-website.pages.dev", rank: 20, spam: 35 }, { domain: "dailybulletin.com.au", rank: 50 }],
};

test("lists sites linking to 2+ competitors, most competitors first, spam last within a count", () => {
  const rows = linkGap(lists, ["provenexpert.com"]);
  assert.deepEqual(rows.map((r) => [r.domain, r.count, r.kind]), [
    ["aussieweb.com.au", 3, "listing"], ["autoyas.com", 2, "site"], ["yably.biz", 2, "listing"], ["global-website.pages.dev", 2, "spam"],
  ]);
  assert.deepEqual(rows[0].competitors, ["rival-one.com.au", "rival-three.com.au", "rival-two.com.au"]);
  assert.equal(rows[1].rank, 48);
});

test("sites already linking to you and the competitors' own subdomains are left out", () => {
  const rows = linkGap(lists, ["https://www.aussieweb.com.au/business/x", "yably.biz"]);
  assert.ok(!rows.some((r) => r.domain === "aussieweb.com.au" || r.domain === "yably.biz"));
  assert.equal(rootOf("rivaltwo.blogspot.com"), "rivaltwo.blogspot.com", "free-hosting subdomains stay separate sites");
  assert.ok(linkGap(lists, [], { min: 1 }).some((r) => r.domain === "truelocal.com.au"), "min 1 shows single-competitor sites");
});

test("runLinkGap: one call per competitor plus yours, own domain skipped, budget errors stop the run", async () => {
  const calls = [];
  const send = async (endpoint, body) => {
    calls.push(body.target);
    if (body.target === "mysite.example") return { items: [{ domain: "aussieweb.com.au", rank: 40 }] };
    return { items: lists[body.target].map((r) => ({ domain: r.domain, rank: r.rank, backlinks_spam_score: r.spam })) };
  };
  const project = { id: 1, start_url: "https://www.mysite.example/" };
  const r = await runLinkGap(project, "rival-one.com.au, https://www.rival-two.com.au/, mysite.example, rival-three.com.au", { send });
  assert.deepEqual(calls, ["rival-one.com.au", "rival-two.com.au", "rival-three.com.au", "mysite.example"]);
  assert.equal(r.own, "mysite.example");
  assert.ok(!r.rows.some((x) => x.domain === "aussieweb.com.au"), "you already have that link");
  assert.equal(r.rows[0].domain, "autoyas.com");
  await assert.rejects(runLinkGap(project, "rival-one.com.au", { send }), /at least 2/);
  const broke = async () => { throw Object.assign(new Error("DataForSEO: Payment Required."), { status: 502 }); };
  await assert.rejects(runLinkGap(project, "a.com, b.com", { send: broke }), /Payment Required/);
});
