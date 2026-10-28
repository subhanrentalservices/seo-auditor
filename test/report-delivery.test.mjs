// Scheduled report delivery and report branding (REQ-055 group 5 items 4 and 5): due dates, saving to a folder, emailing
// the PDF through a fake local SMTP server (PDF maker injected: no browser), failures recorded and redacted, branding
// validation and how the report shows it. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.SEO_AUDITOR_DATA = mkdtempSync(path.join(tmpdir(), "seo-auditor-test-")); // keep the real database untouched
const { run, get } = await import("../src/db.mjs");
const R = await import("../src/report-delivery.mjs");
const B = await import("../src/branding.mjs");
const { buildReport } = await import("../src/report.mjs");
const { updateConfig } = await import("../src/alert-channels.mjs");
const { fakeSmtp, parts } = await import("./fake-smtp.mjs");

run("INSERT INTO projects (id, name, start_url) VALUES (1, 'Acme Plumbing', 'https://acme.example/')");
run("INSERT INTO audits (id, project_id, status, health, ai_readiness, errors, warnings, pages_crawled, finished_at) VALUES (5, 1, 'done', 88, 70, 3, 9, 40, '2026-10-20 01:00:00')");
run("INSERT INTO projects (id, name, start_url) VALUES (2, 'No audits', 'https://none.example/')");
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const pdf = async (auditId) => Buffer.from(`%PDF-1.7 fake report for audit ${auditId}`);

test("due: weekly after 7 days, monthly after one calendar month, never when off", () => {
  const t = (s) => Date.parse(s);
  assert.equal(R.reportDue("off", null), false);
  assert.equal(R.reportDue("weekly", null), true);
  assert.equal(R.reportDue("weekly", "2026-10-01T06:00:00Z", t("2026-10-07T06:00:00Z")), false);
  assert.equal(R.reportDue("weekly", "2026-10-01T06:00:00Z", t("2026-10-08T05:30:00Z")), true); // an hour of slack
  assert.equal(R.reportDue("monthly", "2026-01-31T06:00:00Z", t("2026-02-28T06:00:00Z")), false);
  assert.equal(R.reportDue("monthly", "2026-01-31T06:00:00Z", t("2026-03-03T06:00:00Z")), true);
});

test("settings are validated: schedule, format, recipients and an existing folder", () => {
  assert.throws(() => R.updateReportSettings(1, { schedule: "hourly" }), /Schedule/);
  assert.throws(() => R.updateReportSettings(1, { to: "nope" }), /Recipients/);
  assert.throws(() => R.updateReportSettings(1, { folder: "relative/folder" }), /Folder/);
  assert.throws(() => R.updateReportSettings(1, { schedule: "weekly", delivery: "folder", folder: "" }), /folder/);
  assert.deepEqual(R.updateReportSettings(1, { schedule: "off", to: "boss@example.com" }), { ...R.REPORT_DEFAULTS, to: "boss@example.com" });
});

test("saved to a folder: the HTML report lands there with a dated name", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "seo-reports-"));
  R.updateReportSettings(1, { schedule: "weekly", format: "html", delivery: "folder", folder: dir });
  const r = await R.deliverReport(1, { deps: { now: Date.parse("2026-10-28T06:00:00Z") } });
  assert.equal(path.basename(r.file), "seo-report-acme-plumbing-2026-10-28.html");
  assert.match(readFileSync(r.file, "utf8"), /<h1>SEO report — Acme Plumbing<\/h1>/);
  assert.deepEqual(readdirSync(dir), ["seo-report-acme-plumbing-2026-10-28.html"]);
});

test("emailed: the PDF is attached and sent to the project's recipients through the SMTP settings", async () => {
  const srv = await fakeSmtp();
  try {
    updateConfig({ email: { host: "127.0.0.1", port: srv.port, security: "none", from: "reports@example.com", to: "default@example.com" } });
    R.updateReportSettings(1, { schedule: "monthly", format: "pdf", delivery: "email", to: "boss@example.com" });
    const r = await R.deliverReport(1, { deps: { pdf, now: Date.parse("2026-10-28T06:00:00Z") } });
    assert.deepEqual(r.to, ["boss@example.com"]);
    const s = srv.sessions[0];
    assert.ok(s.commands.includes("RCPT TO:<boss@example.com>"));
    const p = parts(s.data);
    assert.match(p[0].body.toString(), /Site Health 88, AI Readiness 70, 3 errors/);
    assert.equal(p[1].type, 'application/pdf; name="seo-report-acme-plumbing-2026-10-28.pdf"');
    assert.equal(p[1].body.toString(), "%PDF-1.7 fake report for audit 5");
  } finally { await srv.close(); }
});

test("a failed delivery is recorded (redacted), retried a day later, and doesn't move the schedule", async () => {
  updateConfig({ email: { host: "127.0.0.1", port: 1, security: "none", user: "", password: "smtp-pw-secret" } });
  const now = Date.parse("2026-11-30T06:00:00Z");
  const failing = { pdf: async () => { throw new Error("browser failed with smtp-pw-secret"); }, now };
  const out = await R.deliverDueReports({ deps: failing });
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.ok(!out[0].error.includes("smtp-pw-secret"));
  const last = JSON.parse(get("SELECT value FROM meta WHERE key='report-sent:1'").value);
  assert.ok(last.error && last.okAt !== last.at);
  assert.equal((await R.deliverDueReports({ deps: { ...failing, now: now + 3600e3 } })).length, 0, "not again within a day");
  assert.equal((await R.deliverDueReports({ deps: { ...failing, now: now + 25 * 3600e3 } })).length, 1, "tried again the next day");
  await assert.rejects(R.deliverReport(2, { deps: { pdf } }), /Run an audit first/);
});

test("branding: logo, colours and name are validated", () => {
  assert.throws(() => B.cleanBranding({ logo: "data:image/svg+xml;base64,PHN2Zz4=" }), /Logo/);
  assert.throws(() => B.cleanBranding({ logo: "https://example.com/logo.png" }), /Logo/);
  assert.throws(() => B.cleanBranding({ primary: "red; } body { display:none" }), /Colours/);
  assert.deepEqual(B.cleanBranding({ name: "Agency\r\nX", primary: "#1A5FB4", whiteLabel: 1, extra: "ignored" }), { name: "Agency X", primary: "#1a5fb4", whiteLabel: true });
});

test("branding in the report: app-wide values, the project's own on top, white-label footer, all escaped", () => {
  const plain = buildReport(5);
  assert.match(plain, /Generated by SEO Auditor/);
  assert.ok(!plain.includes("brandbar\">"));
  B.saveAppBranding({ name: "Best <Agency>", logo: PNG, primary: "#112233" });
  R.updateProjectBranding(1, { accent: "#445566", whiteLabel: true });
  assert.deepEqual(B.brandingFor(1), { name: "Best <Agency>", logo: PNG, primary: "#112233", accent: "#445566", whiteLabel: true });
  assert.equal(B.brandingFor(2).whiteLabel, false, "other projects keep the app-wide values");
  const html = buildReport(5);
  assert.match(html, /<div class="brandbar"><img src="data:image\/png;base64,[^"]+" alt="Best &lt;Agency&gt;"><b>Best &lt;Agency&gt;<\/b><\/div><h1>/);
  assert.match(html, /h1\{color:#112233\}/);
  assert.match(html, /h2\{border-top-color:#445566\}/);
  assert.match(html, /Prepared by Best &lt;Agency&gt; on /);
  assert.ok(!html.includes("Generated by SEO Auditor"));
  R.updateProjectBranding(1, { whiteLabel: false });
  assert.match(buildReport(5), /Generated by SEO Auditor/);
  B.saveAppBranding({ whiteLabel: true });
  assert.match(buildReport(5), /Generated by SEO Auditor/, "the project's own 'off' wins over the app-wide 'on'");
  R.updateProjectBranding(1, { whiteLabel: "" });
  assert.match(buildReport(5), /Prepared by Best &lt;Agency&gt;/, "'' = as app-wide");
});
