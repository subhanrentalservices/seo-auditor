"""What changed between two checks of the same link."""

from __future__ import annotations

from dataclasses import dataclass

from .checks import VERDICT_ORDER


@dataclass
class Change:
    kind: str
    severity: str  # bad | good | info
    detail: str


def _check(result: dict, num: int) -> dict:
    return next((c for c in result.get("checks", []) if c["num"] == num), {})


def _rank(verdict: str | None) -> int:
    return VERDICT_ORDER.index(verdict) if verdict in VERDICT_ORDER else -1


def diff(prev: dict | None, new: dict) -> list[Change]:
    """Changes worth recording. The first check of a link produces none."""
    if not prev:
        return []
    out: list[Change] = []
    pv, nv = prev.get("verdict"), new.get("verdict")
    if pv != nv:
        worse = _rank(nv) < _rank(pv)
        out.append(Change("verdict", "bad" if worse else "good", f"Verdict changed from {pv} to {nv}."))

    p_link, n_link = prev.get("link") or {}, new.get("link") or {}
    p_found, n_found = prev.get("links_found") or 0, new.get("links_found") or 0
    if p_found and not n_found:
        out.append(Change("link_removed", "bad", "Your link is no longer on the page."))
    elif not p_found and n_found:
        out.append(Change("link_back", "good", "Your link is on the page again."))

    if p_found and n_found:
        p_rel, n_rel = set(p_link.get("rel") or []), set(n_link.get("rel") or [])
        weak = {"nofollow", "ugc", "sponsored"}
        if p_rel != n_rel:
            gained, lost = (n_rel - p_rel) & weak, (p_rel - n_rel) & weak
            sev = "bad" if gained else ("good" if lost else "info")
            out.append(Change("rel_changed", sev,
                              f'rel changed from "{" ".join(sorted(p_rel)) or "none"}" to "{" ".join(sorted(n_rel)) or "none"}".'))
        if (p_link.get("anchor_text") or "") != (n_link.get("anchor_text") or ""):
            out.append(Change("anchor_changed", "info",
                              f'Anchor text changed from "{p_link.get("anchor_text", "")}" to "{n_link.get("anchor_text", "")}".'))

    for num, label in ((7, "meta robots"), (8, "X-Robots-Tag header")):
        p, n = _check(prev, num), _check(new, num)
        if p.get("status") != "fail" and n.get("status") == "fail":
            out.append(Change("noindex", "bad", f"The page is now noindex ({label})."))

    if _check(prev, 9).get("status") != "fail" and _check(new, 9).get("status") == "fail":
        out.append(Change("robots_blocked", "bad", "robots.txt now blocks Google from the page."))

    p_status, n_status = prev.get("status"), new.get("status")
    if p_status == 200 and n_status != 200:
        out.append(Change("page_error", "bad", f"The page now returns HTTP {n_status or 'error'}."))

    if prev.get("final_url") and new.get("final_url") and prev["final_url"] != new["final_url"]:
        out.append(Change("redirect", "info", f"The page now ends at {new['final_url']}."))
    return out
