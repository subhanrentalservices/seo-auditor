// Group 7 extra checks: security headers, accessibility from the DOM, readability, and the missing_lang wording
// (Google doesn't use the lang attribute). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { parseHtml } = await import("../src/crawler.mjs");
const { CHECKS, pageIssues } = await import("../src/checks.mjs");
const { securityHeaders, extraPageIssues, readability, validLang, syllables, EXTRA_CHECKS } = await import("../src/extra-checks.mjs");

const ids = (list) => list.map(([id]) => id);
const page = (data = {}) => ({ url: "https://example.com/a", final_url: "https://example.com/a", status: 200, content_type: "text/html", indexable: 1,
  title: "A good page title for tests", description: "d".repeat(100), h1: "Heading", words: 900, text_ratio: 20, canonical: "https://example.com/a",
  data: { h1Count: 1, viewport: true, lang: "en", canonicals: 1, jsonld: 1, og: true, ...data } });
const SAFE = { "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; frame-ancestors 'self'", "referrer-policy": "strict-origin-when-cross-origin" };

test("security headers: a fully protected HTTPS page raises nothing", () => {
  const s = securityHeaders(new Headers(SAFE), "https://example.com/a");
  assert.equal(s.frameAncestors, "frame-ancestors 'self'");
  assert.deepEqual(extraPageIssues({ secHeaders: s }), []);
});

test("security headers: each missing header raises its notice", () => {
  const found = extraPageIssues({ secHeaders: securityHeaders(new Headers({}), "https://example.com/a") });
  assert.deepEqual(ids(found), ["sec_no_hsts", "sec_no_nosniff", "sec_no_frame_protection", "sec_no_referrer_policy"]);
  for (const id of ids(found)) { assert.equal(CHECKS[id][0], "notice"); assert.match(CHECKS[id][1], /not a Google ranking factor/); }
});

test("security headers: HSTS only on HTTPS, max-age=0 counts as off, X-Frame-Options and meta referrer accepted", () => {
  assert.ok(!ids(extraPageIssues({ secHeaders: securityHeaders(new Headers({}), "http://example.com/a") })).includes("sec_no_hsts"));
  const zero = extraPageIssues({ secHeaders: securityHeaders(new Headers({ ...SAFE, "strict-transport-security": "max-age=0" }), "https://example.com/a") });
  assert.match(zero.find(([id]) => id === "sec_no_hsts")[1], /max-age 0/);
  const xfo = { "x-frame-options": "SAMEORIGIN", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=600" };
  assert.deepEqual(ids(extraPageIssues({ secHeaders: securityHeaders(new Headers(xfo), "https://example.com/a"), metaReferrer: "no-referrer" })), []);
  const allow = extraPageIssues({ secHeaders: securityHeaders(new Headers({ ...xfo, "x-frame-options": "ALLOW-FROM https://x.com" }), "https://example.com/a"), metaReferrer: "origin" });
  assert.deepEqual(ids(allow), ["sec_no_frame_protection"]);
});

test("security headers: old audits (no secHeaders stored) raise nothing through pageIssues", () => {
  assert.ok(!ids(pageIssues(page(), {})).some((id) => id.startsWith("sec_") || id.startsWith("a11y_")));
  assert.ok(ids(pageIssues(page({ secHeaders: { https: true } }), {})).includes("sec_no_hsts"));
});

test("form fields: labelled ways pass, unlabelled fields are counted", () => {
  const html = `<html lang="en"><body><form>
    <label for="n">Name</label><input id="n">
    <label>Email <input type="email"></label>
    <input aria-label="Phone"><input title="Suburb"><input placeholder="Postcode">
    <span id="lbl">Rego</span><input aria-labelledby="lbl">
    <input type="hidden" name="t"><input type="submit"><div hidden><input name="ghost"></div>
    <input name="mystery"><select name="pick"><option>1</option></select><textarea></textarea>
  </form></body></html>`;
  const { data } = parseHtml(html, "https://example.com/a");
  assert.equal(data.formNoLabel, 3);
  assert.equal(data.formNoLabelExample, "<input>[name=mystery]");
  assert.deepEqual(ids(pageIssues(page(data), {})).filter((id) => id.startsWith("a11y_")), ["a11y_form_label"]);
});

test("buttons: text, aria-label, image alt and SVG title name a button; icon-only ones don't", () => {
  const html = `<html lang="en"><body>
    <button>Send</button><button aria-label="Open menu"><svg></svg></button><button><img src="x.png" alt="Search"></button>
    <button><svg><title>Close</title></svg></button><input type="button" value="Go"><input type="image" src="go.png" alt="Go">
    <button class="burger icon"><svg></svg></button><div role="button"></div><input type="image" src="b.png">
  </body></html>`;
  const { data } = parseHtml(html, "https://example.com/a");
  assert.equal(data.emptyButtons, 3);
  assert.equal(data.emptyButtonExample, "<button>.burger");
});

test("lang value: valid BCP 47 shapes pass, made-up values raise a11y_lang_invalid, empty stays missing_lang", () => {
  for (const v of ["en", "en-AU", "zh-Hans-CN", "es-419", "de-CH-1996", "x-klingon"]) assert.ok(validLang(v), v);
  for (const v of ["english", "en_US", "e", "en-"]) assert.ok(!validLang(v), v);
  const bad = parseHtml(`<html lang="en_US"><body><p>Hi</p></body></html>`, "https://example.com/a").data;
  assert.equal(bad.langInvalid, "en_US");
  assert.ok(ids(pageIssues(page(bad), {})).includes("a11y_lang_invalid"));
  const none = parseHtml(`<html><body><p>Hi</p></body></html>`, "https://example.com/a").data;
  const found = ids(pageIssues(page(none), {}));
  assert.ok(found.includes("missing_lang") && !found.includes("a11y_lang_invalid"));
});

test("missing_lang: says Google doesn't use lang and gives the real reasons, as a notice", () => {
  const [sev, title, why] = CHECKS.missing_lang;
  assert.equal(sev, "notice");
  assert.match(title, /not a Google ranking factor/);
  assert.match(why, /Google doesn't use the lang attribute/);
  assert.match(why, /screen readers/);
  assert.match(why, /translation/);
  assert.match(why, /hyphenation/);
  assert.doesNotMatch(why, /helps search engines/);
});

test("readability: English text of 100+ words gets a score; short or non-English text doesn't", () => {
  const easy = "The cat sat on the mat. It was a warm day. We went to the park. ".repeat(10);
  const r = readability(easy, "en-AU");
  assert.ok(r.score >= 90 && r.words >= 100, JSON.stringify(r));
  const hard = "Comprehensive organisational documentation necessitates considerable administrative coordination, particularly regarding interdepartmental responsibilities and regulatory obligations. ".repeat(8);
  assert.ok(readability(hard, "").score < 20);
  assert.equal(readability("Too short.", "en"), null);
  assert.equal(readability(easy, "de"), null);
  assert.equal(syllables("jumped"), 1);
  assert.equal(syllables("table"), 2);
  const { data } = parseHtml(`<html lang="en"><body><main><p>${easy}</p></main></body></html>`, "https://example.com/a");
  assert.ok(data.readability?.score >= 90);
  assert.ok(!ids(pageIssues(page(data), {})).some((id) => /readab/.test(id)), "information only: no issue");
});

test("every extra check is a notice labelled as not a Google ranking factor", () => {
  for (const [id, [sev, title]] of Object.entries(EXTRA_CHECKS)) {
    assert.equal(sev, "notice", id);
    assert.match(title, /not a Google ranking factor/, id);
    assert.equal(CHECKS[id][1], title);
  }
});
