"""Alerts by email (SMTP) and Telegram."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage

import httpx

from .config import Config

ICON = {"bad": "PROBLEM", "good": "RECOVERED", "info": "INFO"}


def channels(cfg: Config) -> list[str]:
    out = []
    if cfg.has_email:
        out.append("email")
    if cfg.has_telegram:
        out.append("telegram")
    return out


KIND_LABEL = {
    "unlinked_mention": "Unlinked mention",
    "journalist": "Journalist request",
    "gap": "Competitor gap",
    "broken_backlink": "Broken competitor link",
    "broken_link": "Broken link on resource page",
    "resource_page": "Resource page",
    "listing": "Free listing",
    "profile": "Your profile",
    "partner": "Competitor partner",
}


def format_opportunities(opps: list) -> list[str]:
    lines = [f"New opportunities ({len(opps)}):"]
    for o in opps[:15]:
        lines.append(f"  [{o['score']}] {KIND_LABEL.get(o['kind'], o['kind'])}: {o['title'][:90]}")
        if not o["url"].startswith("email:"):
            lines.append(f"       {o['url']}")
    if len(opps) > 15:
        lines.append(f"  …and {len(opps) - 15} more in the dashboard.")
    return lines


def format_full_digest(events: list, opps: list) -> tuple[str, str]:
    if events:
        subject, text = format_digest(events)
        if opps:
            subject += f", {len(opps)} new opportunit{'ies' if len(opps) != 1 else 'y'}"
            text += "\n\n" + "\n".join(format_opportunities(opps))
        return subject, text
    best = opps[0]
    subject = f"Backlink alert: {len(opps)} new opportunit{'ies' if len(opps) != 1 else 'y'} (best score {best['score']})"
    return subject, "\n".join([subject, ""] + format_opportunities(opps) + ["", "Open the dashboard to work on them."])


def format_digest(events: list) -> tuple[str, str]:
    """(subject, text) for a list of event rows."""
    bad = len({e["link_id"] for e in events if e["severity"] == "bad"})
    good = len({e["link_id"] for e in events if e["severity"] == "good"} - {e["link_id"] for e in events if e["severity"] == "bad"})
    parts = []
    if bad:
        parts.append(f"problems on {bad} link{'s' if bad != 1 else ''}")
    if good:
        parts.append(f"{good} link{'s' if good != 1 else ''} recovered")
    subject = "Backlink alert: " + (", ".join(parts) or f"{len(events)} change(s)")
    lines = [subject, ""]
    by_link: dict[int, list] = {}
    for e in events:
        by_link.setdefault(e["link_id"], []).append(e)
    for link_id, evs in by_link.items():
        lines.append(f"#{link_id} {evs[0]['source_url']}  ->  {evs[0]['target']}")
        for e in evs:
            lines.append(f"  [{ICON.get(e['severity'], e['severity'])}] {e['detail']}")
        lines.append("")
    lines.append("Open the dashboard or run: linkverify show <number>")
    return subject, "\n".join(lines)


def send_email(cfg: Config, subject: str, text: str) -> str:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = cfg.email_from or cfg.email_username
    msg["To"] = cfg.email_to
    msg.set_content(text)
    ctx = ssl.create_default_context()
    if cfg.email_smtp_port == 465:
        with smtplib.SMTP_SSL(cfg.email_smtp_host, 465, context=ctx, timeout=30) as s:
            if cfg.email_username:
                s.login(cfg.email_username, cfg.email_password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg.email_smtp_host, cfg.email_smtp_port, timeout=30) as s:
            s.starttls(context=ctx)
            if cfg.email_username:
                s.login(cfg.email_username, cfg.email_password)
            s.send_message(msg)
    return "email sent"


def send_telegram(cfg: Config, text: str) -> str:
    # Telegram messages are limited to 4096 characters
    chunks = [text[i:i + 3900] for i in range(0, len(text), 3900)] or [text]
    for chunk in chunks:
        resp = httpx.post(
            f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendMessage",
            json={"chat_id": cfg.telegram_chat_id, "text": chunk, "disable_web_page_preview": True},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Telegram returned {resp.status_code}: {resp.text[:200]}")
    return "telegram sent"


def send(cfg: Config, subject: str, text: str) -> list[str]:
    """Send on every configured channel. Returns one status line per channel."""
    results = []
    if cfg.has_email:
        try:
            results.append(send_email(cfg, subject, text))
        except Exception as exc:
            results.append(f"email FAILED: {exc}")
    if cfg.has_telegram:
        try:
            results.append(send_telegram(cfg, text))
        except Exception as exc:
            results.append(f"telegram FAILED: {exc}")
    return results
