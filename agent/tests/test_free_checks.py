"""The free Gemini path for the second opinion and vision checks."""

import asyncio
import base64

import pytest

from repairmind import checker, reviewer, vision
from tests.test_phase2 import bike

FRAME = base64.b64encode(b"\xff\xd8fake-jpeg").decode()


@pytest.fixture
def no_keys(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY", "RMX_CHECK_PROVIDER"):
        monkeypatch.delenv(k, raising=False)


def test_provider_selection(monkeypatch, no_keys):
    assert checker.provider() is None
    monkeypatch.setenv("GOOGLE_API_KEY", "g")
    assert checker.provider() == "gemini"  # free option, no Anthropic key needed
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a")
    assert checker.provider() == "anthropic"
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "gemini")
    assert checker.provider() == "gemini"
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "off")
    assert checker.provider() is None
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    assert checker.provider() is None  # asked for Claude without a key: no silent switch


class FakeGenai:
    """Stands in for google.genai: records the request and returns a canned answer."""

    def __init__(self, parsed=None, text="", finish="STOP", block=None, raises=None):
        self.parsed, self.text, self.finish, self.block, self.raises = parsed, text, finish, block, raises
        self.requests = []

    def install(self, monkeypatch):
        from google import genai

        fake = self

        class Models:
            async def generate_content(self, **kw):
                fake.requests.append(kw)
                if fake.raises:
                    raise fake.raises
                cand = type("C", (), {"finish_reason": fake.finish})()
                fb = type("F", (), {"block_reason": fake.block})()
                return type("R", (), {"parsed": fake.parsed, "text": fake.text, "candidates": [cand],
                                      "prompt_feedback": fb})()

        class Client:
            def __init__(self, **kw):
                self.aio = type("A", (), {"models": Models()})()

        monkeypatch.setattr(genai, "Client", Client)
        monkeypatch.setenv("GOOGLE_API_KEY", "g")


def review(verdict="approve", **kw):
    base = dict(diagnosis_supported=True, step_matches_model_and_source=True, verdict=verdict, reason="ok")
    base.update(kw)
    return reviewer.Review(**base)


def run_review():
    return asyncio.run(reviewer.review_step(bike(), "Lift the chain", "manual", "p.12", "excerpt", "on",
                                            [FRAME]))


def test_gemini_reviewer_approves_and_sends_evidence(monkeypatch, no_keys):
    fake = FakeGenai(parsed=review())
    fake.install(monkeypatch)
    r = run_review()
    assert r.status == "approve"
    req = fake.requests[0]
    assert req["model"] == checker.GEMINI_MODEL
    assert req["config"].response_schema is reviewer.Review
    assert "Be strict" in req["config"].system_instruction
    parts = req["contents"][0].parts
    assert parts[0].inline_data.mime_type == "image/jpeg" and "FX 2" in parts[-1].text


def test_gemini_reviewer_stays_strict(monkeypatch, no_keys):
    FakeGenai(parsed=review(safety_issues=["no gloves"])).install(monkeypatch)
    assert run_review().status == "revise"  # approve that lists a safety issue is not an approval
    FakeGenai(parsed=review("escalate")).install(monkeypatch)
    assert run_review().status == "escalate"


def test_gemini_refusal_escalates_and_errors_fail_closed(monkeypatch, no_keys):
    FakeGenai(finish="SAFETY").install(monkeypatch)
    assert run_review().status == "escalate"
    FakeGenai(block="PROHIBITED_CONTENT").install(monkeypatch)
    assert run_review().status == "escalate"
    FakeGenai(raises=RuntimeError("429 quota")).install(monkeypatch)
    assert run_review().status == "unavailable"  # free-tier quota hit: blocked, not approved


def test_gemini_json_text_fallback(monkeypatch, no_keys):
    FakeGenai(parsed=None, text=review().model_dump_json()).install(monkeypatch)
    assert run_review().status == "approve"


def test_gemini_locate_uses_native_boxes(monkeypatch, no_keys):
    fake = FakeGenai(parsed=vision.GeminiBox(found=True, box_2d=[100, 200, 300, 600]))
    fake.install(monkeypatch)
    loc = asyncio.run(vision.locate(FRAME, "the blade cap"))
    assert loc.found
    assert loc.x_center == pytest.approx(0.4) and loc.y_center == pytest.approx(0.2)
    assert loc.width == pytest.approx(0.4) and loc.height == pytest.approx(0.2)
    assert "0-1000" in fake.requests[0]["contents"][0].parts[-1].text


def test_gemini_box_conversion_rejects_bad_boxes():
    assert not vision.gemini_box_to_location(vision.GeminiBox(found=False)).found
    assert not vision.gemini_box_to_location(vision.GeminiBox(found=True, box_2d=[1, 2, 3])).found
    assert not vision.gemini_box_to_location(vision.GeminiBox(found=True, box_2d=[500, 500, 400, 600])).found


def test_gemini_step_check_still_needs_two_confident_frames(monkeypatch, no_keys):
    FakeGenai(parsed=vision.StepCheck(outcome="done", confidence=0.95, observation="tie gone")).install(monkeypatch)
    assert asyncio.run(vision.check_step([FRAME, FRAME], "Cut the tie", "tie removed")).status == "done"
    FakeGenai(parsed=vision.StepCheck(outcome="done", confidence=0.7, observation="maybe")).install(monkeypatch)
    assert asyncio.run(vision.check_step([FRAME, FRAME], "Cut the tie", "tie removed")).status == "unclear"
    FakeGenai(raises=RuntimeError("down")).install(monkeypatch)
    assert asyncio.run(vision.check_step([FRAME, FRAME], "Cut the tie", "tie removed")).status == "unavailable"
