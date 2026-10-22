"""'Test' buttons in Settings: each checks one connection and says plainly what happened.

All of these are free calls: DataForSEO's account info, Ahrefs' usage info and
Anthropic's model list cost nothing. The inbox test only logs in and opens the folder.
"""

from __future__ import annotations

import imaplib

import httpx

from .. import alerts
from ..config import Config
from ..finders import parse_alerts_feed


def _r(ok: bool, message: str) -> dict:
    return {"ok": ok, "message": message}


def dataforseo(cfg: Config) -> dict:
    if not cfg.has_dataforseo:
        return _r(False, "Enter your DataForSEO login and password first.")
    try:
        resp = httpx.get("https://api.dataforseo.com/v3/appendix/user_data",
                         auth=(cfg.dataforseo_login, cfg.dataforseo_password), timeout=20)
    except httpx.HTTPError as exc:
        return _r(False, f"Could not reach DataForSEO: {exc}")
    if resp.status_code == 401:
        return _r(False, "DataForSEO rejected the login or password. Use the API password from your dashboard, not your account password.")
    try:
        data = resp.json()
        res = (data.get("tasks") or [{}])[0].get("result") or [{}]
        money = res[0].get("money") or {}
    except (ValueError, AttributeError, IndexError):
        return _r(False, f"DataForSEO answered HTTP {resp.status_code} with something unexpected.")
    if data.get("status_code") not in (20000, None):
        return _r(False, f"DataForSEO said: {data.get('status_message')}")
    bal = money.get("balance")
    return _r(True, f"Connected. Balance: ${bal:.2f}." if isinstance(bal, (int, float)) else "Connected.")


def ahrefs(cfg: Config) -> dict:
    if not cfg.ahrefs_api_key:
        return _r(False, "Enter your Ahrefs API key first.")
    try:
        resp = httpx.get("https://api.ahrefs.com/v3/subscription-info/limits-and-usage",
                         headers={"Authorization": f"Bearer {cfg.ahrefs_api_key}", "Accept": "application/json"}, timeout=20)
    except httpx.HTTPError as exc:
        return _r(False, f"Could not reach Ahrefs: {exc}")
    if resp.status_code in (401, 403):
        return _r(False, "Ahrefs rejected the key. Check it at app.ahrefs.com/api/keys, and that your plan includes API access.")
    if resp.status_code != 200:
        return _r(False, f"Ahrefs answered HTTP {resp.status_code}: {resp.text[:150]}")
    lu = resp.json().get("limits_and_usage") or {}
    used, limit = lu.get("units_usage_workspace"), lu.get("units_limit_workspace")
    plan = lu.get("subscription") or "your plan"
    return _r(True, f"Connected ({plan}). Units used this month: {used} of {limit}." if used is not None else f"Connected ({plan}).")


def anthropic(cfg: Config) -> dict:
    if not cfg.anthropic_api_key:
        return _r(False, "Enter your Anthropic API key first.")
    try:
        resp = httpx.get("https://api.anthropic.com/v1/models", timeout=20,
                         headers={"x-api-key": cfg.anthropic_api_key, "anthropic-version": "2026-10-21"})
    except httpx.HTTPError as exc:
        return _r(False, f"Could not reach Anthropic: {exc}")
    if resp.status_code == 401:
        return _r(False, "Anthropic rejected the key. Create one at console.anthropic.com.")
    if resp.status_code != 200:
        return _r(False, f"Anthropic answered HTTP {resp.status_code}: {resp.text[:150]}")
    ids = [m.get("id") for m in resp.json().get("data", [])]
    if cfg.anthropic_model not in ids and ids:
        return _r(False, f"The key works, but the model '{cfg.anthropic_model}' is not available to it. Try: {', '.join(ids[:3])}")
    return _r(True, "Connected. AI drafts are on.")


def inbox(cfg: Config) -> dict:
    if not cfg.has_imap:
        return _r(False, "Enter the mail server, email address and app password first.")
    try:
        with imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port, timeout=20) as m:
            m.login(cfg.imap_username, cfg.imap_password)
            typ, data = m.select(f'"{cfg.imap_folder}"', readonly=True)
            if typ != "OK":
                return _r(False, f"Logged in, but the folder '{cfg.imap_folder}' was not found.")
            return _r(True, f"Connected. {int(data[0])} messages in {cfg.imap_folder}. The tool only reads request newsletters.")
    except imaplib.IMAP4.error as exc:
        msg = str(exc)
        if "AUTHENTICATIONFAILED" in msg.upper() or "invalid credentials" in msg.lower():
            return _r(False, "The mail server rejected the login. For Gmail, use an App Password, not your normal password.")
        return _r(False, f"The mail server said: {msg[:150]}")
    except OSError as exc:
        return _r(False, f"Could not reach {cfg.imap_host}: {exc}")


def alert(cfg: Config) -> dict:
    ch = alerts.channels(cfg)
    if not ch:
        return _r(False, "Set up email or Telegram first.")
    status = alerts.send(cfg, "Backlink Verifier test alert", "This is a test alert from Backlink Verifier. Alerts work.")
    ok = all("FAILED" not in s for s in status)
    return _r(ok, " ".join(s[0].upper() + s[1:] + "." for s in status))


def feeds(cfg: Config) -> dict:
    if not cfg.google_alerts_feeds:
        return _r(False, "Paste at least one Google Alerts RSS feed address first.")
    out = []
    ok = True
    for f in cfg.google_alerts_feeds:
        try:
            resp = httpx.get(f, timeout=20, follow_redirects=True)
            n = len(parse_alerts_feed(resp.text)) if resp.status_code == 200 else None
        except httpx.HTTPError as exc:
            n, ok = None, False
            out.append(f"{f[:50]}: {exc}")
            continue
        if n is None:
            ok = False
            out.append(f"{f[:50]}: HTTP {resp.status_code}")
        else:
            out.append(f"Feed works, {n} recent result(s).")
    return _r(ok, " ".join(out))


def notify_test(cfg: Config) -> dict:
    from .. import notify
    shown, msg = notify.show("Backlink Verifier", "Notifications work. You'll see one like this after the daily run when something needs you.")
    if shown:
        return _r(True, "Sent. Look at the bottom-right of your screen.")
    return _r(False, msg[0].upper() + msg[1:] + ".")


TESTS = {"notify": notify_test, "dataforseo": dataforseo, "ahrefs": ahrefs, "anthropic": anthropic, "inbox": inbox, "alerts": alert, "feeds": feeds}
