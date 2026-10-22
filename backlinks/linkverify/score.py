"""Opportunity score, 0-100. Higher = work on it first.

score = kind base + site strength + topic relevance + bonuses - penalties

* kind base: how often this kind turns into a link (unlinked mentions convert
  best, then journalist requests, broken links, competitor gaps, resource pages)
* site strength: Ahrefs DR or DataForSEO rank (0-100 scale) x 0.35, so up to 35
* relevance: 7 points per topic word found, up to 20
* bonuses: fresh journalist requests, gaps shared by 3+ competitors
* penalties: pages that link to very many other sites
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

BASE = {
    "unlinked_mention": 35,
    "journalist": 30,
    "broken_backlink": 25,
    "broken_link": 25,
    "gap": 20,
    "resource_page": 10,
    "profile": 45,  # your own social profile: you control it
    "listing": 30,  # a free listing you create yourself
    "partner": 15,
}


def topic_hits(text: str, topics: list[str]) -> list[str]:
    low = (text or "").lower()
    hits = []
    for t in topics:
        t = t.strip().lower()
        if t and re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", low):
            hits.append(t)
    return hits


def score(kind: str, *, strength: float | None = None, text: str = "", topics: list[str] | None = None,
          competitors_shared: int = 0, published: str | None = None, outbound_sites: int | None = None) -> tuple[int, str]:
    parts: list[str] = []
    total = BASE.get(kind, 10)
    parts.append(f"{kind.replace('_', ' ')} {total}")

    if strength is None:
        total += 10
        parts.append("strength unknown +10")
    else:
        s = round(max(0.0, min(100.0, float(strength))) * 0.35)
        total += s
        parts.append(f"strength {strength:g} +{s}")

    hits = topic_hits(text, topics or [])
    if hits:
        r = min(20, 7 * len(hits))
        total += r
        parts.append(f"topics ({', '.join(hits[:4])}) +{r}")

    if kind == "partner" and competitors_shared >= 2:
        b = min(15, 5 * competitors_shared)
        total += b
        parts.append(f"linked from {competitors_shared} competitors +{b}")

    if kind == "gap" and competitors_shared >= 3:
        b = min(10, 5 * (competitors_shared - 2))
        total += b
        parts.append(f"links to {competitors_shared} competitors +{b}")

    if published and kind in ("journalist", "unlinked_mention"):
        try:
            dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            age_days = (datetime.now(timezone.utc) - dt).total_seconds() / 86400
            if kind == "journalist" and age_days <= 2:
                total += 10
                parts.append("fresh request +10")
            elif kind == "unlinked_mention" and age_days <= 30:
                total += 5
                parts.append("recent mention +5")
        except ValueError:
            pass

    if outbound_sites is not None and outbound_sites > 100:
        total -= 10
        parts.append(f"{outbound_sites} outbound sites -10")

    return max(0, min(100, int(total))), "; ".join(parts)
