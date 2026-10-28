// Which pages get JavaScript-rendered (REQ-055 group 2, Oct 2026). Setting renderJs: false (raw HTML only), true
// (every page), or "auto":
//   1. Sample: the home page and the first pages fetched (5 in all) are rendered, and their raw HTML is compared with
//      the rendered page. A sampled page depends on JavaScript when rendering at least doubles its main text (to 50+
//      words) or its internal links (to 5+).
//   2. When at least half of the sampled pages that rendered depend on JavaScript, the site does: every page is
//      rendered. Otherwise only pages whose raw HTML looks JavaScript-dependent are (jsDependentReason): an empty app
//      root (<div id="root"></div>, id="app", "__next", "__nuxt", "___gatsby", <app-root>), a "please enable JavaScript"
//      <noscript> on a page under 300 words, or under 50 words with a large script payload.
// The decision is recorded on the audit (site_info.render) and why each page was rendered on the page (renderReason).
// Rendering runs at most renderConcurrency pages at a time in the crawl's one shared browser.

export const SAMPLE = 5;
export const RENDER_UAS = ["audit", "googlebot"]; // renderUserAgent: the audit's own user agent, or Googlebot smartphone (opt-in)

/** renderJs as stored (true/false/"auto", or "true"/"false" from a form) → false | "auto" | true. */
export const renderModeOf = (v) => (v === true || v === "true" ? true : v === "auto" ? "auto" : false);

const APP_ROOT = /<(div|main|section|span)\b[^>]*\bid\s*=\s*["']?(root|app|__next|__nuxt|___gatsby|svelte|q-app)\b["']?[^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<\/\1>|<app-root\b[^>]*>\s*<\/app-root>/i;
const ENABLE_JS = /(?:enable|turn on|activate|allow)\s+javascript|javascript\s+(?:is\s+)?(?:required|disabled|needs to be (?:enabled|turned on)|must be enabled)|requires\s+javascript/i;

/** Why a page's raw HTML looks like it needs JavaScript to show its content, or null. raw: its parseHtml result. */
export function jsDependentReason(html, raw = {}) {
  html = String(html || "");
  const words = raw.words ?? 0;
  const root = APP_ROOT.exec(html);
  if (root && words < 300) return `empty app root (${root[2] ? `#${root[2]}` : "<app-root>"})`;
  for (const m of html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi))
    if (words < 300 && ENABLE_JS.test(m[1].replace(/<[^>]+>/g, " "))) return "asks to enable JavaScript (<noscript>)";
  if (words < 50) {
    let inline = 0, external = 0;
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(m[1])) external++;
      else if (!/application\/(?:ld\+)?json|text\/template/i.test(m[1])) inline += m[2].length;
    }
    if (inline >= 20_000 || external >= 3) return `${words} words with ${external} script file(s) and ${Math.round(inline / 1024)} KB of inline script`;
  }
  return null;
}

/** Does a sampled page depend on JavaScript? raw/ren: parseHtml of the raw HTML and of the rendered DOM; inScope(url):
 *  the site's own hosts. Returns the reason or null. */
export function sampleNeedsJs(raw, ren, inScope = () => true) {
  const own = (p) => new Set((p.links || []).filter((l) => inScope(l.to)).map((l) => l.to)).size;
  const [rl, nl] = [own(raw), own(ren)];
  if (ren.words >= 50 && raw.words * 2 <= ren.words) return `${raw.words} words in raw HTML, ${ren.words} rendered`;
  if (nl >= 5 && rl * 2 <= nl) return `${rl} internal links in raw HTML, ${nl} rendered`;
  return null;
}

/** At most n calls of fn at a time. */
export function limiter(n) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= n) await new Promise((r) => waiting.push(r)); else active++;
    try { return await fn(); } finally { const w = waiting.shift(); if (w) w(); else active--; }
  };
}

/** One audit's rendering plan. mode: false | "auto" | true; concurrency: renders at a time; decided: a decision kept
 *  from an earlier run of the same audit (resume). render({ url, home, html, raw, parse, inScope, run }) → { rendered,
 *  reason }: run() renders the page (renderPage), parse(html, url) is parseHtml. summary() → site_info.render. */
export function createRenderPlan({ mode = false, concurrency = 3, sample = SAMPLE, decided = null } = {}) {
  mode = renderModeOf(mode);
  const slot = limiter(Math.max(1, concurrency));
  const samples = [];
  let assigned = 0, decision = mode === "auto" ? decided?.decision || null : null, rendered = 0, release, unavailable = null;
  const ready = new Promise((r) => { release = r; });
  if (decision) release();
  const decide = () => {
    if (decision) return;
    const ok = samples.filter((s) => !s.failed), dep = ok.filter((s) => s.reason);
    decision = ok.length && dep.length >= Math.ceil(ok.length / 2) ? "all" : "selected";
    release();
  };
  const report = (s) => { samples.push(s); if (samples.length >= assigned && assigned >= sample) decide(); };

  async function render({ url, home = false, html, raw, parse, inScope = () => true, run }) {
    if (!mode || unavailable) return { rendered: null, reason: null };
    let reason = mode === true ? "always" : null, isSample = false;
    if (mode === "auto") {
      if (!decision && (assigned < sample || home)) { isSample = true; assigned++; reason = home ? "sample (home page)" : "sample"; }
      else {
        await ready;
        reason = decision === "all" ? "site depends on JavaScript" : jsDependentReason(html, raw);
        if (!reason) return { rendered: null, reason: null };
      }
    }
    let out = null;
    try {
      out = await slot(run);
      if (out) rendered++;
      return { rendered: out, reason };
    } finally {
      if (isSample) {
        let why = null;
        try { why = out?.html ? sampleNeedsJs(raw, parse(out.html, url), inScope) : null; } catch { /* unreadable render: not counted */ }
        report({ url, failed: !out?.html, reason: why });
      }
    }
  }
  return {
    render,
    /** The browser couldn't start: nothing is rendered (auto mode carries on with raw HTML). */
    unavailable(msg) { unavailable = String(msg || "no browser").split("\n")[0].slice(0, 160); decision ||= "unavailable"; release(); },
    /** The crawl ended before enough pages were sampled: decide on what was seen. */
    finish: () => decide(),
    summary: () => mode === "auto" && decided && !samples.length
      ? { ...decided, mode, decision, rendered: (decided.rendered || 0) + rendered } // resumed: the first run's sample stands
      : mode === "auto"
      ? { mode, decision, sampled: samples.filter((s) => !s.failed).length, dependent: samples.filter((s) => s.reason).length, rendered, ...(unavailable ? { error: unavailable } : {}),
        samples: samples.slice(0, 10).map((s) => ({ url: s.url, reason: s.failed ? "render failed" : s.reason })) }
      : { mode, rendered, ...(unavailable ? { error: unavailable } : {}) },
  };
}
