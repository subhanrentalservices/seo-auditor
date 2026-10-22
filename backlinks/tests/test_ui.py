"""End-to-end: the app in a real (headless) browser, clicking through every flow a user would.

Skipped when Playwright or its browser isn't installed.
"""

import re
import threading

import pytest

from linkverify import workspace
from linkverify.db import Registry
from linkverify.web.server import make_server

from test_sitegraph import site  # noqa: F401  a small site with a menu, sitemap and some faults

pw = pytest.importorskip("playwright.sync_api")


@pytest.fixture
def browser():
    with pw.sync_playwright() as p:
        try:
            b = p.chromium.launch()
        except Exception as exc:  # browser not installed
            pytest.skip(f"no browser: {exc}")
        yield b
        b.close()


@pytest.fixture
def app(tmp_path):
    root = tmp_path / "config.toml"
    root.write_text('[general]\ndelay_seconds = 0\nrender = false\ntimeout_seconds = 5\n[free]\ntranco = false\n', encoding="utf-8")
    srv, token = make_server(root, port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield {"url": f"http://127.0.0.1:{srv.server_address[1]}", "root": root}
    srv.shutdown()


def watch(page):
    errors = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    return errors


def test_everything(browser, app, site, server):
    base, me = server  # the link fixtures: pages that link to http://localhost:PORT/page
    host = site.split("//")[1]
    page = browser.new_page(viewport={"width": 1300, "height": 900})
    errors = watch(page)
    expect = pw.expect

    # ---- first run: type the address, check what was found, start
    page.goto(app["url"] + "/")
    expect(page.get_by_role("heading", name="Which website do you want links for?")).to_be_visible()
    page.get_by_role("button", name="Continue").click()
    expect(page.get_by_role("alert")).to_contain_text("Type your website address")
    page.get_by_label("Website address").fill(host)
    page.get_by_role("button", name="Continue").click()
    expect(page.get_by_label("What you do")).to_have_value(re.compile("Brake repairs"), timeout=30000)
    page.get_by_label("Business names").fill("Test Garage")
    page.get_by_label("Your name").fill("Alex")
    page.get_by_role("button", name="Start").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    sid = workspace.list_sites(app["root"])[0].id
    assert page.url.endswith(f"#/{sid}/today")
    cfg = workspace.load(app["root"], sid)
    assert cfg.brand_names == ["Test Garage"] and cfg.profile_name == "Alex" and "Brake repairs" in cfg.topics
    expect(page.get_by_text("Log the links you already have")).to_be_visible()

    # ---- add a link from Today; it gets checked and shows its verdict
    page.get_by_role("link", name="Add a link").first.click()
    page.get_by_label("Page that links to you").fill(base + "/nofollow.html")
    page.get_by_label("It should link to").fill("localhost")
    page.get_by_label("How you got it").fill("Guest post")
    page.get_by_role("button", name="Add and check").click()
    expect(page.locator(".vword")).to_have_text("Weak", timeout=30000)
    expect(page.locator(".verdict-block")).to_contain_text('rel="nofollow"')
    expect(page.locator(".checks li").first).to_contain_text("rel value")  # problems first
    # a second link, a good one
    page.get_by_role("link", name="Add a link").first.click()
    page.get_by_label("Page that links to you").fill(base + "/good.html")
    page.get_by_label("It should link to").fill("localhost")
    page.get_by_role("button", name="Add and check").click()
    expect(page.locator(".vword")).to_have_text("Counts", timeout=30000)
    # notes save on change
    page.get_by_label("Notes").fill("Paid $40")
    page.get_by_label("Notes").blur()
    expect(page.locator("#toast")).to_have_text("Saved")
    # list filters and keyboard
    page.get_by_role("button", name="Need a look").click()
    expect(page.locator("#rows li")).to_have_count(1)
    page.get_by_role("button", name="All", exact=True).click()
    expect(page.locator("#rows li")).to_have_count(2)
    page.locator("#rows a").first.focus()
    page.keyboard.press("ArrowDown")
    expect(page.locator('#rows a[aria-current="true"]')).to_contain_text("127.0.0.1")
    # adding your own site as a link is refused clearly
    page.get_by_role("link", name="Add a link").first.click()
    page.get_by_label("Page that links to you").fill(site + "/services.html")
    page.get_by_label("It should link to").fill(host)
    page.get_by_role("button", name="Add and check").click()
    expect(page.get_by_role("alert")).to_contain_text("on your own site")

    # ---- opportunities: draft, edit, save, status, won
    reg = Registry(cfg.db_path)
    oid, _ = reg.upsert_opportunity("k1", "unlinked_mention", base + "/article_author.html", "Best garages in town", "127.0.0.1", 72,
                                    "unlinked mention 35", {"brand": "Test Garage", "how": "Ask them to link the mention."})
    reg.close()
    page.get_by_role("link", name="Opportunities").first.click()
    page.get_by_role("link", name=re.compile("Best garages in town")).click()
    expect(page.locator(".how")).to_have_text("Ask them to link the mention.")
    page.get_by_role("button", name="Write a draft").click()
    expect(page.get_by_label("To", exact=True)).to_have_value("jane@newsdesk.org", timeout=20000)
    body = page.get_by_label("Message")
    expect(body).to_have_value(re.compile("Hi Jane,"))
    body.fill(body.input_value() + "\n[ADD THE PAGE TITLE]")
    expect(page.locator(".ph")).to_contain_text("[ADD THE PAGE TITLE]")
    page.get_by_role("button", name="Save changes").click()
    expect(page.locator(".composer")).to_contain_text("Your edited version")
    page.locator("[data-s=pitched]").click()
    expect(page.locator("#toast")).to_contain_text("Marked: Pitched")
    page.locator("[data-v=pitched]").click()
    expect(page.locator("#rows li")).to_have_count(1)
    page.get_by_label("Page where your link now is").fill(base + "/base.html")
    page.get_by_role("button", name="Add it to my links").click()
    # it is checked against this site's address, which the test page does not link to
    expect(page.locator(".vword")).to_have_text("Not counted", timeout=30000)
    assert re.search(r"#/[^/]+/links/\d+$", page.url)

    # ---- check a page: paste any page, see what it offers
    page.get_by_role("link", name="Opportunities").first.click()
    # (the test site is on 127.0.0.1 too, so the page is opened as localhost to count as another site)
    page.get_by_label("Check a page").fill(base.replace("127.0.0.1", "localhost") + "/links_to_comp_dead.html")
    page.get_by_role("button", name="Check", exact=True).click()
    expect(page.locator(".scanres")).to_contain_text("1 dead link", timeout=30000)
    page.locator(".scanres").get_by_role("link", name="Open opportunity").click()
    expect(page.locator(".dhead .sub")).to_contain_text("Dead link on a page")
    expect(page.get_by_role("heading", name="Draft")).to_be_visible()

    # ---- a free listing: you sign up yourself, no email to write
    reg = Registry(cfg.db_path)
    reg.upsert_opportunity("listing:g", "listing", "https://www.google.com/business/", "Free listing: Google Business Profile", "google.com", 40,
                           "listing 30", {"how": "Create a free listing.", "verify": False})
    reg.close()
    page.reload()
    page.get_by_role("link", name=re.compile("Free listing: Google Business Profile")).click()
    expect(page.get_by_role("link", name="Sign up")).to_be_visible()
    expect(page.get_by_role("heading", name="Draft")).to_have_count(0)
    page.get_by_role("button", name="I've done it").click()
    expect(page.locator("#detail")).to_contain_text("Done.")

    # ---- settings: save, keep after reload, secrets, test buttons
    page.get_by_role("link", name="Settings").first.click()
    page.get_by_label("Competitors").fill("rival-one.com\nrival-two.com")
    page.get_by_label("Your country").select_option("2036")
    expect(page.locator("#savebar")).to_be_visible()
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator("#toast")).to_have_text("Saved")
    page.reload()
    expect(page.get_by_label("Competitors")).to_have_value("rival-one.com\nrival-two.com")
    page.get_by_role("link", name="Free sources").click()
    expect(page.get_by_label("Read #journorequest posts on Mastodon")).to_be_checked()
    page.get_by_role("link", name="Optional extras").click()
    page.get_by_label("DataForSEO login").fill("me@example.com")
    page.get_by_label("DataForSEO password").fill("pw-123")
    page.get_by_role("button", name="Save", exact=True).click()
    expect(page.locator(".saved").first).to_be_visible()
    c2 = workspace.load(app["root"], sid)
    assert c2.dataforseo_password == "pw-123" and c2.dataforseo_location_code == 2036 and c2.competitors == ["rival-one.com", "rival-two.com"]
    assert "pw-123" not in page.content()  # secrets never go back to the browser
    page.get_by_role("button", name="Test Ahrefs").click()
    expect(page.locator("#res-ahrefs")).to_have_text("Enter your Ahrefs API key first.")

    # ---- campaigns
    page.get_by_role("link", name="Campaigns").first.click()
    page.get_by_role("link", name="Track a study").first.click()
    page.get_by_label("Name").fill("Repair cost study")
    page.get_by_label("Where it is published").fill(site + "/blog/post-1.html")
    page.get_by_label("Phrases people will quote").fill("repair costs rose 18%")
    page.get_by_role("button", name="Start tracking").click()
    expect(page.get_by_role("heading", name="Repair cost study")).to_be_visible()
    page.get_by_role("button", name="Stop tracking").click()
    page.get_by_role("button", name=re.compile("Click again")).click()
    expect(page.locator("#rows")).to_contain_text("No campaigns yet")

    # ---- site health: map the site, read faults, open the map
    page.get_by_role("link", name="Site health").first.click()
    page.get_by_role("button", name="Map my site").click()
    expect(page.locator(".fault").first).to_be_visible(timeout=60000)
    expect(page.locator(".faults")).to_contain_text("internal link goes to a broken page")
    page.get_by_role("button", name="Show the map").click()
    frame = page.frame_locator("iframe.mapframe")
    expect(frame.locator("#graph rect").first).to_be_visible()
    # Today now lists the broken link as urgent
    page.get_by_role("link", name="Today").first.click()
    expect(page.locator(".act.urgent").first).to_contain_text("broken page")

    # ---- a second website, then switch back
    page.locator("#switcher").click()
    page.get_by_role("menuitem", name="Add a website").click()
    expect(page.get_by_role("heading", name="Add a website")).to_be_visible()
    page.get_by_label("Website address").fill("second-site.invalid")
    page.get_by_role("button", name="Continue").click()
    expect(page.get_by_role("heading", name=re.compile("Couldn't open"))).to_be_visible(timeout=30000)
    page.get_by_role("button", name="Start").click()
    expect(page.get_by_role("heading", name="Today")).to_be_visible()
    assert "second-site.invalid" in page.url
    page.locator("#switcher").click()
    page.get_by_role("menuitem", name=host.split(":")[0]).first.click()
    expect(page.locator("#switcher")).to_contain_text(host.split(":")[0])

    # the only failed request is the deliberate "that's your own site" refusal above
    assert [e for e in errors if "status of 400" not in e] == [] and sum("status of 400" in e for e in errors) == 1, errors


def test_mobile(browser, app, site):
    host = site.split("//")[1]
    s = workspace.add_site(app["root"], host)
    page = browser.new_page(viewport={"width": 390, "height": 844})
    errors = watch(page)
    page.goto(f"{app['url']}/#/{s.id}/today")
    expect = pw.expect
    expect(page.locator(".tabbar")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    page.locator(".tabbar").get_by_role("link", name="Links").click()
    expect(page.get_by_role("heading", name="Links")).to_be_visible()
    page.locator(".tabbar").get_by_role("link", name="Settings").click()
    expect(page.get_by_role("heading", name="Settings")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth") <= 390
    assert not errors, errors
