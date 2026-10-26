// Conversion path (REQ-040, 2026-10-27): pages with no way to act, and articles that never link to a money page.
// Works for any site type (local, SaaS, shop, content). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { conversionIssues, isArticle } = await import("../src/conversion.mjs");

const S = "https://acme.example";
const conv = (body) => { const d = parseHtml(`<html><body>${body}</body></html>`, S + "/x").data; return [d.convTel, d.convMail, d.convForm, d.convCta]; };

test("the crawler counts phone and email links, real forms and call-to-action buttons; site search is not a form", () => {
  assert.deepEqual(conv('<a href="tel:0390001234">Call us</a><a href="mailto:a@acme.example">Email</a>'), [1, 1, 0, 1]);
  assert.deepEqual(conv('<form role="search"><input name="q"></form><form><input type="search" name="s"><button>Go</button></form>'), [0, 0, 0, 0]);
  assert.deepEqual(conv('<form><input name="email"><button type="submit">Start free trial</button></form>'), [0, 0, 1, 1]);
  assert.deepEqual(conv('<a href="/pricing">Get started</a><a href="/cart">Add to cart</a><a href="/about">About us</a>'), [0, 0, 0, 2]);
  assert.deepEqual(conv("<p>Just reading material.</p>"), [0, 0, 0, 0]);
});

const page = (p, data = {}) => ({ url: S + p, status: 200, indexable: 1, content_type: "text/html", data: { convTel: 0, convMail: 0, convForm: 0, convCta: 0, ...data } });

test("articles are recognised by folder or Article schema, not the blog index", () => {
  assert.equal(isArticle(page("/blog/how-to-x")), true);
  assert.equal(isArticle(page("/blog/")), false);
  assert.equal(isArticle(page("/what-is-x", { schemaTypes: ["BlogPosting"] })), true);
  assert.equal(isArticle(page("/features/sync")), false);
});

test("pages with no way to act and articles with no link to a money page are flagged; legal and listing pages are not", () => {
  const pages = [page("/", { convCta: 2 }), page("/pricing", { convForm: 1 }), page("/features/sync"), page("/privacy"),
    page("/blog/", { childLinks: 12 }), page("/blog/guide-a", { convCta: 1 }), page("/blog/guide-b", { convCta: 1 }), page("/blog/guide-c", { convCta: 1 })];
  const links = new Map([[S + "/blog/guide-a", [S + "/pricing"]], [S + "/blog/guide-b", [S + "/blog/guide-a", S + "/"]]]);
  const out = conversionIssues(pages, links, S + "/");
  assert.deepEqual(out.filter((x) => x[0] === "no_conversion_path").map((x) => x[1]), [S + "/features/sync"]);
  assert.deepEqual(out.filter((x) => x[0] === "article_no_money_link").map((x) => x[1]), [S + "/blog/guide-b", S + "/blog/guide-c"],
    "linking to another article or the home page doesn't count");
});

test("a link to a money page counts even when that page failed to load in this crawl (or carries a ?query)", () => {
  const pages = [page("/blog/guide-d", { convCta: 1 }), { ...page("/services/repairs"), status: 0 }];
  const links = new Map([[S + "/blog/guide-d", [S + "/services/repairs", S + "/blog/"]], [S + "/blog/guide-e", [S + "/quote.html?type=x"]]]);
  assert.deepEqual(conversionIssues(pages, links, S + "/"), []);
  assert.deepEqual(conversionIssues([page("/blog/guide-e", { convCta: 1 })], links, S + "/"), []);
});
