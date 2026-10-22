"""Free mode: no paid services, no email. Tranco strength, Mastodon, listings, partners, Check a page, notifications."""

import io
import zipfile

import httpx
import pytest

from linkverify import finders, freefind, monitor, notify, tranco
from linkverify.checks import Verifier
from linkverify.db import Registry
from linkverify.fetcher import FetchResult


def _zip(rows):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("top-1m.csv", "".join(f"{r},{d}\n" for r, d in rows))
    return buf.getvalue()


class PageFetcher:
    """Answers from {url: html}; anything else is a 404."""

    def __init__(self, pages, dead=()):
        self.pages, self.dead, self.asked = pages, set(dead), []

    def get(self, url, use_cache=True):
        self.asked.append(url)
        if url in self.pages:
            return FetchResult(url, url, 200, {"content-type": "text/html"}, [], self.pages[url], [], "")
        return FetchResult(url, url, 404, {}, [], "", [], "")

    def status_of(self, url, timeout=10):
        return (404, "") if url in self.dead else (200, "")

    def close(self):
        pass


# ---------------------------------------------------------------- Tranco
def test_tranco_download_lookup_and_score(cfg):
    cfg.use_tranco = True
    ok, msg = tranco.ensure(cfg, fetch=lambda: _zip([(1, "google.com"), (250, "news.com.au"), (90000, "smalltown.org")]))
    assert ok and "3 sites" in msg
    assert tranco.ranks(cfg, ["https://www.news.com.au/x", "smalltown.org", "nobody.net"]) == {"news.com.au": 250, "smalltown.org": 90000}
    assert tranco.score(1) == 100 and tranco.score(100) == 70 and tranco.score(1_000_000) == 10 and tranco.score(None) is None
    assert "250" in tranco.describe(250) and "top million" in tranco.describe(None)
    cfg.use_tranco = False
    assert tranco.ranks(cfg, ["news.com.au"]) == {}  # switched off in Settings


def test_tranco_failure_keeps_going(cfg):
    def boom():
        raise httpx.ConnectError("offline")
    ok, msg = tranco.ensure(cfg, fetch=boom)
    assert not ok and "offline" in msg
    ok2, msg2 = tranco.ensure(cfg)  # no retry storm: the failure is remembered for an hour
    assert not ok2 and "recently" in msg2


def test_check_13_uses_free_strength(server, cfg):
    base, me = server
    cfg.use_tranco = True
    tranco.ensure(cfg, fetch=lambda: _zip([(420, "127.0.0.1")]))
    v = Verifier(cfg)
    try:
        r = v.verify(f"{base}/good.html", me)
    finally:
        v.close()
    assert r["world_rank"] == 420 and r["popularity"] == tranco.score(420)
    c13 = next(c for c in r["checks"] if c["num"] == 13)
    assert "ranked 420" in c13["detail"]
    c14 = next(c for c in r["checks"] if c["num"] == 14)
    assert "search Google for: site:" in c14["detail"] and "Connect" not in c14["detail"]


def test_finder_strength_falls_back_to_tranco(cfg, tmp_path):
    cfg.use_tranco, cfg.topics = True, ["car rental"]
    tranco.ensure(cfg, fetch=lambda: _zip([(1000, "bigsite.com")]))
    reg = Registry(tmp_path / "r.db")
    ctx = finders.Context(cfg, reg, fetcher=PageFetcher({}))
    res = finders.FinderResult("t")
    ctx.save_all([finders.Pending("resource_page", "k1", "https://bigsite.com/list", "List", "bigsite.com"),
                  finders.Pending("resource_page", "k2", "https://tiny.net/list", "List", "tiny.net")], res)
    rows = {o["site"]: o for o in reg.opportunities()}
    import json
    big = json.loads(rows["bigsite.com"]["data_json"])
    assert big["strength"] == tranco.score(1000) and big["world_rank"] == 1000 and "Tranco" in big["strength_source"]
    assert json.loads(rows["tiny.net"]["data_json"])["strength"] is None
    reg.close()


# ---------------------------------------------------------------- Mastodon
class _Resp:
    def __init__(self, status, data):
        self.status_code, self._data = status, data

    def json(self):
        return self._data


def test_mastodon_requests(cfg, monkeypatch):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    cfg.topics, cfg.mastodon_instances, cfg.bluesky_search = ["car repairs"], ["journa.host", "closed.social"], False
    post = {"url": "https://journa.host/@amy/1", "created_at": now, "account": {"acct": "amy"},
            "content": "<p>#journorequest Looking for a mechanic to talk about <b>car repairs</b> costs. Email amy@paper.com</p>"}
    off_topic = {"url": "https://journa.host/@bo/2", "created_at": now, "account": {"acct": "bo"}, "content": "<p>Gardening tips wanted</p>"}
    old = {**post, "url": "https://journa.host/@amy/0", "created_at": "2020-01-01T00:00:00Z"}

    def fake_get(url, **kw):
        if "closed.social" in url:
            return _Resp(401, {"error": "This method requires an authenticated user"})
        return _Resp(200, [post, off_topic, old])
    monkeypatch.setattr(finders.httpx, "get", fake_get)
    res = finders.FinderResult("journalists")
    items = finders._mastodon_requests(cfg, res)
    urls = {p.url for p in items}
    assert urls == {"https://journa.host/@amy/1"}  # on topic, recent, de-duplicated by key later
    p = next(iter(items))
    assert p.data["source"] == "Mastodon @amy" and "amy@paper.com" in p.data["contacts"] and "<p>" not in p.text
    assert any("closed.social" in n for n in res.notes)


# ---------------------------------------------------------------- listings
HOME = ('<html><body><a href="https://www.instagram.com/ssauto/">Insta</a> <a href="https://facebook.com/ssauto">FB</a>'
        ' <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a></body></html>')


def test_listings_for_australia(cfg, tmp_path):
    cfg.my_site, cfg.dataforseo_location_code, cfg.use_tranco = "smithmotors.com.au", 2036, False
    reg = Registry(tmp_path / "r.db")
    reg.add("https://www.yelp.com.au/biz/ss-automotive", cfg.my_site, "listing", "")
    ctx = finders.Context(cfg, reg, fetcher=PageFetcher({"https://smithmotors.com.au/": HOME}))
    res = freefind.find_listings(ctx)
    opps = reg.opportunities()
    sites = {o["site"] for o in opps if o["kind"] == "listing"}
    assert "truelocal.com.au" in sites and "brownbook.net" in sites and "google.com" in sites
    assert "yelp.com.au" not in sites  # already have it
    profiles = sorted(o["title"] for o in opps if o["kind"] == "profile")
    assert profiles == ["Add your website to your Facebook profile", "Add your website to your Instagram profile"]
    assert res.new == len(opps) and not res.errors
    again = freefind.find_listings(finders.Context(cfg, reg, fetcher=PageFetcher({"https://smithmotors.com.au/": HOME})))
    assert again.new == 0  # nothing duplicated
    reg.close()


def test_listings_elsewhere_are_generic(cfg, tmp_path):
    cfg.my_site, cfg.dataforseo_location_code, cfg.use_tranco = "shop.co.nz", 2554, False
    reg = Registry(tmp_path / "r.db")
    freefind.find_listings(finders.Context(cfg, reg, fetcher=PageFetcher({})))
    sites = {o["site"] for o in reg.opportunities()}
    assert "brownbook.net" in sites and "truelocal.com.au" not in sites
    reg.close()


# ---------------------------------------------------------------- partners
def test_partners_from_competitor_sites(cfg, tmp_path):
    cfg.my_site, cfg.competitors, cfg.use_tranco = "me.com.au", ["rival1.com.au", "rival2.com.au"], False
    pages = {
        "https://rival1.com.au/": '<a href="https://www.vacc.com.au/">VACC member</a> <a href="https://facebook.com/r1">fb</a>'
                                  '<footer><p>Website by <a href="https://agency.com.au/">Agency</a></p></footer>'
                                  '<a href="/about-us">About us</a> <a href="https://me.com.au/">me</a>',
        "https://rival1.com.au/about-us": '<a href="https://mta.org.au/members">MTA</a> <a href="https://vacc.com.au/x">VACC</a>',
        "https://rival2.com.au/": '<a href="https://vacc.com.au/">Proud VACC member</a> <a href="https://fonts.googleapis.com/css">f</a>',
    }
    reg = Registry(tmp_path / "r.db")
    res = freefind.find_partners(finders.Context(cfg, reg, fetcher=PageFetcher(pages)))
    opps = {o["site"]: o for o in reg.opportunities()}
    assert set(opps) == {"vacc.com.au", "mta.org.au"}, opps.keys()  # no social, designer credit, CDN, me
    assert "2 competitors" in opps["vacc.com.au"]["title"] and opps["vacc.com.au"]["score"] > opps["mta.org.au"]["score"]
    assert not res.errors
    cfg.competitors = []
    assert freefind.find_partners(finders.Context(cfg, reg, fetcher=PageFetcher({}))).errors
    reg.close()


# ---------------------------------------------------------------- check a page
def test_scan_page(server, cfg, tmp_path):
    base, me = server
    cfg.my_site, cfg.brand_names, cfg.topics = me, ["Acme Rentals"], ["car rental"]
    reg = Registry(tmp_path / "r.db")
    ctx = finders.Context(cfg, reg)
    try:
        s = freefind.scan_page(ctx, f"{base}/mention_nolink.html")
        assert s["mention"]["brand"] == "Acme Rentals" and len(s["opps"]) == 1 and "without a link" in s["summary"][0]
        s = freefind.scan_page(ctx, f"{base}/good.html")
        assert s["links"] and s["link_id"] is None and "already links to you" in s["summary"][0]
        s = freefind.scan_page(ctx, f"{base}/links_to_comp_dead.html")
        assert len(s["dead"]) == 1 and s["dead"][0]["url"].startswith("http://127.0.0.2:9")
        assert reg.opportunity(s["opps"][0])["kind"] == "broken_link"
        with pytest.raises(ValueError, match="own site"):
            freefind.scan_page(ctx, f"http://{me}/page")
        with pytest.raises(ValueError, match="could not be read"):
            freefind.scan_page(ctx, f"{base}/gone.html")
    finally:
        ctx.close()
        reg.close()


# ---------------------------------------------------------------- finders and alerts without paid services
def test_paid_finders_skip_quietly(cfg, tmp_path):
    reg = Registry(tmp_path / "r.db")
    assert not ({"gap", "broken", "resources"} & set(finders.available(cfg)))
    assert {"listings", "partners", "mentions", "journalists", "campaigns"} <= set(finders.available(cfg))
    assert finders.run_finders(cfg, reg, ["gap", "broken", "resources"], fetcher=PageFetcher({})) == []
    reg.close()


def test_notifications_without_email(cfg, tmp_path, monkeypatch):
    if not notify.available():
        assert notify.show("t", "b") == (False, "desktop notifications work on Windows only")
    reg = Registry(tmp_path / "r.db")
    lid, _ = reg.add("https://blog.example/post", "me.com", "", "")
    reg.add_event(lid, "lost", "bad", "The link is gone.")
    # the app (not the daily run): nothing is sent, it waits on Today
    assert "waiting for you in the app" in monitor.send_pending_alerts(reg, cfg)[0]
    shown = []
    monkeypatch.setattr(notify, "show", lambda t, b: (shown.append((t, b)), (True, "desktop notification shown"))[1])
    cfg.desktop_notifications = False
    assert "waiting" in monitor.send_pending_alerts(reg, cfg, desktop=True)[0] and not shown
    cfg.desktop_notifications = True
    assert monitor.send_pending_alerts(reg, cfg, desktop=True) == ["desktop notification shown"]
    assert "1 link problem" in shown[0][0] and not reg.unalerted(("bad", "good"))  # marked as told
    reg.close()
    t, b = notify.digest([{"severity": "bad", "source_url": "https://a.com/x", "detail": "Gone"}],
                         [{"title": "Journalist wants mechanics", "score": 80}])
    assert "1 link problem" in t and "1 new opportunity" in t and "score 80" in b
