"""The 15 checks and the verdict.

Verdicts, from worst to best:
    Not counted - missing, broken, blocked, redirected away, hidden, or not a real link
    Weak        - a real link, but nofollow / ugc / sponsored, or on a page with very many outbound links
    Pending     - live and clean, but the linking page was not seen in Google yet
    Counts      - live, followed <a href> to your site on an indexable page
"""

from __future__ import annotations

import gzip
import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from . import ahrefs, integrations, parse, tranco
from .config import Config
from .db import now_iso
from .domains import TargetMatcher, normalize_url, site_of
from .fetcher import Fetcher, FetchResult
from .render import Renderer, playwright_available
from .robots import is_allowed

COUNTS, WEAK, PENDING, NOT_COUNTED = "Counts", "Weak", "Pending", "Not counted"
VERDICT_ORDER = [NOT_COUNTED, WEAK, PENDING, COUNTS]

CHECK_NAMES = {
    1: "Page loads",
    2: "Redirect target",
    3: "Link in raw HTML",
    4: "Link after JavaScript",
    5: "Crawlable link",
    6: "rel value",
    7: "Meta robots",
    8: "X-Robots-Tag header",
    9: "robots.txt",
    10: "Canonical",
    11: "Your target page",
    12: "Hidden link",
    13: "Page strength",
    14: "Indexed",
    15: "Discovered",
}


@dataclass
class Check:
    num: int
    status: str  # pass | warn | fail | skip | info
    detail: str
    effect: str = "none"  # none | weak | pending | not_counted

    @property
    def name(self) -> str:
        return CHECK_NAMES[self.num]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["name"] = self.name
        return d


def _robots_noindex(tokens: set[str]) -> bool:
    return "noindex" in tokens


class Verifier:
    def __init__(self, cfg: Config, fetcher: Fetcher | None = None, renderer: Renderer | None = None):
        self.cfg = cfg
        self.fetcher = fetcher or Fetcher(cfg)
        if renderer is None and cfg.render and playwright_available():
            renderer = Renderer(cfg.user_agent, cfg.render_timeout_seconds)
        self.renderer = renderer if cfg.render else None
        self._robots_cache: dict[str, FetchResult] = {}

    def close(self) -> None:
        self.fetcher.close()
        if self.renderer:
            self.renderer.close()

    # ------------------------------------------------------------------
    def verify(self, source_url: str, target: str, evidence_dir: Path | None = None,
               check_target: bool = True) -> dict:
        matcher = TargetMatcher(target)
        checks: dict[int, Check] = {}
        notes: list[str] = []
        result: dict = {
            "source_url": source_url,
            "target": target,
            "checked_at": now_iso(),
            "final_url": "",
            "link": None,
            "links_found": 0,
            "outbound_sites": None,
            "domain_rating": None,
            "url_rating": None,
            "world_rank": None,
            "popularity": None,
        }

        def add(num: int, status: str, detail: str, effect: str = "none") -> Check:
            checks[num] = Check(num, status, detail, effect)
            return checks[num]

        def skip_rest(start: int, why: str) -> None:
            for n in range(start, 16):
                if n not in checks:
                    add(n, "skip", why)

        # 1 Page loads ----------------------------------------------------
        page = self.fetcher.get(source_url)
        result["final_url"] = page.final_url
        result["status"] = page.status
        if page.error:
            add(1, "fail", f"Could not load the page: {page.error}", "not_counted")
        elif page.status != 200:
            add(1, "fail", f"The page returned HTTP {page.status}, not 200.", "not_counted")
        else:
            hops = f" after {len(page.hops)} redirect(s)" if page.hops else ""
            add(1, "pass", f"HTTP 200{hops}." + (" Page was larger than the size limit; only the first part was read." if page.truncated else ""))
        if checks[1].status == "fail":
            skip_rest(2, "Skipped: the page did not load.")
            return self._finish(result, checks, notes, page, None, evidence_dir)

        final = page.final_url
        # 2 Redirect target -----------------------------------------------
        if normalize_url(final) == normalize_url(source_url):
            add(2, "pass", "No redirect to another page." if not page.hops else "Redirect only changes http/https, www or a trailing slash.")
        elif site_of(final) != site_of(source_url):
            add(2, "fail", f"The page redirects to another site: {final}", "not_counted")
        else:
            add(2, "warn", f"The page redirects to another page on the same site: {final}. The checks below use that page; update the URL in your registry.")
        if checks[2].status == "fail":
            skip_rest(3, "Skipped: the page redirects to another site.")
            return self._finish(result, checks, notes, page, None, evidence_dir)

        # 3 and 4 Link exists (raw HTML, then rendered) -----------------------
        raw_hits = parse.find_links(page.text, final, matcher)
        raw_links = [h for h in raw_hits if h.kind == "a"]

        rendered = None
        rendered_hits: list[parse.LinkHit] = []
        if self.renderer is not None:
            shot = (evidence_dir / "screenshot.png") if (evidence_dir and self.cfg.save_evidence) else None
            rendered = self.renderer.render(final, shot)
            if rendered.error:
                notes.append(f"Rendering failed: {rendered.error}")
                rendered = None
            else:
                rendered_hits = parse.find_links(rendered.html, rendered.final_url or final, matcher)
        rendered_links = [h for h in rendered_hits if h.kind == "a"]

        text_mention = parse.visible_text_mentions(page.text, matcher)
        if raw_links:
            add(3, "pass", f"{len(raw_links)} link(s) to {matcher.raw} in the page's HTML.")
        elif rendered_links:
            add(3, "warn", "Not in the raw HTML; the link is added by JavaScript (see check 4).")
        elif text_mention:
            add(3, "fail", f"{matcher.site} is mentioned as plain text, but there is no link.", "not_counted")
        else:
            add(3, "fail", f"No link to {matcher.raw} found.", "not_counted")

        if rendered is None:
            why = "browser checks are turned off in Settings" if not self.cfg.render else (
                "Playwright is not installed" if not playwright_available() else "rendering failed (see notes)")
            add(4, "skip", f"Not checked: {why}.")
        elif raw_links and rendered_links:
            add(4, "pass", "The link is still there after JavaScript runs.")
        elif rendered_links:
            add(4, "warn", "The link appears only after JavaScript runs. Google renders pages later, so it may find the link more slowly.")
        elif raw_links:
            add(4, "warn", "The link is in the HTML but is removed or changed by JavaScript after the page loads.")
        else:
            add(4, "fail", "No link after JavaScript runs either.", "not_counted")

        links = raw_links or rendered_links
        noncrawl = [h for h in raw_hits + rendered_hits if h.kind == "not-crawlable"]
        wrapped = [h for h in raw_hits + rendered_hits if h.kind == "wrapped"]
        result["links_found"] = len(links)
        if not links and wrapped:
            # replace the "no link" results of checks 3 and 4 with what is really there
            w = wrapped[0]
            how = "in the HTML" if any(h in raw_hits for h in wrapped) else "after JavaScript runs"
            add(3, "warn", f"A link to you was found {how}, but it goes through a redirect: {w.via[:160]}")
            add(4, "info", "See check 5.")

        # 5 Crawlable -------------------------------------------------------
        if links:
            extra = f" ({len(noncrawl)} other non-crawlable link(s) also found.)" if noncrawl else ""
            add(5, "pass", "Uses a real <a href>, which Google can follow." + extra)
        elif wrapped:
            w = wrapped[0]
            status, detail, impact = self._robots_check(w.via)
            if impact == "not_counted":
                add(5, "fail", f"The link goes through {site_of(w.via)}, and that redirect is blocked to Google by robots.txt, "
                               "so it passes nothing to you. It still sends visitors.", "not_counted")
            else:
                add(5, "warn", f"The link goes through a redirect on {site_of(w.via)}. Search engines rarely pass value "
                               "through click-tracking redirects; it still sends visitors.", "weak")
            result["link"] = w.to_dict()
        elif noncrawl:
            add(5, "fail", f"A link exists but Google cannot follow it: {noncrawl[0].problem}.", "not_counted")
            result["link"] = noncrawl[0].to_dict()
        else:
            add(5, "fail", "No link to check.", "not_counted")

        best = self._best(links, rendered)
        if best:
            result["link"] = best.to_dict()

        # 6 rel ---------------------------------------------------------------
        if best is None:
            add(6, "skip", "No link to check.")
        elif best.weak_rel:
            add(6, "warn", f'rel="{" ".join(best.rel)}". Google treats this as a hint, not a full link.', "weak")
        else:
            add(6, "pass", f"Followed link (rel: {' '.join(best.rel) or 'none'}).")

        # 7 Meta robots --------------------------------------------------------
        meta = parse.meta_robots(page.text)
        if rendered is not None:
            for k, v in parse.meta_robots(rendered.html).items():
                meta.setdefault(k, set()).update(v)
        meta_tokens = meta.get("robots", set()) | meta.get("googlebot", set())
        if _robots_noindex(meta_tokens):
            add(7, "fail", f"The page has a noindex meta tag ({', '.join(sorted(meta_tokens))}). Google drops it from the index.", "not_counted")
        elif "nofollow" in meta_tokens:
            add(7, "warn", "The page has a page-wide nofollow meta tag, so every link on it is only a hint.", "weak")
        else:
            add(7, "pass", "No noindex or nofollow meta tag." + (f" ({', '.join(sorted(meta_tokens))})" if meta_tokens else ""))

        # 8 X-Robots-Tag ---------------------------------------------------------
        xr = parse.x_robots(page.header_values("x-robots-tag"))
        if _robots_noindex(xr):
            add(8, "fail", "The server sends X-Robots-Tag: noindex. Google drops the page from the index.", "not_counted")
        elif "nofollow" in xr:
            add(8, "warn", "The server sends X-Robots-Tag: nofollow, so every link on the page is only a hint.", "weak")
        else:
            add(8, "pass", "No blocking X-Robots-Tag header.")

        # 9 robots.txt -----------------------------------------------------------
        add(9, *self._robots_check(final))

        # 10 Canonical -----------------------------------------------------------
        canon = parse.canonical(page.text, final, page.header_values("link"))
        if not canon or normalize_url(canon) == normalize_url(final):
            add(10, "pass", "The page is its own canonical." if canon else "No canonical tag (the page is treated as its own).")
        elif best is None:
            add(10, "info", f"The canonical points to {canon}.")
        else:
            other = self.fetcher.get(canon)
            if other.ok and any(h.kind == "a" for h in parse.find_links(other.text, other.final_url, matcher)):
                add(10, "pass", f"The canonical points to {canon}, which also has your link.")
            else:
                add(10, "fail", f"The canonical points to {canon}, which does not have your link. Google may index that page instead.", "not_counted")

        # 11 Your target page ----------------------------------------------------
        if best is None:
            add(11, "skip", "No link to follow.")
        elif not check_target:
            add(11, "skip", "Not checked (platform test: the linked site is not yours).")
        else:
            add(11, *self._target_check(best.url, matcher))

        # 12 Hidden link -----------------------------------------------------------
        if best is None:
            add(12, "skip", "No link to check.")
        elif best.hidden_reasons:
            add(12, "fail", "The link is hidden from visitors: " + "; ".join(best.hidden_reasons[:3]) + ".", "not_counted")
        else:
            how = "in the HTML and in the browser" if rendered is not None else "in the HTML (browser check not run)"
            add(12, "pass", f"The link is visible ({how}).")

        # 13 Page strength -----------------------------------------------------------
        sites = parse.outbound_sites(page.text, final)
        result["outbound_sites"] = len(sites)
        dr = ur = None
        if self.cfg.ahrefs_api_key:
            try:
                m = ahrefs.metrics(self.cfg, sites=[site_of(final)], pages=[final])
                dr = (m.get(f"site:{site_of(final)}") or {}).get("dr")
                ur = (m.get(f"page:{final}") or {}).get("ur")
                if dr is None and ur is None:
                    notes.append(f"Ahrefs has no rating for {site_of(final)} yet.")
            except RuntimeError as exc:
                notes.append(f"Ahrefs lookup failed: {exc}")
        result["domain_rating"] = dr
        result["url_rating"] = ur
        bits = []
        if dr is not None:
            bits.append(f"Ahrefs DR of {site_of(final)}: {dr:g}")
        if ur is not None:
            bits.append(f"UR of this page: {ur:g}")
        if dr is None and self.cfg.use_tranco:
            rank = tranco.ranks(self.cfg, [final]).get(site_of(final))
            result["world_rank"], result["popularity"] = rank, tranco.score(rank)
            if rank:
                bits.append(f"{site_of(final)} is ranked {rank:,} among the world's websites (popularity {tranco.score(rank):g} of 100, free Tranco list)")
            elif tranco.ensure(self.cfg)[0]:
                bits.append(f"{site_of(final)} is not in the world's top million sites (normal for small and local sites)")
        dr_text = (" " + ", ".join(bits) + ".") if bits else ""
        if len(sites) > self.cfg.max_outbound_domains:
            add(13, "warn", f"The page links to {len(sites)} other sites (your limit is {self.cfg.max_outbound_domains}), so each link passes little.{dr_text}", "weak")
        else:
            add(13, "pass", f"The page links to {len(sites)} other site(s).{dr_text}")

        # 14 Indexed -------------------------------------------------------------------
        seen, msg = integrations.dataforseo_seen_in_google(self.cfg, final)
        if seen is None:
            q = "site:" + final.split("://", 1)[-1].split("#", 1)[0]
            how = f"DataForSEO: {msg}. " if self.cfg.has_dataforseo else ""
            add(14, "skip", f"Not checked automatically. {how}To check by hand, search Google for: {q}")
        elif seen:
            add(14, "pass", f"The page is {msg}.")
        else:
            add(14, "warn", f"The page was {msg}. It may not be indexed yet; re-check in 7 and 30 days.", "pending")

        # 15 Discovered ------------------------------------------------------------------
        add(15, "skip", "Manual for now: look for this page in Search Console > Links, or Ahrefs Free > Backlinks for your site.")

        return self._finish(result, checks, notes, page, rendered, evidence_dir)

    # ------------------------------------------------------------------
    def _best(self, links: list[parse.LinkHit], rendered) -> parse.LinkHit | None:
        if not links:
            return None
        if rendered is not None:
            by_url: dict[str, list[dict]] = {}
            for a in rendered.anchors:
                by_url.setdefault(normalize_url(a.get("href", "")), []).append(a)
            for h in links:
                seen = by_url.get(normalize_url(h.url))
                if not seen:
                    continue
                # a link counts as visible in the browser if any copy of it is visible
                visible = [a for a in seen if not a.get("hiddenBy") and not a.get("offscreen")
                           and (a.get("width", 0) > 0 or a.get("height", 0) > 0)
                           and a.get("fontSize") not in ("0px",)]
                if not visible and not h.hidden_reasons:
                    a = seen[0]
                    if a.get("hiddenBy"):
                        h.hidden_reasons.append(f"in the browser it has {a['hiddenBy']}")
                    elif a.get("offscreen"):
                        h.hidden_reasons.append("in the browser it is positioned off-screen")
                    elif a.get("fontSize") == "0px":
                        h.hidden_reasons.append("in the browser its font size is 0")
                    else:
                        h.hidden_reasons.append("in the browser it has zero size")
        return max(links, key=lambda h: (not h.hidden_reasons, not h.weak_rel))

    def _robots_check(self, url: str) -> tuple[str, str, str]:
        parts = urlsplit(url)
        robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
        res = self._robots_cache.get(robots_url)
        if res is None:
            res = self.fetcher.get(robots_url)
            self._robots_cache[robots_url] = res
        if res.error:
            return "warn", f"robots.txt could not be read ({res.error}). Google may pause crawling the site.", "none"
        if 400 <= res.status < 500:
            return "pass", "No robots.txt, so crawling is allowed.", "none"
        if res.status >= 500:
            return "warn", f"robots.txt returned HTTP {res.status}. Google may pause crawling the site.", "none"
        allowed, rule = is_allowed(res.text, url, "googlebot")
        if allowed:
            return "pass", f"Googlebot may crawl this page ({rule}).", "none"
        return "fail", f"robots.txt blocks Googlebot from this page ({rule}).", "not_counted"

    def _target_check(self, url: str, matcher: TargetMatcher) -> tuple[str, str, str]:
        tgt = self.fetcher.get(url)
        if tgt.error:
            return "fail", f"Your page {url} could not be loaded: {tgt.error}", "not_counted"
        if tgt.status >= 400:
            return "fail", f"Your page {url} returns HTTP {tgt.status}. Fix it or redirect it.", "not_counted"
        if tgt.status != 200:
            return "warn", f"Your page {url} returns HTTP {tgt.status}.", "none"
        if site_of(tgt.final_url) != matcher.site:
            return "fail", f"Your page redirects off your site, to {tgt.final_url}.", "not_counted"
        meta = parse.meta_robots(tgt.text)
        tokens = meta.get("robots", set()) | meta.get("googlebot", set()) | parse.x_robots(tgt.header_values("x-robots-tag"))
        if "noindex" in tokens:
            return "fail", f"Your page {url} is set to noindex, so the link helps a page Google will not show.", "not_counted"
        extra = ""
        state, msg = integrations.gsc_inspect(self.cfg, tgt.final_url)
        if state is not None:
            extra = f" Search Console: {state} ({msg})."
        if tgt.hops:
            return "warn", f"Your page redirects to {tgt.final_url}. It works, but linking to the final URL is better.{extra}", "none"
        return "pass", f"Your page loads (HTTP 200) and is indexable.{extra}", "none"

    # ------------------------------------------------------------------
    def _finish(self, result: dict, checks: dict[int, Check], notes: list[str], page: FetchResult,
                rendered, evidence_dir: Path | None) -> dict:
        ordered = [checks[n] for n in sorted(checks)]
        effects = {c.effect for c in ordered}
        if "not_counted" in effects:
            verdict = NOT_COUNTED
        elif "weak" in effects:
            verdict = WEAK
        elif "pending" in effects:
            verdict = PENDING
        else:
            verdict = COUNTS
        verdict_effect = {NOT_COUNTED: "not_counted", WEAK: "weak", PENDING: "pending"}.get(verdict)
        reasons = [f"{c.num}. {c.name}: {c.detail}" for c in ordered if c.effect == verdict_effect]
        if verdict == COUNTS and checks.get(14) and checks[14].status == "skip":
            notes.append("Index status not checked: this link counts if Google has indexed the page.")
        result.update({
            "verdict": verdict,
            "reasons": reasons,
            "notes": notes,
            "checks": [c.to_dict() for c in ordered],
        })
        if evidence_dir is not None and self.cfg.save_evidence:
            evidence_dir.mkdir(parents=True, exist_ok=True)
            with gzip.open(evidence_dir / "page.html.gz", "wt", encoding="utf-8") as fh:
                fh.write(page.text)
            if rendered is not None:
                with gzip.open(evidence_dir / "rendered.html.gz", "wt", encoding="utf-8") as fh:
                    fh.write(rendered.html)
            (evidence_dir / "headers.json").write_text(json.dumps({
                "status": page.status, "final_url": page.final_url, "redirects": page.hops,
                "headers": page.header_list,
            }, indent=2), encoding="utf-8")
            (evidence_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
            result["evidence_dir"] = str(evidence_dir)
        return result


def evidence_path(cfg: Config, link_id: int) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return cfg.evidence_dir / f"link-{link_id}" / stamp
