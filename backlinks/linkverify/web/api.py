"""The app's JSON API. Every handler takes a Req and returns data (or raises ApiError)."""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from .. import __version__, workspace
from ..domains import site_of
from ..monitor import is_due, next_due
from . import actions
from .connections import TESTS
from .server import ApiError, Raw, Req, route

GROUPS = [
    ("site", "Your website", "What the tool needs to know to find links for this site."),
    ("profile", "You", "Used to sign outreach emails and journalist answers. Drafts say nothing about you beyond this."),
    ("free", "Free sources", "Where the tool looks for links. All free: no accounts to pay for, no email needed."),
    ("notify", "Notifications", "How you hear about lost links and good opportunities. Everything also waits for you on Today."),
    ("finding", "Finding opportunities", "How hard to look each run."),
    ("checking", "Checking links", "How links are checked and re-checked. Shared by all your sites."),
    ("extras", "Optional extras", "Not needed: the tool works fully without these. Paid data services, and email or Telegram, if you ever want them."),
]
TEST_FOR_GROUP = {"extras": ["dataforseo", "ahrefs", "anthropic", "inbox", "alerts"], "free": ["feeds"], "notify": ["notify"]}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _split(url: str) -> tuple[str, str]:
    p = urlsplit(url)
    host = (p.hostname or p.netloc).lower().removeprefix("www.")
    path = (p.path or "/") + (("?" + p.query) if p.query else "")
    return host, path


def _link(reg, row, cfg, now) -> dict:
    res = reg.latest(row["id"]) or {}
    link = res.get("link") or {}
    host, path = _split(row["source_url"])
    return {
        "id": row["id"], "source_url": row["source_url"], "host": host, "path": path, "target": row["target"],
        "strategy": row["strategy"], "notes": row["notes"], "added_at": row["added_at"],
        "last_checked": row["last_checked"], "verdict": row["last_verdict"],
        "anchor": link.get("anchor_text", ""), "rel": link.get("rel") or [],
        "dr": res.get("domain_rating"), "ur": res.get("url_rating"),
        "world_rank": res.get("world_rank"), "popularity": res.get("popularity"),
        "reason": (res.get("reasons") or [""])[0], "due": is_due(row, cfg, now), "next_due": next_due(row, cfg, now).isoformat(),
    }


def _event(e) -> dict:
    host, path = _split(e["source_url"])
    return {"id": e["id"], "link_id": e["link_id"], "at": e["at"], "kind": e["kind"], "severity": e["severity"],
            "detail": e["detail"], "host": host, "path": path}


def _opp(o) -> dict:
    d = json.loads(o["data_json"] or "{}")
    return {"id": o["id"], "kind": o["kind"], "url": o["url"], "title": o["title"], "site": o["site"], "score": o["score"],
            "score_detail": o["score_detail"], "status": o["status"], "found_at": o["found_at"], "updated_at": o["updated_at"],
            "notes": o["notes"], "link_id": o["link_id"], "data": d}


def _jobs(req: Req) -> dict:
    return {"checks": req.site.checks.state(), "task": req.site.tasks.state()}


def _editable(req: Req) -> None:
    if not req.app.editable:
        raise ApiError(400, "Settings can't be changed here: start the app from the project folder (dashboard.bat).")


# --------------------------------------------------------------------------- app and sites

@route("GET", "/app", site=False)
def app_info(req: Req):
    cfg = req.app.shared_cfg()
    return {"version": __version__, "sites": req.app.site_ids(), "editable": req.app.editable,
            "shared": {"dataforseo": cfg.has_dataforseo, "ahrefs": bool(cfg.ahrefs_api_key), "ai": cfg.has_ai,
                       "alerts": bool(cfg.has_email or cfg.has_telegram), "inbox": cfg.has_imap}}


@route("POST", "/detect", site=False)
def detect_site(req: Req):
    from ..detect import detect
    domain = req.need("domain", "your website address")
    return detect(req.app.shared_cfg(), domain)


@route("POST", "/sites", site=False)
def add_site(req: Req):
    _editable(req)
    domain = req.need("domain", "the website address")
    existing = workspace.site_exists(req.app.config_path, domain)
    if existing:
        raise ApiError(409, f"{existing.domain} is already set up here.")
    try:
        s = workspace.add_site(req.app.config_path, domain)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from None
    changes = {k: v for k, v in (req.body.get("settings") or {}).items() if k in workspace.BY_ATTR and k != "my_site"}
    if changes:
        try:
            workspace.save(req.app.config_path, s.id, changes)
        except ValueError as exc:
            raise ApiError(400, str(exc)) from None
    req.app.reload()
    return {"site": {"id": s.id, "domain": s.domain}}


@route("POST", "/sites/(?P<sid>[^/]+)/remove", site=False)
def remove_site(req: Req):
    _editable(req)
    ctx = req.app.site(req.params["sid"])
    if ctx is not None and (ctx.checks.busy() or ctx.tasks.busy()):
        raise ApiError(409, "This website is busy checking or searching. Try again when it finishes.")
    try:
        dest = workspace.remove_site(req.app.config_path, req.params["sid"])
    except KeyError as exc:
        raise ApiError(404, exc.args[0]) from None
    except OSError as exc:
        raise ApiError(409, f"Windows is still using a file in that folder ({exc.strerror}). Close other copies of the app and try again.") from None
    req.app.forget(req.params["sid"])
    req.app.reload()
    return {"moved_to": str(dest)}


@route("GET", "/schedule", site=False)
def schedule_get(req: Req):
    from .. import schedule
    return schedule.query()


@route("POST", "/schedule", site=False)
def schedule_set(req: Req):
    from .. import schedule
    if req.body.get("action") == "remove":
        ok, msg = schedule.remove_quiet()
    else:
        ok, msg = schedule.install_quiet(str(req.body.get("time") or "10:00"))
    if not ok:
        raise ApiError(400, msg or "Could not change the daily run.")
    return {"message": msg, **schedule.query()}


# --------------------------------------------------------------------------- today and jobs

@route("GET", "/today")
def today(req: Req):
    cfg, now = req.site.cfg, _now()
    reg = req.site.registry()
    try:
        return {"site": cfg.my_site, "summary": actions.summary(reg, cfg, now),
                "actions": actions.build(reg, cfg, now, req.site.tasks.state()),
                "recent": [_event(e) for e in reg.events(None, 12) if e["kind"] != "first_check"][:8],
                "jobs": _jobs(req)}
    finally:
        reg.close()


@route("GET", "/jobs")
def jobs(req: Req):
    return _jobs(req)


def _op_find(which: str, cfg):
    from ..finders import FINDERS, available, run_finders
    names = available(cfg) if which == "all" else [which]
    if not set(names) <= set(FINDERS):
        raise ApiError(400, "Unknown finder.")
    if which != "all" and which not in available(cfg):
        raise ApiError(400, "That source needs the optional DataForSEO connection.")

    def fn(cfg, reg, say):
        say(f"Running {', '.join(names)}")
        res = run_finders(cfg, reg, names, progress=say)
        return {"results": [{"name": r.name, "found": r.found, "new": r.new, "registered": r.registered,
                                            "errors": r.errors, "notes": r.notes} for r in res]}
    return fn


def _op_scan(url: str):
    def fn(cfg, reg, say):
        from ..finders import Context
        from ..freefind import scan_page
        say("Reading the page")
        c = Context(cfg, reg, progress=say)
        try:
            return {"scan": scan_page(c, url)}
        except ValueError as exc:
            from .jobs import TaskMessage
            raise TaskMessage(str(exc)) from None
        finally:
            c.close()
    return fn


def _op_graph(cfg, reg, say):
    from ..sitegraph import crawl, save
    g = crawl(cfg, max_pages=cfg.graph_max_pages, reg=reg, printer=say)
    save(g, cfg)
    data = g.to_json()
    return {"pages": len(g.pages), "notes": g.notes, "issues": len([i for i in data["issues"] if i["severity"] in ("high", "medium")])}


def _op_campaign(cid: int):
    def fn(cfg, reg, say):
        from ..campaigns import run_campaign
        say("Checking the campaign")
        res, out = run_campaign(cfg, reg, cid, progress=say)
        return {"linked": len(out["linked"]), "mentions": len(out["mentions"]), "errors": res.errors, "notes": res.notes}
    return fn


def _ids(value) -> list[int]:
    try:
        return [int(i) for i in (value or [])]
    except (TypeError, ValueError):
        raise ApiError(400, "Link numbers must be whole numbers.") from None


@route("POST", "/run")
def run(req: Req):
    op = req.body.get("op")
    ctx, cfg = req.site, req.site.cfg
    if op == "check":
        reg = ctx.registry()
        try:
            rows, now = reg.all(), _now()
            which = req.body.get("which", "due")
            if which == "all":
                ids = [r["id"] for r in rows]
            elif which == "unchecked":
                ids = [r["id"] for r in rows if not r["last_checked"]]
            elif which == "ids":
                known = {r["id"] for r in rows}
                ids = [i for i in _ids(req.body.get("ids")) if i in known]
            else:
                ids = [r["id"] for r in rows if is_due(r, cfg, now)]
        finally:
            reg.close()
        return {"queued": ctx.checks.add(ids), **_jobs(req)}
    if op == "stop":
        return {"stopping": ctx.tasks.stop(), **_jobs(req)}
    if op == "scan":
        url = str(req.body.get("url", "")).strip()
        if url and "://" not in url:
            url = "https://" + url
        host = (urlsplit(url).hostname or "") if re.fullmatch(r"https?://\S+", url) else ""
        if not ("." in host or host == "localhost"):
            raise ApiError(400, "Paste the full address of a page, like https://example.com/page.")
        if not cfg.my_site:
            raise ApiError(400, "Set your website address in Settings first.")
        if not ctx.tasks.start("check a page", _op_scan(url), {"op": "scan", "url": url}):
            raise ApiError(409, f"Already busy: {ctx.tasks.state()['running']}. Try again when it finishes.")
        return _jobs(req)
    if op in ("find", "graph", "campaign"):
        if not cfg.my_site:
            raise ApiError(400, "Set your website address in Settings first.")
        if op == "find":
            which = str(req.body.get("which", "all"))
            name, fn, spec = f"find {which}", _op_find(which, cfg), {"op": "find", "which": which}
        elif op == "graph":
            name, fn, spec = "map your site", _op_graph, {"op": "graph"}
        else:
            try:
                cid = int(req.body.get("id", 0))
            except (TypeError, ValueError):
                raise ApiError(400, "Unknown campaign.") from None
            name, fn, spec = "check campaign", _op_campaign(cid), {"op": "campaign", "id": cid}
        if not ctx.tasks.start(name, fn, spec):
            raise ApiError(409, f"Already busy: {ctx.tasks.state()['running']}. Try again when it finishes.")
        return _jobs(req)
    raise ApiError(400, "Unknown action.")


# --------------------------------------------------------------------------- links

@route("GET", "/links")
def links(req: Req):
    reg, now = req.site.registry(), _now()
    try:
        return {"links": [_link(reg, r, req.site.cfg, now) for r in reg.all()],
                "events": [_event(e) for e in reg.events(None, 60) if e["kind"] != "first_check"], "jobs": _jobs(req)}
    finally:
        reg.close()


@route("POST", "/links")
def add_link(req: Req):
    url = req.need("source_url", "the page that links to you")
    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    target = str(req.body.get("target") or req.site.cfg.my_site).strip()
    if not target:
        raise ApiError(400, "Enter your site or page as the target.")
    if site_of(url) == site_of(target):
        raise ApiError(400, "That page is on your own site. Enter a page on another site that links to you.")
    reg = req.site.registry()
    try:
        link_id, created = reg.add(url, target, str(req.body.get("strategy", "")), str(req.body.get("notes", "")))
    finally:
        reg.close()
    if req.body.get("check", True):
        req.site.checks.add([link_id])
    return {"id": link_id, "created": created}


@route("GET", "/links/(?P<id>\\d+)")
def link_detail(req: Req):
    reg, now = req.site.registry(), _now()
    try:
        row = reg.get(req.int("id"))
        if not row:
            raise ApiError(404, "That link is not in your list.")
        res = reg.latest(row["id"]) or {}
        shot = Path(res.get("evidence_dir") or "") / "screenshot.png"
        return {"link": _link(reg, row, req.site.cfg, now), "result": res,
                "history": [{"at": h["run_at"], "verdict": h["verdict"]} for h in reg.history(row["id"])][:60],
                "events": [_event(e) for e in reg.events(row["id"], 40)],
                "screenshot": bool(res.get("evidence_dir")) and shot.is_file()}
    finally:
        reg.close()


@route("POST", "/links/(?P<id>\\d+)")
def link_update(req: Req):
    def text(k):
        v = req.body.get(k)
        if v is not None and not isinstance(v, str):
            raise ApiError(400, f"{k} must be text.")
        return v[:5000] if v is not None else None
    reg = req.site.registry()
    try:
        ok = reg.update_link(req.int("id"), text("strategy"), text("notes"))
    finally:
        reg.close()
    return {"updated": ok}


@route("POST", "/links/(?P<id>\\d+)/delete")
def link_delete(req: Req):
    reg = req.site.registry()
    try:
        removed = reg.remove(req.int("id"))
    finally:
        reg.close()
    req.site.checks.drop(req.int("id"))
    return {"removed": removed}


@route("GET", "/links/(?P<id>\\d+)/screenshot")
def link_shot(req: Req):
    reg = req.site.registry()
    try:
        res = reg.latest(req.int("id")) or {}
    finally:
        reg.close()
    ev = res.get("evidence_dir")
    if ev:
        shot = (Path(ev) / "screenshot.png").resolve()
        if shot.is_file() and req.site.cfg.evidence_dir.resolve() in shot.parents:
            return Raw(200, shot.read_bytes(), "image/png")
    raise ApiError(404, "No screenshot.")


# --------------------------------------------------------------------------- opportunities and drafts

@route("GET", "/opps")
def opps(req: Req):
    from ..finders import FINDERS, available
    cfg = req.site.cfg
    reg = req.site.registry()
    try:
        return {"opps": [_opp(o) for o in reg.opportunities(limit=2000)],
                "last_runs": {n: reg.get_meta(f"finder_last_run:{n}") for n in FINDERS},
                "spent": round(reg.month_cost("dataforseo"), 4), "budget": cfg.dataforseo_monthly_budget_usd,
                "sources": {"dataforseo": cfg.has_dataforseo, "inbox": cfg.has_imap, "feeds": len(cfg.google_alerts_feeds),
                            "bluesky": cfg.bluesky_search, "mastodon": cfg.mastodon_search,
                            "competitors": len(cfg.competitors), "topics": len(cfg.topics),
                            "brands": len(cfg.brand_names)},
                "finders": available(cfg), "ai": cfg.has_ai, "jobs": _jobs(req)}
    finally:
        reg.close()


@route("POST", "/opps/(?P<id>\\d+)")
def opp_update(req: Req):
    reg = req.site.registry()
    try:
        ok = reg.update_opportunity(req.int("id"), status=req.body.get("status") or None,
                                    notes=req.body.get("notes") if "notes" in req.body else None)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from None
    finally:
        reg.close()
    return {"updated": ok}


@route("POST", "/opps/(?P<id>\\d+)/won")
def opp_won(req: Req):
    cfg = req.site.cfg
    reg = req.site.registry()
    try:
        o = reg.opportunity(req.int("id"))
        if not o:
            raise ApiError(404, "Opportunity not found.")
        url = req.need("link_url", "the page where your link now is")
        if not url.lower().startswith(("http://", "https://")):
            raise ApiError(400, "Enter the full address of the page, starting with https://")
        link_id, _ = reg.add(url, cfg.my_site, o["kind"].replace("_", " "), f"won from opportunity #{o['id']}")
        reg.update_opportunity(o["id"], status="won", link_id=link_id)
    finally:
        reg.close()
    req.site.checks.add([link_id])
    return {"link_id": link_id}


@route("GET", "/opps/(?P<id>\\d+)/draft")
def draft_get(req: Req):
    from ..drafts import stored_draft
    reg = req.site.registry()
    try:
        return {"draft": stored_draft(reg, req.int("id")), "ai": req.site.cfg.has_ai}
    finally:
        reg.close()


@route("POST", "/opps/(?P<id>\\d+)/draft")
def draft_make(req: Req):
    from ..drafts import make_draft
    reg = req.site.registry()
    try:
        current = None
        if isinstance(req.body.get("body"), str) and req.body["body"].strip():
            current = {"subject": str(req.body.get("subject", "")), "body": req.body["body"]}
        return {"draft": make_draft(req.site.cfg, reg, req.int("id"), use_ai=bool(req.body.get("ai")) and req.site.cfg.has_ai,
                                    current=current)}
    except KeyError:
        raise ApiError(404, "Opportunity not found.") from None
    finally:
        reg.close()


@route("POST", "/opps/(?P<id>\\d+)/draft/save")
def draft_save(req: Req):
    from ..drafts import stored_draft
    oid = req.int("id")
    reg = req.site.registry()
    try:
        if not reg.opportunity(oid):
            raise ApiError(404, "Opportunity not found.")
        text = str(req.body.get("body", ""))[:20000]
        if not text.strip():
            raise ApiError(400, "The message is empty.")
        prev = reg.latest_draft(oid)
        contacts = dict((prev or {}).get("contacts") or {})
        if req.body.get("to") is not None:
            to = str(req.body["to"]).strip()
            contacts["emails"] = [to] + [e for e in contacts.get("emails", []) if e != to] if to else contacts.get("emails", [])
        reg.save_draft(oid, "edited", str(req.body.get("subject", ""))[:300], text, contacts)
        return {"draft": stored_draft(reg, oid)}
    finally:
        reg.close()


# --------------------------------------------------------------------------- campaigns

@route("GET", "/campaigns")
def campaigns(req: Req):
    from ..campaigns import is_active
    reg = req.site.registry()
    try:
        out = []
        for c in reg.campaigns():
            out.append({"id": c["id"], "name": c["name"], "asset_url": c["asset_url"], "phrases": json.loads(c["phrases_json"] or "[]"),
                        "started_at": c["started_at"], "last_checked": c["last_checked"],
                        "active": is_active(c, req.site.cfg.campaign_active_days), "stats": reg.campaign_stats(c["id"]),
                        "pickups": [{"url": p["url"], "site": p["site"], "title": p["title"], "kind": p["kind"], "found_at": p["found_at"],
                                     "source": p["source"], "link_id": p["link_id"], "opp_id": p["opp_id"], "verdict": p["last_verdict"]}
                                    for p in reg.pickups(c["id"])]})
        return {"campaigns": out, "dataforseo": req.site.cfg.has_dataforseo, "feeds": len(req.site.cfg.google_alerts_feeds), "active_days": req.site.cfg.campaign_active_days,
                "jobs": _jobs(req)}
    finally:
        reg.close()


@route("POST", "/campaigns")
def campaign_add(req: Req):
    name = req.need("name", "a name for the study")
    asset = req.need("asset_url", "the study's address")
    if not asset.lower().startswith(("http://", "https://")):
        raise ApiError(400, "The study's address must start with https://")
    started = str(req.body.get("started_at") or "").strip()[:10] or date.today().isoformat()
    try:
        date.fromisoformat(started)
    except ValueError:
        raise ApiError(400, "The launch date must look like 2026-10-01.") from None
    phrases = req.body.get("phrases") or []
    if isinstance(phrases, str):
        phrases = phrases.split("\n")
    reg = req.site.registry()
    try:
        return {"id": reg.add_campaign(name, asset, [str(p) for p in phrases], started)}
    finally:
        reg.close()


@route("POST", "/campaigns/(?P<id>\\d+)/delete")
def campaign_delete(req: Req):
    reg = req.site.registry()
    try:
        return {"removed": reg.remove_campaign(req.int("id"))}
    finally:
        reg.close()


# --------------------------------------------------------------------------- site health

@route("GET", "/health")
def health(req: Req):
    from ..sitegraph import load
    data = load(req.site.cfg)
    if data is None:
        return {"mapped": False, "jobs": _jobs(req)}
    pages = data.get("pages", [])
    return {"mapped": True, "crawled_at": data.get("crawled_at"), "summary": {k: v for k, v in data["summary"].items() if k != "external"},
            "issues": data.get("issues", []), "notes": data.get("notes", []), "host_variants": data.get("host_variants", []),
            "weakest": [{"url": p["url"], "title": p["title"], "inbound": p["inbound"], "pagerank": p["pagerank"]}
                        for p in sorted((p for p in pages if p.get("indexable")), key=lambda p: p["pagerank"])[:8]],
            "strongest": [{"url": p["url"], "title": p["title"], "inbound": p["inbound"], "pagerank": p["pagerank"], "backlinks": p["backlinks"]}
                          for p in sorted((p for p in pages if p.get("indexable")), key=lambda p: -p["pagerank"])[:8]],
            "jobs": _jobs(req)}


# --------------------------------------------------------------------------- settings

@route("GET", "/settings")
def settings_get(req: Req):
    cfg = req.site.cfg
    fields = []
    for f in workspace.SCHEMA:
        v = getattr(cfg, f.attr)
        item = {"attr": f.attr, "label": f.label, "help": f.help, "kind": f.kind, "group": f.group, "scope": f.scope,
                "advanced": f.advanced, "secret": f.secret}
        if f.secret:
            item["set"] = bool(v)
            item["value"] = ""
        else:
            item["value"] = "\n".join(v) if f.kind == "list" else v
        fields.append(item)
    return {"groups": [{"id": g, "title": t, "help": h, "tests": TEST_FOR_GROUP.get(g, [])} for g, t, h in GROUPS],
            "fields": fields, "editable": req.app.editable, "site": cfg.my_site}


@route("POST", "/settings")
def settings_save(req: Req):
    _editable(req)
    changes, clear = req.body.get("changes") or {}, req.body.get("clear") or []
    if not isinstance(changes, dict) or not isinstance(clear, list):
        raise ApiError(400, "Settings changes were not in the expected form.")
    changes, clear = dict(changes), {str(c) for c in clear}
    for f in workspace.SCHEMA:
        if f.secret and f.attr in changes and not str(changes[f.attr]).strip():
            changes.pop(f.attr)  # an empty secret box means "keep the saved one"
    for attr in clear:
        if attr in workspace.BY_ATTR and workspace.BY_ATTR[attr].secret and attr not in changes:
            changes[attr] = ""  # Remove, unless a new value was typed after it
    try:
        workspace.save(req.app.config_path, req.site.id, changes)
    except ValueError as exc:
        raise ApiError(400, str(exc)) from None
    req.app.reload()
    return settings_get(req)


@route("POST", "/settings/test")
def settings_test(req: Req):
    what = req.body.get("what")
    if what not in TESTS:
        raise ApiError(400, "Unknown test.")
    return TESTS[what](req.site.cfg)


@route("GET", "/costs")
def costs(req: Req):
    reg = req.site.registry()
    try:
        return {"months": [dict(r) for r in reg.costs_by_month()], "budget": req.site.cfg.dataforseo_monthly_budget_usd}
    finally:
        reg.close()
