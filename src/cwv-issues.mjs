// Core Web Vitals problems as issues (group 7): after Lighthouse and the CrUX refresh, each measured page's LCP, INP
// and CLS are rated with web.dev's thresholds. Field data first (the page's own CrUX record, phone); without it, the
// Lighthouse lab value for LCP and CLS, labelled as lab (INP has no lab measure: Total Blocking Time is only a proxy,
// so no INP issue comes from lab data). The whole site's CrUX record (phone and desktop) is reported on the start URL.
// Poor = warning, needs improvement = notice (cwv_* in CHECKS, defined in extra-checks.mjs). The audit's counts and
// Site Health are recomputed afterwards with the crawler's rules, so they stay right on re-runs.
import { db, all, get, run } from "./db.mjs";
import { CHECKS, healthScore } from "./checks.mjs";
import { cruxData, FIELD_THRESHOLDS } from "./crux.mjs";
import { afterAudit } from "./runner.mjs";

const METRICS = [["lcp", "largest_contentful_paint", "LCP", "lcp_ms"], ["inp", "interaction_to_next_paint", "INP", null], ["cls", "cumulative_layout_shift", "CLS", "cls"]];
const fmt = (k, v) => (k === "cls" ? Number(v).toFixed(2) : k === "lcp" ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
/** Lighthouse's own limit (core/gather/driver/environment.js, SLOW_CPU_BENCHMARK_INDEX_THRESHOLD): at or below this
 *  CPU benchmark it warns that the device is slower than expected, and lab times (LCP, TBT) come out higher than
 *  PageSpeed Insights measures on Google's servers. */
export const SLOW_HOST_BENCHMARK = 1000;
const hostNote = (lab) => (lab?.benchmark && lab.benchmark <= SLOW_HOST_BENCHMARK
  ? ` (measured on a slow computer: Lighthouse CPU benchmark ${lab.benchmark}, it expects over ${SLOW_HOST_BENCHMARK}, so lab times run high; confirm with PageSpeed Insights)` : "");
const share = (m) => (m.good === null || m.good === undefined ? "" : `, ${Math.round(m.good * 100)}% of visits good`);
/** "poor" | "ni" | null for a value and [good, poor] limits (good ≤ first, poor > second). */
export const rate = (v, [good, poor]) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : v > poor ? "poor" : v > good ? "ni" : null);

/** Pure: [[checkId, url, detail]] from the audit's mobile Lighthouse rows, the stored CrUX data (cruxData shape, or
 *  null without a key) and the start URL. One issue per check and URL; several sources for it are joined in the detail. */
export function cwvIssues({ labRows = [], crux = null, start }) {
  const out = new Map();
  const add = (id, url, detail) => { const k = `${id}\0${url}`; out.set(k, out.has(k) ? `${out.get(k)}; ${detail}` : detail); };
  const field = new Map((crux?.urls || []).filter((r) => r.formFactor === "PHONE" && !r.noData && !r.error).map((r) => [r.url, r.metrics]));
  const urls = [...new Set([...labRows.filter((r) => !r.error).map((r) => r.url), ...field.keys()])];
  for (const url of urls) {
    const fm = field.get(url), lab = labRows.find((r) => r.url === url && !r.error);
    for (const [k, cruxKey, label, labKey] of METRICS) {
      const m = fm?.[cruxKey];
      if (m && m.p75 !== null && m.p75 !== undefined) {
        const r = rate(m.p75, FIELD_THRESHOLDS[cruxKey]);
        if (r) add(`cwv_${k}_${r}`, url, `Field data (this page, phone, 28 days): ${label} p75 ${fmt(k, m.p75)}${share(m)}`);
      } else if (labKey && lab) {
        const r = rate(lab[labKey], FIELD_THRESHOLDS[cruxKey]);
        if (r) add(`cwv_${k}_${r}`, url, `Lab (Lighthouse, mobile), no field data for this page: ${label} ${fmt(k, lab[labKey])}${hostNote(lab)}`);
      }
    }
  }
  for (const ff of ["PHONE", "DESKTOP"]) {
    const rec = crux?.origin?.[ff];
    if (!rec || rec.noData || rec.error) continue;
    for (const [k, cruxKey, label] of METRICS) {
      const m = rec.metrics?.[cruxKey]; if (!m) continue;
      const r = rate(m.p75, FIELD_THRESHOLDS[cruxKey]);
      if (r) add(`cwv_${k}_${r}`, start, `Field data (whole site, ${ff.toLowerCase()}, 28 days): ${label} p75 ${fmt(k, m.p75)}${share(m)}`);
    }
  }
  return [...out].map(([k, detail]) => { const [id, url] = k.split("\0"); return [id, url, detail]; });
}

/** Replaces the audit's cwv_* issues and recomputes its error/warning/notice counts and Site Health, using the same
 *  queries as the crawler's totals (crawler.mjs, "totals and health"). Returns the issues raised. */
export function applyCwvIssues(auditId, project) {
  const a = get("SELECT id, pages_crawled FROM audits WHERE id=?", auditId);
  if (!a) return [];
  const labRows = all("SELECT url, lcp_ms, cls, error, details FROM cwv WHERE audit_id=? AND COALESCE(form_factor, 'mobile')='mobile'", auditId)
    .map(({ details, ...r }) => { let b = null; try { b = JSON.parse(details || "{}").benchmark ?? null; } catch {} return { ...r, benchmark: b }; });
  const crux = cruxData(project.id);
  const found = cwvIssues({ labRows, crux: crux.enabled && crux.fetchedAt ? crux : null, start: project.start_url });
  db.exec("BEGIN");
  try {
    run("DELETE FROM issues WHERE audit_id=? AND check_id LIKE 'cwv\\_%' ESCAPE '\\'", auditId);
    const ins = db.prepare("INSERT INTO issues (audit_id, check_id, severity, url, detail) VALUES (?,?,?,?,?)");
    for (const [id, url, detail] of found) ins.run(auditId, id, CHECKS[id][0], url, detail);
    const sev = all("SELECT severity, COUNT(*) n FROM issues WHERE audit_id=? AND check_id NOT LIKE 'ai_%' GROUP BY severity", auditId);
    const count = (s) => sev.find((x) => x.severity === s)?.n || 0;
    const errPages = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='error' AND check_id NOT LIKE 'ai_%'", auditId).n;
    const warnOnly = get("SELECT COUNT(DISTINCT url) n FROM issues WHERE audit_id=? AND severity='warning' AND check_id NOT LIKE 'ai_%' AND url NOT IN (SELECT url FROM issues WHERE audit_id=? AND severity='error')", auditId, auditId).n;
    run("UPDATE audits SET health=?, errors=?, warnings=?, notices=? WHERE id=?", healthScore(a.pages_crawled, errPages, warnOnly), count("error"), count("warning"), count("notice"), auditId);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return found;
}

let registered = false;
/** Registered from cwv.mjs after Lighthouse and CrUX, so it runs before alerts.mjs reads the audit's totals. */
export function register() {
  if (registered) return;
  registered = true;
  afterAudit.push(async (auditId, project) => { applyCwvIssues(auditId, project); });
}
