import asyncio

from repairmind import vision
from repairmind.session import Hypothesis, RepairSession


def active_irreversible_step():
    s = RepairSession(review_required=False)
    s.identify_device("bicycle", "Trek", "FX 2", model_confirmed=True, source="label")
    s.record_history_answer("q", "a")
    s.record_history_answer("q2", "a2")
    s.record_test("t", "r")
    s.update_hypotheses([Hypothesis("Old cable tie rubbing", 0.9)])
    s.set_diagnosis("Old cable tie rubbing", 0.95, ["seen"])
    sid = s.propose_step("Cut the old cable tie", "manual", "p.20", "tie removed").data["step_id"]
    s.mark_photo_taken(sid)
    s.confirm_irreversible_step(sid, "yes go ahead")
    return s, sid


def test_unclear_three_times_escalates():
    s, sid = active_irreversible_step()
    assert s.record_vision_check(sid, "unclear", "blurry").code == "vision_unclear"
    assert s.record_vision_check(sid, "unclear", "blurry").code == "vision_unclear"
    assert s.record_vision_check(sid, "unclear", "blurry").code == "vision_unclear_escalate"


def test_not_done_blocks():
    s, sid = active_irreversible_step()
    assert s.record_vision_check(sid, "not_done", "tie still there").code == "vision_not_done"
    assert s.report_step_result(sid, "camera", True, "x").code == "needs_vision_check"


def test_vision_unavailable_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    v = asyncio.run(vision.check_step(["a", "b"], "Cut the tie", "tie removed"))
    assert v.status == "unavailable"
    assert asyncio.run(vision.locate("a", "screw")) is None


def _fake(monkeypatch, outputs):
    calls = iter(outputs)

    async def fake_parse(frames, prompt, schema):
        return next(calls)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setattr(vision, "_parse", fake_parse)


def test_two_frames_must_agree(monkeypatch):
    done = vision.StepCheck(outcome="done", confidence=0.95, observation="tie gone")
    shaky = vision.StepCheck(outcome="done", confidence=0.6, observation="probably gone")
    _fake(monkeypatch, [done, shaky])
    assert asyncio.run(vision.check_step(["a", "b"], "s", "e")).status == "unclear"
    _fake(monkeypatch, [done, done])
    assert asyncio.run(vision.check_step(["a", "b"], "s", "e")).status == "done"


def test_problem_seen_overrides_done(monkeypatch):
    bad = vision.StepCheck(outcome="done", confidence=0.9, observation="cover off", problems_seen=["clip broken"])
    ok = vision.StepCheck(outcome="done", confidence=0.9, observation="cover off")
    _fake(monkeypatch, [bad, ok])
    v = asyncio.run(vision.check_step(["a", "b"], "s", "e"))
    assert v.status == "unclear" and "clip broken" in v.problems_seen


def test_single_frame_is_not_enough(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    assert asyncio.run(vision.check_step(["a"], "s", "e")).status == "unclear"
