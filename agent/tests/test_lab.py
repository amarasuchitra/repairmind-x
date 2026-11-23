"""Design lab: schema compatibility with the web app, the rethink loop, and the lessons memory."""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from repairmind import checker, token_server
from repairmind.lab import designer
from repairmind.lab.schema import Design, Revision

EXAMPLES = json.loads((Path(__file__).parent / "data" / "lab_examples.json").read_text())


@pytest.fixture
def lab(monkeypatch, tmp_path):
    monkeypatch.setenv("RMX_LAB_DIR", str(tmp_path))
    return TestClient(token_server.app)


def fake_model(monkeypatch, answer):
    calls = []

    async def parse(system, frames, text, schema, purpose, **kw):
        calls.append({"system": system, "text": text, "purpose": purpose, **kw})
        return checker.Result(answer(text) if callable(answer) else answer)

    monkeypatch.setattr(checker, "provider", lambda: "anthropic")
    monkeypatch.setattr(checker, "parse", parse)
    return calls


def test_web_examples_match_the_server_schema():
    # the worked examples in web/src/lab/examples.ts must be valid designs for the server too
    for d in EXAMPLES:
        Design.model_validate(d)


def test_no_model_is_a_clear_503(lab, monkeypatch):
    monkeypatch.setattr(checker, "provider", lambda: None)
    r = lab.post("/api/lab/design", json={"idea": "a small wind turbine for a balcony"})
    assert r.status_code == 503
    assert "examples" in r.json()["detail"]
    assert lab.get("/api/lab/status").json()["ready"] is False


def test_design_uses_the_design_model(lab, monkeypatch):
    calls = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    r = lab.post("/api/lab/design", json={"idea": "inspection rover for ramps"})
    assert r.status_code == 200
    assert r.json()["title"] == EXAMPLES[0]["title"]
    assert calls[0]["purpose"] == "design" and calls[0]["max_tokens"] >= 16000
    assert r.json()["revisions"] == []


def test_revise_passes_findings_keeps_history_and_learns(lab, monkeypatch):
    pod = Design.model_validate(EXAMPLES[1])

    def answer(text):
        out = pod.model_copy(deep=True)
        out.revisions = [Revision(round=1, critique="Stroke too short for the kit's g limit.",
                                  changes=["Pad 60 -> 150 mm"],
                                  lessons=["Average deceleration is set by stopping distance: a = v^2 / 2s."])]
        return out

    calls = fake_model(monkeypatch, answer)
    findings = ["[error] E3 Average deceleration: fails its check, margin of safety -35%"]
    r = lab.post("/api/lab/revise", json={"design": pod.model_dump(), "findings": findings, "note": "keep it under 2 kg"})
    assert r.status_code == 200
    body = r.json()
    assert body["revisions"][-1]["round"] == 1
    assert "fails its check" in calls[0]["text"] and "keep it under 2 kg" in calls[0]["text"]
    # the lesson is remembered and offered to the next design
    assert lab.get("/api/lab/lessons").json()[0]["lesson"].startswith("Average deceleration")
    fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    calls2 = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    lab.post("/api/lab/design", json={"idea": "a drop pod for parcels"})
    assert "stopping distance" in calls2[0]["system"]


def test_lessons_are_deduplicated(monkeypatch, tmp_path):
    monkeypatch.setenv("RMX_LAB_DIR", str(tmp_path))
    designer.save_lessons("x", ["Same lesson", "Same lesson", " "])
    designer.save_lessons("y", ["Same lesson"])
    assert [r["lesson"] for r in designer.load_lessons()] == ["Same lesson"]


def test_refusal_and_failure(lab, monkeypatch):
    async def refused(*a, **k):
        return checker.Result(None, refused=True)

    monkeypatch.setattr(checker, "provider", lambda: "anthropic")
    monkeypatch.setattr(checker, "parse", refused)
    assert lab.post("/api/lab/design", json={"idea": "something the model declines"}).status_code == 422

    async def broken(*a, **k):
        return checker.Result(None, error="anthropic check failed: Timeout")

    monkeypatch.setattr(checker, "parse", broken)
    assert lab.post("/api/lab/design", json={"idea": "a balcony wind turbine"}).status_code == 502
