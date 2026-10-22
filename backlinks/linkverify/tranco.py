"""Free site strength: where a site ranks among the world's top million websites.

Uses the Tranco list (tranco-list.eu), a free research ranking built from five traffic
and popularity sources. No account, no key. The list is downloaded once a month
(about 10 MB) and kept in a small local database for instant lookups.

This is not Ahrefs DR. It measures how popular a site is, which for big sites
tracks authority closely: every DR 90+ site is in the top few thousand.
A site outside the top million gets no score (most small local sites).
"""

from __future__ import annotations

import csv
import io
import math
import sqlite3
import threading
import time
import zipfile
from pathlib import Path

import httpx

from .config import Config
from .domains import site_of

URL = "https://tranco-list.eu/top-1m.csv.zip"
MAX_AGE_DAYS = 30
_LOCK = threading.Lock()


def score(rank: int | None) -> float | None:
    """0-100 from a rank: 1 -> 100, 100 -> 70, 10,000 -> 40, 1,000,000 -> 10."""
    if not rank or rank < 1:
        return None
    return round(max(5.0, 100 - 15 * math.log10(rank)), 1)


def _db_path(cfg: Config) -> Path:
    return cfg.cache_path / "tranco.db"


def _fresh(path: Path) -> bool:
    return path.is_file() and time.time() - path.stat().st_mtime < MAX_AGE_DAYS * 86400


def build_db(zip_bytes: bytes, db: Path) -> int:
    """Load the zipped CSV ("rank,domain" per line) into a lookup table. Returns the row count."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        name = next(n for n in z.namelist() if n.endswith(".csv"))
        text = z.read(name).decode("utf-8", "replace")
    db.parent.mkdir(parents=True, exist_ok=True)
    tmp = db.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp)
    conn.execute("CREATE TABLE t (domain TEXT PRIMARY KEY, rank INTEGER NOT NULL)")
    rows = ((d.strip().lower(), int(r)) for r, d in csv.reader(io.StringIO(text)) if r.isdigit() and d.strip())
    conn.executemany("INSERT OR IGNORE INTO t VALUES (?, ?)", rows)
    n = conn.execute("SELECT COUNT(*) FROM t").fetchone()[0]
    conn.commit()
    conn.close()
    tmp.replace(db)
    return n


def ensure(cfg: Config, fetch=None) -> tuple[bool, str]:
    """Make sure a recent list is available. Returns (ok, message). Never raises."""
    db = _db_path(cfg)
    if _fresh(db):
        return True, ""
    failed = db.with_suffix(".failed")
    if failed.is_file() and time.time() - failed.stat().st_mtime < 3600 and not fetch:
        return db.is_file(), "The free site ranking could not be downloaded recently; will try again later."
    with _LOCK:
        if _fresh(db):
            return True, ""
        try:
            data = fetch() if fetch else httpx.get(URL, timeout=120, follow_redirects=True,
                                                   headers={"User-Agent": cfg.user_agent}).raise_for_status().content
            n = build_db(data, db)
            return True, f"Downloaded the free site ranking ({n:,} sites)."
        except Exception as exc:  # offline, blocked, bad file: keep the old list if there is one
            try:
                failed.parent.mkdir(parents=True, exist_ok=True)
                failed.write_text(str(exc)[:500], encoding="utf-8")  # don't retry on every check
            except OSError:
                pass
            if db.is_file():
                return True, f"Could not refresh the site ranking ({exc}); using the previous copy."
            return False, f"The free site ranking could not be downloaded: {exc}"


def ranks(cfg: Config, hosts: list[str]) -> dict[str, int]:
    """{site: rank} for the sites found in the top million. Downloads the list if needed."""
    if not cfg.use_tranco or not hosts:
        return {}
    ok, _ = ensure(cfg)
    if not ok:
        return {}
    sites = {site_of(h) for h in hosts if h}
    sites.discard("")
    out: dict[str, int] = {}
    conn = sqlite3.connect(_db_path(cfg))
    try:
        for s in sites:
            row = conn.execute("SELECT rank FROM t WHERE domain = ?", (s,)).fetchone()
            if row:
                out[s] = row[0]
    finally:
        conn.close()
    return out


def describe(rank: int | None) -> str:
    if not rank:
        return "not in the world's top million sites"
    return f"world rank {rank:,} (popularity {score(rank):g} of 100)"
