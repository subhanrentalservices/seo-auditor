"""The app's server and API, against a real workspace on disk and the local test site."""

import json
import threading
import time

import httpx
import pytest

from linkverify import workspace
from linkverify.db import Registry
from linkverify.web.server import make_server

from test_sitegraph import site  # noqa: F401  a tiny site with a home page


@pytest.fixture
def app(tmp_path, server):
    base, me = server
    root = tmp_path / "config.toml"
    root.write_text('[general]\ndelay_seconds = 0\nrender = false\ntimeout_seconds = 5\n[free]\ntranco = false\n', encoding="utf-8")
    site = workspace.add_site(root, "localhost")
    srv, token = make_server(root, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    c = httpx.Client(base_url=url, timeout=30)

    def post(path, body=None):
        return c.post(path, json=body or {}, headers={"X-LV-Token": token})
    yield {"c": c, "post": post, "url": url, "root": root, "site": site.id, "base": base, "me": me, "token": token}
    c.close()
    srv.shutdown()


def wait_idle(a, s, timeout=60):
    for _ in range(int(timeout / 0.2)):
        j = a["c"].get(f"/api/s/{s}/jobs").json()
        if j["checks"]["running"] is None and not j["checks"]["queued"] and not j["task"]["running"]:
            return j
        time.sleep(0.2)
    raise AssertionError("jobs never finished")


def test_security(app):
    c = app["c"]
    page = c.get("/")
    assert page.status_code == 200 and app["token"] in page.text and "__TOKEN__" not in page.text
    assert c.get("/app.css").status_code == 200 and c.get("/js/main.js").headers["content-type"].startswith("text/javascript")
    assert c.get("/js/../config.toml").status_code in (403, 404)
    assert c.post("/api/s/localhost/run", json={"op": "check"}).status_code == 403  # no token
    assert c.get("/api/app", headers={"Host": "evil.example"}).status_code == 403  # DNS rebinding
    assert c.get("/api/s/nope.com/today").json()["error"] == "That site is not set up here."


def test_full_flow(app):
    c, post, s, base = app["c"], app["post"], app["site"], app["base"]
    info = c.get("/api/app").json()
    assert info["sites"][0]["id"] == "localhost" and info["editable"]

    # settings: save, secrets masked, kept when left empty
    r = post(f"/api/s/{s}/settings", {"changes": {"brand_names": "Acme Rentals", "topics": "car rental\nroad trip",
                                                  "dataforseo_password": "secret1", "profile_name": "Alex"}})
    assert r.status_code == 200, r.text
    f = {x["attr"]: x for x in r.json()["fields"]}
    assert f["brand_names"]["value"] == "Acme Rentals" and f["dataforseo_password"] == {**f["dataforseo_password"], "set": True, "value": ""}
    r = post(f"/api/s/{s}/settings", {"changes": {"dataforseo_password": "", "topics": "car rental"}})
    assert workspace.load(app["root"], s).dataforseo_password == "secret1"  # empty box = keep
    r = post(f"/api/s/{s}/settings", {"changes": {}, "clear": ["dataforseo_password"]})
    assert workspace.load(app["root"], s).dataforseo_password == ""
    assert post(f"/api/s/{s}/settings", {"changes": {"alert_min_score": "x"}}).json()["error"].endswith("whole number.")

    # today with nothing yet: setup actions only
    t = c.get(f"/api/s/{s}/today").json()
    kinds = [a["kind"] for a in t["actions"]]
    assert "first_link" in kinds and "map_site" in kinds and "setup_listings" in kinds and "setup_feeds" in kinds
    assert not {"setup_dataforseo", "setup_alerts"} & set(kinds)  # no nagging about paid services or email

    # add links and let them be checked
    assert post(f"/api/s/{s}/links", {"source_url": "http://localhost/x"}).json()["error"].startswith("That page is on your own site")
    good = post(f"/api/s/{s}/links", {"source_url": base + "/good.html", "strategy": "Guest post"}).json()
    bad = post(f"/api/s/{s}/links", {"source_url": base + "/nofollow.html"}).json()
    assert good["created"] and bad["created"]
    wait_idle(app, s)
    links = {l["id"]: l for l in c.get(f"/api/s/{s}/links").json()["links"]}
    assert links[good["id"]]["verdict"] == "Counts" and links[bad["id"]]["verdict"] == "Weak"
    assert links[good["id"]]["host"] == "127.0.0.1" and links[good["id"]]["path"] == "/good.html"
    d = c.get(f"/api/s/{s}/links/{good['id']}").json()
    assert len(d["result"]["checks"]) == 15 and d["history"]
    assert post(f"/api/s/{s}/links/{good['id']}", {"notes": "paid $50"}).json()["updated"]
    assert c.get(f"/api/s/{s}/links/{good['id']}").json()["link"]["notes"] == "paid $50"

    # a link that breaks shows up on Today as urgent
    reg = Registry(workspace.load(app["root"], s).db_path)
    reg.add_event(bad["id"], "rel_changed", "bad", "The link became nofollow.")
    reg.close()
    t = c.get(f"/api/s/{s}/today").json()
    assert t["actions"][0]["priority"] == "urgent" and t["actions"][0]["action"]["go"] == f"links/{bad['id']}"
    assert t["summary"]["verdicts"]["Counts"] == 1 and t["summary"]["links"] == 2

    # re-check via /run
    j = post(f"/api/s/{s}/run", {"op": "check", "which": "ids", "ids": [good["id"]]}).json()
    assert j["queued"] == 1
    wait_idle(app, s)

    # opportunities, drafts, won
    reg = Registry(workspace.load(app["root"], s).db_path)
    oid, _ = reg.upsert_opportunity("k1", "unlinked_mention", base + "/article_author.html", "Best rentals", "127.0.0.1", 70, "",
                                    {"brand": "Acme Rentals"})
    reg.close()
    o = c.get(f"/api/s/{s}/opps").json()
    assert o["opps"][0]["id"] == oid and o["sources"]["brands"] == 1
    assert "gap" not in o["finders"] and {"listings", "partners", "mentions"} <= set(o["finders"])  # free only
    dr = post(f"/api/s/{s}/opps/{oid}/draft", {"ai": False}).json()["draft"]
    assert dr["to"] == "jane@newsdesk.org" and "Alex" in dr["body"]
    ed = post(f"/api/s/{s}/opps/{oid}/draft/save", {"to": "other@newsdesk.org", "subject": "Hi", "body": "Edited"}).json()["draft"]
    assert ed["source"] == "edited" and ed["to"] == "other@newsdesk.org"
    assert post(f"/api/s/{s}/opps/{oid}", {"status": "pitched"}).json()["updated"]
    assert post(f"/api/s/{s}/opps/{oid}", {"status": "bogus"}).status_code == 400
    w = post(f"/api/s/{s}/opps/{oid}/won", {"link_url": base + "/base.html"}).json()
    wait_idle(app, s)
    assert c.get(f"/api/s/{s}/links/{w['link_id']}").json()["link"]["verdict"] == "Counts"

    # campaigns
    assert post(f"/api/s/{s}/campaigns", {"name": "S", "asset_url": "nope"}).status_code == 400
    cid = post(f"/api/s/{s}/campaigns", {"name": "Study", "asset_url": f"http://{app['me']}/study", "phrases": "a\nb"}).json()["id"]
    camp = c.get(f"/api/s/{s}/campaigns").json()["campaigns"][0]
    assert camp["id"] == cid and camp["phrases"] == ["a", "b"] and camp["active"]

    # site health: not mapped yet; unknown ops and tests are refused
    assert c.get(f"/api/s/{s}/health").json()["mapped"] is False
    assert post(f"/api/s/{s}/run", {"op": "nope"}).status_code == 400
    assert post(f"/api/s/{s}/settings/test", {"what": "dataforseo"}).json() == {"ok": False, "message": "Enter your DataForSEO login and password first."}
    assert c.get(f"/api/s/{s}/costs").json()["months"] == []


def test_task_runner_and_graph(app, site):
    """Map a small site through the app; the report page is then served."""
    c, post = app["c"], app["post"]
    host = site.split("//")[1]
    sid = post("/api/sites", {"domain": host}).json()["site"]["id"]
    assert c.get(f"/s/{sid}/graph").status_code == 404
    j = post(f"/api/s/{sid}/run", {"op": "graph"}).json()
    assert j["task"]["running"] == "map your site"
    assert post(f"/api/s/{sid}/run", {"op": "graph"}).status_code == 409  # one long task at a time
    j = wait_idle(app, sid, 120)
    assert j["task"]["last"]["ok"], j["task"]["last"]
    h = c.get(f"/api/s/{sid}/health").json()
    assert h["mapped"] and h["summary"]["pages"] >= 8 and any(i["kind"] == "broken_internal" for i in h["issues"])
    assert "plain http" in " ".join(h["notes"])
    assert c.get(f"/s/{sid}/graph").status_code == 200
    t = c.get(f"/api/s/{sid}/today").json()
    assert any(a["kind"] == "site_fault" and a["priority"] == "urgent" for a in t["actions"])


def test_add_and_remove_site(app):
    post, c = app["post"], app["c"]
    assert post("/api/sites", {"domain": "not a site"}).status_code == 400
    r = post("/api/sites", {"domain": "second.com.au", "settings": {"brand_names": "Second Co", "topics": "a\nb"}}).json()
    assert r["site"]["id"] == "second.com.au"
    cfg = workspace.load(app["root"], "second.com.au")
    assert cfg.brand_names == ["Second Co"] and cfg.topics == ["a", "b"]
    assert [x["id"] for x in c.get("/api/app").json()["sites"]] == ["localhost", "second.com.au"]
    assert c.get("/api/s/second.com.au/today").status_code == 200
    again = post("/api/sites", {"domain": "https://www.second.com.au/", "settings": {"brand_names": "Oops"}})
    assert again.status_code == 409 and "already set up" in again.json()["error"]
    assert workspace.load(app["root"], "second.com.au").brand_names == ["Second Co"]  # not overwritten
    assert post("/api/sites/second.com.au/remove").json()["moved_to"].endswith("second.com.au")
    assert [x["id"] for x in c.get("/api/app").json()["sites"]] == ["localhost"]


def test_detect(app, site):
    r = app["post"]("/api/detect", {"domain": site.split("//")[1]}).json()
    assert r["reachable"] and r["final_url"].startswith("http://127.0.0.1")
    assert "Brake repairs" in r["topics"] and "Home" not in r["topics"] and any(p.endswith("/services.html") for p in r["pages"])


def test_fixed_mode_is_read_only(cfg, server):
    cfg.my_site = "localhost"
    srv, token = make_server(cfg, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        info = httpx.get(url + "/api/app").json()
        assert info["sites"][0]["id"] == "localhost" and not info["editable"]
        r = httpx.post(url + "/api/s/localhost/settings", json={"changes": {"topics": "x"}}, headers={"X-LV-Token": token})
        assert r.status_code == 400 and "can't be changed" in r.json()["error"]
    finally:
        srv.shutdown()


def test_bad_input_is_a_400_not_a_crash(app):
    post, s = app["post"], app["site"]
    assert post(f"/api/s/{s}/settings", {"changes": ["x"]}).status_code == 400
    assert post(f"/api/s/{s}/run", {"op": "check", "which": "ids", "ids": ["x"]}).status_code == 400
    lid = post(f"/api/s/{s}/links", {"source_url": app["base"] + "/good.html", "check": False}).json()["id"]
    assert post(f"/api/s/{s}/links/{lid}", {"strategy": 5}).status_code == 400
    assert post(f"/api/s/{s}/run", {"op": "campaign", "id": "x"}).status_code == 400


def test_remove_then_retype_secret(app):
    post, s = app["post"], app["site"]
    post(f"/api/s/{s}/settings", {"changes": {"ahrefs_api_key": "OLD"}})
    post(f"/api/s/{s}/settings", {"changes": {"ahrefs_api_key": "NEW"}, "clear": ["ahrefs_api_key"]})
    assert workspace.load(app["root"], s).ahrefs_api_key == "NEW"


def test_removed_link_does_not_kill_the_checker(app):
    c, post, s, base = app["c"], app["post"], app["site"], app["base"]
    a = post(f"/api/s/{s}/links", {"source_url": base + "/good.html"}).json()["id"]
    post(f"/api/s/{s}/links/{a}/delete")  # removed while queued or being checked
    b = post(f"/api/s/{s}/links", {"source_url": base + "/base.html"}).json()["id"]
    wait_idle(app, s)
    assert c.get(f"/api/s/{s}/links/{b}").json()["link"]["verdict"] == "Counts"


def test_stop_a_long_task(app, site):
    c, post = app["c"], app["post"]
    sid = post("/api/sites", {"domain": site.split("//")[1]}).json()["site"]["id"]
    workspace.save(app["root"], sid, {"delay_seconds": "0.5"})  # slow enough to stop midway
    post(f"/api/s/{sid}/run", {"op": "graph"})
    assert post(f"/api/s/{sid}/run", {"op": "stop"}).json()["stopping"]
    j = wait_idle(app, sid, 60)
    assert j["task"]["last"]["cancelled"] and j["task"]["last"]["op"] == {"op": "graph"}


def test_check_a_page_and_free_settings(app):
    c, post, s, base = app["c"], app["post"], app["site"], app["base"]
    post(f"/api/s/{s}/settings", {"changes": {"brand_names": "Acme Rentals", "use_tranco": False}})
    assert post(f"/api/s/{s}/run", {"op": "scan", "url": "not a page"}).status_code == 400
    assert post(f"/api/s/{s}/run", {"op": "scan", "url": base + "/mention_nolink.html"}).status_code == 200
    wait_idle(app, s)
    last = c.get(f"/api/s/{s}/jobs").json()["task"]["last"]
    assert last["ok"] and last["op"] == {"op": "scan", "url": base + "/mention_nolink.html"}
    assert last["scan"]["mention"]["brand"] == "Acme Rentals" and len(last["scan"]["opps"]) == 1
    post(f"/api/s/{s}/run", {"op": "scan", "url": base + "/gone.html"})
    wait_idle(app, s)
    last = c.get(f"/api/s/{s}/jobs").json()["task"]["last"]
    assert not last["ok"] and last["error"].startswith("The page could not be read")  # plain words, not a crash
    assert post(f"/api/s/{s}/run", {"op": "find", "which": "gap"}).status_code == 400  # paid source not connected
    g = c.get(f"/api/s/{s}/settings").json()
    ids = [x["id"] for x in g["groups"]]
    assert ids[:4] == ["site", "profile", "free", "notify"] and ids[-1] == "extras"
    by = {f["attr"]: f["group"] for f in g["fields"]}
    assert by["dataforseo_login"] == by["imap_host"] == by["email_smtp_host"] == "extras"
    assert by["use_tranco"] == by["mastodon_search"] == by["google_alerts_feeds"] == "free" and by["desktop_notifications"] == "notify"
    assert post(f"/api/s/{s}/settings/test", {"what": "notify"}).json()["ok"] in (True, False)
