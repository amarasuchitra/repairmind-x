"""Think first: the lab understands an idea (facts vs guesses, feasibility numbers, riskiest assumption,
concepts, questions) before designing, and the design is built on what the user confirmed."""

import json
from pathlib import Path

from repairmind.lab.schema import Brief, Design
from tests.test_lab import EXAMPLES, fake_model, lab  # noqa: F401  (fixture)


def brief(**kw) -> Brief:
    base = {
        "restated": "A solar pump that lifts water from a 10 m well for a small farm.",
        "kind": "new", "real_goal": "1000 L of water a day without grid power",
        "known": [{"fact": "Well depth 10 m", "source": "you_said", "ref": ""},
                  {"fact": "Pump mounted on a steel frame", "source": "photo", "ref": "A1"}],
        "feasibility": {"verdict": "build_now", "why": "The energy needed is small.", "path": [{"name": "Desk test", "kind": "build", "what": "pump a bucket", "needs": "a 12 V pump", "time": "a weekend"}],
                        "deciding_numbers": ["1000 kg x 9.81 m/s^2 x 10 m = 98 kJ = 27 Wh per day"],
                        "closest_alternative": ""},
        "riskiest": {"statement": "A 100 W panel gives enough sun hours", "why_it_matters": "No sun, no water",
                     "cheapest_test": "Measure panel output for a day", "pass_if": "at least 300 Wh/day",
                     "test_cost_inr": 0, "test_time": "one day"},
        "concepts": [{"name": "Surface pump", "how_it_works": "sucks", "pros": ["cheap"], "cons": ["7 m suction limit"]},
                     {"name": "Submersible DC pump", "how_it_works": "pushes", "pros": ["no suction limit"], "cons": ["cost"]}],
        "recommended_concept": "Submersible DC pump", "recommended_why": "Suction can't lift 10 m.",
        "questions": [{"q": "How much water a day?", "why": "sizes the panel", "options": ["500 L", "1000 L", "5000 L", "x", "y"]},
                      {"q": "Already answered?", "why": "", "options": ["a", "b"]}],
    }
    base.update(kw)
    return Brief.model_validate(base)


def test_understand_returns_a_brief_and_drops_answered_questions(lab, monkeypatch):  # noqa: F811
    calls = fake_model(monkeypatch, brief())
    r = lab.post("/api/lab/understand", json={"idea": "solar pump for my farm well", "answers": [{"q": "Already answered?", "a": "a"}]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert [q["q"] for q in b["questions"]] == ["How much water a day?"]
    assert len(b["questions"][0]["options"]) == 4
    assert b["riskiest"]["pass_if"] and b["feasibility"]["deciding_numbers"]
    sent = calls[0]
    assert "ANSWERS THEY ALREADY GAVE" in sent["text"] and "riskiest assumption" in sent["system"].lower()


def test_correction_is_sent(lab, monkeypatch):  # noqa: F811
    calls = fake_model(monkeypatch, brief())
    lab.post("/api/lab/understand", json={"idea": "solar pump for my farm well", "correction": "It's a 30 m borewell"})
    assert "30 m borewell" in calls[0]["text"]


def test_design_is_built_on_the_confirmed_brief_and_answers(lab, monkeypatch):  # noqa: F811
    calls = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    r = lab.post("/api/lab/design", json={"idea": "solar pump for my farm well", "brief": brief().model_dump(),
                                          "answers": [{"q": "How much water a day?", "a": "1000 L"}]})
    assert r.status_code == 200, r.text
    text = calls[0]["text"]
    assert "AGREED UNDERSTANDING" in text and "Submersible DC pump" in text
    assert "How much water a day? -> 1000 L" in text
    assert "riskiest-assumption test first" in text


def test_design_without_brief_still_works(lab, monkeypatch):  # noqa: F811
    calls = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    assert lab.post("/api/lab/design", json={"idea": "solar pump for my farm well"}).status_code == 200
    assert "AGREED UNDERSTANDING" not in calls[0]["text"]


def test_web_brief_type_matches_the_server_schema():
    # the web's Brief interface lists the same top-level fields
    ts = (Path(__file__).parents[2] / "web" / "src" / "lab" / "brief.ts").read_text(encoding="utf-8")
    for field in Brief.model_fields:
        assert f"{field}:" in ts or f"{field}?:" in ts, field


def test_level_shapes_the_teaching(lab, monkeypatch):  # noqa: F811
    calls = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    lab.post("/api/lab/design", json={"idea": "solar pump for my farm well", "level": "student"})
    assert "TEACHING" in calls[0]["system"] and "student" in calls[0]["system"]
    assert lab.post("/api/lab/design", json={"idea": "solar pump for my farm well", "level": "wizard"}).status_code == 422
    calls = fake_model(monkeypatch, brief())
    lab.post("/api/lab/understand", json={"idea": "solar pump for my farm well", "level": "engineer"})
    assert "practising engineer" in calls[0]["system"]


def test_learn_steps_round_trip():
    d = Design.model_validate({**EXAMPLES[0], "learn": [{
        "concept": "Torque", "intuition": "a push far from the hinge", "why_here": "wheels", "equation_id": "E1",
        "walkthrough": ["T = F r"], "try_variable": "m", "try_factor": 2, "question": "?", "explain_after": "because"}]})
    assert d.learn[0].try_factor == 2
    assert Design.model_validate(EXAMPLES[0]).learn == []
