// Custom extraction (REQ-055 group 3, Nov 2026), like Screaming Frog's: per project up to 20 rules (setting
// `extract`), each pulling one value out of every crawled HTML page into data.extract[name]. The values show as
// columns in the Pages table, filter and sort it, and go into the pages CSV and the JSONL export.
//   css:   a CSS selector, read with the crawler's own HTML parser (cheerio) on the page as crawled (the rendered DOM
//          when JavaScript rendering is on): text (up to 10 matches joined with " | "), html (first match's inner
//          HTML), attr (an attribute of up to 10 matches) or count (number of matches);
//   regex: a JavaScript regular expression on the raw HTML the server sent; the value is the first match's first
//          group (or the whole match).
// Regular expressions are guarded against catastrophic backtracking three ways: patterns over 200 characters and
// nested quantifiers such as (a+)+ or (\w*)* are refused when the rule is saved; only the first 2 MB of a page (what
// Googlebot reads) is searched; and every search runs in a vm context with a 100 ms timeout. A rule that times out is
// skipped for the rest of the audit (data.extractErrors says so).
import vm from "node:vm";
import * as cheerio from "cheerio";

export const MAX_RULES = 20, MAX_PATTERN = 200, MAX_SELECTOR = 300, MAX_VALUE = 500, MAX_MATCHES = 10;
export const REGEX_INPUT = 2 * 1024 * 1024; // characters of raw HTML searched
export const REGEX_MS = 100;                 // time limit per search
export const OUTPUTS = ["text", "html", "attr", "count"];
export const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/; // also used in SQL JSON paths: no quotes or dots
const ATTR = /^[A-Za-z_:][-A-Za-z0-9_:.]{0,59}$/;
const FLAGS = /^[imsu]{0,4}$/;

const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

/** Why a pattern can backtrack catastrophically, or null: a quantified group whose body is itself quantified,
 *  e.g. (a+)+, (\w*)*, (?:x+y?){2,}. Character classes and escapes are skipped; ? and {0,1} don't count. */
export function nestedQuantifier(src) {
  const stack = [{ q: false }];
  const quantAt = (i) => {
    const c = src[i];
    if (c === "*" || c === "+") return 1;
    if (c === "{") { const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i)); if (m && (m[2] ? m[3] === "" || +m[3] > 1 : +m[1] > 1)) return m[0].length; }
    return 0;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; if (quantAt(i + 1)) stack.at(-1).q = true; continue; }
    if (c === "[") {
      i++;
      while (i < src.length && src[i] !== "]") { if (src[i] === "\\") i++; i++; }
      if (quantAt(i + 1)) stack.at(-1).q = true;
      continue;
    }
    if (c === "(") { stack.push({ q: false }); continue; }
    if (c === ")") {
      const g = stack.length > 1 ? stack.pop() : { q: false };
      if (quantAt(i + 1)) {
        if (g.q) return `nested quantifier near "${src.slice(Math.max(0, i - 20), i + 2)}"`;
        stack.at(-1).q = true;
      } else if (g.q) stack.at(-1).q = true;
      continue;
    }
    if (quantAt(i)) stack.at(-1).q = true;
  }
  return null;
}

/** Validates the rules from the settings screen. Returns [{ name, type, selector, output, attr } | { name, type,
 *  pattern, flags }]; throws a 400 error naming the first bad rule. */
export function cleanExtractRules(input) {
  if (input === undefined || input === null || input === "") return [];
  if (!Array.isArray(input)) fail("Extraction rules must be a list");
  const rows = input.filter((r) => r && (String(r.name || "").trim() || String(r.selector || r.pattern || "").trim()));
  if (rows.length > MAX_RULES) fail(`At most ${MAX_RULES} extraction rules`);
  const out = [], names = new Set();
  for (const r of rows) {
    const name = String(r.name || "").trim();
    if (!RULE_NAME.test(name)) fail(`Extraction rule name "${name.slice(0, 40)}": use 1–40 letters, digits, spaces, - or _`);
    if (names.has(name.toLowerCase())) fail(`Two extraction rules are called "${name}"`);
    names.add(name.toLowerCase());
    if (r.type === "regex") {
      const pattern = String(r.pattern || ""), flags = String(r.flags || "");
      if (!pattern) fail(`Extraction rule "${name}": enter a regular expression`);
      if (pattern.length > MAX_PATTERN) fail(`Extraction rule "${name}": the pattern is over ${MAX_PATTERN} characters`);
      if (!FLAGS.test(flags) || new Set(flags).size !== flags.length) fail(`Extraction rule "${name}": flags may be i, m, s and u`);
      try { new RegExp(pattern, flags); } catch (e) { fail(`Extraction rule "${name}": ${e.message}`); }
      const risky = nestedQuantifier(pattern);
      if (risky) fail(`Extraction rule "${name}": ${risky} can make the search hang; rewrite it without a repeated group that repeats inside`);
      out.push({ name, type: "regex", pattern, flags });
    } else if (r.type === "css") {
      const selector = String(r.selector || "").trim(), output = OUTPUTS.includes(r.output) ? r.output : "text", attr = String(r.attr || "").trim();
      if (!selector) fail(`Extraction rule "${name}": enter a CSS selector`);
      if (selector.length > MAX_SELECTOR) fail(`Extraction rule "${name}": the selector is over ${MAX_SELECTOR} characters`);
      try { cheerio.load("<p></p>")(selector); } catch (e) { fail(`Extraction rule "${name}": invalid CSS selector (${String(e.message).slice(0, 80)})`); }
      if (output === "attr" && !ATTR.test(attr)) fail(`Extraction rule "${name}": enter the attribute to read, e.g. content or href`);
      out.push({ name, type: "css", selector, output, ...(output === "attr" ? { attr } : {}) });
    } else fail(`Extraction rule "${name}": type must be css or regex`);
  }
  return out;
}

const cap = (s) => { s = String(s ?? ""); return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE - 1) + "…" : s; };
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** One CSS rule on a loaded document. */
export function cssValue($, rule) {
  const found = $(rule.selector);
  if (rule.output === "count") return found.length;
  if (rule.output === "html") return cap((found.first().html() || "").trim());
  const vals = found.toArray().map((e) => squash(rule.output === "attr" ? $(e).attr(rule.attr) : $(e).text())).filter(Boolean).slice(0, MAX_MATCHES);
  return cap(vals.join(" | "));
}

/** The extractor for one audit: run(rawHtml, domHtml) → { extract, extractErrors? } ({} without rules).
 *  redact(text) hides the project's request header values in extracted values. timeoutMs: per regex search. */
export function createExtractor(rules = [], { redact = (s) => s, timeoutMs = REGEX_MS } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  const css = list.filter((r) => r.type === "css"), rx = list.filter((r) => r.type === "regex").map((r) => ({ ...r, re: new RegExp(r.pattern, r.flags) }));
  const ctx = vm.createContext(Object.create(null)), search = new vm.Script("re.lastIndex = 0; re.exec(input)");
  const disabled = new Map(); // name → why (a timeout skips the rule for the rest of the audit)
  const stats = { pages: 0, timeouts: 0 };
  return {
    run(rawHtml, domHtml = rawHtml) {
      if (!list.length) return {};
      stats.pages++;
      const extract = {}, errors = {};
      if (css.length) {
        let $ = null;
        try { $ = cheerio.load(String(domHtml || "")); } catch { /* unparseable: values stay empty */ }
        for (const r of css) {
          try { extract[r.name] = $ ? cssValue($, r) : r.output === "count" ? 0 : ""; } catch (e) { extract[r.name] = null; errors[r.name] = String(e.message).slice(0, 120); }
          if (typeof extract[r.name] === "string") extract[r.name] = redact(extract[r.name]);
        }
      }
      const input = String(rawHtml || "").slice(0, REGEX_INPUT);
      for (const r of rx) {
        if (disabled.has(r.name)) { extract[r.name] = null; errors[r.name] = disabled.get(r.name); continue; }
        ctx.re = r.re; ctx.input = input;
        try {
          const m = search.runInContext(ctx, { timeout: timeoutMs });
          extract[r.name] = m ? redact(cap((m[1] ?? m[0]).trim())) : "";
        } catch (e) {
          extract[r.name] = null;
          const why = e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ? `timed out after ${timeoutMs} ms; skipped for the rest of the audit` : String(e.message).slice(0, 120);
          if (e.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { stats.timeouts++; disabled.set(r.name, why); }
          errors[r.name] = why;
        } finally { ctx.input = ""; }
      }
      return Object.keys(errors).length ? { extract, extractErrors: errors } : { extract };
    },
    summary: () => (list.length ? { rules: list.length, ...stats, disabled: [...disabled.keys()] } : null),
  };
}
