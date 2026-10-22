"""Optional headless-browser rendering (Playwright + Chromium).

Used for check 4 (does the link exist after JavaScript runs?) and for the
rendered half of check 12 (is the link visible?). If Playwright is not
installed, those parts are skipped and the report says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

_JS_LINKS = """
(anchors) => anchors.map(a => {
  const r = a.getBoundingClientRect();
  const s = getComputedStyle(a);
  let hiddenBy = '';
  for (let n = a; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none') { hiddenBy = 'display:none'; break; }
    if (cs.visibility === 'hidden') { hiddenBy = 'visibility:hidden'; break; }
    if (parseFloat(cs.opacity) === 0) { hiddenBy = 'opacity:0'; break; }
  }
  const docW = Math.max(document.documentElement.scrollWidth, innerWidth);
  const off = (r.right < 0 || r.bottom < 0 || r.left > docW + 2000);
  return {
    href: a.href, rawHref: a.getAttribute('href') || '', rel: (a.getAttribute('rel') || '').toLowerCase(),
    text: (a.innerText || '').trim().slice(0, 200), width: r.width, height: r.height,
    fontSize: s.fontSize, hiddenBy, offscreen: off,
  };
})
"""


@dataclass
class RenderResult:
    available: bool
    html: str = ""
    final_url: str = ""
    anchors: list[dict] = field(default_factory=list)
    error: str = ""
    screenshot: str = ""


def playwright_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except ImportError:
        return False


class Renderer:
    def __init__(self, user_agent: str, timeout_seconds: float):
        self.user_agent = user_agent
        self.timeout_ms = int(timeout_seconds * 1000)
        self._pw = None
        self._browser = None

    def _start(self) -> None:
        from playwright.sync_api import sync_playwright

        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch()

    def close(self) -> None:
        if self._browser:
            self._browser.close()
        if self._pw:
            self._pw.stop()

    def render(self, url: str, screenshot_path: Path | None = None) -> RenderResult:
        if not playwright_available():
            return RenderResult(False, error="Playwright is not installed")
        try:
            if self._browser is None:
                self._start()
            ctx = self._browser.new_context(user_agent=self.user_agent, viewport={"width": 1366, "height": 900})
            page = ctx.new_page()
            try:
                page.goto(url, wait_until="load", timeout=self.timeout_ms)
                try:
                    page.wait_for_load_state("networkidle", timeout=min(10_000, self.timeout_ms))
                except Exception:
                    pass  # busy pages never go idle; the loaded DOM is enough
                anchors = page.eval_on_selector_all("a[href]", _JS_LINKS)
                html = page.content()
                shot = ""
                if screenshot_path is not None:
                    screenshot_path.parent.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(screenshot_path), full_page=False)
                    shot = str(screenshot_path)
                return RenderResult(True, html=html, final_url=page.url, anchors=anchors, screenshot=shot)
            finally:
                ctx.close()
        except Exception as exc:  # browser missing, timeout, crash
            msg = str(exc).splitlines()[0][:300] if str(exc) else type(exc).__name__
            if "Executable doesn't exist" in str(exc):
                msg = "Chromium is not installed; run: python -m playwright install chromium"
            return RenderResult(True, error=msg)
