// Core Web Vitals problems as issues (group 7): field data first (page, then whole site on the start URL), Lighthouse
// lab values as a labelled fallback (LCP and CLS only), web.dev thresholds, and the audit's totals and Site Health
// recomputed. CrUX data is written straight into the temp database: no API call. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, get, all } = await import("../src/db.mjs");
const { cwvIssues, applyCwvIssues, rate } = await import("../src/cwv-issues.mjs");
const { CHECKS, healthScore } = await import("../src/checks.mjs");
const { saveConfig } = await import("../src/dataforseo.mjs");

const S = "https://acme.example";
const metrics = (lcp, inp, cls, good = 0.6) => ({ largest_contentful_paint: { p75: lcp, good }, interaction_to_next_paint: { p75: inp, good }, cumulative_layout_shift: { p75: cls, good } });
const crux = ({ urls = [], phone = null, desktop = null } = {}) => ({ enabled: true, fetchedAt: "2026-11-01 00:00:00", urls,
  origin: { PHONE: phone && { metrics: phone }, DESKTOP: desktop && { metrics: desktop } } });
const by = (found) => Object.fromEntries(found.map(([id, url, d]) => [`${id} ${url.slice(S.length) || "/"}`, d]));

test("thresholds: good up to the first limit, needs improvement up to the second, poor above it", () => {
  assert.equal(rate(2500, [2500, 4000]), null);
  assert.equal(rate(2501, [2500, 4000]), "ni");
  assert.equal(rate(4000, [2500, 4000]), "ni");
  assert.equal(rate(4001, [2500, 4000]), "poor");
  assert.equal(rate(null, [2500, 4000]), null);
});

test("page field data wins over lab; lab is the labelled fallback for LCP and CLS only", () => {
  const labRows = [{ url: S + "/a", lcp_ms: 5200, cls: 0.3 }, { url: S + "/b", lcp_ms: 3000, cls: 0.02 }, { url: S + "/c", error: "timed out" }];
  const found = by(cwvIssues({ labRows, start: S + "/", crux: crux({ urls: [{ url: S + "/a", formFactor: "PHONE", metrics: metrics(2100, 560, 0.05, 0.7) }] }) }));
  assert.deepEqual(Object.keys(found).sort(), ["cwv_inp_poor /a", "cwv_lcp_ni /b"]);
  assert.equal(found["cwv_inp_poor /a"], "Field data (this page, phone, 28 days): INP p75 560 ms, 70% of visits good");
  assert.equal(found["cwv_lcp_ni /b"], "Lab (Lighthouse, mobile), no field data for this page: LCP 3.0 s");
});

test("no field data at all: lab LCP and CLS raise issues, nothing for INP (no lab measure)", () => {
  const found = by(cwvIssues({ labRows: [{ url: S + "/", lcp_ms: 4500, cls: 0.12, tbt_ms: 2000 }], start: S + "/", crux: null }));
  assert.deepEqual(Object.keys(found).sort(), ["cwv_cls_ni /", "cwv_lcp_poor /"]);
  assert.match(found["cwv_cls_ni /"], /^Lab \(Lighthouse, mobile\).*CLS 0\.12$/);
});

test("whole-site field data goes on the start URL, phone and desktop joined into one issue per check", () => {
  const found = by(cwvIssues({ labRows: [], start: S + "/", crux: crux({ phone: metrics(4300, 150, 0.02), desktop: metrics(4100, 90, 0.3) }) }));
  assert.deepEqual(Object.keys(found).sort(), ["cwv_cls_poor /", "cwv_lcp_poor /"]);
  assert.equal(found["cwv_lcp_poor /"], "Field data (whole site, phone, 28 days): LCP p75 4.3 s, 60% of visits good; Field data (whole site, desktop, 28 days): LCP p75 4.1 s, 60% of visits good");
});

test("pages with too few Chrome users (noData) fall back to lab", () => {
  const found = by(cwvIssues({ labRows: [{ url: S + "/a", lcp_ms: 4100, cls: 0 }], start: S + "/", crux: crux({ urls: [{ url: S + "/a", formFactor: "PHONE", noData: true, metrics: {} }] }) }));
  assert.deepEqual(Object.keys(found), ["cwv_lcp_poor /a"]);
});

test("check definitions: poor is a warning, needs improvement a notice, both cite Google and web.dev", () => {
  for (const k of ["lcp", "inp", "cls"]) {
    assert.equal(CHECKS[`cwv_${k}_poor`][0], "warning");
    assert.equal(CHECKS[`cwv_${k}_ni`][0], "notice");
    assert.match(CHECKS[`cwv_${k}_poor`][2], /web\.dev/);
    assert.match(CHECKS[`cwv_${k}_poor`][2], /Understanding Core Web Vitals and Google search results/);
    assert.match(CHECKS[`cwv_${k}_poor`][2], /don't guarantee good rankings/);
  }
});

test("applyCwvIssues replaces earlier cwv issues and recomputes the audit's counts and Site Health", () => {
  saveConfig({ cruxApiKey: "" }); // no key: lab only
  run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme', ?)", S + "/");
  run("INSERT INTO audits (id, project_id, status, pages_crawled, health, errors, warnings, notices) VALUES (1, 1, 'done', 4, 100, 0, 0, 1)");
  run("INSERT INTO issues (audit_id, check_id, severity, url) VALUES (1, 'missing_og', 'notice', ?)", S + "/c");
  run("INSERT INTO issues (audit_id, check_id, severity, url) VALUES (1, 'cwv_lcp_poor', 'warning', ?)", S + "/old"); // from an earlier run
  run("INSERT INTO cwv (audit_id, url, form_factor, lcp_ms, cls) VALUES (1, ?, 'mobile', 4600, 0.01)", S + "/");
  run("INSERT INTO cwv (audit_id, url, form_factor, lcp_ms, cls) VALUES (1, ?, 'desktop', 9000, 0.9)", S + "/"); // desktop lab rows don't raise issues
  run("INSERT INTO cwv (audit_id, url, lcp_ms, cls) VALUES (1, ?, 1200, 0.15)", S + "/b"); // older row without a form factor = mobile
  const found = applyCwvIssues(1, { id: 1, start_url: S + "/" });
  assert.deepEqual(found.map(([id, u]) => `${id} ${u}`).sort(), [`cwv_cls_ni ${S}/b`, `cwv_lcp_poor ${S}/`]);
  const rows = all("SELECT check_id, url FROM issues WHERE audit_id=1 AND check_id LIKE 'cwv%' ORDER BY url");
  assert.equal(rows.length, 2, "the earlier run's issue is gone");
  const a = get("SELECT health, errors, warnings, notices FROM audits WHERE id=1");
  assert.deepEqual({ ...a }, { health: healthScore(4, 0, 1), errors: 0, warnings: 1, notices: 2 });
  applyCwvIssues(1, { id: 1, start_url: S + "/" }); // a re-run raises the same set, not twice
  assert.equal(get("SELECT COUNT(*) n FROM issues WHERE audit_id=1 AND check_id LIKE 'cwv%'").n, 2);
});
