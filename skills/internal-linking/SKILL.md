---
name: internal-linking
description: Plan and add contextual internal links: build the link graph, topic clusters, find under-linked pages and recommend natural in-sentence links, including links into and out of each new blog post. Use when asked to add internal links, fix orphan or weakly linked pages, build topic clusters, or before publishing a post.
---

# Internal linking

Google's link guidance (developers.google.com/search/docs/crawling-indexing/links-crawlable): only `<a href>` links are
reliably crawlable; anchor text should be "descriptive, reasonably concise, and relevant"; the words around a link add
context; every page you care about should be linked from at least one other page. Links help discovery and
understanding. Link counts are not a ranking formula, so quality beats quantity.

## Project inputs

- The link graph: SEO Auditor's crawl (Pages → inlinks) or an equivalent CSV with inbound, contextual inbound and depth.
- The cluster map (hub → spokes) for the site, kept in the project's research notes.
- The publish schedule, so links to unpublished posts are never added before they go live.

## 1. Build the picture

1. Crawl and list, per page: inbound referring pages, **contextual** (in-content) inbound pages, nav/footer inbound,
   depth, anchors, broken or redirecting links, orphan status.
2. Group pages into clusters (e.g. accident/insurance, mechanical, locations, guides). Each cluster has one hub.
3. Flag: orphans; important pages with < 3 contextual inbound pages; pages whose links come only from the footer;
   hubs that don't link to their spokes; spokes that don't link back to the hub.

## 2. Recommend links (SEO Auditor: Link ideas screen, or `node src/cli.mjs link-ideas <project>`)

For each target page, find source pages that already talk about its topic, then pick the sentence where a reader
would want the link. A good recommendation has: source page, the exact sentence, the anchor words already in that
sentence (or a minimal rewrite), the target URL, and why it helps the reader.

Rules:
- Link inside sentences where it helps; 2–6 contextual links per article is plenty.
- Descriptive anchors that fit the sentence; vary them; never "click here" / "read more".
- Link to the canonical URL (no redirects, no query strings, no `#` unless intended).
- Don't link to pages scheduled but not yet published.
- No hidden links, no keyword-stuffed anchors, no sitewide blocks added just to raise counts.
- Prefer real topical relationships (service ↔ guide ↔ related guide) over reciprocal link swapping.

## 3. Every new blog post

Before it publishes:
1. Main topic → its service/hub page: link to it once, in context.
2. 1–3 related live posts: link where the reader would naturally go next.
3. Find 1–3 **older live** pages that should now link to the new post; add one sentence-level link each.
4. Validate every link returns 200 directly; re-run the crawl; compare contextual inbound counts.

## 4. Targets (working numbers, not Google's)

- Every indexable page: ≥ 3 contextual inbound pages from related pages.
- Priority pages (money pages, hubs): aim for ≥ 11 distinct relevant referring pages where natural; never force it.
- Orphans: 0. Broken internal links: 0. Redirecting internal links: 0.

## 5. Make links visible

A link that looks like plain text helps crawlers but not people. Check that in-text links are distinguishable
(underline or colour plus a non-colour cue) on light and dark sections.

## 6. Record

Each linking batch: pages changed, links added (source sentence → target), before/after contextual counts, deploy
reference, and a review date ≥ 4 weeks later. Don't claim ranking effects without a comparison period.
