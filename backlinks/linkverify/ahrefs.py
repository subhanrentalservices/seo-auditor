"""Ahrefs Domain Rating (DR) and URL Rating (UR), in batches of up to 100, cached.

Uses the Batch Analysis endpoint of Ahrefs API v3:
POST https://api.ahrefs.com/v3/batch-analysis/batch-analysis
Results are cached in the database for `cache_days` (default 30) so the same
site is not paid for twice.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx

from .config import Config
from .db import Registry, now_iso
from .domains import site_of

URL = "https://api.ahrefs.com/v3/batch-analysis/batch-analysis"


def _cache_key(kind: str, target: str) -> str:
    return f"ahrefs:{kind}:{target}"


def _fresh(stamp: str, days: int) -> bool:
    try:
        dt = datetime.fromisoformat(stamp)
    except ValueError:
        return False
    dt = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - dt < timedelta(days=days)


def _post(cfg: Config, targets: list[dict]) -> list[dict]:
    resp = httpx.post(URL, headers={"Authorization": f"Bearer {cfg.ahrefs_api_key}", "Accept": "application/json"},
                      json={"select": ["domain_rating", "url_rating"], "targets": targets, "output": "json"},
                      timeout=max(cfg.timeout_seconds, 60))
    if resp.status_code != 200:
        raise RuntimeError(f"Ahrefs API returned {resp.status_code}: {resp.text[:200]}")
    return resp.json().get("targets") or []


def metrics(cfg: Config, sites: list[str] = (), pages: list[str] = ()) -> dict[str, dict]:
    """{"site:example.com": {"dr": 71.0}, "page:https://...": {"dr": .., "ur": ..}} for what could be found.

    Raises RuntimeError on API errors; returns {} when no key is set.
    """
    if not cfg.ahrefs_api_key:
        return {}
    out: dict[str, dict] = {}
    reg = Registry(cfg.db_path)
    try:
        want: list[tuple[str, dict]] = []
        for s in dict.fromkeys(site_of(x) for x in sites if x):
            key = _cache_key("site", s)
            cached = reg.get_meta(key)
            if cached:
                c = json.loads(cached)
                if _fresh(c.get("at", ""), cfg.ahrefs_cache_days):
                    out[f"site:{s}"] = c
                    continue
            want.append((key, {"url": f"https://{s}", "mode": "domain", "protocol": "both"}))
        for p in dict.fromkeys(x for x in pages if x):
            key = _cache_key("page", p)
            cached = reg.get_meta(key)
            if cached:
                c = json.loads(cached)
                if _fresh(c.get("at", ""), cfg.ahrefs_cache_days):
                    out[f"page:{p}"] = c
                    continue
            want.append((key, {"url": p, "mode": "exact", "protocol": "both"}))
        for i in range(0, len(want), 100):
            chunk = want[i:i + 100]
            rows = _post(cfg, [t for _, t in chunk])
            by_index = {r.get("index", n): r for n, r in enumerate(rows)}
            for n, (key, t) in enumerate(chunk):
                r = by_index.get(n)
                if not r:
                    continue
                val = {"dr": r.get("domain_rating"), "ur": r.get("url_rating"), "at": now_iso()}
                reg.set_meta(key, json.dumps(val))
                name = key.split(":", 2)
                out[f"{name[1]}:{name[2]}"] = val
    finally:
        reg.close()
    return out


def strength(dr: float | None, ur: float | None) -> float | None:
    """One 0-100 number: mostly the site's DR, partly the page's own UR."""
    if dr is None and ur is None:
        return None
    if ur is None:
        return float(dr)
    if dr is None:
        return float(ur)
    return round(0.7 * float(dr) + 0.3 * float(ur), 1)
