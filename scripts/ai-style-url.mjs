// Scores one or more URLs with the same aiStyleFromDom the crawler uses, so a page can be checked before a full audit.
// Usage: node scripts/ai-style-url.mjs <url> [url...]
import * as cheerio from "cheerio";
import { aiStyleFromDom } from "../src/ai-style.mjs";

for (const url of process.argv.slice(2)) {
  const html = await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0 seo-auditor ai-style" } })).text();
  const $ = cheerio.load(html);
  const scope = $("main").length ? $("main") : $("body");
  const r = aiStyleFromDom($, scope);
  if (!r) { console.log(`  - ${url}  (too little prose)`); continue; }
  console.log(`${String(r.score).padStart(3)} ${url}  (depth ${r.depth.score})`);
  for (const p of [...r.problems, ...r.depth.problems.map((d) => `depth: ${d}`)]) console.log(`      ${p}`);
}
