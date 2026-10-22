"""A self-contained HTML report of every link and its latest check."""

from __future__ import annotations

import csv
import html
from datetime import datetime
from pathlib import Path

from . import __version__
from .checks import VERDICT_ORDER
from .db import Registry

CSS = """
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--card:#fff;
--counts:#1f7a4d;--weak:#a16207;--pending:#2f5fb3;--not:#b42318;--none:#8a8984}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#a3a29d;--line:#2f2e2b;--card:#1e1e1c;
--counts:#4cc38a;--weak:#e0a83a;--pending:#7aa7f0;--not:#f07167;--none:#77766f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 20px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:26px}
.tile span{color:var(--muted)}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
td.url{max-width:420px;overflow-wrap:anywhere}td.url>a{word-break:break-all}a{color:inherit}.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.v-Counts{background:var(--counts)}.v-Weak{background:var(--weak)}.v-Pending{background:var(--pending)}.v-Not{background:var(--not)}.v-none{background:var(--none)}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:12px}.checks{margin:8px 0 0;padding:0;list-style:none}
.checks li{padding:3px 0;font-size:13px}.s{display:inline-block;width:42px;font-size:11px;font-weight:700;text-transform:uppercase}
.s-pass{color:var(--counts)}.s-warn{color:var(--weak)}.s-fail{color:var(--not)}.s-skip,.s-info{color:var(--none)}
.ctx{color:var(--muted);font-size:12px;margin-top:6px}.filter{margin:0 0 12px}.filter button{border:1px solid var(--line);background:var(--card);color:var(--fg);
border-radius:999px;padding:4px 12px;margin-right:6px;cursor:pointer}.filter button.on{border-color:var(--fg)}
@media (max-width:760px){td.hide-sm,th.hide-sm{display:none}}
"""

JS = """
document.querySelectorAll('.filter button').forEach(b=>b.addEventListener('click',()=>{
 document.querySelectorAll('.filter button').forEach(x=>x.classList.remove('on'));b.classList.add('on');
 const v=b.dataset.v;document.querySelectorAll('tbody tr').forEach(r=>{r.style.display=(v==='all'||r.dataset.v===v)?'':'none';});}));
"""


def _badge(verdict: str | None) -> str:
    if not verdict:
        return '<span class="badge v-none">Not checked</span>'
    cls = "Not" if verdict == "Not counted" else verdict
    return f'<span class="badge v-{cls}">{html.escape(verdict)}</span>'


def _e(x) -> str:
    return html.escape("" if x is None else str(x))


def build_report(reg: Registry, out: Path) -> Path:
    rows = reg.all()
    counts = {v: 0 for v in VERDICT_ORDER}
    unchecked = 0
    body = []
    for row in rows:
        res = reg.latest(row["id"]) or {}
        verdict = row["last_verdict"]
        if verdict in counts:
            counts[verdict] += 1
        else:
            unchecked += 1
        link = res.get("link") or {}
        rel = " ".join(link.get("rel") or []) or ("none" if link else "")
        checks_html = "".join(
            f'<li><span class="s s-{_e(c["status"])}">{_e(c["status"])}</span>{c["num"]}. {_e(c["name"])}: {_e(c["detail"])}</li>'
            for c in res.get("checks", [])
        )
        reasons = "".join(f"<li>{_e(r)}</li>" for r in res.get("reasons", []))
        notes = "".join(f"<li>{_e(n)}</li>" for n in res.get("notes", []))
        ctx = f'<div class="ctx">“{_e(link.get("context"))}”</div>' if link.get("context") else ""
        details = ""
        if res:
            details = (
                "<details><summary>All 15 checks</summary>"
                + (f"<p><b>Why this verdict</b></p><ul>{reasons}</ul>" if reasons else "")
                + (f"<p><b>Notes</b></p><ul>{notes}</ul>" if notes else "")
                + f'<ul class="checks">{checks_html}</ul>'
                + (f'<p class="ctx">Evidence: {_e(res.get("evidence_dir"))}</p>' if res.get("evidence_dir") else "")
                + "</details>"
            )
        dr = res.get("domain_rating")
        vkey = verdict or "none"
        body.append(
            f'<tr data-v="{_e(vkey)}"><td>{row["id"]}</td>'
            f'<td class="url"><a href="{_e(row["source_url"])}" target="_blank" rel="noreferrer">{_e(row["source_url"])}</a>{ctx}{details}</td>'
            f'<td>{_badge(verdict)}</td>'
            f'<td class="hide-sm">{_e(link.get("anchor_text"))}</td>'
            f'<td>{_e(rel)}</td>'
            f'<td class="hide-sm">{_e(res.get("outbound_sites"))}</td>'
            f'<td class="hide-sm">{_e("" if dr is None else f"{dr:g}")}</td>'
            f'<td class="hide-sm">{_e(row["target"])}<br><span class="ctx">{_e(row["strategy"])}</span></td>'
            f'<td class="hide-sm">{_e((row["last_checked"] or "")[:16].replace("T", " "))}</td></tr>'
        )
    tiles = "".join(f'<div class="tile"><b>{counts[v]}</b><span>{v}</span></div>' for v in reversed(VERDICT_ORDER))
    tiles += f'<div class="tile"><b>{unchecked}</b><span>Not checked yet</span></div>'
    buttons = '<button class="on" data-v="all">All</button>' + "".join(
        f'<button data-v="{v}">{v}</button>' for v in reversed(VERDICT_ORDER))
    doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Backlink report</title><style>{CSS}</style></head><body><main>
<h1>Backlink report</h1><p class="sub">{len(rows)} links · generated {datetime.now().strftime('%Y-%m-%d %H:%M')} · Backlink Verifier {__version__}</p>
<div class="tiles">{tiles}</div><div class="filter">{buttons}</div>
<table><thead><tr><th>#</th><th>Linking page</th><th>Verdict</th><th class="hide-sm">Anchor</th><th>rel</th>
<th class="hide-sm">Outbound sites</th><th class="hide-sm">DR</th><th class="hide-sm">Target · strategy</th><th class="hide-sm">Last checked (UTC)</th></tr></thead>
<tbody>{''.join(body) or '<tr><td colspan="9">No links yet. Add one with: python -m linkverify add URL --target yoursite.com</td></tr>'}</tbody></table>
</main><script>{JS}</script></body></html>"""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(doc, encoding="utf-8")
    return out


def export_csv(reg: Registry, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "source_url", "target", "strategy", "verdict", "last_checked", "final_url",
                    "anchor_text", "rel", "outbound_sites", "domain_rating", "url_rating", "reasons", "notes"])
        for row in reg.all():
            res = reg.latest(row["id"]) or {}
            link = res.get("link") or {}
            w.writerow([row["id"], row["source_url"], row["target"], row["strategy"], row["last_verdict"] or "",
                        row["last_checked"] or "", res.get("final_url", ""), link.get("anchor_text", ""),
                        " ".join(link.get("rel") or []), res.get("outbound_sites", ""),
                        "" if res.get("domain_rating") is None else res["domain_rating"],
                        "" if res.get("url_rating") is None else res["url_rating"],
                        " | ".join(res.get("reasons", [])), " | ".join(res.get("notes", []))])
    return out
