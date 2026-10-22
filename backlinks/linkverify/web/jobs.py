"""Background work for the app: one link-check queue and one long-task runner per site.

Both workers are written so that nothing a single job does can stop them: every step
that can fail is guarded, and a failure is reported in the job state instead.
"""

from __future__ import annotations

import queue
import threading
import time
import traceback
from typing import Callable

from ..config import Config
from ..db import Registry
from ..monitor import check_and_record, send_pending_alerts


class TaskMessage(Exception):
    """Raised by a task to stop with a message meant for the user."""


class Cancelled(BaseException):
    """Raised inside a long task when the user presses Stop. A BaseException, so the many
    `except Exception` guards inside finders and the crawler don't swallow it."""


class CheckQueue:
    """Checks links one at a time in a background thread, so the app stays responsive."""

    def __init__(self, cfg_getter: Callable[[], Config]):
        self.cfg = cfg_getter
        self.q: queue.Queue[int] = queue.Queue()
        self.queued: list[int] = []
        self.running: int | None = None
        self.done = 0
        self.last_error = ""
        self.lock = threading.Lock()
        self.stopped = False
        threading.Thread(target=self._loop, daemon=True).start()

    def add(self, ids: list[int]) -> int:
        added = 0
        with self.lock:
            for i in ids:
                if i not in self.queued and i != self.running:
                    self.queued.append(i)
                    self.q.put(i)
                    added += 1
        return added

    def drop(self, link_id: int) -> None:
        """Forget a queued check (the link was removed)."""
        with self.lock:
            if link_id in self.queued:
                self.queued.remove(link_id)

    def busy(self) -> bool:
        with self.lock:
            return self.running is not None or bool(self.queued)

    def state(self) -> dict:
        with self.lock:
            return {"queued": list(self.queued), "running": self.running, "done": self.done, "error": self.last_error}

    def _loop(self) -> None:
        state = {"verifier": None, "cfg": None}
        while not self.stopped:
            link_id = self.q.get()
            with self.lock:
                if link_id not in self.queued:  # dropped while waiting
                    continue
                self.queued.remove(link_id)
                self.running = link_id
            try:
                self._check(link_id, state)
            except Exception as exc:  # never let one link stop the worker
                self.last_error = f"Link #{link_id}: {type(exc).__name__}: {exc}"
                traceback.print_exc()
            finally:
                with self.lock:
                    self.running = None
                    self.done += 1
                    empty = not self.queued
            if empty:
                try:
                    cfg = self.cfg()
                    reg = Registry(cfg.db_path)
                    try:
                        send_pending_alerts(reg, cfg)
                    finally:
                        reg.close()
                except Exception as exc:
                    self.last_error = f"Alerts: {exc}"

    def _check(self, link_id: int, state: dict) -> None:
        from ..checks import Verifier

        cfg = self.cfg()
        reg = Registry(cfg.db_path)
        try:
            row = reg.get(link_id)
            if row is None:
                return  # removed meanwhile
            if state["verifier"] is None or state["cfg"] is not cfg:  # settings changed: start fresh
                if state["verifier"] is not None:
                    state["verifier"].close()
                state["verifier"], state["cfg"] = Verifier(cfg), cfg
            try:
                check_and_record(reg, state["verifier"], cfg, row)
                self.last_error = ""
            except Exception as exc:
                self.last_error = f"Link #{link_id}: {type(exc).__name__}: {exc}"
                if reg.get(link_id) is not None:  # it may have been removed during the check
                    reg.add_event(link_id, "check_error", "bad", f"The check could not run: {exc}")
        finally:
            reg.close()


class TaskRunner:
    """Runs one long task at a time (finding opportunities, mapping the site, checking a campaign)."""

    def __init__(self, cfg_getter: Callable[[], Config], checks: CheckQueue):
        self.cfg = cfg_getter
        self.checks = checks
        self.lock = threading.Lock()
        self.running: str = ""
        self.op: dict = {}
        self.started = 0.0
        self.progress = ""
        self.cancel = threading.Event()
        self.last: dict | None = None

    def start(self, name: str, fn: Callable[[Config, Registry, Callable[[str], None]], dict], op: dict | None = None) -> bool:
        with self.lock:
            if self.running:
                return False
            self.running, self.op, self.started, self.progress = name, dict(op or {}), time.time(), ""
            self.cancel.clear()
        threading.Thread(target=self._run, args=(name, fn), daemon=True).start()
        return True

    def stop(self) -> bool:
        with self.lock:
            if not self.running:
                return False
        self.cancel.set()
        return True

    def _say(self, msg: str) -> None:
        if self.cancel.is_set():
            raise Cancelled()
        self.progress = str(msg)[:200]

    def _run(self, name: str, fn) -> None:
        result: dict
        try:
            cfg = self.cfg()
            reg = Registry(cfg.db_path)
            try:
                out = fn(cfg, reg, self._say) or {}
                result = {"ok": True, **out}
                # pages a task added to the registry get their first check straight away
                self.checks.add([r["id"] for r in reg.all() if not r["last_checked"]])
                try:
                    send_pending_alerts(reg, cfg)
                except Exception as exc:
                    result["notes"] = list(result.get("notes", [])) + [f"Alerts not sent: {exc}"]
            finally:
                reg.close()
        except Cancelled:
            result = {"ok": False, "cancelled": True, "error": "Stopped."}
        except TaskMessage as exc:  # a plain explanation for the user, not a crash
            result = {"ok": False, "error": str(exc)}
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()[-1500:]}
        with self.lock:
            self.last = {"name": name, "op": self.op, "finished": time.time(), **result}
            self.running, self.progress = "", ""

    def busy(self) -> bool:
        with self.lock:
            return bool(self.running)

    def state(self) -> dict:
        with self.lock:
            return {"running": self.running, "seconds": round(time.time() - self.started) if self.running else 0,
                    "progress": self.progress, "last": self.last, "stopping": self.cancel.is_set() and bool(self.running)}
