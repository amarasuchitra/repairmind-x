from pathlib import Path

from repairmind.session import Hypothesis, RepairSession


WASHER = dict(device="washing machine", brand="Bosch", model="WAN28201GB",
              history=[("What happened?", "It stopped draining mid-cycle"), ("Any error code?", "E18 on the display")],
              test=("Checked the drain hose for kinks", "Hose is straight"),
              causes=[("Blocked drain pump filter", 0.85), ("Failed pump", 0.4)],
              evidence=["E18 code", "hose clear"])
BIKE = dict(device="bicycle", brand="Trek", model="FX 2",
            history=[("What happened?", "Chain came off while shifting"), ("Any noises?", "Clicking before")],
            test=("Spun the pedals backwards", "Chain does not engage"),
            causes=[("Chain derailed off the front ring", 0.9), ("Bent derailleur", 0.3)],
            evidence=["chain visibly off the ring"])


def diagnosed(spec=WASHER, confidence=0.9, expect_allowed=True, review=False) -> RepairSession:
    s = RepairSession(review_required=review)
    s.identify_device(spec["device"], spec["brand"], spec["model"], model_confirmed=True, source="label")
    for q, a in spec["history"]:
        s.record_history_answer(q, a)
    s.record_test(*spec["test"])
    s.update_hypotheses([Hypothesis(c, p) for c, p in spec["causes"]])
    r = s.set_diagnosis(spec["causes"][0][0], confidence, spec["evidence"])
    assert r.allowed is expect_allowed
    return s


def test_cannot_diagnose_without_history():
    s = RepairSession()
    s.identify_device("bike", model_confirmed=False)
    r = s.set_diagnosis("chain off", 0.95, ["chain visibly off"])
    assert not r.allowed and r.code == "diagnosis_not_ready"


def test_close_hypotheses_block_diagnosis():
    s = RepairSession()
    s.identify_device("bike")
    s.record_history_answer("q", "a")
    s.record_history_answer("q2", "a2")
    s.update_hypotheses([Hypothesis("A", 0.6), Hypothesis("B", 0.5)])
    r = s.set_diagnosis("A", 0.9, ["x"])
    assert not r.allowed and "too close" in r.say


def test_low_confidence_does_not_instruct():
    s = diagnosed(confidence=0.6, expect_allowed=False)
    r = s.propose_step("Open the filter flap", "manual", "manual p.32", "flap open")
    assert not r.allowed and r.code == "low_confidence"


def test_red_device_refused():
    s = RepairSession()
    r = s.identify_device("microwave oven")
    assert not r.allowed and r.code == "red_device"


def test_amber_needs_precautions_on_camera():
    s = diagnosed()
    r = s.propose_step("Open the drain filter flap at the bottom right", "manual", "manual p.32", "flap open")
    assert not r.allowed and r.code == "precautions_missing"
    assert not s.confirm_precaution("unplugged", verified_on_camera=False).allowed
    s.confirm_precaution("unplugged", verified_on_camera=True)
    s.confirm_precaution("protective_gear", verified_on_camera=True)
    s.confirm_precaution("water_shut_off", verified_on_camera=True)
    r = s.propose_step("Open the drain filter flap at the bottom right", "manual", "manual p.32", "flap open")
    assert r.allowed


def test_unsourced_model_specific_step_blocked():
    s = diagnosed()
    s.confirm_precaution("unplugged", True)
    s.confirm_precaution("protective_gear", True)
    r = s.propose_step("Remove the pump housing", "general_safe", "", "housing off")
    assert not r.allowed and r.code == "needs_source"


def test_unconfirmed_model_blocks_specific_steps():
    s = RepairSession()
    s.identify_device("bicycle", model_confirmed=False)
    s.record_history_answer("q", "a")
    s.record_history_answer("q2", "a2")
    s.set_diagnosis("chain off the big ring", 0.95, ["seen on camera"])
    r = s.propose_step("Shift to the smallest cog", "ifixit", "https://ifixit.com/x", "chain loose")
    assert not r.allowed and r.code == "model_unconfirmed"


def test_step_must_be_verified_before_next():
    s = diagnosed(BIKE)
    r = s.propose_step("Shift to the smallest rear cog", "manual", "Trek manual p.12", "chain on smallest cog")
    assert r.allowed
    sid = r.data["step_id"]
    r2 = s.propose_step("Lift the chain onto the ring", "manual", "Trek manual p.12", "chain on ring")
    assert not r2.allowed and r2.code == "step_open"
    assert s.report_step_result(sid, "user", True, "user says done").allowed  # green + reversible: ok
    assert s.propose_step("Lift the chain onto the ring", "manual", "Trek manual p.12", "chain on ring").allowed


def test_irreversible_flow():
    s = diagnosed(BIKE)
    r = s.propose_step("Cut the old cable tie", "manual", "Trek manual p.20", "tie removed")
    assert not r.allowed and r.code == "irreversible_needs_confirmation"
    sid = r.data["step_id"]
    assert s.confirm_irreversible_step(sid, "yes go ahead").code == "needs_photo"
    s.mark_photo_taken(sid)
    assert s.confirm_irreversible_step(sid, "hmm wait, not sure").code == "not_confirmed"
    assert s.confirm_irreversible_step(sid, "no").code == "not_confirmed"
    r = s.confirm_irreversible_step(sid, "Yes, go ahead")
    assert r.allowed
    # Irreversible steps need a camera check, not just the user's word.
    assert s.report_step_result(sid, "user", True, "done").code == "needs_camera"
    assert s.report_step_result(sid, "camera", True, "tie gone").allowed


def test_failed_step_returns_to_diagnosis():
    s = diagnosed(BIKE)
    sid = s.propose_step("Loosen the derailleur limit screw", "manual", "p.5", "screw loose").data["step_id"]
    r = s.report_step_result(sid, "camera", False, "there is no limit screw where the manual shows one")
    assert not r.allowed and r.code == "step_failed"


def test_hazard_stop_blocks_everything():
    s = diagnosed(BIKE)
    s.hazard("smoke")
    assert s.propose_step("anything", "manual", "p1", "x").code == "hazard_stop"


def test_general_safe_allowed_before_diagnosis():
    s = RepairSession()
    s.identify_device("desk fan")
    r = s.propose_step("Unplug the fan from the wall", "general_safe", "", "plug out")
    assert r.allowed


def test_escalation_package_and_persistence(tmp_path: Path):
    s = diagnosed()
    r = s.escalate("Models disagree")
    pkg = r.data["package"]
    assert pkg["device"]["model"] == "WAN28201GB" and pkg["stopped_because"] == "Models disagree"
    path = s.save(tmp_path)
    s2 = RepairSession.load(path)
    assert s2.diagnosis == s.diagnosis and s2.escalated


def test_first_step_needs_cross_check():
    s = diagnosed(BIKE, review=True)
    text = "Shift to the smallest rear cog"
    r = s.propose_step(text, "manual", "Trek manual p.12", "chain on smallest cog")
    assert r.code == "needs_review"
    s.record_review(text, "approve", "matches manual")
    assert s.propose_step(text, "manual", "Trek manual p.12", "chain on smallest cog").allowed


def test_cross_check_disagreement_blocks():
    s = diagnosed(BIKE, review=True)
    text = "Shift to the smallest rear cog"
    s.record_review(text, "revise", "manual shows a different derailleur")
    assert s.propose_step(text, "manual", "p.12", "x").code == "review_revise"
    s.record_review(text, "escalate", "frame looks cracked")
    assert s.propose_step(text, "manual", "p.12", "x").code == "review_escalate"


def test_cross_check_unavailable_fails_closed():
    s = diagnosed(BIKE, review=True)
    text = "Shift to the smallest rear cog"
    s.record_review(text, "unavailable", "no key")
    assert s.propose_step(text, "manual", "p.12", "x").code == "review_unavailable"


def test_later_green_reversible_step_skips_review():
    s = diagnosed(BIKE, review=True)
    first = "Shift to the smallest rear cog"
    s.record_review(first, "approve", "ok")
    sid = s.propose_step(first, "manual", "p.12", "x").data["step_id"]
    s.report_step_result(sid, "camera", True, "ok")
    assert not s.needs_review("Lift the chain onto the small ring", "manual")
    assert s.needs_review("Cut the cable tie", "manual")
