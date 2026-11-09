// Templated headings (owner report 2026-11-09: blog "reads as AI content" because every post shares one template).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { templatedHeadings } = await import("../src/quality.mjs");

const blog = (i, extra = []) => ({ url: `https://x.test/blog/post-${i}.html`, h2s: ["Key Takeaways", `Unique heading ${i}`, ...extra] });

test("flags a heading stamped on most pages of a section", () => {
  const pages = Array.from({ length: 12 }, (_, i) => blog(i, i < 6 ? ["Common questions"] : []));
  const r = templatedHeadings(pages);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { section: "/blog/", heading: "Key Takeaways", pages: 12, of: 12, share: 1 });
  assert.equal(r[1].heading, "Common questions");
  assert.equal(r[1].share, 0.5);
});

test("ignores small sections, unique headings and ignored headings; normalises case and punctuation", () => {
  const few = Array.from({ length: 5 }, (_, i) => blog(i));
  assert.deepEqual(templatedHeadings(few), []);
  const pages = Array.from({ length: 10 }, (_, i) => ({ url: `https://x.test/blog/p${i}`, h2s: [i % 2 ? "KEY takeaways!" : "Key Takeaways", `Only here ${i}`] }));
  const r = templatedHeadings(pages);
  assert.equal(r.length, 1);
  assert.equal(r[0].pages, 10);
  assert.deepEqual(templatedHeadings(pages, { ignore: ["key takeaways"] }), []);
});

test("top-level pages form their own section", () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ url: `https://x.test/service-${i}.html`, h2s: ["Why choose us"] }));
  assert.equal(templatedHeadings(pages)[0].section, "/");
});
