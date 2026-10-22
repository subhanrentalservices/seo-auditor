"""Reading a page's HTML: links, robots directives, canonical, outbound domains."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

from .domains import TargetMatcher, site_of

WEAK_REL = {"nofollow", "ugc", "sponsored"}
HIDDEN_STYLE = re.compile(
    r"display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|em|rem|%)?\s*(;|$)|opacity\s*:\s*0(\.0+)?\s*(;|$)",
    re.I,
)
BLOCK_TAGS = {"p", "li", "td", "th", "div", "section", "article", "blockquote", "dd", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6"}


@dataclass
class LinkHit:
    kind: str  # "a" (a real link), "wrapped" (through a redirect URL on another site) or "not-crawlable"
    href: str  # as written in the HTML
    url: str  # absolute
    rel: list[str] = field(default_factory=list)
    anchor_text: str = ""
    hidden_reasons: list[str] = field(default_factory=list)
    context: str = ""
    snippet: str = ""
    crawlable: bool = True
    problem: str = ""
    via: str = ""  # for "wrapped": the redirect URL the link really points at

    @property
    def weak_rel(self) -> list[str]:
        return [r for r in self.rel if r in WEAK_REL]

    def to_dict(self) -> dict:
        return asdict(self)


def soup_of(html: str) -> BeautifulSoup:
    return BeautifulSoup(html or "", "lxml")


def base_url(soup: BeautifulSoup, page_url: str) -> str:
    base = soup.find("base", href=True)
    if base:
        return urljoin(page_url, base["href"].strip())
    return page_url


def _anchor_text(a: Tag) -> str:
    text = " ".join(a.get_text(" ", strip=True).split())
    if not text:
        img = a.find("img", alt=True)
        if img and img["alt"].strip():
            text = f"[image: {img['alt'].strip()}]"
        elif a.find("img"):
            text = "[image, no alt text]"
    return text


def _hidden_reasons(el: Tag) -> list[str]:
    reasons: list[str] = []
    node: Tag | None = el
    depth = 0
    while isinstance(node, Tag) and node.name not in ("body", "html", "[document]"):
        who = "the link" if depth == 0 else f"a parent <{node.name}>"
        if node.has_attr("hidden"):
            reasons.append(f"{who} has the hidden attribute")
        style = node.get("style", "")
        if style and HIDDEN_STYLE.search(style):
            reasons.append(f"{who} has inline style '{style.strip()[:80]}'")
        if node.name in ("template",):
            reasons.append(f"{who} is a <template>")
        node = node.parent
        depth += 1
    return reasons


def _context(a: Tag, width: int = 200) -> str:
    block = a
    while isinstance(block.parent, Tag) and block.name not in BLOCK_TAGS:
        block = block.parent
    text = " ".join(block.get_text(" ", strip=True).split())
    anchor = " ".join(a.get_text(" ", strip=True).split())
    if anchor and anchor in text:
        i = text.index(anchor)
        start, end = max(0, i - width), min(len(text), i + len(anchor) + width)
        return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")
    return text[: 2 * width]


def unwrap(url: str, depth: int = 2) -> str | None:
    """The real destination of a click-tracking redirect such as l.facebook.com/l.php?u=...,
    l.instagram.com/?u=..., google.com/url?q=..., youtube.com/redirect?q=..., out.reddit.com/?url=...
    Returns None when the URL carries no destination URL in its query."""
    try:
        q = urlsplit(url).query
    except ValueError:
        return None
    for _, v in parse_qsl(q, keep_blank_values=False):
        for cand in (v, unquote(v)):
            if cand.lower().startswith(("http://", "https://")) or cand.lower().startswith("www."):
                cand = cand if cand.lower().startswith("http") else "https://" + cand
                inner = unwrap(cand, depth - 1) if depth > 0 else None
                return inner or cand
    return None


def find_links(html: str, page_url: str, matcher: TargetMatcher) -> list[LinkHit]:
    """Every link (and every non-crawlable stand-in for a link) to the target."""
    soup = soup_of(html)
    base = base_url(soup, page_url)
    hits: list[LinkHit] = []

    for a in soup.find_all("a"):
        href = a.get("href")
        rel = [t.lower() for t in (a.get("rel") or [])]
        if isinstance(rel, str):
            rel = rel.split()
        if href is not None:
            href = href.strip()
            low = href.lower()
            if low.startswith("javascript:"):
                blob = href + " " + a.get("onclick", "")
                if matcher.mentioned_in(blob):
                    hits.append(LinkHit("not-crawlable", href, "", rel, _anchor_text(a), crawlable=False,
                                        problem="href uses javascript:, which Google cannot follow",
                                        snippet=str(a)[:300]))
                continue
            absolute = urljoin(base, href)
            if matcher.matches(absolute):
                hits.append(LinkHit("a", href, absolute, rel, _anchor_text(a), _hidden_reasons(a), _context(a),
                                    snippet=str(a)[:300]))
                continue
            dest = unwrap(absolute) if "?" in absolute else None
            if dest and matcher.matches(dest) and site_of(absolute) != site_of(dest):
                hits.append(LinkHit("wrapped", href, dest, rel, _anchor_text(a), _hidden_reasons(a), _context(a),
                                    snippet=str(a)[:300], via=absolute,
                                    problem=f"the link goes through a redirect on {site_of(absolute)}, not straight to you"))
                continue
        # an <a> without a usable href, but pointing at the target some other way
        blob = " ".join(str(a.get(k, "")) for k in ("onclick", "data-href", "data-url", "data-link"))
        if blob.strip() and matcher.mentioned_in(blob):
            hits.append(LinkHit("not-crawlable", a.get("href", "") or "", "", rel, _anchor_text(a), crawlable=False,
                                problem="link uses onclick or data-href instead of a real href",
                                snippet=str(a)[:300]))

    for el in soup.find_all(lambda t: t.name not in ("a", "link", "script", "meta") and (
            t.has_attr("data-href") or t.has_attr("onclick") or t.has_attr("data-url"))):
        blob = " ".join(str(el.get(k, "")) for k in ("onclick", "data-href", "data-url"))
        if matcher.mentioned_in(blob):
            hits.append(LinkHit("not-crawlable", "", "", [], " ".join(el.get_text(" ", strip=True).split())[:120],
                                crawlable=False,
                                problem=f"a <{el.name}> acts as a link through JavaScript; Google cannot follow it",
                                snippet=str(el)[:300]))
    return hits


def visible_text_mentions(html: str, matcher: TargetMatcher) -> bool:
    soup = soup_of(html)
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    return matcher.mentioned_in(soup.get_text(" "))


def robots_tokens(content: str) -> set[str]:
    tokens = {t.strip().lower() for t in content.split(",") if t.strip()}
    if "none" in tokens:
        tokens |= {"noindex", "nofollow"}
    return tokens


def meta_robots(html: str) -> dict[str, set[str]]:
    """Directives from <meta name="robots"> and <meta name="googlebot">."""
    soup = soup_of(html)
    found: dict[str, set[str]] = {}
    for m in soup.find_all("meta"):
        name = (m.get("name") or "").strip().lower()
        if name in ("robots", "googlebot"):
            found.setdefault(name, set()).update(robots_tokens(m.get("content", "")))
    return found


def x_robots(header_values: list[str]) -> set[str]:
    """Directives from X-Robots-Tag headers that apply to Googlebot."""
    tokens: set[str] = set()
    for value in header_values:
        v = value.strip()
        m = re.match(r"^([a-z][a-z0-9_-]*)\s*:\s*(.*)$", v, re.I)
        if m and m.group(1).lower() not in ("noindex", "nofollow", "none", "noarchive", "nosnippet",
                                            "unavailable_after", "max-snippet", "max-image-preview",
                                            "max-video-preview", "notranslate", "noimageindex", "all"):
            if m.group(1).lower() != "googlebot":
                continue
            v = m.group(2)
        tokens |= robots_tokens(v)
    return tokens


def canonical(html: str, page_url: str, link_headers: list[str] | None = None) -> str | None:
    soup = soup_of(html)
    base = base_url(soup, page_url)
    for link in soup.find_all("link", href=True):
        rel = [r.lower() for r in (link.get("rel") or [])]
        if "canonical" in rel:
            return urljoin(base, link["href"].strip())
    for header in link_headers or []:
        for part in header.split(","):
            m = re.match(r'\s*<([^>]+)>\s*;.*rel="?canonical"?', part, re.I)
            if m:
                return urljoin(page_url, m.group(1))
    return None


def outbound_sites(html: str, page_url: str) -> set[str]:
    """Distinct external sites the page links to (any rel)."""
    soup = soup_of(html)
    base = base_url(soup, page_url)
    own = site_of(page_url)
    sites: set[str] = set()
    for a in soup.find_all("a", href=True):
        absolute = urljoin(base, a["href"].strip())
        if absolute.lower().startswith(("http://", "https://")):
            s = site_of(absolute)
            if s and s != own:
                sites.add(s)
    return sites
