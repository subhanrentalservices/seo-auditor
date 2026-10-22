"""The local web server: routing, security, static files.

Runs on 127.0.0.1 only. Every request must name this server in its Host header
(stops DNS-rebinding), and every change (POST) must carry a random token that only
the app's own page knows (stops other websites from triggering actions).
"""

from __future__ import annotations

import json
import mimetypes
import sys
import re
import secrets
import threading
import traceback
import webbrowser
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .. import __version__, workspace
from ..config import Config
from .context import App, SiteContext

STATIC = Path(__file__).resolve().parent.parent / "static" / "app"
ROUTES: list[tuple[str, re.Pattern, object, bool]] = []


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Req:
    app: App
    method: str
    path: str
    query: dict
    body: dict
    params: dict = field(default_factory=dict)
    site: SiteContext | None = None

    def int(self, name: str) -> int:
        return int(self.params[name])

    def need(self, name: str, what: str | None = None) -> str:
        v = str(self.body.get(name, "")).strip()
        if not v:
            raise ApiError(400, f"Enter {what or name}.")
        return v


@dataclass
class Raw:
    status: int
    body: bytes
    ctype: str


def route(method: str, pattern: str, site: bool = True):
    """Register a handler. Site routes live under /api/s/<site>/..."""
    full = ("/api/s/(?P<site>[^/]+)" if site else "/api") + pattern

    def deco(fn):
        ROUTES.append((method, re.compile("^" + full + "$"), fn, site))
        return fn
    return deco


def make_handler(app: App, token: str, port: int):
    from . import api  # noqa: F401  registers the routes

    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        server_version = f"BacklinkVerifier/{__version__}"
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):
            pass

        def _send(self, status: int, body: bytes, ctype: str, cache: bool = False) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "max-age=60" if cache else "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "SAMEORIGIN")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, status: int = 200) -> None:
            self._send(status, json.dumps(obj, default=str).encode(), "application/json")

        def _host_ok(self) -> bool:
            return self.headers.get("Host", "") in allowed_hosts

        def _read_raw(self) -> bytes | None:
            """Read the whole request body first, so an early refusal never leaves bytes on a kept-alive connection."""
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n > 1_000_000:
                self.close_connection = True
                return None
            return self.rfile.read(n) if n else b""

        def _body(self, raw: bytes | None) -> dict:
            if raw is None:
                raise ApiError(413, "That is too much data.")
            if not raw:
                return {}
            try:
                data = json.loads(raw)
            except ValueError:
                raise ApiError(400, "The request was not valid JSON.") from None
            return data if isinstance(data, dict) else {}

        def _static(self, path: str) -> bool:
            if path in ("/", "/index.html") or re.fullmatch(r"/s/[^/]+(/.*)?", path) and not path.endswith(("/graph", "/screenshot")):
                html = (STATIC / "index.html").read_text(encoding="utf-8")
                html = html.replace("__TOKEN__", token).replace("__VERSION__", __version__)
                self._send(200, html.encode(), "text/html; charset=utf-8")
                return True
            m = re.fullmatch(r"/((?:js/(?:views/)?|fonts/)?[a-z0-9_-]+\.(?:js|css|svg|woff2))", path)
            if m:
                f = (STATIC / m.group(1)).resolve()
                if STATIC.resolve() in f.parents and f.is_file():
                    ctype = {"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                             "svg": "image/svg+xml", "woff2": "font/woff2"}[f.suffix[1:]]
                    self._send(200, f.read_bytes(), ctype, cache=f.suffix == ".woff2")
                    return True
            return False

        def _dispatch(self, method: str) -> None:
            raw = self._read_raw() if method == "POST" else b""
            if not self._host_ok():
                return self._send(403, b"forbidden", "text/plain")
            parts = urlsplit(self.path)
            path = parts.path
            if method == "GET" and self._static(path):
                return
            if method == "POST" and self.headers.get("X-LV-Token") != token:
                return self._send(403, b"forbidden", "text/plain")
            # site pages that aren't JSON: the graph report and screenshots
            m = re.fullmatch(r"/s/([^/]+)/graph", path)
            if method == "GET" and m:
                ctx = app.site(m.group(1))
                gp = ctx.cfg.data_dir / "sitegraph.html" if ctx else None
                if gp and gp.is_file():
                    return self._send(200, gp.read_bytes(), "text/html; charset=utf-8")
                return self._send(404, b"No site map yet.", "text/plain; charset=utf-8")
            for meth, pattern, fn, is_site in ROUTES:
                if meth != method:
                    continue
                mm = pattern.match(path)
                if not mm:
                    continue
                try:
                    req = Req(app, method, path, {k: v[-1] for k, v in parse_qs(parts.query).items()},
                              self._body(raw) if method == "POST" else {}, mm.groupdict())
                    if is_site:
                        req.site = app.site(req.params["site"])
                        if req.site is None:
                            raise ApiError(404, "That site is not set up here.")
                    out = fn(req)
                except ApiError as exc:
                    return self._json({"error": exc.message}, exc.status)
                except workspace.SettingsFileError as exc:
                    return self._json({"error": str(exc)}, 500)
                except Exception as exc:  # show the cause; never a silent 500
                    traceback.print_exc()
                    return self._json({"error": f"Something went wrong: {type(exc).__name__}: {exc}"}, 500)
                if isinstance(out, Raw):
                    return self._send(out.status, out.body, out.ctype)
                return self._json(out)
            self._json({"error": "Not found."}, 404)

        def do_GET(self):
            self._dispatch("GET")

        def do_HEAD(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    return Handler


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows, address reuse lets a second copy bind the same port and answer half the requests.
    allow_reuse_address = sys.platform != "win32"


def make_server(target: str | Path | Config | None = None, port: int | None = None) -> tuple[ThreadingHTTPServer, str]:
    """target: a config.toml path (workspace) or a Config (one fixed site)."""
    app = App(fixed=target) if isinstance(target, Config) else App(config_path=target)
    if port is None:
        port = app.shared_cfg().dashboard_port
    token = secrets.token_urlsafe(24)
    srv = _Server(("127.0.0.1", port), make_handler(app, token, port))
    real = srv.server_address[1]
    if real != port:  # port 0 (tests): rebuild with the real port so the Host check matches
        srv.server_close()
        srv = _Server(("127.0.0.1", real), make_handler(app, token, real))
    srv.app = app
    return srv, token


def serve(target=None, open_browser: bool = True, port: int | None = None) -> int:
    from .. import workspace
    try:
        srv, _ = make_server(target, port)
    except workspace.SettingsFileError as exc:
        print(exc)
        return 1
    except OSError as exc:
        # usually the app is already open (a second double-click on the shortcut): just show it
        try:
            p = port or (App(fixed=target) if isinstance(target, Config) else App(config_path=target)).shared_cfg().dashboard_port
            import urllib.request
            with urllib.request.urlopen(f"http://127.0.0.1:{p}/", timeout=3) as r:
                if r.headers.get("Server", "").startswith("BacklinkVerifier") or b"Backlink Verifier" in r.read(4000):
                    print(f"Backlink Verifier is already running. Opening http://127.0.0.1:{p}/")
                    if open_browser:
                        webbrowser.open(f"http://127.0.0.1:{p}/")
                    return 0
        except Exception:
            pass
        print(f"Could not start the app on port {port or 'from your settings'}: {exc}")
        print("It is probably already open: look for its browser tab. Or try: linkverify dashboard --port 8788")
        return 1
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"Backlink Verifier is running at {url}")
    print("Keep this window open while you use it. Press Ctrl+C to stop.")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        srv.server_close()
    return 0


mimetypes.add_type("text/javascript", ".js")
