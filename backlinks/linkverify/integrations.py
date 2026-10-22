"""Optional paid or keyed data sources. Each returns None when not configured.

* Ahrefs API v3 - Domain Rating of the linking site.
* DataForSEO SERP API - is the linking page seen in Google results?
* Google Search Console URL Inspection API - is YOUR target page indexed?
  (Only works for a property you own; 2,000 inspections per day.)
"""

from __future__ import annotations

from datetime import date

import httpx

from .config import Config
from .domains import normalize_url


def _find_number(obj, key: str):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key and isinstance(v, (int, float)):
                return v
            found = _find_number(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_number(v, key)
            if found is not None:
                return found
    return None


def ahrefs_domain_rating(cfg: Config, site: str) -> tuple[float | None, str]:
    if not cfg.ahrefs_api_key:
        return None, "Ahrefs API key not set"
    try:
        resp = httpx.get(
            "https://api.ahrefs.com/v3/site-explorer/domain-rating",
            params={"target": site, "date": date.today().isoformat()},
            headers={"Authorization": f"Bearer {cfg.ahrefs_api_key}", "Accept": "application/json"},
            timeout=cfg.timeout_seconds,
        )
        if resp.status_code != 200:
            return None, f"Ahrefs API returned {resp.status_code}: {resp.text[:200]}"
        dr = _find_number(resp.json(), "domain_rating")
        if dr is None:
            return None, "Ahrefs response had no domain_rating field"
        return float(dr), "Ahrefs API"
    except (httpx.HTTPError, ValueError) as exc:
        return None, f"Ahrefs API error: {exc}"


def dataforseo_seen_in_google(cfg: Config, page_url: str) -> tuple[bool | None, str]:
    """Searches Google for the page URL through DataForSEO. A sample, not proof."""
    if not cfg.has_dataforseo:
        return None, "DataForSEO login not set"
    from .d4s import Client, DataForSEOError

    query = "site:" + page_url.split("://", 1)[-1].split("#", 1)[0]
    try:
        items = Client(cfg).serp(query, depth=10)
    except DataForSEOError as exc:
        return None, str(exc)
    want = normalize_url(page_url)
    if any(normalize_url(i["url"]) == want for i in items):
        return True, f"seen in Google results for '{query}'"
    return False, f"not seen in Google results for '{query}'"


def gsc_inspect(cfg: Config, url: str) -> tuple[str | None, str]:
    """Index coverage state of one of YOUR pages, from Search Console."""
    if not cfg.has_gsc:
        return None, "Search Console not set up"
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import service_account
    except ImportError:
        return None, "install google-auth to use Search Console: pip install google-auth"
    try:
        creds = service_account.Credentials.from_service_account_file(
            cfg.gsc_service_account_file, scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
        )
        creds.refresh(Request())
        resp = httpx.post(
            "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
            headers={"Authorization": f"Bearer {creds.token}"},
            json={"inspectionUrl": url, "siteUrl": cfg.gsc_property},
            timeout=cfg.timeout_seconds,
        )
        if resp.status_code != 200:
            return None, f"Search Console returned {resp.status_code}: {resp.text[:200]}"
        index = resp.json().get("inspectionResult", {}).get("indexStatusResult", {})
        return index.get("verdict"), index.get("coverageState", "")
    except Exception as exc:
        return None, f"Search Console error: {exc}"
