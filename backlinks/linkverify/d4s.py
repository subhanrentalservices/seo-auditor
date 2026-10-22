"""DataForSEO client with cost logging and a monthly budget cap.

Every call's cost (returned by DataForSEO in each response) is saved to the
api_costs table. When this month's total reaches `monthly_budget_usd`, calls
stop with BudgetExceeded instead of spending more.
"""

from __future__ import annotations

import httpx

from .config import Config
from .db import Registry

BASE = "https://api.dataforseo.com/v3/"


class DataForSEOError(RuntimeError):
    pass


class BudgetExceeded(DataForSEOError):
    pass


class Client:
    def __init__(self, cfg: Config):
        if not cfg.has_dataforseo:
            raise DataForSEOError("DataForSEO is not connected (Settings, Optional extras)")
        self.cfg = cfg

    def spent_this_month(self) -> float:
        reg = Registry(self.cfg.db_path)
        try:
            return reg.month_cost("dataforseo")
        finally:
            reg.close()

    def post(self, endpoint: str, task: dict) -> list[dict]:
        """POST one task to a Live endpoint; returns tasks[0].result (a list)."""
        spent = self.spent_this_month()
        if spent >= self.cfg.dataforseo_monthly_budget_usd:
            raise BudgetExceeded(
                f"DataForSEO budget reached: ${spent:.2f} of ${self.cfg.dataforseo_monthly_budget_usd:.2f} this month "
                "(raise the monthly budget in Settings, Optional extras to continue)")
        try:
            resp = httpx.post(BASE + endpoint.strip("/"), auth=(self.cfg.dataforseo_login, self.cfg.dataforseo_password),
                              json=[task], timeout=max(self.cfg.timeout_seconds, 90))
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise DataForSEOError(f"DataForSEO request failed: {exc}") from exc
        cost = data.get("cost") or 0
        reg = Registry(self.cfg.db_path)
        try:
            reg.log_cost("dataforseo", endpoint.strip("/"), cost)
        finally:
            reg.close()
        if data.get("status_code") != 20000:
            raise DataForSEOError(f"DataForSEO: {data.get('status_message', 'error')} ({data.get('status_code')})")
        t = (data.get("tasks") or [{}])[0]
        if t.get("status_code") != 20000:
            raise DataForSEOError(f"DataForSEO: {t.get('status_message', 'task error')} ({t.get('status_code')})")
        return t.get("result") or []

    def serp(self, query: str, depth: int = 20) -> list[dict]:
        """Organic Google results for a query: [{url, title, description, domain, rank}]."""
        result = self.post("serp/google/organic/live/regular", {
            "keyword": query, "location_code": self.cfg.dataforseo_location_code,
            "language_code": self.cfg.dataforseo_language_code, "depth": depth,
        })
        out = []
        for r in result:
            for item in r.get("items") or []:
                if item.get("type") == "organic" and item.get("url"):
                    out.append({"url": item["url"], "title": item.get("title") or "",
                                "description": item.get("description") or "", "domain": item.get("domain") or "",
                                "rank": item.get("rank_absolute")})
        return out
