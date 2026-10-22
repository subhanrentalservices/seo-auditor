"""Domain and URL helpers.

Uses the Public Suffix List (bundled with tldextract, no network needed), with
private suffixes switched on, so that `you.blogspot.com` and `me.github.io`
are treated as their own sites, the same way Ahrefs treats them.
"""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit, urlunsplit

import tldextract

_extract = tldextract.TLDExtract(
    suffix_list_urls=(),  # use the bundled snapshot, never fetch
    cache_dir=None,
    include_psl_private_domains=True,
)


def host_of(url: str) -> str:
    """Lower-case host name of a URL, without port."""
    try:
        return (urlsplit(url).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def site_of(host_or_url: str) -> str:
    """The registrable site a host belongs to.

    example.com for www.example.com, you.blogspot.com for you.blogspot.com.
    IP addresses and single-label hosts (localhost) are returned as they are.
    """
    host = host_or_url
    if "://" in host_or_url:
        host = host_of(host_or_url)
    else:  # a bare "example.com/page" or "example.com:8080"
        host = host.strip().split("/")[0]
        if host.count(":") == 1:
            host = host.split(":")[0]
    host = host.lower().strip().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return ""
    if _is_ip(host) or "." not in host:
        return host
    parts = _extract(host)
    site = getattr(parts, "top_domain_under_public_suffix", None)
    if site is None:  # older tldextract
        site = parts.registered_domain
    return site or host


def normalize_url(url: str) -> str:
    """A comparable form of a URL.

    Drops the fragment, default ports, a leading www. and a trailing slash, and
    lower-cases scheme and host. http and https compare equal.
    """
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    host = (parts.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    port = parts.port
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    path = parts.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return urlunsplit(("https", netloc, path, parts.query, ""))


class TargetMatcher:
    """Decides whether a link points to the user's site.

    A target is either a site ("example.com": any page on it matches) or a
    full URL ("https://example.com/page": only that page matches).
    """

    def __init__(self, target: str):
        target = target.strip()
        self.raw = target
        if "://" in target:
            self.url = normalize_url(target)
            self.site = site_of(target)
        else:
            self.url = None
            self.site = site_of(target)

    def matches(self, absolute_url: str) -> bool:
        if not absolute_url.lower().startswith(("http://", "https://")):
            return False
        if self.url is not None:
            return normalize_url(absolute_url) == self.url
        return site_of(absolute_url) == self.site

    def mentioned_in(self, text: str) -> bool:
        return bool(self.site) and self.site.lower() in text.lower()
