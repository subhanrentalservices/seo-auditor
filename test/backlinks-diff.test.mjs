// Backlink snapshot diff and anchor mix (gap #14, 2026-10-26): built only from stored bl_snapshots and gsc_queries,
// no paid call. Fixtures follow the stored snapshot shape written by fetchBacklinks. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { backlinksData, anchorMix, snapshotDiff, RD_LIST_CAP } = await import("../src/dataforseo.mjs");
const { run } = await import("../src/db.mjs");

const rd = (domain, extra = {}) => ({ domain, rank: 100, backlinks: 2, dofollow: 1, spam: 5, firstSeen: null, ...extra });
const snapshot = (projectId, fetchedAt, totals, data) => run(
  "INSERT INTO bl_snapshots (project_id, fetched_at, backlinks, ref_domains, rank, dofollow, spam_score, data) VALUES (?,?,?,?,?,?,?,?)",
  projectId, fetchedAt, totals.backlinks, totals.ref_domains, 10, totals.dofollow, 3, JSON.stringify({ tlds: {}, countries: {}, types: {}, ...data }));

test("two snapshots differing by one added and one removed domain: one gained, one lost, totals delta", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (901, 'Acme Motors', 'https://acmemotors.com.au/')");
  const anchors = [{ anchor: "Acme Motors", backlinks: 4, domains: 2 }];
  snapshot(901, "2026-09-01 10:00:00", { backlinks: 40, ref_domains: 3, dofollow: 30 }, { referringDomains: [rd("a.com"), rd("b.com"), rd("old.com")], anchors });
  snapshot(901, "2026-10-01 10:00:00", { backlinks: 45, ref_domains: 3, dofollow: 33 }, { referringDomains: [rd("a.com"), rd("b.com"), rd("spammy.xyz", { spam: 72 })], anchors });
  const d = backlinksData(901);
  assert.deepEqual(d.diff.gained.map((x) => x.domain), ["spammy.xyz"]);
  assert.deepEqual(d.diff.lost.map((x) => x.domain), ["old.com"]);
  assert.equal(d.diff.since, "2026-09-01 10:00:00");
  assert.deepEqual([d.diff.totals.backlinks, d.diff.totals.ref_domains, d.diff.totals.dofollow], [5, 0, 3]);
  assert.deepEqual(d.diff.newSpam, ["spammy.xyz"], "a new domain with spam score >= 60 is flagged");
  assert.equal(d.diff.capped, false);
  assert.equal(d.diffNote, null);
});

test("a full stored list says the comparison is capped", () => {
  const many = Array.from({ length: RD_LIST_CAP }, (_, i) => rd(`d${i}.com`));
  const x = snapshotDiff({ fetched_at: "a", data: { referringDomains: many } }, { fetched_at: "b", data: { referringDomains: [...many.slice(1), rd("new.com")] } });
  assert.equal(x.capped, true);
  assert.equal(x.cap, RD_LIST_CAP);
  assert.match(x.note, /top 100/);
});

test("anchors 50% equal to a top Search Console query: exact-match warning", () => {
  run("INSERT INTO projects (id, name, start_url) VALUES (902, 'Acme Motors', 'https://acmemotors.com.au/')");
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (902, 'brake repairs springfield', 'https://acmemotors.com.au/', 30, 400, 0.075, 3)");
  run("INSERT INTO gsc_queries (project_id, query, page, clicks, impressions, ctr, position) VALUES (902, 'acme motors', 'https://acmemotors.com.au/', 90, 200, 0.45, 1)");
  snapshot(902, "2026-10-01 10:00:00", { backlinks: 20, ref_domains: 4, dofollow: 15 }, { referringDomains: [rd("a.com")], anchors: [
    { anchor: "brake repairs springfield", backlinks: 10, domains: 3 }, { anchor: "Acme Motors", backlinks: 5, domains: 2 },
    { anchor: "https://acmemotors.com.au/", backlinks: 3, domains: 1 }, { anchor: "click here", backlinks: 2, domains: 1 }] });
  const d = backlinksData(902);
  const share = Object.fromEntries(d.anchorMix.types.map((t) => [t.type, t.share]));
  assert.equal(share.exact, 0.5);
  assert.equal(share.brand, 0.25);
  assert.equal(share.naked, 0.15);
  assert.equal(share.generic, 0.1);
  assert.equal(d.anchorMix.exactShare, 0.5);
  assert.match(d.anchorMix.warning, /50%/);
  assert.equal(d.anchorMix.queriesUsed, 1, "the brand query is not used for exact match");
});

test("one snapshot only: anchor mix, and a note that the diff needs a second fetch", () => {
  const d = backlinksData(902);
  assert.equal(d.diff, null);
  assert.match(d.diffNote, /two snapshots/);
  assert.ok(d.anchorMix.types.length === 5);
});

test("anchor types: extra brand names, generic, longer anchors containing a query, empty = other; no warning at 20% or less", () => {
  const m = anchorMix([{ anchor: "Bolt Panels", backlinks: 5 }, { anchor: "read more", backlinks: 2 }, { anchor: "best brake repairs springfield today", backlinks: 2 },
    { anchor: "", backlinks: 1 }, { anchor: "a review of local garages", backlinks: 0 }], { brandTerms: ["Acme Motors", "Bolt Panels"], queries: ["brake repairs springfield"] });
  const by = Object.fromEntries(m.types.map((t) => [t.type, t.backlinks]));
  assert.deepEqual(by, { brand: 5, naked: 0, generic: 2, exact: 2, other: 1 });
  assert.equal(m.exactShare, 0.2);
  assert.equal(m.warning, null);
});
