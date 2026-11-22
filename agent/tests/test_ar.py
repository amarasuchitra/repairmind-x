from repairmind import ar
from repairmind.session import RepairSession, Step


def session_with_step(status: str) -> RepairSession:
    s = RepairSession()
    s.steps.append(Step(id="s1", text="Turn the cap clockwise", source_kind="general_safe", source_ref="",
                        risk="green", irreversible=[], expected_result="cap off", status=status))
    return s


def test_pointing_without_arrow_always_allowed():
    assert ar.gate_action(RepairSession(), "") == ("", "", "")


def test_arrow_needs_an_active_step():
    action, step, note = ar.gate_action(RepairSession(), "turn_cw")
    assert (action, step) == ("", "") and "no active approved step" in note
    for status in ("pending", "awaiting_confirmation", "done", "blocked"):
        assert ar.gate_action(session_with_step(status), "turn_cw")[0] == ""
    assert ar.gate_action(session_with_step("active"), "TURN_CW")[:2] == ("turn_cw", "s1")


def test_no_arrow_during_hazard_or_unknown_action():
    s = session_with_step("active")
    assert ar.gate_action(s, "smash")[0] == ""
    s.hazard_stop = "smoke"
    assert ar.gate_action(s, "press")[0] == ""


def test_refind_is_rate_limited():
    t = ar.ARTarget(1, "the blade cap", "cap")
    now = 100.0
    assert t.may_refind(now)
    t.note_refind(now)
    assert not t.may_refind(now + 1)
    assert t.may_refind(now + ar.REFIND_GAP_S)
    for i in range(1, ar.MAX_REFINDS):
        t.note_refind(now + 10 * i)
    assert not t.may_refind(now + 1000)
