"""robots.txt rules, applied the way Googlebot applies them.

Python's urllib.robotparser does not support Google's `*` and `$` wildcards or
its longest-match rule, so this module implements them:

* The group for the most specific matching user agent is used ("googlebot"
  beats "*"); several groups for the same agent are merged.
* Among matching rules the longest pattern wins; on a tie, Allow wins.
* A missing robots.txt (4xx) allows everything.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit


@dataclass
class Rules:
    allow: list[str] = field(default_factory=list)
    disallow: list[str] = field(default_factory=list)


def parse(text: str) -> dict[str, Rules]:
    groups: dict[str, Rules] = {}
    current_agents: list[str] = []
    last_was_agent = False
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            if not last_was_agent:
                current_agents = []
            agent = value.lower()
            current_agents.append(agent)
            groups.setdefault(agent, Rules())
            last_was_agent = True
            continue
        last_was_agent = False
        if key in ("allow", "disallow") and current_agents:
            for agent in current_agents:
                rules = groups[agent]
                if key == "allow":
                    rules.allow.append(value)
                elif value:  # an empty Disallow means "allow everything"
                    rules.disallow.append(value)
    return groups


def _pattern_to_regex(pattern: str) -> re.Pattern:
    anchored = pattern.endswith("$")
    if anchored:
        pattern = pattern[:-1]
    parts = [re.escape(p) for p in pattern.split("*")]
    return re.compile("".join(p if i == 0 else ".*" + p for i, p in enumerate(parts)) + ("$" if anchored else ""))


def _select(groups: dict[str, Rules], agent: str) -> Rules | None:
    agent = agent.lower()
    best = None
    best_len = -1
    for name, rules in groups.items():
        if name == "*":
            continue
        if agent.startswith(name) and len(name) > best_len:
            best, best_len = rules, len(name)
    if best is None:
        best = groups.get("*")
    return best


def is_allowed(robots_text: str, url: str, agent: str = "googlebot") -> tuple[bool, str]:
    """Returns (allowed, the rule that decided it)."""
    groups = parse(robots_text)
    rules = _select(groups, agent)
    if rules is None:
        return True, "no group for this crawler"
    parts = urlsplit(url)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    best_len, best_allow, best_rule = -1, True, "no matching rule"
    for allow, patterns in ((True, rules.allow), (False, rules.disallow)):
        for pat in patterns:
            if not pat:
                continue
            if _pattern_to_regex(pat).match(path):
                length = len(pat)
                if length > best_len or (length == best_len and allow and not best_allow):
                    best_len, best_allow = length, allow
                    best_rule = f"{'Allow' if allow else 'Disallow'}: {pat}"
    return best_allow, best_rule
