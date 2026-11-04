// Answer layout (2026-11-04): is each question heading answered straight away, and does a long page use lists or
// tables anywhere? Both feed experimental AI-readiness notices (ai-checks.mjs). Google says no special optimisation
// is needed for AI Overviews/AI Mode; these only flag layouts that make a clear answer harder to find and quote.

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const wordCount = (s) => (s ? s.split(" ").length : 0);
// Leaf text blocks in reading order. <summary> is left out: an FAQ accordion's <h3> inside it is found directly.
const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,dd,td";
export const LATE_WORDS = 40; // a first sentence longer than this is a lead-in, not an answer

/** $: cheerio root, $c: the page's content (main or body), chrome(el): true for menus, header, footer, sidebars.
 *  Returns { qAnswered, qLate, qLateExample, formats }. */
export function answerLayout($, $c, chrome = () => false) {
  const leaf = $c.find(BLOCKS).toArray().filter((e) => !chrome(e) && !$(e).find(BLOCKS).length);
  let answered = 0, late = 0, example = "";
  for (let i = 0; i < leaf.length; i++) {
    const e = leaf[i];
    if (!/^h[23]$/.test(e.name)) continue;
    const q = clean($(e).text());
    if (!/\?$/.test(q)) continue;
    // A list or table straight under the heading is itself the answer (steps, options, a comparison).
    if (/^(li|td|dd)$/.test(leaf[i + 1]?.name || "")) { answered++; continue; }
    let text = "";
    for (let j = i + 1; j < leaf.length && !/^h[1-6]$/.test(leaf[j].name); j++) {
      if (/^(li|td|dd)$/.test(leaf[j].name)) break; // "It depends on the road:" + a table: the lead-in ends here
      text = clean(`${text} ${$(leaf[j]).text()}`);
      if (wordCount(text) > 120) break;
    }
    // "Yes." or "A few days to a few weeks." is an answer; only a missing answer or a long lead-in is late.
    const n = wordCount(clean(text.split(/(?<=[.!?:])\s+/)[0]));
    if (n && n <= LATE_WORDS) { answered++; continue; }
    late++;
    example ||= `"${q.slice(0, 80)}" (${n ? `first sentence is ${n} words` : "no answer text before the next heading"})`;
  }
  // Lists and tables that carry content: not menus, and not lists that are only links.
  let formats = $c.find("ul,ol,table").toArray().filter((e) => {
    if (chrome(e) || $(e).closest("nav").length || $(e).find("li,tr").length < 2) return false;
    return clean($(e).text()).length > clean($(e).find("a").text()).length + 20;
  }).length;
  // Steps laid out as numbered headings ("1. At the scene", "Step 2: …") or numbered cards ("01", "02" over each
  // card) are a list in all but markup; count each such run of 3+ as one format.
  const heads = $c.find("h2,h3,h4").toArray().filter((e) => !chrome(e)).map((e) => clean($(e).text()));
  if (heads.filter((t) => /^(step\s*)?\d{1,2}\s*[.):-]\s+\S/i.test(t)).length >= 3) formats++;
  if (leaf.filter((e) => /^0?\d{1,2}$/.test(clean($(e).text()))).length >= 3) formats++;
  return { qAnswered: answered, qLate: late, qLateExample: example, formats };
}
