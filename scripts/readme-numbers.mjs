// README numbers from the code (REQ-055 group 9): the check counts (CHECKS + AI checks, check-sources.mjs), the AI
// visibility price per prompt (visibility.mjs PLATFORMS) and the default monthly DataForSEO budget are written
// between the <!-- generated:numbers --> markers in README.md, so the README can't drift from the code.
//   node scripts/readme-numbers.mjs          rewrite the block
//   node scripts/readme-numbers.mjs --check  exit 1 when README.md is out of date (the tests run this check too)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const README = path.join(ROOT, "README.md");
const START = "<!-- generated:numbers (node scripts/readme-numbers.mjs) -->", END = "<!-- /generated:numbers -->";

/** The Markdown between the markers. Imports the modules lazily: a database module needs SEO_AUDITOR_DATA first. */
export async function numbersBlock() {
  process.env.SEO_AUDITOR_DATA ||= mkdtempSync(path.join(tmpdir(), "seo-auditor-readme-")); // never the real data folder
  const { checkCounts } = await import("../src/check-sources.mjs");
  const { PLATFORMS } = await import("../src/visibility.mjs");
  const { DEFAULT_BUDGET } = await import("../src/dataforseo.mjs");
  const c = checkCounts(), g = c.groups;
  const perPrompt = Object.values(PLATFORMS).reduce((t, p) => t + p.cost, 0);
  const usd = (n) => `$${n.toFixed(3).replace(/0$/, "")}`;
  return [
    `**${c.total} checks**: ${c.severity.error} errors, ${c.severity.warning} warnings, ${c.severity.notice} notices.`,
    "",
    "| Group | Checks |",
    "|---|---|",
    `| SEO (on-page, content, links, structured data, sitemaps, hreflang…) | ${g.seo || 0} |`,
    `| Crawlability (status codes, redirects, robots.txt, canonicals, rendering…) | ${g.crawl || 0} |`,
    `| AI search (AI crawlers, answer-ready content; scored as AI Readiness) | ${g.ai || 0} |`,
    `| Core Web Vitals (field data first, Lighthouse as fallback) | ${g.performance || 0} |`,
    `| Security headers (information, not a Google ranking factor) | ${g.security || 0} |`,
    `| Accessibility (information, not a Google ranking factor) | ${g.accessibility || 0} |`,
    "",
    `${c.withGoogleSource} checks link to the Google Search Central page on their topic; the rest are labelled in the app as tool heuristics, security or accessibility information.`,
    "",
    `AI visibility costs about ${usd(perPrompt)} per prompt with all ${Object.keys(PLATFORMS).length} platforms (${Object.values(PLATFORMS).map((p) => `${p.label} ${usd(p.cost)}`).join(", ")}). The default monthly DataForSEO budget is $${DEFAULT_BUDGET.toFixed(2)}.`,
  ].join("\n");
}

/** README text with the block replaced (throws when the markers are missing). */
export function withNumbers(text, block) {
  const a = text.indexOf(START), b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error("README.md has no generated:numbers markers");
  return text.slice(0, a + START.length) + "\n" + block + "\n" + text.slice(b);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = readFileSync(README, "utf8").replace(/\r\n/g, "\n");
  const next = withNumbers(text, await numbersBlock());
  if (process.argv.includes("--check")) {
    if (next !== text) { console.error("README.md numbers are out of date: run node scripts/readme-numbers.mjs"); process.exitCode = 1; }
    else console.log("README.md numbers match the code");
  } else { writeFileSync(README, next); console.log("README.md numbers updated"); }
  process.exit();
}
