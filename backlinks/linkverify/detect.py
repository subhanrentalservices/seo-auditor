"""Read a website's home page and suggest settings for it (used when you add a site).

Suggests the brand name, the services you talk about (topics), the pages worth
promoting, public contact emails and social profiles, and spots address problems
such as a www version that doesn't exist. Read-only.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from . import parse
from .config import Config
from .domains import site_of
from .fetcher import Fetcher

SOCIAL = {"facebook.com": "Facebook", "instagram.com": "Instagram", "linkedin.com": "LinkedIn", "x.com": "X",
          "twitter.com": "X", "youtube.com": "YouTube", "tiktok.com": "TikTok", "pinterest.com": "Pinterest",
          "yelp.com": "Yelp", "g.page": "Google Business Profile", "maps.app.goo.gl": "Google Maps"}
SKIP_PAGE = re.compile(r"privacy|terms|cookie|login|sign-?in|cart|checkout|account|wp-admin|feed|tag/|category/|author/|"
                       r"sitemap|thank|404|search", re.I)
SKIP_TEXT = re.compile(r"^(home|about( us)?|contact( us)?|blog|news|faq|privacy.*|terms.*|login|book( now| online)?|"
                       r"(our |all )?services|locations?|gallery|reviews|testimonials|careers|team|shop|cart|"
                       r"call( us)?( now)?|get (a )?quote|menu|close|more|read more|learn more|skip to .*|\d+)$", re.I)
SEPARATORS = re.compile(r"\s+[|–—\-:·•]\s+")


GENERIC = re.compile(r"^(home( ?page)?|welcome|official (web)?site|index|main|blog|news|shop|store|services?|about( us)?|contact( us)?|"
                     r"melbourne|sydney|brisbane|perth|adelaide|lahore|karachi|islamabad|london|australia|pakistan)$", re.I)


def _brand(soup, domain: str) -> list[str]:
    """Likely business names, best first: the site's declared name, then the part of the title that matches the domain."""
    out: list[str] = []
    og = soup.find("meta", attrs={"property": "og:site_name"})
    if og and (og.get("content") or "").strip():
        out.append(og["content"].strip())
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        m = re.search(r'"@type"\s*:\s*"(?:AutoRepair|LocalBusiness|Organization|AutomotiveBusiness|Store|AutoBodyShop)"[^{}]*?"name"\s*:\s*"([^"]{2,60})"',
                      tag.string or "", re.S)
        if m:
            out.append(m.group(1).strip())
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    parts = [p.strip() for p in SEPARATORS.split(title) if p.strip() and not GENERIC.match(p.strip())]
    squash = lambda t: re.sub(r"[^a-z0-9]", "", t.lower())  # noqa: E731
    stem = squash(domain.split(".")[0])
    out += [p for p in parts if stem and (squash(p) in stem or stem in squash(p))]
    if len(parts) > 1:
        out.append(parts[-1])  # sites usually end the title with their name
    seen, uniq = set(), []
    for b in out:
        if b.lower() not in seen and 2 < len(b) <= 60 and not GENERIC.match(b):
            seen.add(b.lower())
            uniq.append(b)
    return uniq[:3]


def detect(cfg: Config, domain: str, fetcher: Fetcher | None = None) -> dict:
    domain = domain.strip().lower().removeprefix("https://").removeprefix("http://").split("/")[0].removeprefix("www.")
    own = fetcher is None
    fetcher = fetcher or Fetcher(cfg)
    out: dict = {"domain": domain, "reachable": False, "final_url": "", "title": "", "description": "", "brand_names": [],
                 "topics": [], "pages": [], "emails": [], "social": [], "problems": []}
    try:
        page = None
        for start in (f"https://{domain}/", f"http://{domain}/", f"https://www.{domain}/"):
            page = fetcher.get(start)
            if page.ok:
                break
        if page is None or not page.ok:
            out["problems"].append(f"Could not open {domain}: {page.error if page else ''} {page.status if page else ''}".strip())
            return out
        out["reachable"] = True
        out["final_url"] = page.final_url
        soup = parse.soup_of(page.text)
        out["title"] = " ".join(soup.title.get_text(" ", strip=True).split()) if soup.title else ""
        desc = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
        out["description"] = (desc.get("content") or "").strip() if desc else ""
        out["brand_names"] = _brand(soup, domain)
        base = parse.base_url(soup, page.final_url)
        site = site_of(page.final_url)

        # topics: the words of your own menu, which on a business site are your services
        nav_links = []
        for container in soup.find_all(["nav", "header"]) or [soup]:
            for a in container.find_all("a", href=True):
                nav_links.append(a)
        nav_ids = {id(a) for a in nav_links}
        topics: list[str] = []
        pages: list[str] = []
        for a in nav_links + soup.find_all("a", href=True):
            href = urljoin(base, a["href"].strip()).split("#")[0]
            if not href.startswith(("http://", "https://")) or site_of(href) != site:
                continue
            text = " ".join(a.get_text(" ", strip=True).split())
            path = urlsplit(href).path
            if path in ("", "/") or SKIP_PAGE.search(path):
                continue
            if text and 3 <= len(text) <= 40 and not SKIP_TEXT.match(text) and text.lower() not in (t.lower() for t in topics):
                if id(a) in nav_ids and len(topics) < 8:
                    topics.append(text)
            if href not in pages and len(pages) < 8 and id(a) in nav_ids:
                pages.append(href)
        out["topics"] = topics
        out["pages"] = pages[:6]

        # social profiles and public emails
        social = {}
        for a in soup.find_all("a", href=True):
            href = a["href"].strip()
            if href.lower().startswith("mailto:"):
                e = href[7:].split("?")[0].strip().lower()
                if e and e not in out["emails"]:
                    out["emails"].append(e)
                continue
            s = site_of(href) if href.startswith("http") else ""
            for key, name in SOCIAL.items():
                if s == key or s.endswith("." + key) or (key in href and s == site_of("https://" + key)):
                    social.setdefault(name, href.split("?")[0])
        out["social"] = [{"name": k, "url": v} for k, v in social.items()]

        # address variants: every way of typing the address should reach the site
        bare = domain.split(":")[0]
        variants = () if re.fullmatch(r"[\d.]+|localhost", bare) else (f"https://www.{domain}/", f"http://{domain}/")
        for v in variants:
            r = fetcher.get(v)
            if r.error and re.search(r"getaddrinfo|Name or service|nodename|No address|11001|Errno -2", r.error):
                out["problems"].append(f"{v} does not exist (no DNS record). Links that use it are dead. "
                                       f"Add a DNS record for it and redirect it to https://{domain}/.")
            elif r.error:
                out["problems"].append(f"{v} could not be opened: {r.error[:80]}")
            elif site_of(r.final_url) != site or r.status != 200:
                out["problems"].append(f"{v} ends on {r.final_url} (HTTP {r.status}), not your home page.")
    finally:
        if own:
            fetcher.close()
    return out
