"""Polite HTTP fetching with a recorded redirect chain."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx

from .config import Config
from .domains import host_of


@dataclass
class FetchResult:
    requested_url: str
    final_url: str = ""
    status: int = 0
    headers: dict[str, str] = field(default_factory=dict)
    header_list: list[tuple[str, str]] = field(default_factory=list)
    text: str = ""
    hops: list[tuple[str, int]] = field(default_factory=list)  # (url, status) for each redirect
    error: str = ""
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return not self.error and self.status == 200

    def header_values(self, name: str) -> list[str]:
        name = name.lower()
        return [v for k, v in self.header_list if k.lower() == name]


class Fetcher:
    """Fetches pages one at a time, waiting between requests to the same host."""

    MAX_REDIRECTS = 10

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.client = httpx.Client(
            follow_redirects=False,
            timeout=cfg.timeout_seconds,
            headers={
                "User-Agent": cfg.user_agent,
                "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
                "Accept-Language": "en-US,en;q=0.8",
            },
        )
        self._last_hit: dict[str, float] = {}
        self._cache: dict[str, FetchResult] = {}

    def close(self) -> None:
        self.client.close()

    def _wait_for(self, url: str) -> None:
        host = host_of(url)
        last = self._last_hit.get(host)
        if last is not None:
            gap = time.monotonic() - last
            if gap < self.cfg.delay_seconds:
                time.sleep(self.cfg.delay_seconds - gap)
        self._last_hit[host] = time.monotonic()

    def status_of(self, url: str, timeout: float = 10.0) -> tuple[int, str]:
        """Status code of a URL after redirects, without downloading the body. (0, error) on failure."""
        self._wait_for(url)
        try:
            resp = self.client.head(url, follow_redirects=True, timeout=timeout)
            if resp.status_code in (400, 403, 405, 501):  # many servers refuse HEAD; ask again with GET
                with self.client.stream("GET", url, follow_redirects=True, timeout=timeout) as r:
                    return r.status_code, ""
            return resp.status_code, ""
        except httpx.HTTPError as exc:
            return 0, f"{type(exc).__name__}: {exc}".strip()

    def get(self, url: str, use_cache: bool = True) -> FetchResult:
        if use_cache and url in self._cache:
            return self._cache[url]
        result = FetchResult(requested_url=url)
        current = url
        for _ in range(self.MAX_REDIRECTS + 1):
            self._wait_for(current)
            try:
                with self.client.stream("GET", current) as resp:
                    status = resp.status_code
                    if status in (301, 302, 303, 307, 308) and "location" in resp.headers:
                        result.hops.append((current, status))
                        current = urljoin(current, resp.headers["location"])
                        continue
                    body = bytearray()
                    for chunk in resp.iter_bytes():
                        body.extend(chunk)
                        if len(body) > self.cfg.max_page_bytes:
                            result.truncated = True
                            break
                    result.status = status
                    result.final_url = str(resp.url)
                    result.header_list = list(resp.headers.multi_items())
                    result.headers = {k.lower(): v for k, v in resp.headers.items()}
                    encoding = resp.encoding or "utf-8"
                    try:
                        result.text = bytes(body).decode(encoding, errors="replace")
                    except LookupError:
                        result.text = bytes(body).decode("utf-8", errors="replace")
                    break
            except httpx.HTTPError as exc:
                result.error = f"{type(exc).__name__}: {exc}".strip()
                result.final_url = current
                break
        else:
            result.error = f"more than {self.MAX_REDIRECTS} redirects"
            result.final_url = current
        self._cache[url] = result
        return result
