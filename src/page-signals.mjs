// Glue for the REQ-044 build rows 7, 10, 26, 36-40 and 54 (Oct 2026): what parseHtml records per page, and the site
// rules the crawler runs once the crawl is done. The checks themselves live in hreflang.mjs, spam-signals.mjs,
// image-checks.mjs, title-signals.mjs and video-checks.mjs (pure functions, tested on their own).
import { all, get } from "./db.mjs";
import { stuffedList, repeatedPhrases, keywordStuffingIssues, spamFindings, hackedSpamIssues } from "./spam-signals.mjs";
import { imageFindings, altReuseIssues, imagesBlockedIssues } from "./image-checks.mjs";
import { videoFindings } from "./video-checks.mjs";
import { titleQualityIssues, dupH1Issues } from "./title-signals.mjs";
import { hreflangClusterIssues } from "./hreflang.mjs";

/** Page data fields from one parsed page. $c: main content (or body); text: the main text. */
export function pageSignals($, { url, $c, text }) {
  const d = { ...spamFindings($, url), ...imageFindings($, url, $c), ...videoFindings($, $c) };
  const list = stuffedList($);
  if (list) d.stuffList = list;
  // Repeated phrases count in prose only: link text ("Read more" on every blog card), buttons and menus are navigation.
  const prose = $c && $c.length ? $c.clone().find("a, button, nav").remove().end().text().replace(/\s+/g, " ").trim() : text;
  const phrases = repeatedPhrases(prose);
  if (phrases.length) d.stuffPhrases = phrases;
  return d;
}

/** What the previous finished audit of the project recorded: its URLs and, when it stored them, script hosts. */
function previousAudit(projectId, auditId) {
  const prev = get("SELECT id FROM audits WHERE project_id=? AND id<? AND status='done' ORDER BY id DESC LIMIT 1", projectId, auditId);
  if (!prev) return {};
  const rows = all("SELECT url, status, json_extract(data, '$.scriptHosts') h FROM pages WHERE audit_id=?", prev.id);
  const recorded = rows.filter((r) => r.h !== null);
  let hosts = null;
  if (recorded.length) {
    hosts = new Map();
    for (const r of recorded) for (const h of JSON.parse(r.h)) hosts.set(h, (hosts.get(h) || 0) + 1);
  }
  return { prevAudit: prev.id, prevUrls: new Set(rows.map((r) => r.url)), prevScriptHosts: hosts };
}

/** [[id, url, detail]] for the site rules. Reads the audit's image links and the previous audit from the database. */
export function signalSiteIssues({ auditId, projectId, pages, start, cluster, brandTerms = [], allow = [], robots = null, robotsTxt = "", origin }) {
  const home = pages.find((p) => p.url === start || p.final_url === start) || null;
  const images = all("SELECT to_url, MIN(from_url) page FROM links WHERE audit_id=? AND kind='img' AND internal=1 GROUP BY to_url", auditId).map((r) => [r.to_url, r.page]);
  for (const p of pages) for (const v of p.data?.videoUrls || []) if (v.thumb) images.push([v.thumb, p.url]);
  return [
    ...hreflangClusterIssues(pages),
    ...keywordStuffingIssues(pages, { brandTerms }),
    ...hackedSpamIssues(pages, { home, allow, brandTerms, ...previousAudit(projectId, auditId) }),
    ...altReuseIssues(pages, { brandTerms }),
    ...imagesBlockedIssues(images, { robots, robotsTxt, origin }),
    ...titleQualityIssues(pages, { brandTerms }),
    ...dupH1Issues(pages, cluster),
  ];
}
