"""Multi-site workspaces and the settings files."""

import pytest

from linkverify import cli, workspace
from linkverify.db import Registry


def test_add_load_save(tmp_path):
    root = tmp_path / "config.toml"
    root.write_text('[ahrefs]\napi_key = "AH"\n[general]\ndelay_seconds = 0.5\n', encoding="utf-8")
    a = workspace.add_site(root, "https://www.SmithMotors.com.au/")
    b = workspace.add_site(root, "blackstoneautogroup.com.au")
    assert [s.id for s in workspace.list_sites(root)] == ["blackstoneautogroup.com.au", "smithmotors.com.au"]
    assert workspace.add_site(root, "smithmotors.com.au").id == a.id  # no duplicates
    cfg = workspace.save(root, a.id, {"brand_names": "Smith Motors\nSmith", "topics": "smash repairs\nroadworthy",
                                      "profile_name": "Alex", "dataforseo_login": "me@x.com", "alert_min_score": "55",
                                      "render": "false", "dataforseo_location_code": "2036"})
    assert cfg.my_site == "smithmotors.com.au" and cfg.brand_names == ["Smith Motors", "Smith"]
    assert cfg.topics == ["smash repairs", "roadworthy"] and cfg.alert_min_score == 55 and cfg.render is False
    assert cfg.ahrefs_api_key == "AH" and cfg.delay_seconds == 0.5  # shared settings survive the rewrite
    assert cfg.data_dir == a.data_dir and cfg.site_id == a.id
    other = workspace.load(root, b.id)
    assert other.brand_names == [] and other.profile_name == ""  # site settings stay with their site
    assert other.dataforseo_login == "me@x.com" and other.render is False  # shared ones are shared
    assert other.dataforseo_location_code == 2036  # per-site search country, from the .au address
    assert workspace.load(root, workspace.add_site(root, "plain.com").id).dataforseo_location_code == 2840
    assert (a.file.parent / "site.toml.bak").exists() and "Alex" in a.file.read_text(encoding="utf-8")
    with pytest.raises(ValueError, match="new site"):
        workspace.save(root, a.id, {"my_site": "other.com"})
    with pytest.raises(ValueError, match="whole number"):
        workspace.save(root, a.id, {"alert_min_score": "lots"})


def test_quotes_and_newlines_round_trip(tmp_path):
    root = tmp_path / "config.toml"
    s = workspace.add_site(root, "a.com")
    tricky = 'He said "hi"\\ back\tslash'
    cfg = workspace.save(root, s.id, {"profile_bio": tricky, "profile_facts": "Fact one\nFact, two"})
    assert cfg.profile_bio == tricky and cfg.profile_facts == ["Fact one", "Fact, two"]  # facts keep their commas


def test_legacy_single_site_config(tmp_path):
    root = tmp_path / "config.toml"
    root.write_text('[general]\ndata_dir = "data"\n[project]\nsite = "old.com"\nbrand_names = ["Old"]\n[profile]\nname = "Me"\n', encoding="utf-8")
    sites = workspace.list_sites(root)
    assert len(sites) == 1 and sites[0].legacy and sites[0].data_dir == tmp_path / "data"
    cfg = workspace.load(root)
    assert cfg.my_site == "old.com" and cfg.brand_names == ["Old"] and cfg.data_dir == tmp_path / "data"
    cfg = workspace.save(root, None, {"topics": "a\nb"})
    assert cfg.topics == ["a", "b"] and cfg.brand_names == ["Old"]
    assert workspace.load(root).data_dir == tmp_path / "data"  # data_dir kept on rewrite
    new = workspace.add_site(root, "new.com")
    n = workspace.load(root, new.id)
    assert n.brand_names == [] and n.profile_name == ""  # the legacy site's brand does not leak
    assert [s.id for s in workspace.list_sites(root)] == ["old.com", "new.com"]


def test_remove_site_moves_folder(tmp_path):
    root = tmp_path / "config.toml"
    s = workspace.add_site(root, "gone.com")
    dest = workspace.remove_site(root, s.id)
    assert dest.exists() and not s.file.exists() and workspace.list_sites(root) == []


def test_bad_domain(tmp_path):
    with pytest.raises(ValueError):
        workspace.add_site(tmp_path / "config.toml", "not a site")


def test_cli_sites_and_site_option(tmp_path, capsys):
    root = tmp_path / "config.toml"
    assert cli.main(["--config", str(root), "sites", "add", "one.com"]) == 0
    assert cli.main(["--config", str(root), "sites", "add", "two.com"]) == 0
    assert cli.main(["--config", str(root), "--site", "two.com", "add", "https://x.com/a", "--target", "two.com"]) == 0
    reg = Registry(tmp_path / "sites" / "two.com" / "data" / "links.db")
    assert len(reg.all()) == 1
    reg.close()
    capsys.readouterr()
    assert cli.main(["--config", str(root), "sites"]) == 0
    out = capsys.readouterr().out
    assert "one.com" in out and "two.com" in out and "1 link(s)" in out
    assert cli.main(["--config", str(root), "--site", "nope.com", "list"]) == 2


def test_adding_a_site_keeps_the_legacy_one(tmp_path):
    """Review finding: adding a second site used to rewrite config.toml without the old site's settings."""
    root = tmp_path / "config.toml"
    root.write_text('[general]\ndata_dir = "data"\n[project]\nsite = "legacy.com"\nbrand_names = ["Legacy Co"]\n'
                    'competitors = ["rival.com"]\n[profile]\nname = "Me"\n[email]\nusername = "me@x.com"\n', encoding="utf-8")
    second = workspace.add_site(root, "second.com")
    workspace.save(root, second.id, {"brand_names": "Second", "telegram_chat_id": "42", "alert_min_score": ""})
    sites = workspace.list_sites(root)
    assert [s.id for s in sites] == ["legacy.com", "second.com"]
    legacy = workspace.load(root, "legacy.com")
    assert legacy.brand_names == ["Legacy Co"] and legacy.competitors == ["rival.com"] and legacy.profile_name == "Me"
    assert legacy.telegram_chat_id == "42"  # shared
    text = root.read_text(encoding="utf-8")
    assert "from =" not in text  # untouched derived values are not written back
    assert workspace.load(root, second.id).alert_min_score == 60  # an empty number box means the default


def test_untouched_keys_and_paths_stay_as_written(tmp_path):
    root = tmp_path / "config.toml"
    root.write_text('[search_console]\nservice_account_file = "sa.json"\n[custom]\nmine = 1\n', encoding="utf-8")
    s = workspace.add_site(root, "a.com")
    workspace.save(root, s.id, {"ahrefs_api_key": "K"})
    text = root.read_text(encoding="utf-8")
    assert 'service_account_file = "sa.json"' in text and "mine = 1" in text and 'api_key = "K"' in text


def test_bom_and_broken_files(tmp_path):
    root = tmp_path / "config.toml"
    root.write_bytes("\ufeff[general]\ndelay_seconds = 2\n".encode("utf-8"))
    assert workspace.load(root).delay_seconds == 2
    root.write_text("[general\nbroken", encoding="utf-8")
    with pytest.raises(workspace.SettingsFileError, match="has a mistake"):
        workspace.load(root)


def test_parallel_saves_lose_nothing(tmp_path):
    import threading
    root = tmp_path / "config.toml"
    a, b = workspace.add_site(root, "a.com"), workspace.add_site(root, "b.com")
    errors = []

    def run(sid, attr, n):
        try:
            for i in range(n):
                workspace.save(root, sid, {attr: f"{attr}{i}"})
        except Exception as exc:  # pragma: no cover
            errors.append(exc)
    ts = [threading.Thread(target=run, args=(a.id, "profile_bio", 15)), threading.Thread(target=run, args=(b.id, "telegram_chat_id", 15))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors
    assert workspace.load(root, a.id).profile_bio == "profile_bio14" and workspace.load(root, a.id).telegram_chat_id == "telegram_chat_id14"


def test_commas_stay_inside_list_items(tmp_path):
    root = tmp_path / "config.toml"
    s = workspace.add_site(root, "a.com")
    cfg = workspace.save(root, s.id, {"brand_names": "Smith, Jones & Co\nSJ", "topics": "Brakes, clutches and suspension"})
    assert cfg.brand_names == ["Smith, Jones & Co", "SJ"] and cfg.topics == ["Brakes, clutches and suspension"]
