"""Command line: python -m linkverify <command> ..."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from . import __version__
from . import alerts
from .checks import NOT_COUNTED, Verifier
from .db import Registry
from .monitor import check_and_record, next_due, run_monitor, send_pending_alerts
from .render import playwright_available
from .report import build_report, export_csv

SYMBOL = {"pass": "OK  ", "warn": "WARN", "fail": "FAIL", "skip": "skip", "info": "info"}


def _print_result(res: dict, link_id: int | None = None) -> None:
    head = f"#{link_id} " if link_id is not None else ""
    print(f"\n{head}{res['source_url']}")
    print(f"  -> target {res['target']}")
    print(f"  VERDICT: {res['verdict']}")
    for r in res.get("reasons", []):
        print(f"    because {r}")
    for n in res.get("notes", []):
        print(f"    note: {n}")


def _print_checks(res: dict) -> None:
    for c in res.get("checks", []):
        print(f"  [{SYMBOL.get(c['status'], c['status'])}] {c['num']:>2}. {c['name']}: {c['detail']}")
    link = res.get("link")
    if link:
        print(f"\n  Anchor text: {link.get('anchor_text') or '(none)'}")
        print(f"  rel: {' '.join(link.get('rel') or []) or '(none)'}")
        if link.get("context"):
            print(f"  Context: {link['context']}")
    if res.get("evidence_dir"):
        print(f"  Evidence saved in: {res['evidence_dir']}")


def cmd_init(args, cfg) -> int:
    here = Path.cwd()
    example = Path(__file__).resolve().parent.parent / "config.example.toml"
    target = here / "config.toml"
    if not target.exists() and example.exists():
        shutil.copy(example, target)
        print(f"Created {target} (edit it to add API keys later).")
    reg = Registry(cfg.db_path)
    reg.close()
    print(f"Database ready at {cfg.db_path}")
    if not playwright_available():
        print("Tip: install Playwright for the JavaScript checks: pip install playwright && python -m playwright install chromium")
    return 0


def cmd_add(args, cfg) -> int:
    if not args.url.lower().startswith(("http://", "https://")):
        print("The URL must start with http:// or https://", file=sys.stderr)
        return 2
    reg = Registry(cfg.db_path)
    link_id, created = reg.add(args.url, args.target, args.strategy or "", args.notes or "")
    print(f"{'Added' if created else 'Already in the registry as'} link #{link_id}.")
    if args.check:
        _run_checks(reg, cfg, [reg.get(link_id)], verbose=True)
    reg.close()
    return 0


def cmd_import(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    added, skipped, problems = reg.import_csv(Path(args.file), args.target or "")
    print(f"Imported {added} new link(s); {skipped} were already in the registry.")
    for p in problems:
        print(f"  skipped {p}")
    reg.close()
    return 0 if not problems else 1


def cmd_list(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    rows = reg.all(args.verdict)
    if not rows:
        print("No links." if not args.verdict else f"No links with verdict {args.verdict}.")
    for r in rows:
        checked = (r["last_checked"] or "never")[:16].replace("T", " ")
        print(f"#{r['id']:<4} {(r['last_verdict'] or 'Not checked'):<12} {checked:<16}  {r['source_url']}  ->  {r['target']}")
    reg.close()
    return 0


def _run_checks(reg: Registry, cfg, rows, verbose: bool) -> int:
    verifier = Verifier(cfg)
    changed = 0
    try:
        for i, row in enumerate(rows, 1):
            if len(rows) > 1:
                print(f"[{i}/{len(rows)}] checking #{row['id']} {row['source_url']}", flush=True)
            res, changes = check_and_record(reg, verifier, cfg, row)
            _print_result(res, row["id"])
            if verbose:
                _print_checks(res)
            for c in changes:
                print(f"  CHANGE ({c.severity}): {c.detail}")
            changed += bool(changes)
    finally:
        verifier.close()
    if changed:
        print(f"\n{changed} link(s) changed since the last check.")
    status = send_pending_alerts(reg, cfg)
    for s in status:
        print(f"Alerts: {s}")
    return 0


def cmd_check(args, cfg) -> int:
    if args.no_render:
        cfg.render = False
    reg = Registry(cfg.db_path)
    if args.all:
        rows = reg.all()
    elif args.due:
        rows = reg.due(cfg.recheck_days)
    else:
        rows = [reg.get(i) for i in args.ids]
        missing = [i for i, r in zip(args.ids, rows) if r is None]
        if missing:
            print(f"No link with id {', '.join(map(str, missing))}.", file=sys.stderr)
            return 2
    if not rows:
        print("Nothing to check. Use ids, --all or --due.")
        return 0
    _run_checks(reg, cfg, rows, verbose=len(rows) == 1 or args.verbose)
    reg.close()
    return 0


def cmd_test(args, cfg) -> int:
    """Check one URL without saving it."""
    if args.no_render:
        cfg.render = False
    verifier = Verifier(cfg)
    try:
        res = verifier.verify(args.url, args.target, None)
    finally:
        verifier.close()
    _print_result(res)
    _print_checks(res)
    return 0 if res["verdict"] != NOT_COUNTED else 1


def cmd_show(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    row = reg.get(args.id)
    if not row:
        print(f"No link with id {args.id}.", file=sys.stderr)
        return 2
    res = reg.latest(args.id)
    if not res:
        print(f"#{args.id} has not been checked yet. Run: python -m linkverify check {args.id}")
        return 0
    _print_result(res, args.id)
    _print_checks(res)
    hist = reg.history(args.id)
    if len(hist) > 1:
        print("\n  History:")
        for h in hist[:10]:
            print(f"    {h['run_at'][:16].replace('T', ' ')}  {h['verdict']}")
    evs = [e for e in reg.events(args.id, 20) if e["kind"] != "first_check"]
    if evs:
        print("\n  Changes:")
        for e in evs:
            print(f"    {e['at'][:16].replace('T', ' ')}  [{e['severity']}] {e['detail']}")
    cfg_due = next_due(row, cfg)
    print(f"\n  Next scheduled re-check: {cfg_due.strftime('%Y-%m-%d')}")
    reg.close()
    return 0


def cmd_monitor(args, cfg) -> int:
    from . import workspace

    # without --site, the daily run covers every site
    configs = [cfg] if args.site else [workspace.load(args.config, s.id) for s in workspace.list_sites(args.config)] or [cfg]
    failed = False
    for c in configs:
        if args.no_render:
            c.render = False
        if len(configs) > 1:
            print(f"\n=== {c.my_site} ===")
        reg = Registry(c.db_path)
        summary = run_monitor(c, reg, send_alerts=not args.no_alerts)
        if summary.checked:
            build_report(reg, c.data_dir / "report.html")  # keep the HTML report fresh too
        reg.close()
        print(f"Log: {summary.log_file}")
        failed |= bool(summary.errors)
    return 1 if failed else 0


def cmd_sites(args, cfg) -> int:
    from . import workspace

    if args.action == "add":
        if not args.domain:
            print("Usage: linkverify sites add example.com", file=sys.stderr)
            return 2
        try:
            site = workspace.add_site(args.config, args.domain)
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 2
        print(f"Added {site.domain}. Its settings are in {site.file}. Use --site {site.id} with any command, "
              f"or pick it in the dashboard.")
        return 0
    if args.action == "remove":
        try:
            dest = workspace.remove_site(args.config, args.domain or "")
        except KeyError as exc:
            print(exc.args[0], file=sys.stderr)
            return 2
        print(f"Moved its folder to {dest}. Nothing was deleted.")
        return 0
    sites = workspace.list_sites(args.config)
    if not sites:
        print("No sites yet. Add one: linkverify sites add yoursite.com")
    for st in sites:
        reg = Registry(st.data_dir / "links.db")
        n = len(reg.all())
        reg.close()
        print(f"{st.id:<32} {n:>4} link(s)  {'(settings in config.toml)' if st.legacy else st.file}")
    return 0


def cmd_changes(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    evs = [e for e in reg.events(None, args.limit) if args.all or e["kind"] != "first_check"]
    if not evs:
        print("No changes recorded yet.")
    for e in evs:
        print(f"{e['at'][:16].replace('T', ' ')}  #{e['link_id']:<4} [{e['severity']:<4}] {e['detail']}  ({e['source_url']})")
    reg.close()
    return 0


def cmd_alert_test(args, cfg) -> int:
    if not alerts.channels(cfg):
        print("No alert channel set up. Fill in [email] or [telegram] in config.toml first.")
        return 2
    for s in alerts.send(cfg, "Backlink Verifier test alert",
                         "This is a test alert from Backlink Verifier. If you can read it, alerts work."):
        print(s)
    return 0


def cmd_dashboard(args, cfg) -> int:
    from .web.server import serve

    return serve(args.config or "config.toml", open_browser=not args.no_browser, port=args.port)


def cmd_find(args, cfg) -> int:
    from .finders import PAID, available, run_finders

    if args.no_render:
        cfg.render = False
    names = available(cfg) if args.which == "all" else [args.which]
    if args.which in PAID and not cfg.has_dataforseo:
        print(f"'{args.which}' needs the optional DataForSEO connection. The free finders: {', '.join(available(cfg))}.")
        return 2
    reg = Registry(cfg.db_path)
    print(f"Running: {', '.join(names)}. This can take a few minutes; pages are fetched politely, one per second per site.")
    for r in run_finders(cfg, reg, names):
        print(f"\n{r.name}: {r.found} opportunit{'ies' if r.found != 1 else 'y'} found, {r.new} new"
              + (f", {r.registered} already linking (added to your registry)" if r.registered else ""))
        for e in r.errors:
            print(f"  problem: {e}")
        for n in r.notes:
            print(f"  note: {n}")
    spent = reg.month_cost("dataforseo")
    if spent:
        print(f"\nDataForSEO spend this month: ${spent:.3f} of ${cfg.dataforseo_monthly_budget_usd:.2f} budget.")
    top = reg.opportunities(status="new", limit=10)
    if top:
        print("\nTop new opportunities (linkverify opps for all):")
        for o in top:
            print(f"  #{o['id']:<4} [{o['score']:>3}] {o['kind']:<17} {o['title'][:70]}")
    reg.close()
    return 0


def cmd_scan(args, cfg) -> int:
    from .finders import Context
    from .freefind import scan_page

    reg = Registry(cfg.db_path)
    ctx = Context(cfg, reg)
    try:
        s = scan_page(ctx, args.url if "://" in args.url else "https://" + args.url)
    except ValueError as exc:
        print(exc)
        return 1
    finally:
        ctx.close()
        reg.close()
    print(f"{s['title']} ({s['site']})")
    for line in s["summary"]:
        print(f"  {line}")
    for d in s["dead"]:
        print(f"  dead: {d['url']} ({d['status']})" + (f"; offer {d['suggested_page']}" if d["suggested_page"] else ""))
    if s["opps"]:
        print(f"  Saved as opportunit{'ies' if len(s['opps']) > 1 else 'y'} #" + ", #".join(map(str, s["opps"])))
    return 0


def cmd_opps(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    rows = reg.opportunities(args.kind, args.status, args.min_score, args.limit)
    if not rows:
        print("No opportunities yet. Run: linkverify find all")
    for o in rows:
        where = "" if o["url"].startswith("email:") else o["url"]
        print(f"#{o['id']:<4} [{o['score']:>3}] {o['status']:<8} {o['kind']:<17} {o['title'][:60]}  {where}")
    reg.close()
    return 0


def cmd_opp(args, cfg) -> int:
    import json as _json

    reg = Registry(cfg.db_path)
    o = reg.opportunity(args.id)
    if not o:
        print(f"No opportunity #{args.id}.", file=sys.stderr)
        return 2
    if args.status or args.note is not None:
        try:
            reg.update_opportunity(args.id, status=args.status, notes=args.note)
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 2
    if args.status == "won":
        url = args.link_url or ("" if o["url"].startswith("email:") else o["url"])
        if not url:
            print("Give the page where your link now is: --link-url https://...")
        else:
            link_id, _ = reg.add(url, cfg.my_site or args.target or "", o["kind"].replace("_", " "), f"won from opportunity #{o['id']}")
            reg.update_opportunity(args.id, link_id=link_id)
            print(f"Marked won and added to your link registry as link #{link_id}. Checking it now…")
            _run_checks(reg, cfg, [reg.get(link_id)], verbose=False)
    o = reg.opportunity(args.id)
    data = _json.loads(o["data_json"])
    print(f"\n#{o['id']} {o['kind']}  score {o['score']}  status {o['status']}")
    print(f"  {o['title']}")
    if not o["url"].startswith("email:"):
        print(f"  {o['url']}")
    print(f"  Score: {o['score_detail']}")
    for k in ("how", "context", "dead_url", "dead_status", "anchor", "wayback", "suggested_page", "competitors",
              "deadline", "outlet", "contacts", "source", "request"):
        v = data.get(k)
        if v:
            if isinstance(v, list):
                v = ", ".join(map(str, v))
            v = str(v)
            print(f"  {k.replace('_', ' ').capitalize()}: {v[:1500]}")
    if o["notes"]:
        print(f"  Notes: {o['notes']}")
    reg.close()
    return 0


def cmd_draft(args, cfg) -> int:
    from .drafts import make_draft

    reg = Registry(cfg.db_path)
    if args.no_render:
        cfg.render = False
    if args.ai and not cfg.has_ai:
        print("No Anthropic API key: add [drafting] anthropic_api_key to config.toml. Using the template.")
    try:
        d = make_draft(cfg, reg, args.id, use_ai=args.ai and cfg.has_ai)
    except KeyError as exc:
        print(exc.args[0], file=sys.stderr)
        reg.close()
        return 2
    reg.close()
    c = d["contacts"]
    print(f"Draft for opportunity #{args.id} ({'AI-personalised' if d['source'] == 'ai' else 'template'}). Nothing has been sent.\n")
    print(f"To:      {d['to'] or '(no public email found)'}")
    if c.get("author"):
        print(f"Author:  {c['author']}")
    if len(c.get("emails") or []) > 1:
        print(f"Other emails: {', '.join(c['emails'][1:])}")
    if c.get("contact_pages"):
        print(f"Contact pages: {', '.join(c['contact_pages'][:3])}")
    print(f"Subject: {d['subject']}\n")
    print(d["body"])
    print()
    for n in d["notes"]:
        print(f"note: {n}")
    for t in d["tips"]:
        print(f"tip: {t}")
    if d["placeholders"]:
        print(f"\nFill in before sending: {', '.join(d['placeholders'])}")
    print(f"\nOpen in your email app: {d['mailto'][:2000]}")
    return 0


def cmd_campaign(args, cfg) -> int:
    import json as _json
    from datetime import date

    from .campaigns import is_active, run_campaign

    reg = Registry(cfg.db_path)
    try:
        if args.action == "add":
            if not args.name or not args.asset:
                print('Usage: linkverify campaign add --name "2026 price study" --asset https://yoursite.com/study '
                      '--phrase "phrase people will quote" [--phrase ...] [--started 2026-10-01]', file=sys.stderr)
                return 2
            started = args.started or date.today().isoformat()
            try:
                date.fromisoformat(started[:10])
            except ValueError:
                print("--started must be a date like 2026-10-01", file=sys.stderr)
                return 2
            cid = reg.add_campaign(args.name, args.asset, args.phrase or [], started[:10])
            print(f"Added campaign #{cid}. It is checked weekly for {cfg.campaign_active_days} days by the monitor; "
                  f"run `linkverify campaign check {cid}` to check now.")
            return 0
        if args.action == "list":
            rows = reg.campaigns()
            if not rows:
                print('No campaigns. Add one: linkverify campaign add --name "..." --asset https://... --phrase "..."')
            for r in rows:
                st = reg.campaign_stats(r["id"])
                act = "active" if is_active(r, cfg.campaign_active_days) else "ended"
                print(f"#{r['id']:<3} {r['name'][:40]:<40} {act:<6} since {r['started_at'][:10]}  "
                      f"{st['linked']} linking, {st['counts']} counting, {st['mentions']} unlinked  {r['asset_url']}")
            return 0
        if args.id is None:
            print("Give the campaign number, e.g. linkverify campaign show 1", file=sys.stderr)
            return 2
        row = reg.campaign(args.id)
        if not row:
            print(f"No campaign #{args.id}.", file=sys.stderr)
            return 2
        if args.action == "remove":
            reg.remove_campaign(args.id)
            print(f"Removed campaign #{args.id}. Links it found stay in your registry.")
            return 0
        if args.action == "check":
            if args.no_render:
                cfg.render = False
            print(f"Checking campaign #{args.id} {row['name']}…")
            res, out = run_campaign(cfg, reg, args.id)
            for e in res.errors:
                print(f"  problem: {e}")
            for n in res.notes:
                print(f"  note: {n}")
            print(f"{len(out['linked'])} new linking page(s), {len(out['mentions'])} new unlinked mention(s).")
            if out["linked"]:
                print("Checking the new links now…")
                _run_checks(reg, cfg, [reg.get(i) for i in out["linked"]], verbose=False)
        row = reg.campaign(args.id)
        st = reg.campaign_stats(args.id)
        print(f"\n#{row['id']} {row['name']}\n  Asset: {row['asset_url']}\n  Started: {row['started_at'][:10]}"
              f"   Last checked: {(row['last_checked'] or 'never')[:16]}")
        print(f"  Phrases: {', '.join(_json.loads(row['phrases_json'])) or '(none)'}")
        print(f"  {st['pickups']} pickup(s) on {st['sites']} site(s): {st['linked']} linking ({st['counts']} counting), "
              f"{st['mentions']} mention(s) without a link")
        for p in reg.pickups(args.id):
            v = p["last_verdict"] or ("unlinked: opp #" + str(p["opp_id"]) if p["kind"] == "mention" else "not checked")
            print(f"  {p['found_at'][:10]}  {v:<18} {p['url']}")
        return 0
    finally:
        reg.close()


def cmd_graph(args, cfg) -> int:
    from .sitegraph import crawl, save

    if not (args.start or cfg.my_site):
        print("Set site under [project] in config.toml, or give a start URL: linkverify graph https://yoursite.com/", file=sys.stderr)
        return 2
    reg = Registry(cfg.db_path)
    print(f"Crawling {args.start or cfg.my_site} (up to {args.max_pages} pages, {cfg.delay_seconds:g}s between requests)…", flush=True)
    try:
        g = crawl(cfg, args.start, args.max_pages, reg=reg, printer=(lambda m: print(m, flush=True)) if args.verbose else (lambda *_: None))
    except (RuntimeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        reg.close()
        return 1
    reg.close()
    jpath, hpath = save(g, cfg, Path(args.out) if args.out else None)
    data = g.to_json()
    s = data["summary"]
    print(f"\n{s['pages']} pages, {s['indexable']} indexable, {s['internal_links']} internal links, max click depth {s['max_depth']}, "
          f"links out to {s['external_sites']} other sites, {s['backlinks']} backlinks in your registry ({s['backlinks_counting']} counting).")
    for n in g.notes:
        print(f"note: {n}")
    for i in data["issues"]:
        print(f"\n[{i['severity'].upper()}] {i['title']}\n  {i['fix']}")
        for line in i["pages"][:8]:
            print(f"  - {line}")
        if len(i["pages"]) > 8:
            print(f"  … and {len(i['pages']) - 8} more (see the report)")
    print(f"\nReport: {hpath.resolve()}\nData:   {jpath.resolve()}")
    if args.open:
        import webbrowser
        webbrowser.open(hpath.resolve().as_uri())
    return 0


def cmd_platform(args, cfg) -> int:
    from .platform import test_platform

    reg = Registry(cfg.db_path)
    if args.action == "list":
        rows = reg.platforms()
        if not rows:
            print("No platforms tested yet. Run: linkverify platform test URL --link site-the-user-linked-to.com")
        for p in rows:
            print(f"{p['site']:<28} {p['verdict']:<45} {p['tested_at'][:10]}  {p['url']}")
        reg.close()
        return 0
    if not args.url:
        print("Give a page URL: linkverify platform test https://platform.com/some-profile --link theirsite.com")
        return 2
    if args.no_render:
        cfg.render = False
    s = test_platform(cfg, args.url, args.link)
    reg.save_platform(args.url, s["site"], s["verdict"], s)
    reg.close()
    print(f"\n{s['site']}: {s['verdict']}")
    if s.get("note"):
        print(f"  note: {s['note']}")
    if s.get("result"):
        for r in s["result"].get("reasons") or []:
            print(f"  because {r}")
    if s["rel_counts"]:
        print("  Outbound links on this page by rel: " + ", ".join(f"{k}: {v}" for k, v in s["rel_counts"].items()))
        for row in s["outbound"][:15]:
            print(f"    {row['site']:<30} {row['rel']:<22} {row['anchor'][:40]}")
    return 0


def cmd_costs(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    rows = reg.costs_by_month()
    print(f"DataForSEO this month: ${reg.month_cost('dataforseo'):.3f} of ${cfg.dataforseo_monthly_budget_usd:.2f} budget")
    for r in rows:
        print(f"  {r['month']}  {r['provider']:<11} {r['endpoint']:<45} {r['calls']:>5} calls  ${r['usd']}")
    reg.close()
    return 0


def cmd_schedule(args, cfg) -> int:
    from .schedule import install, remove, status

    if args.action == "install":
        return install(args.time)
    if args.action == "remove":
        return remove()
    return status()


def cmd_report(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    out = build_report(reg, Path(args.out))
    reg.close()
    print(f"Report written to {out.resolve()}")
    return 0


def cmd_export(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    out = export_csv(reg, Path(args.out))
    reg.close()
    print(f"CSV written to {out.resolve()}")
    return 0


def cmd_remove(args, cfg) -> int:
    reg = Registry(cfg.db_path)
    ok = reg.remove(args.id)
    reg.close()
    print(f"Removed link #{args.id}." if ok else f"No link with id {args.id}.")
    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="linkverify", description="Personal backlink registry and 15-check verifier.")
    p.add_argument("--config", help="path to config.toml (default: ./config.toml)")
    p.add_argument("--site", help="which of your sites (default: the first one; `monitor` runs all)")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create config.toml and the database")

    a = sub.add_parser("add", help="add a placed link to the registry")
    a.add_argument("url", help="the page that should link to you")
    a.add_argument("--target", required=True, help="your site (example.com) or one page (https://example.com/page)")
    a.add_argument("--strategy", help="how you got it, e.g. guest post, journalist request, profile")
    a.add_argument("--notes")
    a.add_argument("--check", action="store_true", help="check it right away")

    im = sub.add_parser("import", help="import links from a CSV (columns: source_url,target,strategy,notes)")
    im.add_argument("file")
    im.add_argument("--target", help="target for rows that have none")

    ls = sub.add_parser("list", help="list links and their last verdict")
    ls.add_argument("--verdict", help="only this verdict, e.g. Weak")

    c = sub.add_parser("check", help="run the 15 checks")
    c.add_argument("ids", nargs="*", type=int)
    c.add_argument("--all", action="store_true", help="check every link")
    c.add_argument("--due", action="store_true", help="check links not checked in the last recheck_days")
    c.add_argument("--no-render", action="store_true", help="skip the headless browser checks")
    c.add_argument("--verbose", "-v", action="store_true", help="print every check")

    t = sub.add_parser("test", help="check one URL without saving it")
    t.add_argument("url")
    t.add_argument("--target", required=True)
    t.add_argument("--no-render", action="store_true")

    s = sub.add_parser("show", help="show the latest checks for one link")
    s.add_argument("id", type=int)

    r = sub.add_parser("report", help="write an HTML report")
    r.add_argument("--out", default="report.html")

    e = sub.add_parser("export", help="write a CSV of all links and verdicts")
    e.add_argument("--out", default="links-export.csv")

    rm = sub.add_parser("remove", help="remove a link from the registry")
    rm.add_argument("id", type=int)

    m = sub.add_parser("monitor", help="re-check links that are due, record changes, send alerts (run daily)")
    m.add_argument("--no-render", action="store_true")
    m.add_argument("--no-alerts", action="store_true")

    ch = sub.add_parser("changes", help="list recent changes (lost links, rel changes, recoveries)")
    ch.add_argument("--limit", type=int, default=50)
    ch.add_argument("--all", action="store_true", help="include first-check entries")

    sub.add_parser("alert-test", help="send a test alert by email / Telegram")

    d = sub.add_parser("dashboard", help="open the dashboard in your browser")
    d.add_argument("--port", type=int)
    d.add_argument("--no-browser", action="store_true")

    f = sub.add_parser("find", help="find link opportunities")
    f.add_argument("which", choices=["mentions", "journalists", "listings", "partners", "campaigns", "gap", "broken", "resources", "all"])
    f.add_argument("--no-render", action="store_true")

    sc = sub.add_parser("scan", help="check any page: does it link to you, mention you, or have dead links?")
    sc.add_argument("url")

    o = sub.add_parser("opps", help="list opportunities, best first")
    o.add_argument("--kind", choices=["unlinked_mention", "journalist", "listing", "profile", "partner", "gap", "broken_backlink", "broken_link", "resource_page"])
    o.add_argument("--status", choices=["new", "working", "pitched", "won", "lost", "ignored"])
    o.add_argument("--min-score", type=int, default=0)
    o.add_argument("--limit", type=int, default=50)

    op = sub.add_parser("opp", help="show or update one opportunity")
    op.add_argument("id", type=int)
    op.add_argument("--status", choices=["new", "working", "pitched", "won", "lost", "ignored"])
    op.add_argument("--note", help="replace the notes")
    op.add_argument("--link-url", help="with --status won: the page where your link now is")
    op.add_argument("--target", help="with --status won, if [project] site is not set: your site")

    dr = sub.add_parser("draft", help="draft an outreach email or journalist answer for one opportunity (never sends)")
    dr.add_argument("id", type=int)
    dr.add_argument("--ai", action="store_true", help="personalise with Claude (needs [drafting] anthropic_api_key)")
    dr.add_argument("--no-render", action="store_true")

    cp = sub.add_parser("campaign", help="track pickups of a data study or other PR campaign")
    cp.add_argument("action", choices=["add", "list", "show", "check", "remove"])
    cp.add_argument("id", type=int, nargs="?")
    cp.add_argument("--name")
    cp.add_argument("--asset", help="the URL of the study or asset")
    cp.add_argument("--phrase", action="append", help="a phrase people will use when writing about it (repeatable)")
    cp.add_argument("--started", help="launch date, YYYY-MM-DD (default today)")
    cp.add_argument("--no-render", action="store_true")

    gr = sub.add_parser("graph", help="crawl your site and map its internal links, outbound links and backlinks")
    gr.add_argument("start", nargs="?", help="start URL (default: https://<[project] site>/)")
    gr.add_argument("--max-pages", type=int, default=300)
    gr.add_argument("--out", help="HTML report path (default data/sitegraph.html)")
    gr.add_argument("--open", action="store_true", help="open the report in your browser")
    gr.add_argument("-v", "--verbose", action="store_true", help="print every page as it is crawled")

    pl = sub.add_parser("platform", help="test what kind of links a platform really gives")
    pl.add_argument("action", choices=["test", "list"])
    pl.add_argument("url", nargs="?")
    pl.add_argument("--link", help="the site a user linked to from that page (for an exact answer)")
    pl.add_argument("--no-render", action="store_true")

    sub.add_parser("costs", help="show DataForSEO spending")

    st = sub.add_parser("sites", help="list, add or remove your websites")
    st.add_argument("action", nargs="?", choices=["list", "add", "remove"], default="list")
    st.add_argument("domain", nargs="?")

    sc = sub.add_parser("schedule", help="set up the daily monitor run (Windows Task Scheduler)")
    sc.add_argument("action", choices=["install", "remove", "status"])
    sc.add_argument("--time", default="10:00", help="daily run time, 24-hour HH:MM (default 10:00)")
    return p


COMMANDS = {
    "init": cmd_init, "add": cmd_add, "import": cmd_import, "list": cmd_list, "check": cmd_check,
    "test": cmd_test, "show": cmd_show, "report": cmd_report, "export": cmd_export, "remove": cmd_remove,
    "monitor": cmd_monitor, "changes": cmd_changes, "alert-test": cmd_alert_test,
    "dashboard": cmd_dashboard, "schedule": cmd_schedule, "find": cmd_find, "scan": cmd_scan, "opps": cmd_opps, "opp": cmd_opp,
    "platform": cmd_platform, "costs": cmd_costs,
    "draft": cmd_draft, "campaign": cmd_campaign, "graph": cmd_graph, "sites": cmd_sites,
}


def _safe_output() -> None:
    """Windows writes redirected output (scheduled runs, logs) in cp1252, which can't print characters like
    arrows or curly quotes from web pages; never crash on that."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    _safe_output()
    args = build_parser().parse_args(argv)
    from . import workspace
    try:
        cfg = workspace.load(args.config, args.site)
    except KeyError as exc:
        print(exc.args[0], file=sys.stderr)
        return 2
    except workspace.SettingsFileError as exc:
        print(exc, file=sys.stderr)
        return 2
    try:
        return COMMANDS[args.cmd](args, cfg)
    except KeyboardInterrupt:
        print("\nStopped.")
        return 130
