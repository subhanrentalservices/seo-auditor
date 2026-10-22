"""The link registry: a small SQLite database."""

from __future__ import annotations

import csv
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url    TEXT NOT NULL,
    target        TEXT NOT NULL,
    strategy      TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    added_at      TEXT NOT NULL,
    last_checked  TEXT,
    last_verdict  TEXT,
    UNIQUE (source_url, target)
);
CREATE TABLE IF NOT EXISTS checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    run_at        TEXT NOT NULL,
    verdict       TEXT NOT NULL,
    result_json   TEXT NOT NULL,
    evidence_dir  TEXT
);
CREATE INDEX IF NOT EXISTS checks_by_link ON checks (link_id, run_at);
CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id       INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
    at            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    severity      TEXT NOT NULL,   -- bad | good | info
    detail        TEXT NOT NULL,
    alerted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_by_time ON events (at);
CREATE TABLE IF NOT EXISTS opportunities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key    TEXT NOT NULL UNIQUE,
    kind          TEXT NOT NULL,   -- unlinked_mention | journalist | gap | broken_backlink | broken_link | resource_page
    url           TEXT NOT NULL,   -- the page or site to work on
    title         TEXT NOT NULL DEFAULT '',
    site          TEXT NOT NULL DEFAULT '',
    found_at      TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'new',  -- new | working | pitched | won | lost | ignored
    score         INTEGER NOT NULL DEFAULT 0,
    score_detail  TEXT NOT NULL DEFAULT '',
    data_json     TEXT NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT '',
    link_id       INTEGER REFERENCES links(id) ON DELETE SET NULL,
    alerted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS opps_by_score ON opportunities (status, score);
CREATE TABLE IF NOT EXISTS meta (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_costs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    provider      TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    cost_usd      REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    opp_id        INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL,
    source        TEXT NOT NULL,   -- template | ai
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    contacts_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS campaigns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    asset_url     TEXT NOT NULL,
    phrases_json  TEXT NOT NULL DEFAULT '[]',
    started_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_checked  TEXT,
    notes         TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pickups (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id   INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    url           TEXT NOT NULL,
    site          TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    found_at      TEXT NOT NULL,
    kind          TEXT NOT NULL,   -- linked | mention
    source        TEXT NOT NULL,
    link_id       INTEGER REFERENCES links(id) ON DELETE SET NULL,
    opp_id        INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
    UNIQUE (campaign_id, url)
);
CREATE TABLE IF NOT EXISTS platforms (
    url           TEXT PRIMARY KEY,
    site          TEXT NOT NULL,
    tested_at     TEXT NOT NULL,
    verdict       TEXT NOT NULL,
    summary_json  TEXT NOT NULL
);
"""

OPP_STATUSES = ("new", "working", "pitched", "won", "lost", "ignored")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Registry:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")  # dashboard reads while checks write
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # links -------------------------------------------------------------
    def add(self, source_url: str, target: str, strategy: str = "", notes: str = "") -> tuple[int, bool]:
        """Add a link. Returns (id, created). An existing pair is not duplicated."""
        source_url, target = source_url.strip(), target.strip()
        row = self.conn.execute(
            "SELECT id FROM links WHERE source_url = ? AND target = ?", (source_url, target)
        ).fetchone()
        if row:
            return row["id"], False
        cur = self.conn.execute(
            "INSERT INTO links (source_url, target, strategy, notes, added_at) VALUES (?, ?, ?, ?, ?)",
            (source_url, target, strategy.strip(), notes.strip(), now_iso()),
        )
        self.conn.commit()
        return cur.lastrowid, True

    def import_csv(self, path: Path, default_target: str = "") -> tuple[int, int, list[str]]:
        """Import rows with columns source_url, target, strategy, notes.

        Returns (added, skipped, problems).
        """
        added = skipped = 0
        problems: list[str] = []
        with path.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            for n, row in enumerate(reader, start=2):
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
                src = row.get("source_url") or row.get("url") or row.get("source") or ""
                tgt = row.get("target") or default_target
                if not src.lower().startswith(("http://", "https://")):
                    problems.append(f"line {n}: source_url must start with http:// or https://")
                    continue
                if not tgt:
                    problems.append(f"line {n}: no target (add a target column or use --target)")
                    continue
                _, created = self.add(src, tgt, row.get("strategy", ""), row.get("notes", ""))
                added += created
                skipped += not created
        return added, skipped, problems

    def get(self, link_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()

    def all(self, verdict: str | None = None) -> list[sqlite3.Row]:
        if verdict:
            return self.conn.execute(
                "SELECT * FROM links WHERE lower(last_verdict) = lower(?) ORDER BY id", (verdict,)
            ).fetchall()
        return self.conn.execute("SELECT * FROM links ORDER BY id").fetchall()

    def due(self, days: int) -> list[sqlite3.Row]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).replace(microsecond=0).isoformat()
        return self.conn.execute(
            "SELECT * FROM links WHERE last_checked IS NULL OR last_checked < ? ORDER BY id", (cutoff,)
        ).fetchall()

    def update_link(self, link_id: int, strategy: str | None = None, notes: str | None = None) -> bool:
        sets, args = [], []
        if strategy is not None:
            sets.append("strategy = ?")
            args.append(strategy.strip())
        if notes is not None:
            sets.append("notes = ?")
            args.append(notes.strip())
        if not sets:
            return False
        cur = self.conn.execute(f"UPDATE links SET {', '.join(sets)} WHERE id = ?", (*args, link_id))
        self.conn.commit()
        return cur.rowcount > 0

    def remove(self, link_id: int) -> bool:
        cur = self.conn.execute("DELETE FROM links WHERE id = ?", (link_id,))
        self.conn.commit()
        return cur.rowcount > 0

    # checks ------------------------------------------------------------
    def record(self, link_id: int, result: dict, evidence_dir: str | None) -> None:
        run_at = result.get("checked_at") or now_iso()
        self.conn.execute(
            "INSERT INTO checks (link_id, run_at, verdict, result_json, evidence_dir) VALUES (?, ?, ?, ?, ?)",
            (link_id, run_at, result["verdict"], json.dumps(result), evidence_dir),
        )
        self.conn.execute(
            "UPDATE links SET last_checked = ?, last_verdict = ? WHERE id = ?",
            (run_at, result["verdict"], link_id),
        )
        self.conn.commit()

    def latest(self, link_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT result_json FROM checks WHERE link_id = ? ORDER BY run_at DESC, id DESC LIMIT 1",
            (link_id,),
        ).fetchone()
        return json.loads(row["result_json"]) if row else None

    def history(self, link_id: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT run_at, verdict FROM checks WHERE link_id = ? ORDER BY run_at DESC, id DESC",
            (link_id,),
        ).fetchall()

    # events --------------------------------------------------------------
    def add_event(self, link_id: int, kind: str, severity: str, detail: str, at: str | None = None) -> int:
        cur = self.conn.execute(
            "INSERT INTO events (link_id, at, kind, severity, detail) VALUES (?, ?, ?, ?, ?)",
            (link_id, at or now_iso(), kind, severity, detail),
        )
        self.conn.commit()
        return cur.lastrowid

    def events(self, link_id: int | None = None, limit: int = 100) -> list[sqlite3.Row]:
        sql = ("SELECT e.*, l.source_url, l.target FROM events e JOIN links l ON l.id = e.link_id"
               + (" WHERE e.link_id = ?" if link_id is not None else "")
               + " ORDER BY e.at DESC, e.id ASC LIMIT ?")  # same moment: verdict change first
        args = (link_id, limit) if link_id is not None else (limit,)
        return self.conn.execute(sql, args).fetchall()

    def unalerted(self, severities: tuple[str, ...]) -> list[sqlite3.Row]:
        marks = ",".join("?" * len(severities))
        return self.conn.execute(
            f"SELECT e.*, l.source_url, l.target FROM events e JOIN links l ON l.id = e.link_id "
            f"WHERE e.alerted = 0 AND e.severity IN ({marks}) ORDER BY e.at, e.id", severities
        ).fetchall()

    def mark_alerted(self, ids: list[int]) -> None:
        if ids:
            self.conn.executemany("UPDATE events SET alerted = 1 WHERE id = ?", [(i,) for i in ids])
            self.conn.commit()

    # opportunities -------------------------------------------------------
    def upsert_opportunity(self, key: str, kind: str, url: str, title: str, site: str, score: int,
                           score_detail: str, data: dict) -> tuple[int, bool]:
        """Insert a new opportunity, or refresh one that is still 'new'. Returns (id, created)."""
        row = self.conn.execute("SELECT id, status FROM opportunities WHERE dedupe_key = ?", (key,)).fetchone()
        now = now_iso()
        if row:
            if row["status"] == "new":
                self.conn.execute(
                    "UPDATE opportunities SET title = ?, score = ?, score_detail = ?, data_json = ?, updated_at = ? WHERE id = ?",
                    (title, score, score_detail, json.dumps(data), now, row["id"]),
                )
                self.conn.commit()
            return row["id"], False
        cur = self.conn.execute(
            "INSERT INTO opportunities (dedupe_key, kind, url, title, site, found_at, updated_at, score, score_detail, data_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (key, kind, url, title, site, now, now, score, score_detail, json.dumps(data)),
        )
        self.conn.commit()
        return cur.lastrowid, True

    def opportunity(self, opp_id: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM opportunities WHERE id = ?", (opp_id,)).fetchone()

    def opportunities(self, kind: str | None = None, status: str | None = None, min_score: int = 0,
                      limit: int = 500) -> list[sqlite3.Row]:
        sql, args = "SELECT * FROM opportunities WHERE score >= ?", [min_score]
        if kind:
            sql += " AND kind = ?"
            args.append(kind)
        if status:
            sql += " AND status = ?"
            args.append(status)
        sql += " ORDER BY (status IN ('won','lost','ignored')), score DESC, found_at DESC LIMIT ?"
        args.append(limit)
        return self.conn.execute(sql, args).fetchall()

    def update_opportunity(self, opp_id: int, status: str | None = None, notes: str | None = None,
                           link_id: int | None = None) -> bool:
        sets, args = ["updated_at = ?"], [now_iso()]
        if status is not None:
            if status not in OPP_STATUSES:
                raise ValueError(f"status must be one of: {', '.join(OPP_STATUSES)}")
            sets.append("status = ?")
            args.append(status)
        if notes is not None:
            sets.append("notes = ?")
            args.append(notes)
        if link_id is not None:
            sets.append("link_id = ?")
            args.append(link_id)
        args.append(opp_id)
        cur = self.conn.execute(f"UPDATE opportunities SET {', '.join(sets)} WHERE id = ?", args)
        self.conn.commit()
        return cur.rowcount > 0

    def opportunities_to_alert(self, min_score: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT * FROM opportunities WHERE alerted = 0 AND status = 'new' AND score >= ? ORDER BY score DESC",
            (min_score,),
        ).fetchall()

    def mark_opportunities_alerted(self, ids: list[int]) -> None:
        if ids:
            self.conn.executemany("UPDATE opportunities SET alerted = 1 WHERE id = ?", [(i,) for i in ids])
            self.conn.commit()

    def opportunity_id(self, key: str) -> int | None:
        row = self.conn.execute("SELECT id FROM opportunities WHERE dedupe_key = ?", (key,)).fetchone()
        return row["id"] if row else None

    def known_opportunity(self, key: str) -> bool:
        return self.conn.execute("SELECT 1 FROM opportunities WHERE dedupe_key = ?", (key,)).fetchone() is not None

    # meta, costs, platforms ------------------------------------------------
    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                          (key, value))
        self.conn.commit()

    def log_cost(self, provider: str, endpoint: str, cost: float) -> None:
        self.conn.execute("INSERT INTO api_costs (at, provider, endpoint, cost_usd) VALUES (?, ?, ?, ?)",
                          (now_iso(), provider, endpoint, float(cost or 0)))
        self.conn.commit()

    def month_cost(self, provider: str = "dataforseo") -> float:
        month = datetime.now(timezone.utc).strftime("%Y-%m")
        row = self.conn.execute("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM api_costs WHERE provider = ? AND substr(at, 1, 7) = ?",
                                (provider, month)).fetchone()
        return float(row["s"])

    def costs_by_month(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT substr(at, 1, 7) AS month, provider, endpoint, COUNT(*) AS calls, ROUND(SUM(cost_usd), 4) AS usd"
            " FROM api_costs GROUP BY month, provider, endpoint ORDER BY month DESC, usd DESC").fetchall()

    def save_platform(self, url: str, site: str, verdict: str, summary: dict) -> None:
        self.conn.execute(
            "INSERT INTO platforms (url, site, tested_at, verdict, summary_json) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(url) DO UPDATE SET site = excluded.site, tested_at = excluded.tested_at,"
            " verdict = excluded.verdict, summary_json = excluded.summary_json",
            (url, site, now_iso(), verdict, json.dumps(summary)))
        self.conn.commit()

    def platforms(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM platforms ORDER BY site").fetchall()

    # drafts ----------------------------------------------------------------
    def save_draft(self, opp_id: int, source: str, subject: str, body: str, contacts: dict) -> int:
        cur = self.conn.execute(
            "INSERT INTO drafts (opp_id, created_at, source, subject, body, contacts_json) VALUES (?, ?, ?, ?, ?, ?)",
            (opp_id, now_iso(), source, subject, body, json.dumps(contacts)))
        self.conn.commit()
        return cur.lastrowid

    def latest_draft(self, opp_id: int) -> dict | None:
        row = self.conn.execute("SELECT * FROM drafts WHERE opp_id = ? ORDER BY id DESC LIMIT 1", (opp_id,)).fetchone()
        if not row:
            return None
        return {"id": row["id"], "created_at": row["created_at"], "source": row["source"], "subject": row["subject"],
                "body": row["body"], "contacts": json.loads(row["contacts_json"])}

    # campaigns ---------------------------------------------------------------
    def add_campaign(self, name: str, asset_url: str, phrases: list[str], started_at: str) -> int:
        cur = self.conn.execute(
            "INSERT INTO campaigns (name, asset_url, phrases_json, started_at, created_at) VALUES (?, ?, ?, ?, ?)",
            (name.strip(), asset_url.strip(), json.dumps([p.strip() for p in phrases if p.strip()]), started_at, now_iso()))
        self.conn.commit()
        return cur.lastrowid

    def campaigns(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT * FROM campaigns ORDER BY id DESC").fetchall()

    def campaign(self, cid: int) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM campaigns WHERE id = ?", (cid,)).fetchone()

    def remove_campaign(self, cid: int) -> bool:
        cur = self.conn.execute("DELETE FROM campaigns WHERE id = ?", (cid,))
        self.conn.commit()
        return cur.rowcount > 0

    def touch_campaign(self, cid: int) -> None:
        self.conn.execute("UPDATE campaigns SET last_checked = ? WHERE id = ?", (now_iso(), cid))
        self.conn.commit()

    def add_pickup(self, cid: int, url: str, site: str, title: str, kind: str, source: str,
                   link_id: int | None = None, opp_id: int | None = None) -> bool:
        try:
            self.conn.execute(
                "INSERT INTO pickups (campaign_id, url, site, title, found_at, kind, source, link_id, opp_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (cid, url, site, title, now_iso(), kind, source, link_id, opp_id))
            self.conn.commit()
            return True
        except sqlite3.IntegrityError:
            return False

    def pickups(self, cid: int) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT p.*, l.last_verdict FROM pickups p LEFT JOIN links l ON l.id = p.link_id"
            " WHERE p.campaign_id = ? ORDER BY p.found_at DESC", (cid,)).fetchall()

    def has_pickup(self, cid: int, url: str) -> bool:
        return self.conn.execute("SELECT 1 FROM pickups WHERE campaign_id = ? AND url = ?", (cid, url)).fetchone() is not None

    def campaign_stats(self, cid: int) -> dict:
        rows = self.pickups(cid)
        return {
            "pickups": len(rows),
            "linked": sum(1 for r in rows if r["kind"] == "linked"),
            "mentions": sum(1 for r in rows if r["kind"] == "mention"),
            "counts": sum(1 for r in rows if r["last_verdict"] == "Counts"),
            "sites": len({r["site"] for r in rows}),
        }

    def linked_sites(self) -> set[str]:
        """Sites that already link to you (any verdict except Not counted)."""
        from .domains import site_of
        rows = self.conn.execute("SELECT source_url FROM links WHERE last_verdict IS NULL OR last_verdict <> 'Not counted'").fetchall()
        return {site_of(r["source_url"]) for r in rows}

    def previous(self, link_id: int) -> dict | None:
        rows = self.conn.execute(
            "SELECT result_json FROM checks WHERE link_id = ? ORDER BY run_at DESC, id DESC LIMIT 2",
            (link_id,),
        ).fetchall()
        return json.loads(rows[1]["result_json"]) if len(rows) > 1 else None
