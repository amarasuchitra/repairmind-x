import pytest
from fastapi.testclient import TestClient

from repairmind.redesign import brief as briefs
from repairmind.redesign import failure_modes, library, units
from repairmind.redesign.brief import DesignBrief, Measure
from repairmind.session import RepairSession, SafeTest


# ----------------------------------------------------------------- units
@pytest.mark.parametrize("text,dim,si", [
    ("12 mm", "length", 0.012), ("1.5in", "length", 0.0381), ("20 N", "force", 20.0), ("2 kN", "force", 2000.0),
    ("3 N·m", "torque", 3.0), ("3 Nm", "torque", 3.0), ("2 bar", "pressure", 2e5), ("40 MPa", "pressure", 4e7),
    ("60 °C", "temperature", 333.15), ("212 F", "temperature", 373.15), ("1200 rpm", "angular_speed", 125.66),
    ("250 g", "mass", 0.25),
])
def test_units_parse_to_si(text, dim, si):
    q = units.parse(text)
    assert q.dimension == dim
    assert q.si == pytest.approx(si, rel=1e-3)


@pytest.mark.parametrize("text", ["12", "", "twelve mm", "5 furlongs"])
def test_units_refuse_bare_or_unknown(text):
    with pytest.raises(units.UnitError):
        units.parse(text)


def test_units_refuse_wrong_kind():
    with pytest.raises(units.UnitError, match="length"):
        units.parse("20 N", expect="length")


# --------------------------------------------------------- failure modes
def test_suggest_fatigue_from_description():
    top = failure_modes.suggest("hairline crack started at the screw hole after years of use")[0]
    assert top["id"] == "fatigue"


def test_required_analyses_always_has_static_and_follows_mode():
    assert failure_modes.required_analyses([]) == ["static_strength"]
    got = failure_modes.required_analyses(["fatigue"])
    assert "fatigue" in got and "vibration" in got and got[0] == "static_strength"
    assert "creep" in failure_modes.required_analyses(["thermal"])


# ----------------------------------------------------------------- brief
def good_brief(**kw) -> DesignBrief:
    base = dict(
        device="washing machine", part="door hinge clip", part_function="hold the door shut against the seal",
        failure_mode="fatigue", failure_mode_certainty="seen", material="ABS", material_source="estimated",
        dimensions=[Measure(name="length", value="42 mm", source="measured"),
                    Measure(name="wall", value="2 mm", source="measured")],
        operating=[Measure(name="closing force", value="20 N", source="estimated"),
                   Measure(name="cycles per day", value="6 cycles", source="user")],
    )
    base.update(kw)
    return DesignBrief(**base)


def test_complete_brief_is_ready_and_lists_assumptions():
    c = briefs.check(good_brief())
    assert c.ready and not c.blocked and not c.errors and not c.missing
    assert any("closing force" in a for a in c.assumptions)
    assert any("ABS" in a for a in c.assumptions)
    assert [a["id"] for a in c.required_analyses][:2] == ["static_strength", "fatigue"]
    assert c.quantities["dimension:length"]["si"] == pytest.approx(0.042)


def test_missing_units_are_errors_not_guesses():
    c = briefs.check(good_brief(dimensions=[Measure(name="length", value="42")]))
    assert not c.ready
    assert any("length" in e and "unit" in e for e in c.errors)


def test_dimension_must_be_a_length():
    c = briefs.check(good_brief(dimensions=[Measure(name="length", value="42 N")]))
    assert any("length" in e for e in c.errors)


def test_missing_items_are_listed():
    c = briefs.check(DesignBrief(part="gear"))
    assert not c.ready
    text = " ".join(c.missing)
    assert "has to do" in text and "How it failed" in text and "dimensions" in text and "load" in text


def test_red_level_is_blocked():
    c = briefs.check(good_brief(device="microwave", part="high voltage capacitor bracket"))
    assert c.blocked and not c.ready


def test_life_critical_needs_signoff_but_can_draft():
    c = briefs.check(good_brief(device="step ladder", part="hinge bracket"))
    assert c.ready and c.needs_signoff and "ladder" in c.signoff_reason
    lab = briefs.to_lab(good_brief(device="step ladder", part="hinge bracket"), c)
    assert "LIFE-CRITICAL" in lab["context"]


def test_to_lab_shape_and_caps():
    b = good_brief(observations=["x" * 300] * 30, constraints=["c" * 200] * 20)
    lab = briefs.to_lab(b, briefs.check(b))
    assert set(lab) == {"idea", "context"}
    assert "door hinge clip" in lab["idea"] and "fatigue" in lab["idea"].lower()
    assert "42 mm" in lab["context"] and "safety factor of 1.5" in lab["context"]
    assert len(lab["idea"]) <= 4000 and len(lab["context"]) <= 4000


def session_with_part() -> RepairSession:
    s = RepairSession(session_id="rmx-abcdef123456", device="washing machine", brand="Bosch", model="WAN28",
                      model_confirmed=True, diagnosis="door clip cracked", diagnosis_evidence=["crack at hole"])
    s.tests.append(SafeTest("pressed door", "does not latch"))
    r = s.record_failed_part("door hinge clip", "hold the door shut", "fatigue", "seen", ["beach marks"],
                             "ABS", "estimated",
                             [{"name": "length", "value": "42 mm"}, {"name": "width", "value": "9"}],
                             [{"name": "force", "value": "20 N", "source": "estimated"}])
    assert r.allowed and "width" in r.say  # the unitless width was refused, not guessed
    return s


def test_session_records_failed_part_with_unit_checks():
    s = session_with_part()
    assert [d["name"] for d in s.failed_part["dimensions"]] == ["length"]
    assert s.record_failed_part("", "x", "fatigue", "seen", []).code == "missing_part"
    assert s.record_failed_part("clip", "x", "magic", "seen", []).code == "bad_mode"


def test_from_session_prefills(tmp_path):
    s = session_with_part()
    s.save(tmp_path)
    loaded = RepairSession.load(tmp_path / f"{s.session_id}.json")  # old files load too (field has a default)
    b = briefs.from_session(loaded)
    assert b.part == "door hinge clip" and b.failure_mode == "fatigue" and b.failure_mode_certainty == "seen"
    assert b.model == "WAN28" and b.dimensions[0].value == "42 mm"
    assert any("pressed door" in o for o in b.observations)


def test_from_session_guesses_mode_when_not_recorded():
    s = RepairSession(session_id="rmx-abcdef123456", device="kettle", symptoms=["handle melted and warped"])
    b = briefs.from_session(s)
    assert b.failure_mode == "thermal" and b.failure_mode_certainty == "suspected"


# --------------------------------------------------------------- library
def test_library_keeps_no_personal_text(tmp_path):
    b = good_brief(id=briefs.new_id(), room="rmx-abcdef123456", observations=["my name is Asha, 12 MG Road"])
    rec = library.add(tmp_path, b)
    assert "room" not in rec and "observations" not in rec
    assert "Asha" not in (tmp_path / "failure_library.jsonl").read_text(encoding="utf-8")


def test_library_search_stats_outcome(tmp_path):
    a = good_brief(id=briefs.new_id())
    b = good_brief(id=briefs.new_id(), device="kettle", part="handle", failure_mode="thermal")
    library.add(tmp_path, a)
    library.add(tmp_path, b)
    library.add(tmp_path, a)  # re-adding replaces, never duplicates
    assert len(library.all_records(tmp_path)) == 2
    assert [r["part"] for r in library.search(tmp_path, "hinge clip")] == ["door hinge clip"]
    assert [r["part"] for r in library.search(tmp_path, mode="thermal")] == ["handle"]
    assert library.set_outcome(tmp_path, a.id, "holding")["outcome"] == "holding"
    st = library.stats(tmp_path)
    assert st["total"] == 2 and st["outcomes"] == {"holding": 1, "pending": 1}
    with pytest.raises(ValueError):
        library.set_outcome(tmp_path, a.id, "great")


# ------------------------------------------------------------------- API
@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RMX_SESSIONS_DIR", str(tmp_path))
    from repairmind.token_server import app

    return TestClient(app)


def test_api_full_flow(client, tmp_path):
    session_with_part().save(tmp_path)
    r = client.post("/api/redesign/briefs/from-session", json={"room": "rmx-abcdef123456"})
    assert r.status_code == 200
    brief = r.json()["brief"]
    assert brief["part"] == "door hinge clip"
    assert not r.json()["check"]["ready"] or r.json()["check"]["missing"] == []

    brief["dimensions"].append({"name": "wall", "value": "2 mm", "source": "measured"})
    brief["room"] = "rmx-somethingelse1"  # server-owned: ignored
    r = client.post("/api/redesign/briefs", json=brief)
    assert r.status_code == 200 and r.json()["brief"]["room"] == "rmx-abcdef123456"
    assert r.json()["check"]["ready"]

    lab = client.post(f"/api/redesign/briefs/{brief['id']}/lab").json()
    assert "door hinge clip" in lab["idea"]

    assert client.post(f"/api/redesign/briefs/{brief['id']}/share").status_code == 200
    assert client.get("/api/redesign/library", params={"q": "clip"}).json()[0]["brief_id"] == brief["id"]
    assert client.post(f"/api/redesign/library/{brief['id']}/outcome", json={"outcome": "failed_again"}).json()[
        "outcome"] == "failed_again"
    assert client.get("/api/redesign/library/stats").json()["total"] == 1


def test_api_refuses_unready_and_blocked(client):
    r = client.post("/api/redesign/briefs", json={"part": "gear"})
    bid = r.json()["brief"]["id"]
    assert client.post(f"/api/redesign/briefs/{bid}/lab").status_code == 409
    r = client.post("/api/redesign/briefs", json=good_brief(device="microwave", part="high voltage capacitor").model_dump())
    bid = r.json()["brief"]["id"]
    res = client.post(f"/api/redesign/briefs/{bid}/lab")
    assert res.status_code == 409 and "red-level" in res.json()["detail"]
    assert client.post(f"/api/redesign/briefs/{bid}/share").status_code == 409


def test_api_rejects_bad_ids(client):
    assert client.post("/api/redesign/briefs/from-session", json={"room": "../etc"}).status_code == 400
    assert client.post("/api/redesign/briefs/from-session", json={"room": "rmx-nosuchroom1"}).status_code == 404
    assert client.get("/api/redesign/briefs/..%2Fx").status_code == 404
    assert client.post("/api/redesign/briefs", json={"id": "brf-000000000000"}).status_code == 404
    assert client.post("/api/redesign/library/nope/outcome", json={"outcome": "holding"}).status_code == 404


def test_api_failure_modes(client):
    body = client.get("/api/redesign/failure-modes").json()
    assert {m["id"] for m in body["modes"]} >= {"fatigue", "wear", "thermal"}
