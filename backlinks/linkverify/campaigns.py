"""Pickup tracking for data studies and other digital PR campaigns.

A campaign is one asset you published (for example a survey or price study) plus a
few phrases that people will use when they write about it. Each weekly run:

1. asks DataForSEO for new backlinks to the asset first seen after the start date,
   and adds each linking page to your registry (so it gets the 15 checks);
2. searches Google (DataForSEO SERP) for each phrase, opens the pages, and
   - adds pages that link to you to the registry,
   - turns pages that mention the study without a link into "unlinked mention"
     opportunities, tagged with the campaign.

Read-only: it only reads public pages and the DataForSEO API.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

from . import parse
from .d4s import DataForSEOError
from .domains import TargetMatcher, normalize_url, site_of
from .finders import Context, FinderResult, Pending, _key, page_title, snippet, visible_text


def _start_dt(row) -> datetime:
    raw = (row["started_at"] or row["created_at"] or "")[:19]
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        dt = datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def is_active(row, active_days: int, now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    return now - _start_dt(row) <= timedelta(days=active_days)


def strategy_name(row) -> str:
    return f"digital PR: {row['name']}"


def _new_backlinks(ctx: Context, row, res: FinderResult) -> list[dict]:
    since = _start_dt(row).strftime("%Y-%m-%d %H:%M:%S +00:00")
    try:
        result = ctx.client.post("backlinks/backlinks/live", {
            "target": row["asset_url"], "mode": "as_is", "limit": 500,
            "filters": ["first_seen", ">", since], "order_by": ["first_seen,desc"],
        })
    except DataForSEOError as exc:
        res.errors.append(f"{row['name']}: new backlinks not looked up: {exc}")
        return []
    out = []
    for r in result:
        for item in r.get("items") or []:
            if item.get("url_from") and not item.get("is_lost"):
                out.append(item)
    return out


def check_campaign(ctx: Context, row, res: FinderResult) -> dict:
    """Run one campaign. Returns {"linked": [link ids], "mentions": [opp ids]}."""
    cfg, reg = ctx.cfg, ctx.reg
    cid = row["id"]
    phrases = json.loads(row["phrases_json"] or "[]")
    asset = row["asset_url"]
    mine = site_of(cfg.my_site) if cfg.my_site else site_of(asset)
    asset_match = TargetMatcher(asset)
    site_match = TargetMatcher(mine)
    out = {"linked": [], "mentions": []}

    def register(url: str, title: str, target: str, source: str) -> None:
        link_id, created = reg.add(url, target, strategy_name(row), f"pickup found by {source}")
        if reg.add_pickup(cid, normalize_url(url), site_of(url), title[:300], "linked", source, link_id=link_id):
            out["linked"].append(link_id)
            res.registered += 1

    # 1. new backlinks to the asset (DataForSEO Backlinks)
    if ctx.client is not None:
        for item in _new_backlinks(ctx, row, res):
            url = item["url_from"]
            if site_of(url) == mine or reg.has_pickup(cid, normalize_url(url)):
                continue
            register(url, item.get("page_from_title") or "", asset, "DataForSEO backlinks")

    # 2. pages that mention the study: Google search for each phrase (DataForSEO), or your free Google Alerts feeds
    if not phrases:
        return out
    candidates: dict[str, dict] = {}
    if ctx.client is not None:
        for phrase in phrases:
            try:
                for item in ctx.serp(f'"{phrase}" -site:{mine}', depth=30):
                    candidates.setdefault(normalize_url(item["url"]), {**item, "phrase": phrase})
            except DataForSEOError as exc:
                res.errors.append(f"{row['name']}: search failed: {exc}")
                break
    elif cfg.google_alerts_feeds:
        from .finders import parse_alerts_feed
        for feed in cfg.google_alerts_feeds:
            f = ctx.fetcher.get(feed, use_cache=False)
            if f.ok:
                for e in parse_alerts_feed(f.text):
                    candidates.setdefault(normalize_url(e["url"]), {"url": e["url"], "title": e["title"]})
    else:
        res.notes.append(f"{row['name']}: to catch pages that write about the study, create a free Google Alert for its "
                         "key phrase with 'Deliver to: RSS feed' and add the feed in Settings, Free sources.")
        return out
    source = "Google search" if ctx.client is not None else "Google Alerts"
    for norm, c in candidates.items():
        site = site_of(c["url"])
        if site == mine or reg.has_pickup(cid, norm):
            continue
        if not ctx.take_page():
            res.notes.append("Page limit for this run reached; the rest will be checked next run.")
            break
        page = ctx.fetcher.get(c["url"])
        if not page.ok:
            continue
        text = visible_text(page.text)
        phrase = next((p for p in phrases if re.search(r"(?<!\w)" + re.escape(p) + r"(?!\w)", text, re.I)), None)
        if not phrase:
            continue  # the search result is stale; the phrase is not on the page now
        title = page_title(page.text) or c.get("title") or ""
        to_asset = [h for h in parse.find_links(page.text, page.final_url, asset_match) if h.kind == "a"]
        to_site = to_asset or [h for h in parse.find_links(page.text, page.final_url, site_match) if h.kind == "a"]
        if to_site:
            register(page.final_url, title, asset if to_asset else mine, source)
            continue
        key = _key("mention", normalize_url(page.final_url))
        p = Pending(
            "unlinked_mention", key, page.final_url, title, site,
            text=snippet(text, phrase, 300),
            outbound_sites=len(parse.outbound_sites(page.text, page.final_url)),
            data={"brand": phrase, "context": snippet(text, phrase), "source": f"campaign: {row['name']}",
                  "campaign": row["name"], "campaign_id": cid, "suggested_page": asset,
                  "how": f"This page writes about your study \"{row['name']}\" without linking to it. "
                         f"Thank the author and ask them to cite the study with a link to {asset}."},
        )
        before = res.new
        ctx.save_all([p], res)
        opp_id = reg.opportunity_id(key)
        if reg.add_pickup(cid, norm, site, title[:300], "mention", source, opp_id=opp_id):
            if opp_id and res.new > before:
                out["mentions"].append(opp_id)
    return out


def find_campaigns(ctx: Context) -> FinderResult:
    res = FinderResult("campaigns")
    rows = [r for r in ctx.reg.campaigns() if is_active(r, ctx.cfg.campaign_active_days)]
    if not rows:
        res.notes.append("No active campaigns. Add one with: linkverify campaign add")
        return res
    for row in rows:
        try:
            check_campaign(ctx, row, res)
        finally:
            ctx.reg.touch_campaign(row["id"])
    if res.registered:
        res.notes.append(f"{res.registered} new page(s) link to your studies; added them to your link registry.")
    return res


def run_campaign(cfg, reg, cid: int, fetcher=None, client=None, progress=None) -> tuple[FinderResult, dict]:
    """Check one campaign now (CLI `campaign check`, dashboard "Check now")."""
    row = reg.campaign(cid)
    if row is None:
        raise KeyError(f"No campaign {cid}")
    ctx = Context(cfg, reg, fetcher, client, progress)
    res = FinderResult("campaigns")
    try:
        out = check_campaign(ctx, row, res)
    finally:
        reg.touch_campaign(cid)
        ctx.close()
    return res, out
