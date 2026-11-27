"""Idea and upgrade analyst: request shape, plain-code safety enforcement, and learning from corrections."""

import pytest
from fastapi.testclient import TestClient

from repairmind import checker, token_server
from repairmind.upgrade import assess as analyst
from repairmind.upgrade.schema import Assessment

CATALOG = [{"id": i, "name": i} for i in ["esp32", "nano", "mic", "player", "speaker", "ring", "touch", "aa3", "boost5", "lipo", "relay", "usb"]]
TRIGGERS = [{"id": t, "label": t} for t in ["start", "touch", "sound", "button"]]
ACTIONS = [{"id": a, "label": a} for a in ["say", "light", "switch"]]


def answer(**over):
    base = {
        "product": {"kind": "existing", "name": "Glowing plush owl", "category": "soft toy", "how_it_works": "Two AA cells light an LED.",
                    "power": "battery", "power_detail": "2 x AA", "inside": [{"name": "LED", "purpose": "glow", "confidence": "likely"}],
                    "space": "Small pocket in the back", "inner_mm": [], "for_kids": True, "hazards": [], "can_open": "Velcro pocket"},
        "wishes": [{"wish": "Talk", "verdict": "possible", "why": "A voice player fits.", "factors": [{"kind": "power", "verdict": "ok", "text": "~250 mA"}],
                    "how": "Add an MP3 player", "alternative": "", "effort": "moderate", "cost_inr": 600}],
        "overall": "go", "overall_why": "Doable",
        "plan": {"summary": "Add voice", "reuse": "The pocket", "steps": ["Open"],
                 "parts": [{"id": "esp32", "why": "brain"}, {"id": "player", "why": "voice"}, {"id": "lipo", "why": "power"}, {"id": "laser", "why": "not in catalogue"}],
                 "rules": [{"when": "touch", "then": "say", "text": "Hi", "color": ""}, {"when": "teleport", "then": "say", "text": "", "color": ""}],
                 "other_parts": [], "stages": [{"name": "Desk prototype", "goal": "Prove it talks", "tasks": ["Wire it"], "weeks": 1}], "warnings": []},
        "restated": "Make the owl talk", "questions": [{"q": "Who will use it?", "why": "safety", "options": ["A child", "An adult"]},
                                                     {"q": "How long on batteries?", "why": "size", "options": ["A day", "A week"]}],
        "design_lab": False,
    }
    base.update(over)
    return Assessment.model_validate(base)


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RMX_UPGRADE_DIR", str(tmp_path))
    return TestClient(token_server.app)


def fake(monkeypatch, result):
    calls = []

    async def parse(system, frames, text, schema, purpose, **kw):
        calls.append({"system": system, "text": text})
        return checker.Result(result() if callable(result) else result)

    monkeypatch.setattr(checker, "provider", lambda: "anthropic")
    monkeypatch.setattr(checker, "parse", parse)
    return calls


def body(**over):
    b = {"idea": "make it talk", "product": "a plush owl that glows", "for_kids": True, "catalog": CATALOG, "triggers": TRIGGERS, "actions": ACTIONS}
    b.update(over)
    return b


def test_without_a_model_it_says_so(client, monkeypatch):
    monkeypatch.setattr(checker, "provider", lambda: None)
    r = client.post("/api/upgrade/assess", json=body())
    assert r.status_code == 503
    assert client.get("/api/upgrade/status").json()["ready"] is False


def test_plan_is_kept_inside_the_catalogue_and_answered_questions_are_dropped(client, monkeypatch):
    calls = fake(monkeypatch, answer)
    r = client.post("/api/upgrade/assess", json=body(answers=[{"q": "Who will use it?", "a": "A child"}]))
    assert r.status_code == 200, r.text
    a = r.json()
    assert [p["id"] for p in a["plan"]["parts"]] == ["esp32", "player", "lipo"]
    assert [x["when"] for x in a["plan"]["rules"]] == ["touch"]
    assert [q["q"] for q in a["questions"]] == ["How long on batteries?"]
    assert any("AA cells" in w for w in a["plan"]["warnings"])
    assert "Who will use it? -> A child" in calls[0]["text"]
    assert "WHAT THEY ALREADY HAVE" in calls[0]["text"]


def test_new_ideas_are_framed_as_new(client, monkeypatch):
    calls = fake(monkeypatch, answer)
    client.post("/api/upgrade/assess", json=body(product="", idea="a glove that lights up when I point at things"))
    assert "THIS IS A NEW IDEA" in calls[0]["text"]


def test_red_level_products_never_get_a_relay_or_a_plain_go(client, monkeypatch):
    def a():
        x = answer()
        x.plan.parts.append(analyst.Assessment.model_fields["plan"].annotation.model_fields["parts"].annotation.__args__[0](id="relay", why="switch it"))
        return x
    fake(monkeypatch, a)
    r = client.post("/api/upgrade/assess", json=body(product="my microwave oven", idea="make it talk when the food is ready"))
    j = r.json()
    assert j["overall"] != "go"
    assert "relay" not in [p["id"] for p in j["plan"]["parts"]]
    assert j["plan"]["warnings"][0].startswith("Safety:")


def test_no_dead_end_when_no_wish_is_possible_as_asked(client, monkeypatch):
    def a():
        x = answer()
        x.wishes[0].verdict = "not_possible"
        return x
    fake(monkeypatch, a)
    j = client.post("/api/upgrade/assess", json=body(idea="make it fly")).json()
    # the plan builds the closest alternative instead of being wiped, and isn't presented as "go as asked"
    assert j["overall"] == "go_with_changes"
    assert j["plan"]["parts"]

    def nothing():
        x = a()
        x.plan.parts, x.plan.rules = [], []
        return x
    fake(monkeypatch, nothing)
    assert client.post("/api/upgrade/assess", json=body(idea="make it fly")).json()["overall"] == "not_recommended"


def test_corrections_and_precedents_are_learned_and_reused(client, monkeypatch):
    calls = fake(monkeypatch, answer)
    first = client.post("/api/upgrade/assess", json=body()).json()
    client.post("/api/upgrade/assess", json=body(correction="It runs on 3 AAA cells, not 2 AA.", previous=first))
    client.post("/api/upgrade/assess", json=body(product="a plush rabbit"))
    last = calls[-1]["system"]
    assert "It runs on 3 AAA cells, not 2 AA." in last
    assert 'soft toy: "Talk" -> possible' in last
    s = client.get("/api/upgrade/status").json()
    assert s["learned"] == 1 and s["precedents"] == 3


def concept(title, parts):
    return {"title": title, "pitch": "p", "for_user": "u", "tech": "t", "new_because": "n", "parts": parts,
            "cost_inr": 900, "effort": "moderate", "risk": "r"}


def test_concepts_are_kept_to_three_and_to_catalogue_parts(client, monkeypatch):
    many = [concept("Story star", ["esp32", "player", "warp_drive"]), concept("Chatty owl", ["esp32", "mic"]),
            concept("Sleep coach", ["nano", "ring"]), concept("Fourth", ["nano"])]
    calls = fake(monkeypatch, lambda: answer(concepts=many))
    r = client.post("/api/upgrade/assess", json=body())
    assert r.status_code == 200, r.text
    got = r.json()["concepts"]
    assert [c["title"] for c in got] == ["Story star", "Chatty owl", "Sleep coach"]
    assert got[0]["parts"] == ["esp32", "player"]
    # the analyst is asked to innovate: three ranked directions, each grounded in a real user and real numbers
    assert "exactly 3 concepts" in calls[0]["system"] and "Build concept:" in calls[0]["system"]


def test_an_answer_without_concepts_still_validates():
    assert answer().concepts == []
