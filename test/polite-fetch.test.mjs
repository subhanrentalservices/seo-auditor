// Polite research reader (REQ-055 group 6): robots.txt obeyed, per-host gap, honest user agent, cache, size cap,
// 429/503 back-off, background jobs. Injected fetch and clock: no network. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { get } = await import("../src/db.mjs");
const { createPolite, startJob, jobStatus, pruneCache, RESEARCH_UA } = await import("../src/polite-fetch.mjs");
const { fakeWeb } = await import("./fake-web.mjs");

const ROBOTS = "User-agent: *\nDisallow: /private/\n\nUser-agent: SEOAuditor\nDisallow: /no-tools/\nAllow: /\n";

test("robots.txt: the tool's own group is obeyed, disallowed pages are never fetched", async () => {
  const w = fakeWeb({ "https://a.example/robots.txt": [200, ROBOTS, "text/plain"], "https://a.example/ok": [200, "<title>ok</title>"],
    "https://a.example/no-tools/x": [200, "secret"] });
  const p = createPolite(w);
  assert.equal((await p.page("https://a.example/ok")).body, "<title>ok</title>");
  const blocked = await p.page("https://a.example/no-tools/x");
  assert.equal(blocked.blocked, "robots");
  assert.ok(!w.calls.some((c) => c.url.includes("/no-tools/")), "a disallowed page is not requested");
  assert.equal(w.calls.filter((c) => c.url.endsWith("/robots.txt")).length, 1, "robots.txt read once per origin");
  assert.equal(p.stats.blocked, 1);
  // our own group allows /private/ (the * group's rule doesn't apply once a group names us)
  assert.equal(await p.allowed("https://a.example/private/y"), true);
});

test("robots.txt answers: 4xx allows everything; 5xx or no answer means don't crawl", async () => {
  const w = fakeWeb({ "https://b.example/robots.txt": [404], "https://c.example/robots.txt": [503], "https://d.example/robots.txt": ["throw"],
    "https://b.example/p": [200, "b"], "https://c.example/p": [200, "c"], "https://d.example/p": [200, "d"] });
  const p = createPolite(w);
  assert.equal((await p.page("https://b.example/p")).body, "b");
  assert.equal((await p.page("https://c.example/p")).blocked, "robots");
  assert.equal((await p.page("https://d.example/p")).blocked, "robots");
  assert.equal(await p.allowed("not a url"), false);
});

test("honest user agent and a gap between requests to one host", async () => {
  const w = fakeWeb({ "https://e.example/1": [200, "1"], "https://e.example/2": [200, "2"], "https://f.example/1": [200, "f"] });
  const p = createPolite({ ...w, gapMs: 2000 });
  await p.get("https://e.example/1");
  await p.get("https://f.example/1");
  await p.get("https://e.example/2");
  assert.ok(w.calls.every((c) => c.ua === RESEARCH_UA && /SEOAuditor/.test(c.ua)));
  const [e1, , e2] = w.calls;
  assert.ok(e2.at - e1.at >= 2000, "same host waits for the gap");
  assert.equal(w.calls[1].at, e1.at, "another host doesn't wait");
});

test("cache: a repeat read asks nobody until the answer is older than the TTL; 5xx is not cached", async () => {
  const w = fakeWeb({ "https://g.example/x": [200, "cached body"], "https://g.example/err": [500] });
  const p = createPolite({ ...w, ttlHours: 1 });
  await p.get("https://g.example/x");
  const again = await p.get("https://g.example/x");
  assert.equal(again.cached, true);
  assert.equal(again.body, "cached body");
  assert.equal(w.calls.length, 1);
  w.tick(2 * 3600e3);
  assert.equal((await p.get("https://g.example/x")).cached, false);
  await p.get("https://g.example/err");
  await p.get("https://g.example/err");
  assert.equal(w.calls.filter((c) => c.url.endsWith("/err")).length, 2);
});

test("429/503: the host is left alone for the rest of the run", async () => {
  const w = fakeWeb({ "https://h.example/a": [429], "https://h.example/b": [200, "b"] });
  const p = createPolite(w);
  assert.equal((await p.get("https://h.example/a")).status, 429);
  const b = await p.get("https://h.example/b");
  assert.equal(b.status, 429);
  assert.match(b.error, /slow down/);
  assert.equal(w.calls.length, 1);
  assert.equal(p.stats.limited, 1);
});

test("size cap, network errors and binary (gzip) bodies", async () => {
  const gz = gzipSync("<urlset></urlset>");
  const w = fakeWeb({ "https://i.example/big": [200, "x".repeat(5000)], "https://i.example/down": ["throw"], "https://i.example/s.xml.gz": [200, gz, "application/gzip"] });
  const p = createPolite({ ...w, maxBytes: 1000 });
  assert.equal((await p.get("https://i.example/big")).body.length, 1000);
  const down = await p.get("https://i.example/down");
  assert.equal(down.status, 0);
  assert.equal(down.error, "ECONNREFUSED");
  const s = await p.get("https://i.example/s.xml.gz", { binary: true });
  assert.ok(Buffer.compare(s.bytes, gz) === 0);
  assert.ok(Buffer.compare((await p.get("https://i.example/s.xml.gz", { binary: true })).bytes, gz) === 0, "the same bytes from the cache");
});

test("jobs: one per kind and project, progress, errors; pruneCache", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const done = startJob("t", 1, async (progress) => { progress(1, 3, "working"); await gate; });
  await Promise.resolve();
  assert.equal(jobStatus("t", 1).running, true);
  assert.equal(jobStatus("t", 1).note, "working");
  assert.throws(() => startJob("t", 1, async () => {}), (e) => e.status === 409);
  release(); await done;
  assert.equal(jobStatus("t", 1).running, false);
  await startJob("t", 2, async () => { throw new Error("boom"); });
  assert.equal(jobStatus("t", 2).error, "boom");
  assert.equal(jobStatus("t", 3), null);
  const before = get("SELECT COUNT(*) n FROM research_cache").n;
  assert.ok(before > 0);
  pruneCache(0, Date.now() + 1e12);
  assert.equal(get("SELECT COUNT(*) n FROM research_cache").n, 0);
});
