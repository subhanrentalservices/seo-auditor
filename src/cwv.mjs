// Lab Core Web Vitals via Lighthouse (the engine behind PageSpeed Insights), mobile, simulated throttling.
// Runs on Playwright's Chromium, so no separate Chrome install is needed. Lab data: repeatable, but not the
// same as Google's field data (CrUX) — the UI says so.
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { all, get, run } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";

export const THRESHOLDS = { lcp_ms: [2500, 4000], cls: [0.1, 0.25], tbt_ms: [200, 600], fcp_ms: [1800, 3000] };
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

/** Picks up to n pages: the start page, then the most-linked page of each site section in turn. */
export function pickPages(auditId, n) {
  const rows = all("SELECT url, final_url, inlinks FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE '%html%' ORDER BY depth IS NULL, depth, inlinks DESC", auditId);
  if (!rows.length || n <= 0) return [];
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const seg = new URL(r.final_url || r.url).pathname.split("/").filter(Boolean);
    const key = seg.length > 1 ? seg[0] : "(root)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const g of groups.values()) g.sort((a, b) => b.inlinks - a.inlinks);
  const out = [rows[0].final_url || rows[0].url];
  while (out.length < n && [...groups.values()].some((g) => g.length))
    for (const g of groups.values()) if (g.length && out.length < n) { const r = g.shift(); out.push(r.final_url || r.url); }
  return out.slice(0, n);
}

/** One Lighthouse run → metrics, category scores, top opportunities and failed checks. */
async function audit(port, url) {
  const r = await lighthouse(url, { port, output: "json", logLevel: "error", onlyCategories: CATEGORIES, formFactor: "mobile", screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } });
  const lhr = r.lhr, A = lhr.audits, C = lhr.categories;
  if (lhr.runtimeError) throw new Error(lhr.runtimeError.message);
  const score = (k) => (C[k]?.score === null || C[k]?.score === undefined ? null : Math.round(C[k].score * 100));
  const opportunities = Object.values(A)
    .filter((x) => x.details?.type === "opportunity" && x.score !== null && x.score < 0.9)
    .map((x) => ({ id: x.id, title: x.title, savingsMs: Math.round(x.details.overallSavingsMs || 0), savingsKb: Math.round((x.details.overallSavingsBytes || 0) / 1024) }))
    .sort((a, b) => b.savingsMs - a.savingsMs || b.savingsKb - a.savingsKb).slice(0, 8);
  const failed = CATEGORIES.slice(1).flatMap((k) => C[k].auditRefs.filter((ref) => A[ref.id]?.score === 0).map((ref) => ({ category: C[k].title, id: ref.id, title: A[ref.id].title })));
  return {
    lcp_ms: Math.round(A["largest-contentful-paint"]?.numericValue ?? 0), cls: Math.round((A["cumulative-layout-shift"]?.numericValue ?? 0) * 1000) / 1000,
    tbt_ms: Math.round(A["total-blocking-time"]?.numericValue ?? 0), fcp_ms: Math.round(A["first-contentful-paint"]?.numericValue ?? 0),
    si_ms: Math.round(A["speed-index"]?.numericValue ?? 0), transfer_kb: Math.round((A["total-byte-weight"]?.numericValue ?? 0) / 1024),
    perf: score("performance"), a11y: score("accessibility"), bp: score("best-practices"), seo: score("seo"),
    details: { opportunities, failed, lcpElement: A["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node?.snippet || null },
  };
}

export async function runCwv(auditId, project, settings, n = settings.cwvPages) {
  const urls = pickPages(auditId, n);
  if (!urls.length) return [];
  const { chromiumPath } = await import("./browser.mjs");
  const chrome = await chromeLauncher.launch({ chromePath: await chromiumPath(), chromeFlags: ["--headless=new", "--no-first-run", "--disable-extensions"] });
  const out = [];
  try {
    run("DELETE FROM cwv WHERE audit_id=?", auditId);
    for (const [i, url] of urls.entries()) {
      phase(project.id, auditId, `Lighthouse ${i + 1}/${urls.length}`);
      try {
        const m = await audit(chrome.port, url);
        run("INSERT INTO cwv (audit_id, url, lcp_ms, cls, tbt_ms, transfer_kb, fcp_ms, si_ms, perf, a11y, bp, seo, details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
          auditId, url, m.lcp_ms, m.cls, m.tbt_ms, m.transfer_kb, m.fcp_ms, m.si_ms, m.perf, m.a11y, m.bp, m.seo, JSON.stringify(m.details));
        out.push({ url, ...m });
      } catch (e) {
        run("INSERT INTO cwv (audit_id, url, error) VALUES (?,?,?)", auditId, url, String(e.message).slice(0, 300));
        console.error("lighthouse", url, e.message);
      }
    }
  } finally { try { await chrome.kill(); } catch {} }
  return out;
}

export function cwvRows(auditId) {
  return all("SELECT url, lcp_ms, cls, tbt_ms, fcp_ms, si_ms, transfer_kb, perf, a11y, bp, seo, details, error FROM cwv WHERE audit_id=? ORDER BY rowid", auditId)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

let busy = false;
export function register({ routes }) {
  afterAudit.push((auditId, project, settings) => (settings.cwvPages > 0 ? runCwv(auditId, project, settings) : null));
  routes.push(["GET", /^\/api\/audits\/(\d+)\/cwv$/, ([id]) => ({ thresholds: THRESHOLDS, rows: cwvRows(Number(id)), running: busy })]);
  routes.push(["POST", /^\/api\/audits\/(\d+)\/cwv$/, async ([id], q, body) => {
    const a = get("SELECT * FROM audits WHERE id=? AND status='done'", Number(id));
    if (!a) throw Object.assign(new Error("Audit not finished"), { status: 400 });
    if (busy) throw Object.assign(new Error("Lighthouse is already running"), { status: 409 });
    const project = get("SELECT * FROM projects WHERE id=?", a.project_id);
    const n = Math.min(Math.max(Number(body.pages) || 5, 1), 50);
    busy = true;
    runCwv(a.id, project, JSON.parse(a.settings || "{}"), n).catch((e) => console.error("lighthouse:", e.message)).finally(() => { busy = false; phase(project.id, a.id, null); });
    return { started: true };
  }]);
}
