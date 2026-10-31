// Lab Core Web Vitals via Lighthouse (the engine behind PageSpeed Insights), mobile (and desktop when the project's
// cwvDesktop setting is on), simulated throttling. Pages are sampled by URL template.
// Runs on Playwright's Chromium, so no separate Chrome install is needed. Lab data: repeatable, but not the
// same as Google's field data (CrUX) — the UI says so.
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import * as chromeLauncher from "chrome-launcher";
import { all, get, run, projectSettings } from "./db.mjs";
import { afterAudit, phase } from "./runner.mjs";
import { register as registerCrux } from "./crux.mjs";
import { register as registerCruxHistory } from "./crux-history.mjs";
import { provideFeed } from "./alerts.mjs";
import { perfRegressions } from "./perf-alerts.mjs";
import { register as registerCwvIssues, applyCwvIssues } from "./cwv-issues.mjs";

export const THRESHOLDS = { lcp_ms: [2500, 4000], cls: [0.1, 0.25], tbt_ms: [200, 600], fcp_ms: [1800, 3000] };
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
// Total Blocking Time swings most between runs when the computer is busy (Lighthouse's variability guide: run 5 times,
// use the median). A page whose TBT is "needs work" or worse and at least twice the site's median is re-run.
export const RECHECK_RUNS = 5;
const RECHECK_MAX_PAGES = 10;

/** URL pattern a page most likely shares a template with: "/" for the home page, "/*" for top-level pages, then the
 *  first folder and one * per deeper level ("/blog/*", "/services/*\/*"), with "?" added when the URL has a query. */
export function templateKey(url) {
  const u = new URL(url), seg = u.pathname.split("/").filter(Boolean);
  const key = !seg.length ? "/" : seg.length === 1 ? "/*" : `/${seg[0]}/${seg.slice(1).map(() => "*").join("/")}`;
  return u.search ? `${key}?` : key;
}

/** Picks up to n pages by template: the start page, then the most-linked page of each URL pattern in turn, largest
 *  pattern first, so a sample of 5 covers the home page and the four most common templates. */
export function pickPages(auditId, n) {
  const rows = all("SELECT url, final_url, inlinks FROM pages WHERE audit_id=? AND status=200 AND indexable=1 AND content_type LIKE '%html%' ORDER BY depth IS NULL, depth, inlinks DESC", auditId);
  if (!rows.length || n <= 0) return [];
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const key = templateKey(r.final_url || r.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const order = [...groups.values()].sort((a, b) => b.length - a.length); // stable: equal sizes keep crawl order
  for (const g of order) g.sort((a, b) => b.inlinks - a.inlinks);
  const out = [rows[0].final_url || rows[0].url];
  while (out.length < n && order.some((g) => g.length))
    for (const g of order) if (g.length && out.length < n) { const r = g.shift(); out.push(r.final_url || r.url); }
  return out.slice(0, n);
}

const MOBILE = { formFactor: "mobile", screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } };

/** One Lighthouse run → metrics, category scores, top opportunities and failed checks. Desktop uses Lighthouse's own
 *  desktop config (1350×940, desktop throttling), like PageSpeed Insights' desktop tab. */
async function audit(port, url, formFactor = "mobile") {
  const flags = { port, output: "json", logLevel: "error", onlyCategories: CATEGORIES };
  const r = formFactor === "desktop" ? await lighthouse(url, flags, desktopConfig) : await lighthouse(url, { ...flags, ...MOBILE });
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
    details: {
      opportunities, failed, lcpElement: A["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node?.snippet || null,
      // CPU speed Lighthouse measured just before this run: lower than the other runs = the computer was busy.
      benchmark: Math.round(lhr.environment?.benchmarkIndex || 0) || null,
      longTasks: (A["long-tasks"]?.details?.items || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 5)
        .map((t) => ({ url: typeof t.url === "string" ? t.url : "Unattributable", ms: Math.round(t.duration), startMs: Math.round(t.startTime || 0) })),
      mainThread: (A["mainthread-work-breakdown"]?.details?.items || []).slice().sort((a, b) => b.duration - a.duration).slice(0, 4)
        .map((g) => ({ label: g.groupLabel || g.group, ms: Math.round(g.duration) })),
      warnings: (lhr.runWarnings || []).map((w) => String(w).slice(0, 200)).slice(0, 3),
    },
  };
}

const median = (v) => { const s = v.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Pages to re-run: TBT worse than "good" and at least twice the median of the other pages (any TBT worse than good
 *  when fewer than 3 pages were measured). A site that is slow everywhere has a high median, so nothing is re-run. */
export function recheckTargets(rows) {
  const ok = rows.filter((r) => Number.isFinite(r.tbt_ms));
  const mid = ok.length >= 3 ? median(ok.map((r) => r.tbt_ms)) : 0;
  return ok.filter((r) => r.tbt_ms > THRESHOLDS.tbt_ms[0] && r.tbt_ms >= 2 * Math.max(mid, 50))
    .sort((a, b) => b.tbt_ms - a.tbt_ms).slice(0, RECHECK_MAX_PAGES).map((r) => r.url);
}

/** Of several runs of one page, the one with the median TBT (ties: median FCP), plus a verdict: slow in most runs =
 *  the page itself blocks the main thread; slow in a minority = the first result was the computer being busy. */
export function medianRun(runs) {
  const tbt = median(runs.map((m) => m.tbt_ms)), fcp = median(runs.map((m) => m.fcp_ms));
  const best = runs.slice().sort((a, b) => Math.abs(a.tbt_ms - tbt) - Math.abs(b.tbt_ms - tbt) || Math.abs(a.fcp_ms - fcp) - Math.abs(b.fcp_ms - fcp))[0];
  const slow = runs.filter((m) => m.tbt_ms > THRESHOLDS.tbt_ms[0]).length;
  const verdict = slow * 2 > runs.length ? "page" : "noise";
  return { ...best, details: { ...best.details,
    runs: runs.map((m) => ({ tbt_ms: m.tbt_ms, perf: m.perf, lcp_ms: m.lcp_ms, benchmark: m.details?.benchmark ?? null })),
    verdict, slowRuns: slow } };
}

// Long runs: one headless Chrome degrades after a few dozen Lighthouse runs ("An internal Chrome error occurred. Please
// restart Chrome", missing lh:* performance marks), and every later page then fails. Chrome is restarted every
// RESTART_EVERY pages, and after such an error the page is retried once in a fresh Chrome.
export const RESTART_EVERY = 15;
const CHROME_BROKEN = /internal Chrome error|performance mark has not been set|Target closed|ECONNREFUSED|Protocol error/i;

/** Runs Lighthouse page by page in a Chrome it relaunches when needed. launch() → { port, kill() }; run(port, url, ...args). */
export function chromeSession(launch, run, every = RESTART_EVERY) {
  let chrome = null, used = 0;
  const fresh = async () => { if (chrome) { try { await chrome.kill(); } catch { /* already gone */ } } chrome = await launch(); used = 0; };
  return {
    async measure(url, ...args) {
      if (!chrome || used >= every) await fresh();
      used++;
      try { return await run(chrome.port, url, ...args); } catch (e) {
        if (!CHROME_BROKEN.test(String(e?.message))) throw e;
        await fresh(); used++;
        return run(chrome.port, url, ...args);
      }
    },
    async close() { if (chrome) { try { await chrome.kill(); } catch {} chrome = null; } },
  };
}

/** Measures the sampled pages on mobile, then (cwvDesktop) on desktop; re-checks blocking-time outliers on mobile only.
 *  Rows carry form_factor ("mobile" / "desktop"; NULL in older audits = mobile) and details.template. */
export async function runCwv(auditId, project, settings, n = settings.cwvPages) {
  const urls = pickPages(auditId, n);
  if (!urls.length) return [];
  const { chromiumPath } = await import("./browser.mjs");
  const path = await chromiumPath();
  const chrome = chromeSession(() => chromeLauncher.launch({ chromePath: path, chromeFlags: ["--headless=new", "--no-first-run", "--disable-extensions"] }), audit);
  const out = [];
  const factors = settings.cwvDesktop === true ? ["mobile", "desktop"] : ["mobile"];
  const save = (url, ff, m, update) => run(update
    ? "UPDATE cwv SET lcp_ms=?, cls=?, tbt_ms=?, transfer_kb=?, fcp_ms=?, si_ms=?, perf=?, a11y=?, bp=?, seo=?, details=? WHERE audit_id=? AND url=? AND form_factor=?"
    : "INSERT INTO cwv (lcp_ms, cls, tbt_ms, transfer_kb, fcp_ms, si_ms, perf, a11y, bp, seo, details, audit_id, url, form_factor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    m.lcp_ms, m.cls, m.tbt_ms, m.transfer_kb, m.fcp_ms, m.si_ms, m.perf, m.a11y, m.bp, m.seo, JSON.stringify({ ...m.details, template: templateKey(url) }), auditId, url, ff);
  try {
    run("DELETE FROM cwv WHERE audit_id=?", auditId);
    const jobs = factors.flatMap((ff) => urls.map((url) => [url, ff]));
    for (const [i, [url, ff]] of jobs.entries()) {
      phase(project.id, auditId, `Lighthouse ${i + 1}/${jobs.length}${factors.length > 1 ? ` (${ff})` : ""}`);
      try {
        const m = await chrome.measure(url, ff);
        save(url, ff, m);
        out.push({ url, form_factor: ff, ...m });
      } catch (e) {
        run("INSERT INTO cwv (audit_id, url, form_factor, error) VALUES (?,?,?,?)", auditId, url, ff, String(e.message).slice(0, 300));
        console.error("lighthouse", ff, url, e.message);
      }
    }
    const mobile = out.filter((r) => r.form_factor === "mobile");
    const targets = recheckTargets(mobile);
    for (const [i, url] of targets.entries()) {
      const k = out.findIndex((r) => r.url === url && r.form_factor === "mobile"), runs = [out[k]];
      for (let j = 2; j <= RECHECK_RUNS; j++) {
        phase(project.id, auditId, `Re-checking slow page ${i + 1}/${targets.length} (run ${j}/${RECHECK_RUNS})`);
        try { runs.push(await chrome.measure(url, "mobile")); } catch (e) { console.error("lighthouse re-check", url, e.message); }
      }
      if (runs.length < 3) continue;
      const m = medianRun(runs);
      save(url, "mobile", m, true);
      out[k] = { url, form_factor: "mobile", ...m };
    }
  } finally { await chrome.close(); }
  return out;
}

/** Lighthouse rows of one audit for one form factor (default mobile; older audits' rows have no form factor = mobile). */
export function cwvRows(auditId, formFactor = "mobile") {
  return all("SELECT url, COALESCE(form_factor, 'mobile') form_factor, lcp_ms, cls, tbt_ms, fcp_ms, si_ms, transfer_kb, perf, a11y, bp, seo, details, error FROM cwv WHERE audit_id=? AND COALESCE(form_factor, 'mobile')=? ORDER BY rowid", auditId, formFactor)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
}

let busy = false;
export function register({ routes }) {
  afterAudit.push(Object.assign((auditId, project, settings) => (settings.cwvPages > 0 ? runCwv(auditId, project, settings) : null), { label: "Lighthouse (Core Web Vitals lab data)" }));
  routes.push(["GET", /^\/api\/audits\/(\d+)\/cwv$/, ([id]) => ({ thresholds: THRESHOLDS, rows: cwvRows(Number(id)), desktop: cwvRows(Number(id), "desktop"), running: busy })]);
  routes.push(["POST", /^\/api\/audits\/(\d+)\/cwv$/, async ([id], q, body) => {
    const a = get("SELECT * FROM audits WHERE id=? AND status='done'", Number(id));
    if (!a) throw Object.assign(new Error("Audit not finished"), { status: 400 });
    if (busy) throw Object.assign(new Error("Lighthouse is already running"), { status: 409 });
    const project = get("SELECT * FROM projects WHERE id=?", a.project_id);
    const n = Math.min(Math.max(Number(body.pages) || 5, 1), 10000); // more than the site has = every page
    busy = true;
    // Desktop follows the request, else the project's current setting (the audit's own settings predate a change).
    const settings = { ...JSON.parse(a.settings || "{}"), cwvDesktop: typeof body.desktop === "boolean" ? body.desktop : projectSettings(project).cwvDesktop === true };
    runCwv(a.id, project, settings, n).then(() => applyCwvIssues(a.id, project)).catch((e) => console.error("lighthouse:", e.message)).finally(() => { busy = false; phase(project.id, a.id, null); });
    return { started: true };
  }]);
  registerCrux({ routes }); // field data (CrUX) after Lighthouse: its after-audit hook runs after the one above
  registerCruxHistory({ routes }); // then the 25-week field-data trend
  registerCwvIssues(); // then LCP/INP/CLS problems become issues (field first, lab fallback), before alerts read the totals
  provideFeed("perfRegressions", perfRegressions); // Lighthouse regression alert (alerts.mjs rule perf_regression)
}
