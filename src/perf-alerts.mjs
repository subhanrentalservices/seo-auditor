// Lighthouse regression alert: compares the last two audits that have Lighthouse rows, page by page and per form
// factor, and reports metrics that got worse by more than the project's alert thresholds AND are now outside "good".
// Lab data varies between runs, so the alert says so. The data reaches alerts.mjs through its "perfRegressions" feed
// (provided from cwv.mjs's register); the rule logic below is pure and tested with fixtures.
import { all } from "./db.mjs";

// worse: +1 = higher is worse, -1 = lower is worse. good: the "good" limit the new value must be past to alert.
export const PERF_METRICS = {
  lcp_ms: { label: "LCP", worse: 1, good: 2500, field: "lcpMs", fmt: (v) => `${(v / 1000).toFixed(1)} s` },
  cls: { label: "CLS", worse: 1, good: 0.1, field: "cls", fmt: (v) => Number(v).toFixed(3) },
  tbt_ms: { label: "TBT", worse: 1, good: 200, field: "tbtMs", fmt: (v) => `${Math.round(v)} ms` },
  perf: { label: "Performance score", worse: -1, good: 90, field: "perf", fmt: (v) => String(v) },
};

/** Paired rows (same url and form factor) → [{ url, formFactor, metric, from, to, change }], change > 0 = worse. */
export function perfChanges(prevRows, curRows) {
  const key = (r) => `${r.form_factor || "mobile"} ${r.url}`;
  const prev = new Map(prevRows.filter((r) => !r.error).map((r) => [key(r), r]));
  const out = [];
  for (const c of curRows) {
    const p = !c.error && prev.get(key(c)); if (!p) continue;
    for (const [m, def] of Object.entries(PERF_METRICS)) {
      if (!Number.isFinite(p[m]) || !Number.isFinite(c[m])) continue;
      const change = (c[m] - p[m]) * def.worse;
      if (change > 0) out.push({ url: c.url, formFactor: c.form_factor || "mobile", metric: m, from: p[m], to: c[m], change });
    }
  }
  return out;
}

/** Feed for alerts.mjs: the last two audits with Lighthouse data and their changes, or null when there aren't two. */
export function perfRegressions(projectId) {
  const audits = all("SELECT DISTINCT a.id FROM audits a JOIN cwv c ON c.audit_id=a.id AND c.error IS NULL WHERE a.project_id=? AND a.status='done' ORDER BY a.id DESC LIMIT 2", projectId);
  if (audits.length < 2) return null;
  const rows = (id) => all("SELECT url, form_factor, lcp_ms, cls, tbt_ms, perf, error FROM cwv WHERE audit_id=?", id);
  const [cur, prev] = audits.map((a) => a.id);
  return { auditId: cur, prevAuditId: prev, changes: perfChanges(rows(prev), rows(cur)) };
}

const beyondGood = (def, v) => (def.worse > 0 ? v > def.good : v < def.good);

/** Alert items from the feed and the rule's thresholds (s.lcpMs, s.cls, s.tbtMs, s.perf): one per page and form factor. */
export function regressionItems(feed, s) {
  const pages = new Map();
  for (const ch of feed.changes) {
    const def = PERF_METRICS[ch.metric], limit = Number(s[def.field]);
    if (!(limit > 0) || ch.change < limit || !beyondGood(def, ch.to)) continue;
    const k = `${ch.formFactor} ${ch.url}`;
    if (!pages.has(k)) pages.set(k, { url: ch.url, formFactor: ch.formFactor, parts: [] });
    pages.get(k).parts.push(`${def.label} ${def.fmt(ch.from)} → ${def.fmt(ch.to)}`);
  }
  return [...pages.values()].map((p) => ({ fingerprint: `${feed.auditId}:${p.formFactor}:${p.url}`, severity: "warning", urls: [p.url],
    title: `Lighthouse (${p.formFactor}): ${p.parts.length === 1 ? p.parts[0].split(" ")[0] : "speed"} got worse on ${new URL(p.url).pathname}`,
    detail: `${p.parts.join("; ")} (audit #${feed.prevAuditId} → #${feed.auditId}). Lab data: results vary between runs, so re-run Lighthouse or check the field data before acting.` }));
}
