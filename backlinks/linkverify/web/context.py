"""Which sites the app knows about, and each site's settings and background workers."""

from __future__ import annotations

import threading
from pathlib import Path

from .. import workspace
from ..config import Config
from ..db import Registry
from .jobs import CheckQueue, TaskRunner


class SiteContext:
    def __init__(self, sid: str, cfg: Config):
        self.id = sid
        self.cfg = cfg
        self.checks = CheckQueue(lambda: self.cfg)
        self.tasks = TaskRunner(lambda: self.cfg, self.checks)

    def registry(self) -> Registry:
        return Registry(self.cfg.db_path)


class App:
    """Workspace mode (a config.toml path: settings can be edited, sites added) or
    fixed mode (one ready-made Config, used by tests and `dashboard --config` on an old setup)."""

    def __init__(self, config_path: str | Path | None = None, fixed: Config | None = None):
        self.config_path = workspace.root_of(config_path) if fixed is None else None
        self.fixed = fixed
        self._sites: dict[str, SiteContext] = {}
        self.lock = threading.Lock()

    @property
    def editable(self) -> bool:
        return self.fixed is None

    def site_ids(self) -> list[dict]:
        if self.fixed is not None:
            return [{"id": self._fixed_id(), "domain": self.fixed.my_site or "this site", "legacy": True}]
        return [{"id": s.id, "domain": s.domain, "legacy": s.legacy} for s in workspace.list_sites(self.config_path)]

    def _fixed_id(self) -> str:
        return self.fixed.site_id or (workspace._safe_id(self.fixed.my_site) if self.fixed.my_site else "default")

    def site(self, sid: str) -> SiteContext | None:
        with self.lock:
            ctx = self._sites.get(sid)
            if ctx is not None:
                return ctx
            if self.fixed is not None:
                if sid != self._fixed_id():
                    return None
                cfg = self.fixed
            else:
                s = workspace.find_site(self.config_path, sid)
                if s is None or s.id != sid:
                    return None
                cfg = workspace.load(self.config_path, sid)
            cfg.data_dir.mkdir(parents=True, exist_ok=True)
            Registry(cfg.db_path).close()
            ctx = self._sites[sid] = SiteContext(sid, cfg)
            return ctx

    def forget(self, sid: str) -> None:
        with self.lock:
            ctx = self._sites.pop(sid, None)
        if ctx is not None:
            ctx.checks.stopped = True

    def shared_cfg(self) -> Config:
        if self.fixed is not None:
            return self.fixed
        sites = workspace.list_sites(self.config_path)
        return workspace.load(self.config_path, sites[0].id if sites else None)

    def reload(self) -> None:
        """After settings change: every open site picks up the new values (workers keep running)."""
        if self.fixed is not None:
            return
        with self.lock:
            for sid, ctx in list(self._sites.items()):
                try:
                    ctx.cfg = workspace.load(self.config_path, sid)
                except KeyError:
                    self._sites.pop(sid)
