// cta_below_fold (REQ-044 build row 55, Oct 2026): on a phone-sized screen (412×823, the size Lighthouse's mobile
// run uses), the first call, email or call-to-action button on the home page and money pages sits below the first
// screen. A conversion and UX notice, not a Google ranking issue (Rio Ichikawa, "A discussion of UX for SEO", Search
// Off the Record 2024, anecdotal). Up to 6 pages, one at a time, in the browser the audit already uses for rendering
// or Lighthouse. measure() runs in the page; ctaFoldVerdict() is pure.
import { pageRoles } from "./conversion.mjs";
import { MOBILE_UA } from "./ua-parity.mjs";

// Button or link text that asks the visitor to act (any kind of site: book, buy, sign up, get a quote, start a trial...).
export const CTA = /^(?:[^\w]*)(book|call|ring|phone|contact|enquire|inquire|get (?:a |your |started|in touch|quote)|request|claim|apply|buy|order|shop|add to (?:cart|bag|basket)|checkout|sign ?up|register|join|subscribe|start|try|free trial|demo|schedule|download|install|quote)\b/i;
export const FOLD = { width: 412, height: 823 };

/** Runs in the page: the first visible tel:/mailto: link or CTA element. { found, top, sticky, text } — sticky when
 *  it (or a parent) is position fixed/sticky and on screen, as a sticky call bar is. */
export function measure(ctaSource) {
  const re = new RegExp(ctaSource, "i");
  const els = [...document.querySelectorAll('a[href^="tel:" i], a[href^="mailto:" i], a[href], button, input[type=submit]')]
    .filter((e) => /^(tel|mailto):/i.test(e.getAttribute("href") || "") || re.test((e.innerText || e.value || "").trim()));
  let best = null, found = 0;
  for (const e of els) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || !r.height || cs.visibility === "hidden" || +cs.opacity === 0) continue;
    found++;
    let sticky = false;
    for (let x = e; x && x !== document.body; x = x.parentElement) if (/fixed|sticky/.test(getComputedStyle(x).position)) { sticky = true; break; }
    const top = r.top + window.scrollY;
    if (sticky && r.top < innerHeight && r.bottom > 0) return { found, top: r.top, sticky: true, text: (e.innerText || e.value || e.getAttribute("href") || "").trim().slice(0, 60) };
    if (!best || top < best.top) best = { top, text: (e.innerText || e.value || e.getAttribute("href") || "").trim().slice(0, 60) };
  }
  return { found, top: best ? best.top : null, sticky: false, text: best?.text || "" };
}

/** Detail for cta_below_fold, or null: the page has a CTA, none is sticky on screen, and the first starts below the
 *  first screen. */
export function ctaFoldVerdict(m, height = FOLD.height) {
  if (!m || !m.found || m.sticky || m.top === null || m.top <= height) return null;
  return `first call/email/CTA ("${m.text}") starts ${Math.round(m.top)} px down; a ${FOLD.width}×${height} phone screen shows ${height} px`;
}

/** Home page plus the best-linked money pages that have a phone/email link or CTA (from the crawl data). */
export function foldTargets(pages, start, max = 6) {
  const role = pageRoles(pages, start);
  const live = pages.filter((p) => p.status === 200 && p.indexable && (p.content_type || "").includes("html") && !p.data?.variantOf
    && (p.data?.convTel || p.data?.convMail || p.data?.convCta));
  const home = live.filter((p) => role(p.url) === "home");
  const money = live.filter((p) => role(p.url) === "money").sort((a, b) => (b.inlinks || 0) - (a.inlinks || 0));
  return [...home.slice(0, 1), ...money].slice(0, max);
}

/** [[id, url, detail]] for cta_below_fold. browser: a Playwright browser (null → nothing is checked). */
export async function ctaFoldIssues({ pages, start, browser, max = 6, stop = () => false }) {
  if (!browser) return [];
  const out = [];
  for (const p of foldTargets(pages, start, max)) {
    if (stop()) break;
    const ctx = await browser.newContext({ viewport: FOLD, isMobile: true, hasTouch: true, deviceScaleFactor: 1.75, userAgent: MOBILE_UA });
    try {
      const page = await ctx.newPage();
      await page.goto(p.final_url || p.url, { waitUntil: "load", timeout: 30000 });
      const why = ctaFoldVerdict(await page.evaluate(measure, CTA.source));
      if (why) out.push(["cta_below_fold", p.url, why]);
    } catch { /* page didn't load in time: not checked */ } finally { await ctx.close().catch(() => {}); }
  }
  return out;
}
