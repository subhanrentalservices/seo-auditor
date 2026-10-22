"""Platform link-type tester.

Public "dofollow site" lists are often wrong. This tests a platform for real:
give it a page on the platform where a user placed a link (a profile with a
website field, a post, a listing) and the site that link points to. It runs
the full 15-check verifier on that link and also lists how every outbound link
on the page is marked, so you can see the platform's policy.
"""

from __future__ import annotations

from collections import Counter
from urllib.parse import urljoin

from . import parse
from .checks import COUNTS, NOT_COUNTED, PENDING, WEAK, Verifier
from .domains import _extract, host_of, site_of


def _is_platform_subdomain(host: str) -> bool:
    """True for hosts like you.blogspot.com, where each user gets their own site."""
    try:
        return bool(getattr(_extract(host), "is_private", False))
    except Exception:
        return False


def outbound_rel_table(html: str, page_url: str) -> list[dict]:
    soup = parse.soup_of(html)
    base = parse.base_url(soup, page_url)
    own = site_of(page_url)
    rows: dict[str, dict] = {}
    for a in soup.find_all("a", href=True):
        url = urljoin(base, a["href"].strip())
        if not url.lower().startswith(("http://", "https://")):
            continue
        s = site_of(url)
        if not s or s == own:
            continue
        rel = " ".join(sorted(t.lower() for t in (a.get("rel") or []))) or "none (followed)"
        key = f"{s}|{rel}"
        if key not in rows:
            rows[key] = {"site": s, "rel": rel, "anchor": " ".join(a.get_text(" ", strip=True).split())[:60], "count": 0}
        rows[key]["count"] += 1
    return sorted(rows.values(), key=lambda r: (-r["count"], r["site"]))


def test_platform(cfg, url: str, link_target: str | None, verifier: Verifier | None = None) -> dict:
    own_verifier = verifier is None
    verifier = verifier or Verifier(cfg)
    try:
        page = verifier.fetcher.get(url)
        table = outbound_rel_table(page.text, page.final_url or url) if page.ok else []
        rel_counts = Counter()
        for r in table:
            rel_counts["followed" if r["rel"].startswith("none") else r["rel"]] += r["count"]
        host = host_of(page.final_url or url)
        summary = {
            "url": url, "final_url": page.final_url, "status": page.status, "error": page.error,
            "site": site_of(url), "platform_subdomain": _is_platform_subdomain(host),
            "outbound": table[:60], "rel_counts": dict(rel_counts), "link_target": link_target,
        }
        if link_target:
            res = verifier.verify(url, link_target, None, check_target=False)
            summary["result"] = {k: res.get(k) for k in ("verdict", "reasons", "notes", "checks", "link")}
            v = res["verdict"]
            link = res.get("link") or {}
            if v in (COUNTS, PENDING):
                verdict = "Followed (dofollow) link"
            elif v == WEAK:
                rel = " ".join(link.get("rel") or [])
                verdict = f"Weak: {rel or 'see reasons'}"
            else:
                verdict = "Not counted: " + (res["reasons"][0].split(": ", 1)[-1] if res["reasons"] else "see checks")
        elif not page.ok:
            verdict = f"Could not load (HTTP {page.status or page.error})"
        elif not table:
            verdict = "No outbound links found"
        else:
            followed = rel_counts.get("followed", 0)
            total = sum(rel_counts.values())
            verdict = (f"{followed} of {total} outbound links are followed. Add --link with the site a user linked to "
                       "for an exact answer.")
        if summary["platform_subdomain"]:
            summary["note"] = ("Each user gets their own subdomain here, so your page counts as its own small site; "
                               "the platform's DR does not pass to it.")
        summary["verdict"] = verdict
        return summary
    finally:
        if own_verifier:
            verifier.close()
