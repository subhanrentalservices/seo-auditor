// AI audit: how easily AI search systems (Google AI Overviews/AI Mode, ChatGPT search, Perplexity,
// Copilot) can fetch, understand and quote each page. Issue IDs start with "ai_" and are kept out of
// Site Health; they feed the separate AI Readiness score.
import robotsParser from "robots-parser";
import { CHECKS } from "./checks.mjs";

export const AI_CHECKS = {
  ai_bot_blocked_server: ["error", "Server treats a search/AI crawler differently from a browser", "robots.txt allows the bot, but the host or firewall answers it with a different status or a much smaller page, so that product can't read the site.", "Check the firewall/CDN/security plugin rules for that user agent; allow the documented crawler."],
  ai_snippet_blocked: ["warning", "Page limits snippets (nosnippet / noarchive / nocache / max-snippet:0)", "Bing documents that these limit how Copilot and Bing answers can use and cite the page; nosnippet also removes Google snippets.", "Remove the directive unless you really want the page kept out of answers."],
  ai_search_bot_blocked: ["error", "AI search crawler blocked in robots.txt", "This crawler fetches pages for an AI search or answer product (ChatGPT search, Claude, Perplexity, Bing/Copilot). Blocked at the site root, it can't read the site, so the site can't be shown or cited there.", "Allow the bot in robots.txt. To opt out of AI training only, block the training tokens (GPTBot, ClaudeBot, CCBot, Google-Extended…) instead."],
  ai_training_optout: ["notice", "AI training opt-out in robots.txt (information)", "This token controls AI model training or grounding, not search: Google-Extended and Applebot-Extended aren't separate crawlers, and Google says blocking Google-Extended doesn't affect Google Search, including AI Overviews. GPTBot, ClaudeBot and CCBot collect training data. A valid choice: it doesn't count against AI Readiness.", "Nothing to fix. Keep the block if you don't want your content used for training; remove it if you do."],
  // Older audits stored every robots.txt block under one id; kept so their issue lists still show a title.
  ai_bot_blocked: ["error", "AI crawler blocked in robots.txt (older audits)", "Older audits didn't separate AI search crawlers from AI training opt-outs; newer audits report them as ai_search_bot_blocked and ai_training_optout.", "Run a new audit to see which kind each block is."],
  ai_js_dependent: ["error", "Main content needs JavaScript", "Most AI crawlers don't run JavaScript, so they see an almost empty page.", "Render the main content on the server (static HTML / SSR)."],
  ai_no_answer: ["warning", "No direct answer near the top", "AI answers favour pages that answer the question in the first part of the page.", "Open with a paragraph (40–180 words) whose first sentences answer the page's main question."],
  ai_no_author: ["warning", "No author or reviewer signal", "Named, accountable authors are a trust signal for AI and Google.", "Show an author/reviewer with role, and add author to Article/BlogPosting schema."],
  ai_no_date: ["notice", "No published/updated date", "AI systems prefer current information and need a date to judge it.", "Show a visible 'Last updated' date and add dateModified to schema."],
  ai_no_citable_block: ["notice", "No self-contained passage of 100–180 words (experimental)", "Experimental, not a Google requirement: Google's AI optimisation guide says chunking content for AI isn't needed. Long self-contained answers may still be easier to quote.", "Add one complete answer passage per key question (about 130–170 words)."],
  ai_no_question_headings: ["notice", "No question-style headings (experimental)", "Experimental, not a Google requirement: headings phrased like customer questions can make answers easier to find.", "Phrase some H2/H3 as the questions customers ask."],
  ai_no_sources: ["notice", "Long article without outbound sources", "Citing primary sources (government, standards, studies) makes claims verifiable.", "Link 1–3 authoritative sources for facts and figures."],
  ai_thin: ["warning", "Too little content to be cited (under 300 words)", "Pages with very little text rarely contain a quotable answer.", "Add specific, original detail or merge into a stronger page."],
};
Object.assign(CHECKS, AI_CHECKS);

// robots.txt user-agent tokens, as of October 2026 (vendors rename and add tokens: re-check their docs yearly).
// Search/answer fetchers: blocking them keeps the site out of that product's answers.
export const AI_SEARCH_BOTS = ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Bingbot"];
// Training and grounding control tokens: blocking them is an opt-out, with no effect on search visibility.
export const AI_TRAINING_BOTS = ["GPTBot", "ClaudeBot", "anthropic-ai", "CCBot", "Google-Extended", "Applebot-Extended", "Meta-ExternalAgent"];
// Google's crawler for research and one-off fetches (not Search); reported for information only.
export const OTHER_BOTS = ["GoogleOther"];
export const AI_BOTS = [...AI_SEARCH_BOTS, ...AI_TRAINING_BOTS, ...OTHER_BOTS];
const kindOf = (b) => (AI_SEARCH_BOTS.includes(b) ? "search" : AI_TRAINING_BOTS.includes(b) ? "training" : "other");

export function aiPageIssues(p) {
  const d = p.data || {};
  const out = [];
  if (p.status !== 200 || !p.indexable || !(p.content_type || "").includes("html")) return out;
  if (d.jsWordsRaw !== undefined && d.jsWordsRendered > 150 && d.jsWordsRaw < d.jsWordsRendered * 0.5)
    out.push(["ai_js_dependent", `${d.jsWordsRaw} words without JS vs ${d.jsWordsRendered} rendered`]);
  if (p.words < 300) out.push(["ai_thin", `${p.words} words`]);
  if (d.snippetBlock) out.push(["ai_snippet_blocked", d.snippetBlock]);
  if (!d.answerEarly) out.push(["ai_no_answer", ""]);
  // Bylines and dates are expected on articles, not on service, contact or booking pages.
  const types = d.schemaTypes || [];
  const listing = types.some((t) => /^(Blog|CollectionPage|ItemList)$/.test(t)) || d.childLinks >= 6;
  const path = new URL(p.final_url || p.url).pathname;
  const article = !listing && (types.some((t) => /Article|BlogPosting|Report/.test(t)) || /\/(blog|news|articles?|guides?)\/./.test(path));
  if (article && !d.author) out.push(["ai_no_author", ""]);
  if (article && !d.dated) out.push(["ai_no_date", ""]);
  // Answer passages and question headings suit content pages, not an index of other pages or a legal notice.
  const legal = /\/(privacy|terms|cookies?|legal|disclaimer)[^/]*$/i.test(path);
  if (listing || legal) return out;
  if (p.words >= 400 && !d.citableBlocks) out.push(["ai_no_citable_block", ""]);
  if (p.words >= 600 && d.headings >= 3 && !d.questionHeadings) out.push(["ai_no_question_headings", ""]);
  if (p.words >= 600 && !d.externalLinks) out.push(["ai_no_sources", ""]);
  return out;
}

/** Search/answer fetchers blocked at the site root → ai_search_bot_blocked (error); training tokens blocked →
 *  ai_training_optout (notice). GoogleOther is only listed in aiBotAccess. */
export function aiSiteIssues(robotsTxt, origin) {
  if (!robotsTxt) return [];
  const r = robotsParser(origin + "/robots.txt", robotsTxt);
  const blocked = (b) => r.isAllowed(origin + "/", b) === false;
  return [...AI_SEARCH_BOTS.filter(blocked).map((b) => ["ai_search_bot_blocked", b]),
    ...AI_TRAINING_BOTS.filter(blocked).map((b) => ["ai_training_optout", `${b}: ${/^Google-/.test(b) ? "doesn't affect Google Search or AI Overviews" : "training opt-out; search crawlers are separate tokens"}`])];
}

export function aiBotAccess(robotsTxt, origin) {
  const r = robotsParser(origin + "/robots.txt", robotsTxt || "");
  return AI_BOTS.map((b) => ({ bot: b, kind: kindOf(b), allowed: robotsTxt ? r.isAllowed(origin + "/", b) !== false : true }));
}

const WEIGHT = { error: 10, warning: 4, notice: 1 };
/** AI Readiness 0–100: each indexable page starts at 100 and loses points per AI issue; each blocked AI search
 *  crawler (siteBlocks) costs 15. Training opt-outs are not passed in and cost nothing. */
export function aiReadiness(pageIssueRows, indexablePages, siteBlocks) {
  if (!indexablePages) return 0;
  const perPage = new Map();
  for (const r of pageIssueRows) perPage.set(r.url, (perPage.get(r.url) || 0) + WEIGHT[r.severity]);
  let sum = 0;
  for (let i = 0; i < indexablePages; i++) sum += 100;
  for (const pts of perPage.values()) sum -= Math.min(100, pts * 3);
  return Math.max(0, Math.round(sum / indexablePages - siteBlocks * 15));
}
