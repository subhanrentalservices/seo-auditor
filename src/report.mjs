// One-click report: a self-contained HTML page (inline CSS, no scripts) and the same page as PDF via Playwright.
// Every value that came from a crawled site is escaped.
import { all, get } from "./db.mjs";
import { CHECKS } from "./checks.mjs";
import { priorities } from "./extras.mjs";
import { summary as gscSummary } from "./gsc.mjs";
import { keywordsData, backlinksData } from "./dataforseo.mjs";
import { visibilityData } from "./visibility.mjs";
import { cwvRows } from "./cwv.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = (x) => (x === null || x === undefined ? "–" : Number(x).toLocaleString("en-AU"));
const band = (s) => (s === null || s === undefined ? ["–", "#7a7974"] : s >= 90 ? ["Good", "#0ca30c"] : s >= 70 ? ["Needs work", "#b77d00"] : ["Poor", "#d03b3b"]);
const short = (u, base) => { try { const x = new URL(u); return x.origin === new URL(base).origin ? x.pathname + x.search : u; } catch { return u; } };

function score(label, value, sub) {
  const [word, color] = band(value);
  return `<div class="score"><div class="lbl">${esc(label)}</div><div class="big" style="color:${color}">${value ?? "–"}</div><div class="sub">${esc(word)}${sub ? " · " + esc(sub) : ""}</div></div>`;
}

export function buildReport(auditId) {
  const a = get("SELECT * FROM audits WHERE id=?", auditId);
  if (!a || a.status !== "done") throw Object.assign(new Error("Audit not finished"), { status: 400 });
  const p = get("SELECT * FROM projects WHERE id=?", a.project_id);
  const prev = get("SELECT * FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", p.id, a.id);
  const info = JSON.parse(a.site_info || "{}");
  const base = p.start_url;
  const groups = all("SELECT check_id, severity, COUNT(*) n, COUNT(DISTINCT url) pages FROM issues WHERE audit_id=? GROUP BY check_id ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, n DESC", a.id);
  const pri = priorities(a.id, 10);
  const cwv = cwvRows(a.id).filter((r) => !r.error);
  const avg = (k) => (cwv.length ? Math.round(cwv.reduce((t, r) => t + (r[k] || 0), 0) / cwv.length) : null);
  const g = gscSummary(p.id), kw = keywordsData(p.id), bl = backlinksData(p.id), vis = visibilityData(p.id);
  const d = (k) => (prev ? a[k] - prev[k] : null);
  const delta = (v, invert) => (v === null || v === 0 ? "" : `<span class="${(invert ? v < 0 : v > 0) ? "up" : "down"}">${v > 0 ? "+" : ""}${v}</span>`);
  const when = new Date(a.finished_at + "Z").toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short" });

  const issueRows = groups.map((r) => {
    const [sev, title, why, fix] = CHECKS[r.check_id] || [r.severity, r.check_id, "", ""];
    const urls = all("SELECT url, detail FROM issues WHERE audit_id=? AND check_id=? ORDER BY url LIMIT 8", a.id, r.check_id);
    return `<tr><td><span class="dot ${sev}"></span>${esc(sev)}</td><td><b>${esc(title)}</b><div class="why">${esc(why)} <i>Fix:</i> ${esc(fix)}</div>
      <div class="urls">${urls.map((u) => esc(short(u.url, base)) + (u.detail ? ` <span class="muted">(${esc(String(u.detail).slice(0, 90))})</span>` : "")).join("<br>")}${r.n > urls.length ? `<br><span class="muted">… and ${r.n - urls.length} more</span>` : ""}</div></td>
      <td class="num">${n(r.n)}</td></tr>`;
  }).join("");

  const sections = [];
  sections.push(`<h2>What to fix first</h2><p class="muted">Ranked by severity, number of pages and how much Google search traffic those pages get.</p>
    <ol class="pri">${pri.map((r) => `<li><b>${esc(r.title)}</b> — ${n(r.pages)} page${r.pages > 1 ? "s" : ""}${r.impressions ? `, ${n(r.impressions)} impressions/28 days` : ""}<br><span class="muted">${esc(r.fix)}</span></li>`).join("")}</ol>`);
  sections.push(`<h2>All issues</h2><table><thead><tr><th>Type</th><th>Issue, why it matters and affected URLs</th><th class="num">Count</th></tr></thead><tbody>${issueRows || `<tr><td colspan="3">No issues found.</td></tr>`}</tbody></table>`);
  if (cwv.length) sections.push(`<h2>Performance (Lighthouse, mobile lab test)</h2><div class="scores">${score("Performance", avg("perf"))}${score("Accessibility", avg("a11y"))}${score("Best practices", avg("bp"))}${score("SEO", avg("seo"))}</div>
    <table><thead><tr><th>Page</th><th class="num">Perf</th><th class="num">LCP</th><th class="num">CLS</th><th class="num">TBT</th><th class="num">Weight</th></tr></thead><tbody>${cwv.map((r) => `<tr><td>${esc(short(r.url, base))}</td><td class="num">${r.perf ?? "–"}</td><td class="num">${(r.lcp_ms / 1000).toFixed(1)} s</td><td class="num">${r.cls}</td><td class="num">${n(r.tbt_ms)} ms</td><td class="num">${n(r.transfer_kb)} KB</td></tr>`).join("")}</tbody></table>`);
  if (g.connected) sections.push(`<h2>Google Search (${esc(g.startDate)} to ${esc(g.endDate)})</h2><div class="kpis"><div><b>${n(g.totals.clicks)}</b>clicks</div><div><b>${n(g.totals.impressions)}</b>impressions</div><div><b>${((g.totals.ctr || 0) * 100).toFixed(2)}%</b>CTR</div><div><b>${g.totals.position?.toFixed(1) ?? "–"}</b>avg position</div><div><b>${n(g.keywords)}</b>keywords</div><div><b>${n(g.top10)}</b>in top 10</div></div>
    ${g.quickWins.length ? `<h3>Quick wins (position 4–20 with impressions)</h3><table><thead><tr><th>Query</th><th>Page</th><th class="num">Impr.</th><th class="num">Pos.</th></tr></thead><tbody>${g.quickWins.slice(0, 12).map((q) => `<tr><td>${esc(q.query)}</td><td>${esc(short(q.page, base))}</td><td class="num">${n(q.impressions)}</td><td class="num">${q.position.toFixed(1)}</td></tr>`).join("")}</tbody></table>` : ""}
    ${g.cannibal.length ? `<h3>Pages competing for the same query</h3><table><thead><tr><th>Query</th><th class="num">Pages</th><th class="num">Impr.</th></tr></thead><tbody>${g.cannibal.slice(0, 10).map((c) => `<tr><td>${esc(c.query)}</td><td class="num">${c.pages}</td><td class="num">${n(c.impressions)}</td></tr>`).join("")}</tbody></table>` : ""}`);
  if (kw.last) { const s = kw.snapshots.at(-1); sections.push(`<h2>Organic keywords (DataForSEO, ${esc(new Date(s.fetched_at + "Z").toLocaleDateString("en-AU"))})</h2><div class="kpis"><div><b>${n(s.total)}</b>ranked keywords</div><div><b>${n(s.top3)}</b>top 3</div><div><b>${n(s.top10)}</b>top 10</div><div><b>${n(Math.round(s.etv || 0))}</b>est. visits/month</div></div>`); }
  if (bl.last) sections.push(`<h2>Backlinks (DataForSEO)</h2><div class="kpis"><div><b>${n(bl.last.backlinks)}</b>backlinks</div><div><b>${n(bl.last.ref_domains)}</b>referring domains</div><div><b>${n(bl.last.spam_score)}</b>spam score</div><div><b>${n(bl.spam.flagged.length)}</b>spam domains</div></div>
    ${bl.spam.flagged.length ? `<p>${n(bl.spam.flagged.length)} referring domains look like spam (${Math.round(bl.spam.anchorShare * 100)}% of links use link-seller anchors). Google ignores most such links; a disavow file is available in the app if needed.</p>` : ""}`);
  if (vis.last) {
    const rate = (r, k) => { const base2 = r.platform === "google" ? r.present || 0 : r.n - r.errors; return base2 ? `${r[k] || 0}/${base2}` : "–"; };
    sections.push(`<h2>AI visibility (${esc(new Date(vis.last.started_at + "Z").toLocaleDateString("en-AU"))}, ${n(vis.last.prompts)} prompts)</h2>
    <table><thead><tr><th>Platform</th><th class="num">Mentioned</th><th class="num">Cited</th></tr></thead><tbody>${vis.last.rates.map((r) => `<tr><td>${esc(vis.platforms[r.platform]?.label || r.platform)}</td><td class="num">${rate(r, "mentioned")}</td><td class="num">${rate(r, "cited")}</td></tr>`).join("")}</tbody></table>
    <h3>Sites AI cites most</h3><p>${vis.shareOfVoice.slice(0, 10).map((s) => esc(s.domain) + (s.own ? " (you)" : "") + ` ${Math.round(s.share * 100)}%`).join(" · ") || "None"}</p>`);
  }
  const bots = (info.aiBots || []).filter((b) => !b.allowed).map((b) => b.bot);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SEO report — ${esc(p.name)}</title>
<style>
body{font:14px/1.5 system-ui,"Segoe UI",Roboto,sans-serif;color:#0b0b0b;max-width:980px;margin:0 auto;padding:28px 22px;background:#fff}
h1{font-size:24px;margin:0} h2{font-size:18px;margin:30px 0 8px;padding-top:10px;border-top:1px solid #e2e1dc} h3{font-size:14px;margin:16px 0 6px}
.muted{color:#6b6a65}.sub{color:#52514e;font-size:12.5px}.up{color:#006300}.down{color:#b42323}
.scores{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:14px 0}.score{border:1px solid #e2e1dc;border-radius:10px;padding:12px}
.score .lbl{font-size:12.5px;color:#52514e}.score .big{font-size:32px;font-weight:700}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}.kpis div{border:1px solid #e2e1dc;border-radius:10px;padding:8px 12px;font-size:12.5px;color:#52514e}.kpis b{display:block;font-size:20px;color:#0b0b0b}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:6px 0}th{text-align:left;color:#52514e;border-bottom:1px solid #d6d5cf;padding:6px}td{border-bottom:1px solid #eeede8;padding:6px;vertical-align:top}
.num{text-align:right;white-space:nowrap}.why{color:#52514e;margin-top:2px}.urls{font-size:12px;margin-top:4px;word-break:break-all}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.dot.error{background:#d03b3b}.dot.warning{background:#fab219}.dot.notice{background:#2a78d6}
.pri li{margin-bottom:8px}.foot{margin-top:40px;color:#6b6a65;font-size:12px}
@media print{body{padding:0}h2{break-after:avoid}tr,li,.score{break-inside:avoid}}
@media (max-width:640px){.scores{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<h1>SEO report — ${esc(p.name)}</h1>
<p class="muted">${esc(base)} · audit finished ${esc(when)} · ${n(a.pages_crawled)} pages crawled${prev ? ` · compared with ${esc(new Date(prev.finished_at + "Z").toLocaleDateString("en-AU"))}` : ""}</p>
<div class="scores">${score("Site Health", a.health, prev ? `${a.health - prev.health >= 0 ? "+" : ""}${a.health - prev.health} vs last` : null)}${score("AI Readiness", a.ai_readiness)}
<div class="score"><div class="lbl">Errors / warnings</div><div class="big">${n(a.errors)} <span style="font-size:20px;color:#52514e">/ ${n(a.warnings)}</span></div><div class="sub">errors ${delta(d("errors"), true) || "±0"} · warnings ${delta(d("warnings"), true) || "±0"}</div></div>
<div class="score"><div class="lbl">Notices</div><div class="big">${n(a.notices)}</div><div class="sub">for information</div></div></div>
<p class="sub">Site Health = 100 × (1 − (pages with errors + ½ × pages with only warnings) ÷ pages crawled). robots.txt ${info.robotsTxt ? "found" : "missing"} · sitemap ${info.sitemapUrls ? n(info.sitemapUrls) + " URLs" : "missing"} · ${bots.length ? "AI crawlers blocked: " + esc(bots.join(", ")) : "all major AI crawlers allowed"}.</p>
${sections.join("\n")}
<p class="foot">Generated by SEO Auditor on ${esc(new Date().toLocaleString("en-AU"))}. Lab and third-party figures (Lighthouse, DataForSEO) are estimates; Search Console figures are Google's own data.</p>
</body></html>`;
}

export async function reportPdf(auditId) {
  const html = buildReport(auditId);
  const { launchChromium } = await import("./browser.mjs");
  const browser = await launchChromium({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" }, printBackground: true,
      displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#888"><span class="pageNumber"></span> / <span class="totalPages"></span></div>` });
  } finally { await browser.close().catch(() => {}); }
}

export function register({ routes }) {
  routes.push(["GET", /^\/api\/audits\/(\d+)\/report\.html$/, ([id]) => ({ __raw: true, body: buildReport(Number(id)), type: "text/html; charset=utf-8",
    headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } })]);
  routes.push(["GET", /^\/api\/audits\/(\d+)\/report\.pdf$/, async ([id]) => {
    const a = get("SELECT a.id, p.name FROM audits a JOIN projects p ON p.id=a.project_id WHERE a.id=?", Number(id));
    const pdf = await reportPdf(Number(id));
    const name = String(a?.name || "site").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    return { __raw: true, body: pdf, type: "application/pdf", headers: { "Content-Disposition": `attachment; filename="seo-report-${name}-${id}.pdf"` } };
  }]);
}
