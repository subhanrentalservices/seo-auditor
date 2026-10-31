// Extra page checks (group 7): security headers, accessibility from the DOM, a readability score, and the definitions
// of the Core Web Vitals issues cwv-issues.mjs raises. Security, accessibility and readability aren't Google ranking
// factors: those issues are notices (they don't count toward Site Health) and readability is information only.
// Import-free on purpose: checks.mjs and crawler.mjs both import it.

export const EXTRA_CHECKS = {
  sec_no_hsts: ["notice", "No HSTS header on an HTTPS page (security, information: not a Google ranking factor)", "Strict-Transport-Security tells browsers to use HTTPS for the site from then on, so a visitor who types http:// or follows an old link can't be intercepted before the redirect (MDN; OWASP Secure Headers). Google's HTTPS ranking boost depends on serving HTTPS, not on this header.", "Send Strict-Transport-Security: max-age=31536000 (add includeSubDomains only when every subdomain serves HTTPS) from the server or CDN for HTTPS responses."],
  sec_no_nosniff: ["notice", "No X-Content-Type-Options: nosniff (security, information: not a Google ranking factor)", "Without nosniff a browser may guess (sniff) a file's type and run an uploaded or mislabelled file as script or style (MDN; OWASP Secure Headers). Not used by Google Search.", "Send X-Content-Type-Options: nosniff on every response, and make sure each file is served with its correct Content-Type."],
  sec_no_frame_protection: ["notice", "No clickjacking protection (security, information: not a Google ranking factor)", "Neither a Content-Security-Policy frame-ancestors directive nor X-Frame-Options DENY / SAMEORIGIN is sent, so another site can load this page in a hidden frame and trick visitors into clicking it (clickjacking; MDN, OWASP). frame-ancestors only works as an HTTP header, not in a <meta> tag. Not used by Google Search.", "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: SAMEORIGIN). List any partner that genuinely needs to embed the page."],
  sec_no_referrer_policy: ["notice", "No Referrer-Policy (security, information: not a Google ranking factor)", "Neither a Referrer-Policy header nor <meta name=\"referrer\"> is set. Current browsers then default to strict-origin-when-cross-origin, which already sends only the site's address (not the full URL) to other sites, so this matters mainly for older browsers or URLs that carry private data (MDN). Not used by Google Search.", "Optional: send Referrer-Policy: strict-origin-when-cross-origin to make the default explicit for every browser."],
  a11y_form_label: ["notice", "Form fields without a label (accessibility, not a Google ranking factor)", "A screen reader announces a field by its accessible name; a field with no <label>, aria-label, aria-labelledby, title or placeholder is read out only as \"edit text\", so blind visitors can't tell what to type (WCAG 2 success criteria 1.3.1 and 4.1.2; axe rule label). Lost form fills are lost enquiries.", "Give each field a visible <label for=\"id\">, or wrap it in a <label>; use aria-label only when a visible label is impossible. A placeholder alone disappears while typing."],
  a11y_empty_button: ["notice", "Buttons without an accessible name (accessibility, not a Google ranking factor)", "The button has no text, no aria-label or aria-labelledby, no title and no image with alt text, so screen readers announce just \"button\" (WCAG 2 success criterion 4.1.2; axe rule button-name). Icon-only buttons (menu, close, search) are the usual cause.", "Add visible text, or an aria-label that says what the button does (e.g. aria-label=\"Open menu\"); for <input type=\"image\"> add alt text."],
  a11y_lang_invalid: ["notice", "html lang value isn't a valid language code (accessibility, not a Google ranking factor)", "The lang attribute should be a BCP 47 language tag such as en, en-AU or pt-BR; a value like \"english\" or \"en_US\" isn't one, so screen readers may read the page with the wrong voice and browsers may offer the wrong translation (WCAG 2 success criterion 3.1.1). Google doesn't use the lang attribute to detect a page's language: it reads the visible text (Google's multilingual sites doc).", "Use a valid code, e.g. <html lang=\"en-AU\">: a language subtag, optionally a region, joined by a hyphen."],
};

/** Compact security-relevant response headers for one page (stored as d.secHeaders). `headers` is a fetch Headers. */
export function securityHeaders(headers, url = "") {
  const g = (n) => (headers?.get?.(n) || "").trim();
  const csp = g("content-security-policy");
  const fa = csp.split(/[;,]/).map((x) => x.trim()).find((x) => /^frame-ancestors\b/i.test(x)) || "";
  const out = { https: /^https:/i.test(url) };
  if (g("strict-transport-security")) out.hsts = g("strict-transport-security").slice(0, 120);
  if (g("x-content-type-options")) out.nosniff = /\bnosniff\b/i.test(g("x-content-type-options"));
  if (g("x-frame-options")) out.xfo = g("x-frame-options").slice(0, 60);
  if (fa) out.frameAncestors = fa.slice(0, 160);
  if (g("referrer-policy")) out.referrer = g("referrer-policy").slice(0, 80);
  return out;
}

const hstsOn = (v) => { const m = /max-age\s*=\s*"?(\d+)/i.exec(v || ""); return Boolean(m && +m[1] > 0); };
/** The language-tag shape from BCP 47 (2–3 letter language, optional extlang/script/region/variants/extensions), plus
 *  x- private and i- legacy tags. The unused 5–8 letter language subtags are left out, so "english" is invalid. */
export const validLang = (v) => /^[a-z]{2,3}(?:-[a-z]{3}){0,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[a-wyz\d](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$|^(?:x|i)(?:-[a-z\d]{1,8})+$/i.test(v);

/** Short description of an element for an issue detail: tag, type and the first of id / name / class. */
function describe($, el) {
  const a = (n) => $(el).attr(n);
  const tag = el.tagName || el.name;
  const id = a("id") ? `#${a("id")}` : a("name") ? `[name=${a("name")}]` : a("class") ? `.${String(a("class")).trim().split(/\s+/)[0]}` : "";
  return `<${tag}${a("type") ? ` type=${a("type")}` : ""}>${id}`.slice(0, 80);
}

const hidden = ($, el) => $(el).closest('[hidden],[aria-hidden="true"],template,noscript').length > 0 || /display\s*:\s*none/i.test($(el).attr("style") || "");
const filled = (v) => Boolean(v && String(v).trim());

/** Accessibility and readability facts from the parsed page ($ = cheerio). Returns only keys that have something. */
export function domFacts($, { text = "", lang = "" } = {}) {
  const d = {};
  const named = (el) => ["aria-label", "title"].some((n) => filled($(el).attr(n)))
    || ($(el).attr("aria-labelledby") || "").trim().split(/\s+/).some((id) => id && filled($(`[id="${id}"]`).text()));
  // Form fields: the names axe's "label" rule accepts (label[for], a wrapping label, aria-*, title, placeholder).
  const unlabelled = $("input, select, textarea").toArray().filter((el) => {
    const type = ($(el).attr("type") || "text").toLowerCase();
    if (el.tagName === "input" && ["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
    if (hidden($, el)) return false;
    const id = $(el).attr("id");
    if (id && $("label").toArray().some((l) => $(l).attr("for") === id && filled($(l).text()))) return false;
    if ($(el).closest("label").length && filled($(el).closest("label").text())) return false;
    return !named(el) && !filled($(el).attr("placeholder"));
  });
  if (unlabelled.length) { d.formNoLabel = unlabelled.length; d.formNoLabelExample = describe($, unlabelled[0]); }
  // Buttons: text (with image alt and SVG titles), aria-*, title; input buttons by value / alt.
  const empty = $('button, [role="button"], input[type="button" i], input[type="image" i]').toArray().filter((el) => {
    if (hidden($, el) || named(el)) return false;
    if (el.tagName === "input") return ($(el).attr("type") || "").toLowerCase() === "image" ? !filled($(el).attr("alt")) : !filled($(el).attr("value"));
    const alts = $(el).find("img[alt]").map((_, i) => $(i).attr("alt")).get().join(" ");
    return !filled($(el).text()) && !filled(alts) && !filled($(el).find("svg title").text());
  });
  if (empty.length) { d.emptyButtons = empty.length; d.emptyButtonExample = describe($, empty[0]); }
  if (lang && !validLang(lang.trim())) d.langInvalid = lang.slice(0, 40);
  const ref = $('meta[name="referrer" i]').attr("content");
  if (filled(ref)) d.metaReferrer = ref.trim().slice(0, 60);
  const r = readability(text, lang);
  if (r) d.readability = r;
  return d;
}

/** Syllables in one English word: vowel groups, minus a silent final e, at least 1 (heuristic). */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  // Silent endings: "jumped" (not "created"), "make" (not "table").
  const stem = /[^aeiouytd]ed$/.test(w) ? w.slice(0, -2) : /[^aeiouyl]e$/.test(w) ? w.slice(0, -1) : w;
  const groups = stem.replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch Reading Ease and Flesch-Kincaid grade for English text of 100+ words, or null. Information only: Google has no
 *  readability score; the formula was made for English prose and sentence splits on headings and lists are rough. */
export function readability(text, lang = "") {
  if (lang && !/^en\b/i.test(lang.trim())) return null;
  const words = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []);
  if (words.length < 100) return null;
  const sentences = Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) || []).length);
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const wps = words.length / sentences, spw = syl / words.length;
  const score = Math.round(Math.max(0, Math.min(100, 206.835 - 1.015 * wps - 84.6 * spw)));
  const grade = Math.max(0, +(0.39 * wps + 11.8 * spw - 15.59).toFixed(1));
  return { score, grade, words: words.length };
}

/** Issues from the facts above for one HTML 200 page: [[checkId, detail], ...]. Old audits have no secHeaders: nothing. */
export function extraPageIssues(d) {
  const out = [];
  const s = d.secHeaders;
  if (s) {
    if (s.https && !hstsOn(s.hsts)) out.push(["sec_no_hsts", s.hsts ? `Strict-Transport-Security: ${s.hsts} (max-age 0 switches HSTS off)` : "no Strict-Transport-Security header"]);
    if (!s.nosniff) out.push(["sec_no_nosniff", "no X-Content-Type-Options: nosniff header"]);
    const xfoOk = /^(deny|sameorigin)$/i.test(s.xfo || "");
    if (!s.frameAncestors && !xfoOk) out.push(["sec_no_frame_protection", s.xfo ? `X-Frame-Options: ${s.xfo} (only DENY or SAMEORIGIN are supported), no CSP frame-ancestors` : "no CSP frame-ancestors, no X-Frame-Options"]);
    if (!s.referrer && !d.metaReferrer) out.push(["sec_no_referrer_policy", "no Referrer-Policy header or <meta name=\"referrer\">: browsers use strict-origin-when-cross-origin"]);
  }
  if (d.formNoLabel) out.push(["a11y_form_label", `${d.formNoLabel} field(s), e.g. ${d.formNoLabelExample}`]);
  if (d.emptyButtons) out.push(["a11y_empty_button", `${d.emptyButtons} button(s), e.g. ${d.emptyButtonExample}`]);
  if (d.langInvalid) out.push(["a11y_lang_invalid", `lang="${d.langInvalid}"`]);
  return out;
}

// Core Web Vitals problems (cwv-issues.mjs raises them after Lighthouse and CrUX): field data first, lab as fallback.
const CWV_WHY = "Core Web Vitals are used by Google's ranking systems as part of page experience, but good scores don't guarantee good rankings: helpful, relevant content matters more (Google Search Central, \"Understanding Core Web Vitals and Google search results\"). Google judges the 75th percentile of real Chrome users' visits (CrUX field data); when a page has too few visitors for field data, the detail shows the Lighthouse lab value instead, an estimate from one simulated phone visit.";
const CWV_DEFS = {
  lcp: ["Largest Contentful Paint (LCP)", "how long the main content (the largest image or text block) takes to appear", "good at 2.5 s or less, poor above 4 s",
    "Make the largest element load sooner: serve that image at the right size in a modern format, don't lazy-load it, add fetchpriority=\"high\" or preload it, cut render-blocking CSS and JavaScript, and reduce the server response time. The Performance screen's page detail names the element."],
  inp: ["Interaction to Next Paint (INP)", "how quickly the page responds to taps, clicks and key presses", "good at 200 ms or less, poor above 500 ms",
    "Find the slow interactions (Chrome DevTools Performance panel): break up long JavaScript tasks, defer or remove heavy third-party scripts, and keep click handlers small. Lighthouse's Total Blocking Time and long-task list point to the same scripts."],
  cls: ["Cumulative Layout Shift (CLS)", "how much the page jumps around while it loads", "good at 0.1 or less, poor above 0.25",
    "Give images, videos, iframes and ad or embed slots a width and height (or aspect-ratio), don't insert banners or notices above content that has already appeared, and load web fonts with size-matched fallbacks."],
};
export const CWV_CHECKS = Object.fromEntries(Object.entries(CWV_DEFS).flatMap(([k, [name, what, limits, fix]]) => [
  [`cwv_${k}_poor`, ["warning", `${name} is poor (Core Web Vitals)`, `${name} measures ${what}; web.dev's thresholds: ${limits}. ${CWV_WHY}`, fix]],
  [`cwv_${k}_ni`, ["notice", `${name} needs improvement (Core Web Vitals)`, `${name} measures ${what}; web.dev's thresholds: ${limits}. ${CWV_WHY}`, fix]],
]));
