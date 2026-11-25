"""The build guide: one turn of conversation, its prompt, plain-code safety, and tidying what the model returns."""

import pytest
from fastapi.testclient import TestClient

from repairmind import checker, token_server
from repairmind.guide import agent
from repairmind.guide.schema import GuideTurn


@pytest.fixture
def client():
    return TestClient(token_server.app)


def fake(monkeypatch, result):
    calls = []

    async def parse(system, frames, text, schema, purpose, **kw):
        calls.append({"system": system, "text": text, "purpose": purpose, "schema": schema})
        return result if isinstance(result, checker.Result) else checker.Result(result)

    monkeypatch.setattr(checker, "provider", lambda: "gemini")
    monkeypatch.setattr(checker, "parse", parse)
    return calls


def reply(**over):
    base = {"say": "A night light that wakes up when it hears a clap. Let me check that's doable.",
            "actions": [{"tool": "understand_idea", "args": [{"key": "idea", "value": "clap night light"}], "why": "Thinking it through"}],
            "stage": "understand", "then_continue": True}
    base.update(over)
    return GuideTurn.model_validate(base)


def msgs(*texts):
    return [{"role": "user", "text": t} for t in texts]


def test_without_a_model_it_says_so(client, monkeypatch):
    monkeypatch.setattr(checker, "provider", lambda: None)
    r = client.post("/api/guide/turn", json={"messages": msgs("hi")})
    assert r.status_code == 503
    assert "GOOGLE_API_KEY" in r.json()["detail"]


def test_a_turn_sends_state_catalogue_and_conversation(client, monkeypatch):
    calls = fake(monkeypatch, reply())
    r = client.post("/api/guide/turn", json={
        "messages": msgs("I want a night light that turns on when I clap"),
        "state": "stage: idea", "catalog": "nano: Arduino Nano", "language": "hi"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["actions"][0]["tool"] == "understand_idea"
    assert body["then_continue"] is True
    c = calls[0]
    assert c["purpose"] == "guide"
    assert "STATE:\nstage: idea" in c["text"] and "CATALOGUE:\nnano: Arduino Nano" in c["text"]
    assert "PERSON: I want a night light" in c["text"]
    assert "Hindi" in c["system"]  # replies in the person's language
    assert "SAFETY CHECK" not in c["system"]


def test_tool_results_reach_the_model_as_data(client, monkeypatch):
    calls = fake(monkeypatch, reply(actions=[], then_continue=True))
    r = client.post("/api/guide/turn", json={"messages": [
        {"role": "user", "text": "test it"}, {"role": "guide", "text": "Testing."},
        {"role": "tool", "text": "test_on_bench: LED burned out at 120 mA"}]})
    assert r.status_code == 200
    assert "TOOL RESULTS: test_on_bench: LED burned out" in calls[0]["text"]
    # no actions means nothing to wait for
    assert r.json()["then_continue"] is False


def test_mains_work_gets_the_plain_code_safety_rule(client, monkeypatch):
    calls = fake(monkeypatch, reply())
    client.post("/api/guide/turn", json={"messages": msgs("I want to rewire the microwave's high voltage capacitor")})
    assert "SAFETY CHECK" in calls[0]["system"]


def test_replies_are_trimmed_to_a_calm_size():
    t = agent.tidy(reply(chips=["a", "b", "c", "d", "e", " "], actions=[{"tool": "check"}] * 9,
                         checkpoint={"step": 2, "question": "Did the LED light up?", "options": ["Yes", "No", "", "Not sure", "x", "y"]}))
    assert len(t.chips) == 4 and len(t.actions) == agent.MAX_ACTIONS
    assert t.checkpoint.options == ["Yes", "No", "Not sure", "x"]


def test_unknown_tools_are_refused_by_the_schema():
    with pytest.raises(ValueError):
        GuideTurn.model_validate({"say": "x", "actions": [{"tool": "format_disk"}]})


def test_model_failures_come_back_in_plain_words(client, monkeypatch):
    fake(monkeypatch, checker.Result(None, error="Gemini check failed after 3 tries: overloaded. Try again in a minute."))
    r = client.post("/api/guide/turn", json={"messages": msgs("hello")})
    assert r.status_code == 502
    assert "Try again" in r.json()["detail"]


def test_expired_attachments_are_reported(client, monkeypatch):
    fake(monkeypatch, reply())
    r = client.post("/api/guide/turn", json={"messages": msgs("look"), "attachment_ids": ["nope"]})
    assert r.status_code == 410


# --- one assistant for everything, and checking a photo of the real build -----------------------------------------

def test_the_assistant_covers_repairs_and_every_tool(client, monkeypatch):
    calls = fake(monkeypatch, reply(say="That sounds like the fan's capacitor. Want me to look through your camera?",
                                    actions=[{"tool": "start_repair_call", "args": [], "why": ""}],
                                    stage="fix", then_continue=False))
    r = client.post("/api/guide/turn", json={"messages": msgs("my ceiling fan hums but won't spin")})
    assert r.status_code == 200, r.text
    assert r.json()["actions"][0]["tool"] == "start_repair_call"
    assert r.json()["stage"] == "fix"
    s = calls[0]["system"]
    for tool in ("open_panel", "start_repair_call", "search_library", "ask_for_photo", "check_build_photo",
                 "show_buy_list", "export_build_pack"):
        assert tool in s


def _photo(monkeypatch, image=True):
    from repairmind.lab import attachments

    class A:
        image_b64 = "aGVsbG8=" if image else ""

    monkeypatch.setattr(attachments, "load", lambda i: A() if i == "a1" else None)


def test_a_photo_check_is_made_stricter_in_code(client, monkeypatch):
    from repairmind.guide.photo_check import PhotoCheck

    _photo(monkeypatch)
    calls = fake(monkeypatch, PhotoCheck.model_validate({
        "photo": "good", "power_on": True, "summary": "",
        "wires": [{"n": 1, "verdict": "ok"}, {"n": 2, "verdict": "wrong", "note": "goes to D3, not D2"},
                  {"n": 9, "verdict": "ok"}]}))
    r = client.post("/api/guide/check-build", json={
        "attachment_id": "a1", "wires": [{"n": 1, "text": "5V to red rail"}, {"n": 2, "text": "LED + to D2"},
                                         {"n": 3, "text": "GND to blue rail"}]})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["power_on"] is False  # a wrong wire overrides the model's yes
    assert [w["n"] for w in b["wires"]] == [1, 2, 3]  # unknown wire 9 dropped, missing wire 3 added
    assert b["wires"][2]["verdict"] == "unclear"
    assert "Wire 2: WRONG goes to D3" in b["text"] and "NOT YET" in b["text"]
    assert calls[0]["purpose"] == "vision" and "1. 5V to red rail" in calls[0]["text"]


def test_a_photo_check_needs_a_photo(client, monkeypatch):
    fake(monkeypatch, None)
    _photo(monkeypatch, image=False)
    w = [{"n": 1, "text": "x"}]
    assert client.post("/api/guide/check-build", json={"attachment_id": "gone", "wires": w}).status_code == 410
    assert client.post("/api/guide/check-build", json={"attachment_id": "a1", "wires": w}).status_code == 422
