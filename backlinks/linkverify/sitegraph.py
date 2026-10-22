"""Your site's link graph: `linkverify graph`

Crawls your own site (from the home page and the sitemap), the way Google would,
and builds a graph of every page, every internal link between them, every site
you link out to, and every backlink in your registry pointing at each page.

From that graph it works out:
- how internal "link strength" flows (an internal PageRank, 0-100 for the strongest page),
- click depth from the home page,
- pages with few or no internal links pointing at them (orphans),
- broken internal links, internal links that redirect,
- noindex pages, canonical problems, sitemap problems, duplicate titles,
- which pages earn backlinks, and which important pages have none yet.

It only reads your public pages, at the polite crawl rate, and obeys robots.txt.
"""

from __future__ import annotations

import gzip
import json
import re
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from . import parse
from .config import Config
from .db import Registry, now_iso
from .domains import TargetMatcher, site_of
from .fetcher import Fetcher
from .robots import is_allowed

DNS_FAIL = re.compile(r"getaddrinfo failed|Name or service not known|nodename nor servname|No address associated|"
                      r"Temporary failure in name resolution|Errno -2|Errno 11001", re.I)


def _short_err(err: str) -> str:
    if re.search(r"timed? ?out|Timeout", err, re.I):
        return "did not answer in time"
    if re.search(r"SSL|certificate", err, re.I):
        return "security certificate problem"
    if re.search(r"refused|reset", err, re.I):
        return "refused the connection"
    return err[:80]


SKIP_EXT = re.compile(r"\.(?:jpe?g|png|gif|webp|svg|ico|bmp|avif|pdf|zip|rar|7z|gz|mp4|webm|mp3|wav|css|js|json|xml|txt|"
                      r"woff2?|ttf|eot|docx?|xlsx?|pptx?)$", re.I)


@dataclass
class PageNode:
    url: str
    status: int = 0
    error: str = ""
    final_url: str = ""
    redirect: list[str] = field(default_factory=list)
    title: str = ""
    description_len: int = 0
    h1: int = 0
    words: int = 0
    canonical: str = ""
    noindex: bool = False
    nofollow: bool = False
    blocked: bool = False  # by robots.txt
    in_sitemap: bool = False
    depth: int | None = None
    out: list[str] = field(default_factory=list)  # internal pages it links to (followed links only)
    out_nofollow: list[str] = field(default_factory=list)
    external: dict[str, list[str]] = field(default_factory=dict)  # site -> rel values used
    external_urls: list[str] = field(default_factory=list)
    inbound: int = 0
    pagerank: float = 0.0
    backlinks: int = 0  # registry links pointing at this page
    backlinks_counting: int = 0

    @property
    def indexable(self) -> bool:
        return (self.status == 200 and not self.noindex and not self.blocked and not self.redirect
                and (not self.canonical or self.canonical == self.url))


def page_key(url: str) -> str:
    """One id per page: scheme, host and path; query and fragment dropped, trailing slash kept as is."""
    p = urlsplit(url)
    path = p.path or "/"
    return urlunsplit((p.scheme.lower(), p.netloc.lower(), path, "", ""))


def _sitemap_urls(fetcher: Fetcher, url: str, seen: set[str], limit: int = 5000) -> list[str]:
    if url in seen or len(seen) > 50:
        return []
    seen.add(url)
    r = fetcher.get(url)
    if not r.ok:
        return []
    text = r.text
    if url.endswith(".gz") or r.headers.get("content-type", "").startswith("application/x-gzip"):
        try:
            text = gzip.decompress(r.text.encode("latin-1")).decode("utf-8", "replace")
        except OSError:
            return []
    locs = [m.strip() for m in re.findall(r"<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*</loc>", text, re.I)]
    if re.search(r"<sitemapindex", text, re.I):
        out: list[str] = []
        for loc in locs:
            out += _sitemap_urls(fetcher, loc.replace("&amp;", "&"), seen, limit)
            if len(out) >= limit:
                break
        return out[:limit]
    return [l.replace("&amp;", "&") for l in locs][:limit]


@dataclass
class SiteGraph:
    site: str
    home: str
    crawled_at: str
    pages: dict[str, PageNode]
    sitemaps: list[str]
    robots_status: int
    broken_links: list[dict]
    redirect_links: list[dict]
    broken_external: list[dict]
    notes: list[str]
    referring: dict[str, list[dict]]  # page -> registry links pointing at it
    host_variants: list[dict] = field(default_factory=list)
    unverified_external: list[dict] = field(default_factory=list)

    def to_json(self) -> dict:
        d = {k: v for k, v in asdict(self).items() if k != "pages"}
        d["pages"] = [asdict(p) | {"indexable": p.indexable} for p in self.pages.values()]
        d["issues"] = issues(self)
        d["summary"] = summary(self)
        return d


def crawl(cfg: Config, start: str | None = None, max_pages: int = 300, fetcher: Fetcher | None = None,
          reg: Registry | None = None, printer=lambda *_: None, check_external: bool = True,
          max_external: int = 200) -> SiteGraph:
    if not (start or cfg.my_site):
        raise ValueError("Add your website address first, or give a start URL.")
    given = bool(start)
    start = start or f"https://{cfg.my_site}/"
    own_fetcher = fetcher is None
    fetcher = fetcher or Fetcher(cfg)
    notes: list[str] = []
    try:
        home = fetcher.get(start)
        if home.error and not given:  # a site without https
            plain = fetcher.get(f"http://{cfg.my_site}/")
            if not plain.error:
                home, start = plain, f"http://{cfg.my_site}/"
                notes.append(f"https://{cfg.my_site}/ could not be opened, so the site was read over plain http. "
                             "Browsers mark http sites as not secure; consider adding https.")
        if home.error or not home.final_url:
            raise RuntimeError(f"Could not open {start}: {home.error or home.status}")
        home_url = page_key(home.final_url)
        if page_key(start) != home_url:
            notes.append(f"{start} redirects to {home.final_url}; crawling from there.")
        site = site_of(home_url)
        origin = f"{urlsplit(home_url).scheme}://{urlsplit(home_url).netloc}"
        same = TargetMatcher(site)

        robots = fetcher.get(origin + "/robots.txt")
        robots_text = robots.text if robots.ok else ""
        sitemaps = [l.split(":", 1)[1].strip() for l in robots_text.splitlines() if l.lower().startswith("sitemap:")]
        if not sitemaps:
            sitemaps = [origin + "/sitemap.xml"]
        sm_urls: list[str] = []
        seen_sm: set[str] = set()
        for sm in sitemaps:
            sm_urls += _sitemap_urls(fetcher, sm, seen_sm)
        sm_keys = {page_key(u) for u in sm_urls if site_of(u) == site}
        if not sm_urls:
            notes.append("No sitemap found (checked robots.txt and /sitemap.xml).")

        pages: dict[str, PageNode] = {}
        queue: deque[tuple[str, int]] = deque([(home_url, 0)])
        queued = {home_url}
        for k in sorted(sm_keys):
            if k not in queued:
                queue.append((k, -1))  # depth unknown until a link to it is found
                queued.add(k)
        broken: list[dict] = []
        redirects: list[dict] = []
        raw_links: dict[str, list[tuple[str, str, list[str]]]] = {}  # page -> [(target key, href, rel)]

        while queue and len(pages) < max_pages:
            key, _ = queue.popleft()
            node = PageNode(url=key, in_sitemap=key in sm_keys)
            pages[key] = node
            if robots_text:
                allowed, _ = is_allowed(robots_text, key)
                if not allowed:
                    node.blocked = True
                    continue
            r = fetcher.get(key)
            node.status, node.error = r.status, r.error
            node.final_url = r.final_url
            node.redirect = [f"{u} ({s})" for u, s in r.hops]
            printer(f"[{len(pages)}] {node.status or node.error} {key}")
            if not r.ok or "html" not in r.headers.get("content-type", "html"):
                continue
            final_key = page_key(r.final_url)
            if r.hops and site_of(final_key) == site and final_key not in queued:
                queue.append((final_key, -1))
                queued.add(final_key)
            if r.hops:
                continue  # the redirect target is crawled as its own page
            soup = parse.soup_of(r.text)
            node.title = " ".join(soup.title.get_text(" ", strip=True).split()) if soup.title else ""
            desc = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
            node.description_len = len((desc.get("content") or "").strip()) if desc else 0
            node.h1 = len(soup.find_all("h1"))
            robots_meta = parse.meta_robots(r.text)
            tokens = set().union(*robots_meta.values()) if robots_meta else set()
            tokens |= parse.x_robots([v for k, v in r.header_list if k.lower() == "x-robots-tag"])
            node.noindex, node.nofollow = "noindex" in tokens, "nofollow" in tokens
            canon = parse.canonical(r.text, r.final_url, [v for k, v in r.header_list if k.lower() == "link"])
            node.canonical = page_key(canon) if canon else ""
            for t in soup(["script", "style", "noscript", "template"]):
                t.decompose()
            node.words = len(soup.get_text(" ").split())
            links = []
            for hit in parse.find_links(r.text, r.final_url, same):
                if hit.kind != "a" or not hit.url.lower().startswith(("http://", "https://")):
                    continue
                links.append((page_key(hit.url), hit.href, [x.lower() for x in hit.rel]))
            raw_links[key] = links
            for tkey, _, rel in links:
                if node.nofollow or "nofollow" in rel:
                    if tkey not in node.out_nofollow:
                        node.out_nofollow.append(tkey)
                    continue
                if tkey not in node.out and tkey != key:
                    node.out.append(tkey)
                if tkey not in queued and not SKIP_EXT.search(urlsplit(tkey).path):
                    queue.append((tkey, -1))
                    queued.add(tkey)
            ext: dict[str, set[str]] = {}
            base = parse.base_url(soup, r.final_url)
            for a in parse.soup_of(r.text).find_all("a", href=True):
                absolute = urljoin(base, a["href"].strip())
                if absolute.lower().startswith(("http://", "https://")):
                    s = site_of(absolute)
                    if s and s != site:
                        rels = [x.lower() for x in (a.get("rel") or [])]
                        ext.setdefault(s, set()).add(" ".join(sorted(x for x in rels if x in ("nofollow", "ugc", "sponsored"))) or "followed")
                        clean = absolute.split("#", 1)[0]
                        if clean not in node.external_urls:
                            node.external_urls.append(clean)
            node.external = {s: sorted(v) for s, v in sorted(ext.items())}

        if queue:
            notes.append(f"Stopped at {max_pages} pages; {len(queue)} more were found. To read more, raise "
                         "'Pages to read when mapping your site' in Settings, Checking links (or use --max-pages).")

        # broken and redirecting internal links
        for src, links in raw_links.items():
            for tkey, href, rel in links:
                t = pages.get(tkey)
                if t is None:
                    continue
                if t.error or (t.status and t.status >= 400):
                    broken.append({"from": src, "to": tkey, "href": href, "status": t.status or t.error})
                elif t.redirect:
                    redirects.append({"from": src, "to": tkey, "href": href, "final": t.final_url})

        # every way people might type your address must end on the same home page
        variants: list[dict] = []
        bare = urlsplit(home_url).netloc
        base_host = bare[4:] if bare.startswith("www.") else bare
        if not re.fullmatch(r"[\d.:]+|localhost(:\d+)?|\[.*\]", base_host):
            for v in (f"http://{base_host}/", f"http://www.{base_host}/", f"https://{base_host}/", f"https://www.{base_host}/"):
                if page_key(v) == home_url:
                    continue
                vr = fetcher.get(v)
                final = page_key(vr.final_url) if vr.final_url and not vr.error else ""
                ok = final == home_url and vr.status == 200
                variants.append({"url": v, "final": vr.final_url, "status": vr.status, "error": vr.error[:120],
                                 "hops": [s for _, s in vr.hops], "ok": ok,
                                 "permanent": all(s in (301, 308) for _, s in vr.hops)})
                printer(f"  variant {v} -> {vr.final_url or vr.error} ({vr.status})")

        broken_ext: list[dict] = []
        unverified_ext: list[dict] = []
        if check_external:
            urls: dict[str, list[str]] = {}
            for k, p in pages.items():
                for u in p.external_urls:
                    urls.setdefault(u, []).append(k)
            if len(urls) > max_external:
                notes.append(f"Checked the first {max_external} of {len(urls)} outbound links.")
            for u in list(urls)[:max_external]:
                status, err = fetcher.status_of(u)
                if err and not DNS_FAIL.search(err):
                    status, err = fetcher.status_of(u, timeout=15)  # slow sites get a second, longer try
                printer(f"  outbound {status or err[:40]} {u}")
                # 401/403/429/999: the other site refuses robots, which says nothing about the link
                if status in (404, 410) or (err and DNS_FAIL.search(err)):
                    broken_ext.append({"url": u, "status": status or "the site's address does not exist", "pages": urls[u][:20]})
                elif err or status >= 500:
                    unverified_ext.append({"url": u, "status": status or _short_err(err), "pages": urls[u][:20]})

        _depths(pages, home_url)
        _inbound(pages)
        _pagerank(pages)
        referring = _backlinks(pages, reg, site)
        return SiteGraph(site=site, home=home_url, crawled_at=now_iso(), pages=pages, sitemaps=sitemaps,
                         robots_status=robots.status, broken_links=broken, redirect_links=redirects,
                         broken_external=broken_ext, host_variants=variants, unverified_external=unverified_ext,
                         notes=notes, referring=referring)
    finally:
        if own_fetcher:
            fetcher.close()


def _depths(pages: dict[str, PageNode], home: str) -> None:
    if home not in pages:
        return
    pages[home].depth = 0
    q = deque([home])
    while q:
        k = q.popleft()
        for t in pages[k].out:
            if t in pages and pages[t].depth is None:
                pages[t].depth = pages[k].depth + 1
                q.append(t)


def _inbound(pages: dict[str, PageNode]) -> None:
    for p in pages.values():
        p.inbound = 0
    for k, p in pages.items():
        for t in p.out:
            if t in pages and t != k:
                pages[t].inbound += 1


def _pagerank(pages: dict[str, PageNode], iterations: int = 40, d: float = 0.85) -> None:
    """Internal PageRank over followed internal links, scaled so the strongest page is 100."""
    nodes = [k for k, p in pages.items() if p.status == 200 and not p.redirect]
    if not nodes:
        return
    idx = set(nodes)
    out = {k: [t for t in pages[k].out if t in idx] for k in nodes}
    n = len(nodes)
    pr = {k: 1.0 / n for k in nodes}
    for _ in range(iterations):
        sink = sum(pr[k] for k in nodes if not out[k])
        new = {k: (1 - d) / n + d * sink / n for k in nodes}
        for k in nodes:
            if out[k]:
                share = d * pr[k] / len(out[k])
                for t in out[k]:
                    new[t] += share
        pr = new
    top = max(pr.values())
    for k in nodes:
        pages[k].pagerank = round(100 * pr[k] / top, 1)


def _backlinks(pages: dict[str, PageNode], reg: Registry | None, site: str) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    if reg is None:
        return out
    for row in reg.all():
        res = reg.latest(row["id"]) or {}
        link = res.get("link") or {}
        url = link.get("url") or row["target"]
        if not url.lower().startswith(("http://", "https://")):
            url = f"https://{site}/"  # whole-site targets count towards the home page
        if site_of(url) != site:
            continue
        key = page_key(url)
        if key not in pages:  # try the http/https and slash variants
            alt = [k for k in pages if k.split("://", 1)[1].rstrip("/") == key.split("://", 1)[1].rstrip("/")]
            if not alt:
                continue
            key = alt[0]
        out.setdefault(key, []).append({"id": row["id"], "source": row["source_url"], "verdict": row["last_verdict"],
                                        "site": site_of(row["source_url"])})
    for key, items in out.items():
        pages[key].backlinks = len(items)
        pages[key].backlinks_counting = sum(1 for i in items if i["verdict"] == "Counts")
    return out


def issues(g: SiteGraph) -> list[dict]:
    """Problems, worst first. Each: {severity, kind, title, pages, fix}."""
    out: list[dict] = []
    P = g.pages

    def add(sev, kind, title, pages, fix):
        if pages:
            n = len(pages)
            text = re.sub(r"\[([^|\]]*)\|([^\]]*)\]", lambda m: m.group(1) if n == 1 else m.group(2), title).format(n=n)
            out.append({"severity": sev, "kind": kind, "title": text, "pages": pages[:200], "fix": fix})

    add("high", "broken_internal", "{n} internal [link goes|links go] to a broken page",
        [f"{b['from']} → {b['to']} ({b['status']})" for b in g.broken_links],
        "Fix or remove these links. Every broken link wastes link strength and looks bad to visitors.")
    add("high", "host_variant", "{n} [version|versions] of your address [doesn't|don't] reach your home page",
        [f"{v['url']} → " + (("this address does not exist (no DNS record)" if DNS_FAIL.search(v["error"]) else
                               f"can't be opened ({_short_err(v['error'])})") if v["error"] else f"{v['final']} (HTTP {v['status']})")
         for v in g.host_variants if not v["ok"]],
        "Links that use this version of your address are dead or split. Make every version (http, https, with and without www) "
        "exist and 301-redirect to your one home page. For a missing www: add a DNS record for www and a redirect.")
    add("medium", "temp_redirect", "{n} [version|versions] of your address [uses|use] a temporary redirect",
        [f"{v['url']} ({', '.join(map(str, v['hops']))})" for v in g.host_variants if v["ok"] and not v["permanent"]],
        "Use a permanent (301) redirect so links to the old version pass their full value.")
    add("high", "broken_external", "{n} [link|links] to other sites [is|are] broken",
        [f"{b['url']} ({b['status']}) on {len(b['pages'])} page(s): {', '.join(b['pages'][:3])}" for b in g.broken_external],
        "Update or remove them. Broken outbound links make a page look unmaintained.")
    add("low", "unverified_external", "{n} [link|links] to other sites could not be checked",
        [f"{b['url']} ({b['status']}) on {len(b['pages'])} page(s)" for b in g.unverified_external],
        "These sites were slow or refused the checker. Open them in your browser; if they work, there is nothing to do.")
    add("high", "sitemap_bad", "{n} [page|pages] in your sitemap [is|are] not indexable",
        [f"{k} ({_why_not_indexable(p)})" for k, p in P.items() if p.in_sitemap and not p.indexable],
        "A sitemap should list only pages you want in Google: 200, not noindex, self-canonical, not redirecting.")
    add("high", "orphan", "{n} [page has|pages have] no internal links pointing at [it|them]",
        [k for k, p in P.items() if p.indexable and p.inbound == 0 and k != g.home],
        "Link to each from at least one related page. Google finds and values pages through internal links.")
    add("low", "noindex_linked", "{n} noindex [page gets|pages get] internal links",
        [f"{k} (from {p.inbound} page(s))" for k, p in P.items() if p.noindex and p.inbound],
        "Fine if intended (thank-you pages, forms). Otherwise remove the noindex.")
    add("medium", "redirect_internal", "{n} internal [link points|links point] at a redirect",
        [f"{r['from']} → {r['to']} → {r['final']}" for r in g.redirect_links],
        "Point the links straight at the final address.")
    add("medium", "deep", "{n} [page is|pages are] 4 or more clicks from your home page",
        [f"{k} (depth {p.depth})" for k, p in P.items() if p.indexable and p.depth is not None and p.depth >= 4],
        "Link to them from the home page, a hub page or the menu.")
    add("medium", "unreached", "{n} [page|pages] in your sitemap can't be reached by following links from your home page",
        [k for k, p in P.items() if p.in_sitemap and p.depth is None and p.status == 200],
        "Add internal links to them.")
    add("medium", "weak_internal", "{n} [page has|pages have] only 1 to 4 internal links pointing at [it|them]",
        [f"{k} ({p.inbound})" for k, p in sorted(P.items(), key=lambda kv: kv[1].inbound)
         if p.indexable and 0 < p.inbound < 5 and k != g.home],
        "Link to them from related pages, with descriptive anchor text. This passes strength from your strong pages.")
    add("medium", "canonical_other", "{n} [page has|pages have] a canonical pointing at a different page",
        [f"{k} → {p.canonical}" for k, p in P.items() if p.status == 200 and p.canonical and p.canonical != k],
        "Check that this is intended; Google will usually index the canonical page instead.")
    add("low", "not_in_sitemap", "{n} [page is|pages are] missing from your sitemap",
        [k for k, p in P.items() if p.indexable and not p.in_sitemap],
        "Add them to the sitemap.")
    titles: dict[str, list[str]] = {}
    for k, p in P.items():
        if p.indexable and p.title:
            titles.setdefault(p.title.lower(), []).append(k)
    add("low", "dup_title", "{n} [group|groups] of pages share the same title",
        [" + ".join(v) for v in titles.values() if len(v) > 1], "Give every page its own title.")
    add("low", "h1", "{n} [page doesn't|pages don't] have exactly one H1 heading",
        [f"{k} ({p.h1})" for k, p in P.items() if p.indexable and p.h1 != 1], "Use one H1 that says what the page is about.")
    add("low", "no_description", "{n} [page has|pages have] no meta description",
        [k for k, p in P.items() if p.indexable and p.description_len == 0], "Write one; it is your snippet in Google.")
    add("low", "thin", "{n} [page has|pages have] under 300 words",
        [f"{k} ({p.words})" for k, p in P.items() if p.indexable and p.words < 300], "Thin pages rarely earn links or rankings.")
    add("info", "no_backlinks", "{n} of your strongest pages [has|have] no backlinks yet",
        [k for k, p in sorted(P.items(), key=lambda kv: -kv[1].pagerank) if p.indexable and not p.backlinks][:15],
        "These are your strongest pages without outside links; good targets for outreach.")
    return out


def _why_not_indexable(p: PageNode) -> str:
    if p.blocked:
        return "blocked by robots.txt"
    if p.error:
        return p.error
    if p.status != 200:
        return f"HTTP {p.status}"
    if p.redirect:
        return f"redirects to {p.final_url}"
    if p.noindex:
        return "noindex"
    if p.canonical and p.canonical != p.url:
        return f"canonical is {p.canonical}"
    return "?"


def summary(g: SiteGraph) -> dict:
    P = list(g.pages.values())
    ok = [p for p in P if p.status == 200 and not p.redirect]
    ext_sites: dict[str, dict] = {}
    for p in ok:
        for s, rels in p.external.items():
            e = ext_sites.setdefault(s, {"pages": 0, "rels": set()})
            e["pages"] += 1
            e["rels"].update(rels)
    return {
        "pages": len(P), "ok": len(ok), "indexable": sum(1 for p in P if p.indexable),
        "in_sitemap": sum(1 for p in P if p.in_sitemap), "internal_links": sum(len(p.out) for p in ok),
        "max_depth": max((p.depth for p in P if p.depth is not None), default=0),
        "external_sites": len(ext_sites),
        "external": [{"site": s, "pages": v["pages"], "rels": sorted(v["rels"])}
                     for s, v in sorted(ext_sites.items(), key=lambda kv: -kv[1]["pages"])],
        "backlinks": sum(p.backlinks for p in P), "backlinks_counting": sum(p.backlinks_counting for p in P),
        "pages_with_backlinks": sum(1 for p in P if p.backlinks),
    }


def save(g: SiteGraph, cfg: Config, out_html: Path | None = None) -> tuple[Path, Path]:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    data = g.to_json()
    jpath = cfg.data_dir / "sitegraph.json"
    jpath.write_text(json.dumps(data, indent=1), encoding="utf-8")
    hpath = out_html or (cfg.data_dir / "sitegraph.html")
    hpath.write_text(render_html(data), encoding="utf-8")
    return jpath, hpath


def load(cfg: Config) -> dict | None:
    p = cfg.data_dir / "sitegraph.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return None


def render_html(data: dict) -> str:
    tpl = (Path(__file__).resolve().parent / "static" / "sitegraph.html").read_text(encoding="utf-8")
    # every "<" escaped: a crawled title like "<!--<script" can't break out of the script tag
    blob = json.dumps(data).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return tpl.replace("/*__DATA__*/null", blob)
