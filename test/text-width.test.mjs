// Title/description pixel-width estimate (2026-11-05): a Screaming Frog crawl of a client site flagged
// 17 titles over 561 px that this tool missed because it only counted characters (65). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-"));
const { textWidth, titleWidth, descWidth, TITLE_PX, DESC_PX } = await import("../src/text-width.mjs");
const { pageIssues } = await import("../src/checks.mjs");

const S = "https://example.com";
const page = (title, description) => ({ url: S + "/a.html", final_url: S + "/a.html", status: 200, content_type: "text/html", indexable: 1, title, description, h1: "Heading",
  words: 600, text_ratio: 20, depth: 1, outlinks: 3, canonical: S + "/a.html", data: { h1Count: 1, canonicals: 1, viewport: true, lang: "en" } });
const issue = (p, id) => pageIssues(p, { siteIsHttps: true }).find((i) => (i.check_id || i.id || i[0]) === id || JSON.stringify(i).includes(`"${id}"`));

test("widths follow Arial metrics: wide letters cost more than narrow ones", () => {
  assert.equal(textWidth("WWW", 20), 57); // 944 units each
  assert.equal(textWidth("iii", 20), 13);
  assert.equal(textWidth("", 20), 0);
  assert.equal(textWidth("—", 10), 10); // em dash = 1 em
  assert.equal(textWidth("中", 10), 6); // unknown characters count as an average letter
  // Calibrated against Screaming Frog 25.1 on a live crawl: estimates land within about 10 px of its widths.
  const t = titleWidth("Not-at-Fault Car Repair & Claim Help, Doncaster | AB Automotive");
  assert.ok(t > TITLE_PX && t < 600, String(t));
});

test("a 58-character title of wide letters is flagged by width; a narrower title is not", () => {
  const wide = "Mercedes-Benz Service & Mechanic Doncaster | AB Automotive"; // 58 chars, ~578 px
  assert.ok(wide.length <= 65 && titleWidth(wide) > TITLE_PX);
  const hit = issue(page(wide, "x".repeat(120)), "title_too_long");
  assert.ok(hit, "title_too_long raised on width");
  assert.match(JSON.stringify(hit), /px/);
  const ok = "Mercedes-Benz Service, Doncaster | AB Automotive";
  assert.ok(titleWidth(ok) <= TITLE_PX);
  assert.equal(issue(page(ok, "x".repeat(120)), "title_too_long"), undefined);
});

test("descriptions under 170 characters are flagged when wider than the snippet width", () => {
  const d = "Contact Example Motors at 12 Sample Road, Springfield VIC 3000. Call 03 9000 0000 or send an enquiry. Open Monday to Friday 9 to 6 and Saturday 10 to 3 by appointment.";
  assert.ok(d.length <= 170 && descWidth(d) > DESC_PX, String(descWidth(d)));
  assert.ok(issue(page("A normal page title for testing | Brand", d), "desc_length"));
  const short = "Contact Example Motors, 12 Sample Road, Springfield VIC 3000. Call 03 9000 0000 or send an enquiry.";
  assert.equal(issue(page("A normal page title for testing | Brand", short), "desc_length"), undefined);
});

// Owner reel 2026-11-05: pages titled "Best X: Reddit Recommendations" on the business's own site get repeated by
// ChatGPT as "Reddit users recommend X". Flag them; real Reddit pages and plain mentions are left alone.
test("borrowed_platform_title flags 'Reddit recommendations' pages that are not on Reddit", () => {
  const p = (url, title, h1) => ({ ...page(title, "x".repeat(120)), url, final_url: url, h1 });
  assert.ok(issue(p("https://xyz.com/best-crm-reddit", "Best CRM for Small Business - Reddit Recommendations", "Best CRM: Reddit Recommendations"), "borrowed_platform_title"));
  assert.ok(issue(p("https://xyz.com/crm", "Top CRM picks", "What Reddit users recommend for CRM"), "borrowed_platform_title"));
  assert.equal(issue(p("https://www.reddit.com/r/crm/best", "Best CRM? : r/crm", "Best CRM?"), "borrowed_platform_title"), undefined);
  assert.equal(issue(p("https://xyz.com/social-media-guide", "How to use Reddit for support", "Using Reddit for support"), "borrowed_platform_title"), undefined);
});
