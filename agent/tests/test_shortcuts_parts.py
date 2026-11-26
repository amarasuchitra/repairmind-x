"""Learned shortcuts and the part finder."""

from urllib.parse import parse_qs, urlparse

from repairmind import known_fixes, parts, summary
from tests.test_phase2 import bike


def fixed_bike(session_id="rmx-aaaaaaaaaaaa"):
    s = bike()
    s.session_id = session_id
    s.symptoms.append("chain fell off when shifting")
    s.propose_step("Lift the chain back onto the small ring", "general_safe", "", "chain on ring")
    s.report_step_result(s.steps[0].id, "camera", True, "chain seated")
    return s


def test_only_fully_verified_fixes_are_remembered(tmp_path):
    path = known_fixes.store_path(tmp_path)
    s = bike()
    assert not known_fixes.record(path, s)  # no steps
    s.propose_step("Lift the chain back onto the small ring", "general_safe", "", "chain on ring")
    assert not known_fixes.record(path, s)  # step not done
    s.report_step_result(s.steps[0].id, "camera", True, "chain seated")
    s.hazard("smoke")
    assert not known_fixes.record(path, s)  # stopped for danger
    assert known_fixes.load(path) == []


def test_remember_count_and_lookup(tmp_path):
    path = known_fixes.store_path(tmp_path)
    assert known_fixes.record(path, fixed_bike("rmx-aaaaaaaaaaaa"))
    assert not known_fixes.record(path, fixed_bike("rmx-aaaaaaaaaaaa"))  # same call, counted once
    assert known_fixes.record(path, fixed_bike("rmx-bbbbbbbbbbbb"))
    hits = known_fixes.lookup(path, "trek", "FX-2", "chain keeps falling off")
    assert len(hits) == 1 and hits[0]["worked"] == 2
    assert known_fixes.lookup(path, "Trek", "FX 3") == []  # other model: nothing
    assert known_fixes.lookup(path, "", "") == []
    text = known_fixes.for_model(hits)
    assert "worked 2 times" in text and "propose_step" in text and "Lift the chain" in text


def test_corrupt_store_is_ignored(tmp_path):
    path = known_fixes.store_path(tmp_path)
    path.write_text("{not json", encoding="utf-8")
    assert known_fixes.load(path) == []
    assert known_fixes.record(path, fixed_bike())
    assert len(known_fixes.load(path)) == 1


def test_part_links_are_searches_never_prices(monkeypatch):
    monkeypatch.delenv("RMX_PART_SHOPS", raising=False)
    f = parts.find("Bosch", "WAN28", "drain pump", "00145338")
    assert f["query"] == "Bosch 00145338 drain pump"
    assert {lk["shop"] for lk in f["links"]} >= {"iFixit", "eBay"}
    for lk in f["links"]:
        u = urlparse(lk["url"])
        assert u.scheme == "https"
        assert "00145338" in " ".join(v for vs in parse_qs(u.query).values() for v in vs)
    assert "never state" in parts.for_model(f, True)
    assert "may not fit" in parts.for_model(f, False)
    assert parts.find("", "", "<script>x</script>")["query"] == "script x /script"


def test_custom_shops_must_be_https(monkeypatch):
    monkeypatch.setenv("RMX_PART_SHOPS", "Local|https://shop.example/s?q={q},Bad|http://x/{q},NoQ|https://y/")
    assert parts.shops() == [("Local", "https://shop.example/s?q={q}")]
    monkeypatch.setenv("RMX_PART_SHOPS", "Bad|javascript:alert({q})")
    assert parts.shops() == parts.DEFAULT_SHOPS


def test_parts_and_shortcuts_reach_the_summary():
    s = fixed_bike()
    s.parts.append(parts.find(s.brand, s.model, "chain"))
    s._record("part_search", part="chain", query="Trek FX 2 chain")
    s._record("known_fix", diagnosis="Chain derailed", worked=2)
    out = summary.build(s)
    assert out["parts"][0]["part"] == "chain"
    texts = [n["text"] for n in out["notes"]]
    assert "Searched shops for a part: Trek FX 2 chain" in texts
    assert any(t.startswith("Found a fix that worked before") for t in texts)
    assert "## Parts to look for" in summary.to_markdown(out)
