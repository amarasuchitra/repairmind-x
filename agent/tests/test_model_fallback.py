"""Retries, backup models and plain error messages for every AI call (checker.parse)."""

import asyncio

import pytest
from google.genai import errors as gerrors
from pydantic import BaseModel

from repairmind import checker


class Out(BaseModel):
    ok: bool


@pytest.fixture
def keys(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY", "RMX_CHECK_PROVIDER"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    monkeypatch.setattr(checker, "GEMINI_MODEL", "main-model")
    monkeypatch.setattr(checker, "GEMINI_FALLBACKS", ["backup-model"])
    monkeypatch.setattr(checker, "GEMINI_DESIGN_FALLBACKS", ["lite-model"])


def script(monkeypatch, plan):
    """plan: {model: [exception or None, ...]} in call order; None means answer {ok: true}."""
    calls = []

    async def fake_gemini(system, frames, text, schema, timeout, model=""):
        calls.append(model)
        steps = plan.get(model, [])
        outcome = steps.pop(0) if steps else gerrors.ServerError(503, {"error": {"message": "overloaded"}})
        if outcome is None:
            return checker.Result(schema(ok=True))
        raise outcome

    async def fake_anthropic(system, frames, text, schema, purpose, effort, timeout, max_tokens=4000, model=""):
        calls.append(model)
        steps = plan.get("claude", [])
        outcome = steps.pop(0) if steps else RuntimeError("down")
        if outcome is None:
            return checker.Result(schema(ok=True))
        raise outcome

    monkeypatch.setattr(checker, "_gemini", fake_gemini)
    monkeypatch.setattr(checker, "_anthropic", fake_anthropic)
    return calls


def run(purpose="design"):
    return asyncio.run(checker.parse("sys", [], "hi", Out, purpose, timeout=60))


def overloaded():
    return gerrors.ServerError(503, {"error": {"message": "The model is overloaded."}})


def test_transient_errors_are_retried_on_the_same_model(monkeypatch, keys):
    calls = script(monkeypatch, {"main-model": [overloaded(), overloaded(), None]})
    res = run()
    assert res.parsed and res.parsed.ok and res.model == "main-model"
    assert calls == ["main-model"] * 3


def test_backup_model_answers_when_the_main_one_stays_down(monkeypatch, keys):
    calls = script(monkeypatch, {"main-model": [overloaded()] * 3, "backup-model": [None]})
    res = run()
    assert res.parsed and res.model == "backup-model"
    assert calls == ["main-model"] * 3 + ["backup-model"]


def test_a_missing_model_is_skipped_without_retrying(monkeypatch, keys):
    calls = script(monkeypatch, {"main-model": [gerrors.ClientError(404, {"error": {"message": "models/x is not found"}})],
                                 "backup-model": [None]})
    res = run()
    assert res.parsed and calls == ["main-model", "backup-model"]


def test_claude_is_the_last_backup_when_its_key_is_set(monkeypatch, keys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "gemini")  # forced: no switching provider
    calls = script(monkeypatch, {"claude": [None]})
    assert run().parsed is None and "claude" not in " ".join(calls)
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "auto")  # auto: Claude goes first, Gemini is its backup
    calls = script(monkeypatch, {"claude": [RuntimeError("Connection reset")] * 3, "main-model": [None]})
    res = run()
    assert res.parsed and res.model == "main-model" and calls[0].startswith("claude")


def test_failure_message_is_plain_and_names_what_was_tried(monkeypatch, keys):
    script(monkeypatch, {})
    res = run()
    assert res.parsed is None
    assert res.error.startswith("Gemini check failed after")
    assert "main-model" in res.error and "backup-model" in res.error and "lite-model" in res.error
    assert "overloaded" in res.error
    assert "try again in a minute" in res.error
    assert "ANTHROPIC_API_KEY" in res.error  # suggests a backup provider


def test_refusal_is_final_and_not_shopped_to_another_model(monkeypatch, keys):
    calls = []

    async def refuse(system, frames, text, schema, timeout, model=""):
        calls.append(model)
        return checker.Result(None, refused=True)

    monkeypatch.setattr(checker, "_gemini", refuse)
    res = run("review")
    assert res.refused and calls == ["main-model"]


def test_classification():
    assert checker._classify(overloaded()).transient
    assert checker._classify(gerrors.ClientError(429, {"error": {"message": "RESOURCE_EXHAUSTED"}})).kind == "quota"
    assert checker._classify(gerrors.ClientError(403, {"error": {"message": "PERMISSION_DENIED"}})).kind == "key"
    assert not checker._classify(gerrors.ClientError(400, {"error": {"message": "bad schema"}})).transient
    assert checker._classify(asyncio.TimeoutError()).kind == "timeout"


def test_lite_backup_is_for_design_only_never_for_safety_checks(monkeypatch, keys):
    calls = script(monkeypatch, {})
    run("design")
    assert "lite-model" in calls
    calls = script(monkeypatch, {})
    run("review")
    assert "lite-model" not in calls and "backup-model" in calls


def test_total_time_is_capped(monkeypatch, keys):
    clock = [0.0]
    monkeypatch.setattr(checker.time, "monotonic", lambda: clock[0])

    async def slow(system, frames, text, schema, timeout, model=""):
        clock[0] += timeout  # every attempt uses its whole allowance, then times out
        raise TimeoutError()

    monkeypatch.setattr(checker, "_gemini", slow)
    res = asyncio.run(checker.parse("sys", [], "hi", Out, "design", timeout=300))
    assert res.parsed is None and clock[0] <= checker.MAX_SECONDS["design"]
    assert "took too long" in res.error
