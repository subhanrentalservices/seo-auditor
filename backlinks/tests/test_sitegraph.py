"""Site link graph on a small fake site with every kind of problem."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from linkverify import cli
from linkverify.db import Registry
from linkverify.sitegraph import crawl, page_key, save


def site_pages(port):
    o = f"http://127.0.0.1:{port}"
    nav = '<nav><a href="/">Home</a> <a href="/services.html">Brake repairs</a> <a href="/blog/">Blog</a></nav>'
    page = lambda title, body, head="": (200, {}, f"<html><head><title>{title}</title><meta name='description' content='d'>"
                                                 f"<link rel='canonical' href='{o}{{path}}'>{head}</head><body>{nav}<h1>{title}</h1>{body}</body></html>")
    return {
        "/robots.txt": (200, {"Content-Type": "text/plain"}, f"User-agent: *\nDisallow: /private/\nSitemap: {o}/sitemap_index.xml\n"),
        "/sitemap_index.xml": (200, {"Content-Type": "application/xml"},
                               f"<sitemapindex><sitemap><loc>{o}/sitemap-pages.xml</loc></sitemap></sitemapindex>"),
        "/sitemap-pages.xml": (200, {"Content-Type": "application/xml"}, "<urlset>" + "".join(
            f"<url><loc>{o}{p}</loc></url>" for p in ["/", "/services.html", "/blog/", "/blog/post-1.html", "/orphan.html",
                                                      "/thanks.html", "/gone.html"]) + "</urlset>"),
        "/": page("Home", '<a href="/services.html?ref=x#top">Our services</a> <a href="/old.html">Old</a> '
                          '<a href="http://partner.example/" rel="nofollow">Partner</a> <a href="http://gov.example/">Gov</a>'),
        "/services.html": page("Services", '<a href="/missing.html">Broken</a> <a href="/thanks.html">Thanks</a> '
                                           '<a href="/private/admin.html">Admin</a>'),
        "/blog/": page("Blog", '<a href="/blog/post-1.html">Post 1</a>'),
        "/blog/post-1.html": page("Post 1", '<a href="/blog/deep-1.html">Deeper</a> <a href="http://gov.example/x">Gov</a>'),
        "/blog/deep-1.html": page("Deep 1", '<a href="/blog/deep-2.html">Deeper</a>'),
        "/blog/deep-2.html": page("Deep 2", '<a href="/blog/deep-3.html">Deeper</a>'),
        "/blog/deep-3.html": page("Deep 3", "end", ),
        "/orphan.html": page("Orphan", "nobody links here"),
        "/thanks.html": page("Thanks", "thank you", head="<meta name='robots' content='noindex'>"),
        "/old.html": (301, {"Location": "/services.html"}, ""),
        "/gone.html": (404, {}, "gone"),
        "/missing.html": (404, {}, "missing"),
        "/private/admin.html": page("Admin", "secret"),
    }


class _H(BaseHTTPRequestHandler):
    routes = {}

    def log_message(self, *a):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        status, headers, body = self.routes.get(path, (404, {}, "not found"))
        body = body.replace("{path}", path)
        data = body.encode()
        self.send_response(status)
        if "Content-Type" not in headers:
            self.send_header("Content-Type", "text/html; charset=utf-8")
        for k, v in headers.items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def site():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _H)
    port = srv.server_address[1]
    _H.routes = site_pages(port)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{port}"
    srv.shutdown()


def test_graph(cfg, site):
    cfg.my_site = "127.0.0.1"
    reg = Registry(cfg.db_path)
    lid, _ = reg.add("https://news.example/story", site + "/services.html", "test")
    reg.conn.execute("UPDATE links SET last_verdict = 'Counts' WHERE id = ?", (lid,))
    reg.conn.commit()
    g = crawl(cfg, site + "/", reg=reg)
    P = g.pages
    home, svc = site + "/", site + "/services.html"
    assert P[home].depth == 0 and P[svc].depth == 1 and P[site + "/blog/deep-3.html"].depth == 5
    assert P[svc].inbound == 8  # the 8 other crawled pages link to it in the menu (queries are dropped)
    assert P[site + "/private/admin.html"].blocked and not P[site + "/private/admin.html"].status
    assert P[site + "/thanks.html"].noindex and P[site + "/thanks.html"].in_sitemap
    assert P[site + "/old.html"].redirect and P[site + "/old.html"].final_url == svc
    assert P[site + "/orphan.html"].inbound == 0 and P[site + "/orphan.html"].depth is None
    assert P[home].pagerank == 100 or P[svc].pagerank == 100
    assert P[site + "/orphan.html"].pagerank < 10
    assert P[home].external == {"gov.example": ["followed"], "partner.example": ["nofollow"]}
    assert P[svc].backlinks == 1 and P[svc].backlinks_counting == 1
    kinds = {i["kind"]: i for i in g.to_json()["issues"]}
    assert kinds["broken_internal"]["pages"] == [f"{svc} → {site}/missing.html (404)"]
    assert any("gone.html (HTTP 404)" in p for p in kinds["sitemap_bad"]["pages"])
    assert any("thanks.html (noindex)" in p for p in kinds["sitemap_bad"]["pages"])
    assert kinds["orphan"]["pages"] == [site + "/orphan.html"]
    assert len(kinds["broken_external"]["pages"]) == 3  # .example hosts never resolve
    assert kinds["redirect_internal"]["pages"] == [f"{home} → {site}/old.html → {svc}"]
    assert any("deep-3.html (depth 5)" in p for p in kinds["deep"]["pages"])
    assert any("deep-1.html" in p for p in kinds["not_in_sitemap"]["pages"])
    assert "private/admin.html" not in json.dumps(kinds.get("not_in_sitemap", {}))
    s = g.to_json()["summary"]
    assert s["external_sites"] == 2 and s["backlinks_counting"] == 1
    jpath, hpath = save(g, cfg)
    html = hpath.read_text(encoding="utf-8")
    assert "/*__DATA__*/null" not in html and '"site": "127.0.0.1"' in html and "orphan.html" in html


def test_page_key():
    assert page_key("HTTPS://Ex.com/a?b=1#c") == "https://ex.com/a"
    assert page_key("https://ex.com") == "https://ex.com/"


def test_graph_cli(cfg, site, tmp_path, capsys):
    conf = tmp_path / "config.toml"
    conf.write_text(f'[general]\ndata_dir = "{cfg.data_dir.as_posix()}"\ndelay_seconds = 0\nrender = false\n', encoding="utf-8")
    assert cli.main(["--config", str(conf), "graph"]) == 2  # no site set
    assert cli.main(["--config", str(conf), "graph", site + "/"]) == 0
    out = capsys.readouterr().out
    assert "[HIGH] 1 internal link goes to a broken page" in out and "sitegraph.html" in out


class FakeFetcher:
    """Answers from a dict: url -> (final_url, status, error, hops). Anything else is a 404."""

    def __init__(self, table):
        self.table = table

    def get(self, url, use_cache=True):
        from linkverify.fetcher import FetchResult
        final, status, error, hops = self.table.get(url, (url, 404, "", []))
        html = "<html><head><title>Home</title></head><body><h1>Home</h1></body></html>" if status == 200 else ""
        return FetchResult(url, final, status, {"content-type": "text/html"}, [("content-type", "text/html")], html, hops, error)

    def status_of(self, url, timeout=10):
        if "slow" in url:
            return 0, "ReadTimeout: The read operation timed out"
        return 200, ""

    def close(self):
        pass


def test_host_variants_and_slow_sites(cfg):
    home = "https://shop.com.au/"
    f = FakeFetcher({
        home: (home, 200, "", []),
        "http://shop.com.au/": (home, 200, "", [("http://shop.com.au/", 301)]),
        "http://www.shop.com.au/": ("http://www.shop.com.au/", 0, "ConnectError: [Errno 11001] getaddrinfo failed", []),
        "https://www.shop.com.au/": ("https://www.shop.com.au/", 0, "ConnectError: [Errno 11001] getaddrinfo failed", []),
    })
    f.table[home] = (home, 200, "", [])
    g = crawl(cfg, home, fetcher=f, check_external=False)
    kinds = {i["kind"]: i for i in g.to_json()["issues"]}
    assert len(kinds["host_variant"]["pages"]) == 2 and "does not exist (no DNS record)" in kinds["host_variant"]["pages"][0]
    assert "temp_redirect" not in kinds  # http -> https is a 301
    f.table["http://shop.com.au/"] = (home, 200, "", [("http://shop.com.au/", 302)])
    g = crawl(cfg, home, fetcher=f, check_external=False)
    assert "temp_redirect" in {i["kind"] for i in g.to_json()["issues"]}


def test_slow_outbound_site_is_not_broken(cfg):
    home = "https://shop.com.au/"

    class F(FakeFetcher):
        def get(self, url, use_cache=True):
            r = super().get(url)
            if url == home:
                r.text = '<html><body><a href="https://slow.gov.au/">gov</a></body></html>'
            return r
    g = crawl(cfg, home, fetcher=F({home: (home, 200, "", [])}))
    kinds = {i["kind"]: i for i in g.to_json()["issues"]}
    assert "broken_external" not in kinds and "did not answer in time" in kinds["unverified_external"]["pages"][0]
