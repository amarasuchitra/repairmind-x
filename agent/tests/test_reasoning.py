"""Test-first diagnosis, the circuit simulator, repair memory across models, and the gates around them."""

from pathlib import Path

import pytest

from repairmind import known_fixes
from repairmind.reasoning import circuit
from repairmind.reasoning import evidence as ev
from repairmind.session import Hypothesis, RepairSession, Step

LAMP = [
    {"id": "BAT", "type": "V", "a": "vin", "b": "0", "value": 5},
    {"id": "F1", "type": "F", "a": "vin", "b": "f"},
    {"id": "R1", "type": "R", "a": "f", "b": "led", "value": 220},
    {"id": "D1", "type": "LED", "a": "led", "b": "0", "vf": 2.0},
]


# ----------------------------------------------------------------------------------------------- simulator
def test_healthy_circuit_voltages():
    rep = circuit.report(LAMP, [])
    assert rep["healthy"]["vin"] == 5.0 and rep["healthy"]["f"] == pytest.approx(5.0, abs=0.01)
    assert rep["healthy"]["led"] == pytest.approx(2.0, abs=0.05)  # LED forward drop


def test_dead_led_is_found_from_two_readings():
    rep = circuit.report(LAMP, [{"node": "vin", "volts": 5.0}, {"node": "led", "volts": 5.0}])
    assert rep["ranked"][0]["fault"].startswith("D1 open") and rep["ranked"][0]["fits"]
    assert not next(r for r in rep["ranked"] if r["part"] == "")["fits"]  # the healthy circuit doesn't explain it


def test_cut_off_node_reads_zero_like_a_real_meter():
    rep = circuit.report(LAMP, [{"node": "vin", "volts": 5.0}, {"node": "led", "volts": 0.0}])
    tops = {r["part"] for r in rep["ranked"] if r["fits"]}
    assert {"F1", "R1", "D1"} <= tops
    # the probe point that splits a blown fuse from the rest is the fuse's far side
    assert rep["probe"]["node"] == "f"
    assert rep["probe"]["expect"]["F1 blown"] == pytest.approx(0.0, abs=0.05)


def test_mains_is_refused():
    with pytest.raises(circuit.Refused):
        circuit.report([{"type": "V", "a": "l", "b": "0", "value": 230}, {"type": "R", "a": "l", "b": "0", "value": 1e3}], [])


def test_bad_netlists_are_explained():
    with pytest.raises(ValueError, match="no supply"):
        circuit.parse([{"type": "R", "a": "a", "b": "0", "value": 10}])
    with pytest.raises(ValueError, match="unknown part"):
        circuit.parse([{"type": "V", "a": "a", "b": "0", "value": 5}, {"type": "Q", "a": "a", "b": "0"}])


# ----------------------------------------------------------------------------------------------- evidence
def test_bayes_update_and_best_test():
    e = ev.Evidence(priors={"blown fuse": 0.5, "dead LED": 0.5})
    good = ev.TestPlan("meter on fuse far side", {"blown fuse": "0 V", "dead LED": "5 V"})
    useless = ev.TestPlan("meter on battery", {"blown fuse": "5 V", "dead LED": "5 V"})
    slow = ev.TestPlan("take the LED out and test it", {"blown fuse": "lights", "dead LED": "dark"}, cost=3)
    ranked = ev.plan(e, [useless, slow, good])
    assert ranked[0][0] is good  # same information as the slow test, a third of the effort
    e.measurements.append(ev.Measurement(good.test, good.expect, "0 V"))
    post = e.posterior()
    assert post["blown fuse"] > 0.8 and post["dead LED"] < 0.1


def test_unpredicted_reading_moves_weight_to_unknown():
    e = ev.Evidence(priors={"a": 0.5, "b": 0.5})
    t = ev.TestPlan("t", {"a": "0 V", "b": "5 V"})
    for _ in range(2):
        e.measurements.append(ev.Measurement(t.test, t.expect, ""))
    assert e.posterior()[ev.OTHER] > 0.3


def test_outcome_matching_and_words():
    t = ev.TestPlan("t", {"a": "0 V", "b": "5 V"})
    assert ev.match_outcome(t, "0 v") == "0 V" and ev.match_outcome(t, "none of these") == ""
    assert ev.certainty(0.95) == "sure" and ev.certainty(0.3).startswith("not sure")


# --------------------------------------------------------------------------------------- session + gates
def session_with_causes() -> RepairSession:
    s = RepairSession(review_required=False)
    s.identify_device("desk lamp", "Acme", "L1", model_confirmed=True, source="label")
    s.record_history_answer("What happened?", "It stopped lighting")
    s.record_history_answer("Anything change?", "Nothing")
    s.update_hypotheses([Hypothesis("blown fuse", 0.5), Hypothesis("dead LED", 0.5)])
    return s


def test_planned_reading_updates_confidences_and_counts_as_a_test():
    s = session_with_causes()
    r = s.plan_tests([ev.TestPlan("Meter on the fuse's far side", {"blown fuse": "0 V", "dead LED": "5 V"})])
    assert r.allowed and s.ui_state()["next_test"]["test"].startswith("Meter")
    r = s.record_measurement("0 V", "0.02 V")
    assert r.allowed and s.hypotheses[0].cause == "blown fuse" and s.hypotheses[0].confidence > 0.8
    assert s.tests and s.tests[-1].result == "0.02 V" and s.ui_state()["next_test"] is None
    assert "fairly sure" in r.say or "sure" in r.say


def test_restating_a_number_cannot_inflate_a_tested_cause():
    s = session_with_causes()
    s.plan_tests([ev.TestPlan("t", {"blown fuse": "0 V", "dead LED": "5 V"})])
    s.record_measurement("5 V")
    before = next(h.confidence for h in s.hypotheses if h.cause == "blown fuse")
    s.update_hypotheses([Hypothesis("blown fuse", 0.99), Hypothesis("dead LED", 0.01)])
    assert next(h.confidence for h in s.hypotheses if h.cause == "blown fuse") == pytest.approx(before)


def test_diagnosis_confidence_is_capped_by_the_readings_so_steps_stay_blocked():
    s = session_with_causes()
    s.plan_tests([ev.TestPlan("t", {"blown fuse": "0 V", "dead LED": "5 V"})])
    s.record_measurement("5 V")  # points at the LED
    s.update_hypotheses([Hypothesis("dead LED", 0.5), Hypothesis("blown fuse", 0.5), Hypothesis("loose wire", 0.0)])
    r = s.set_diagnosis("blown fuse", 0.95, ["it's dark"])
    assert not r.allowed  # the readings don't support it, whatever the model says
    assert s.diagnosis_confidence < 0.75
    step = s.propose_step("Replace the fuse with the same rating", "manual", "p.4", "fuse holder empty")
    assert not step.allowed


def test_irreversible_tests_are_not_planned():
    s = session_with_causes()
    r = s.plan_tests([ev.TestPlan("Cut the LED leg to test it", {"blown fuse": "lights", "dead LED": "dark"})])
    assert not r.allowed and r.code == "no_useful_test"


def test_measurement_without_a_plan_is_refused():
    s = session_with_causes()
    assert s.record_measurement("0 V").code == "no_pending_test"


def test_evidence_survives_save_and_load(tmp_path: Path):
    s = session_with_causes()
    s.plan_tests([ev.TestPlan("t", {"blown fuse": "0 V", "dead LED": "5 V"})])
    s.record_measurement("0 V")
    back = RepairSession.load(s.save(tmp_path))
    assert back.ev.measurements and back.hypotheses[0].cause == "blown fuse"


# ----------------------------------------------------------------------------------------------- memory
def finished(model: str, diagnosis: str, symptoms: list[str], reading: tuple[str, str] | None = None) -> RepairSession:
    s = RepairSession(review_required=False)
    s.identify_device("desk lamp", "Acme", model, model_confirmed=True, source="label")
    s.symptoms = symptoms
    s.diagnosis = diagnosis
    if reading:
        s.evidence = {"priors": {}, "measurements": [{"test": reading[0], "expect": {}, "observed": "0 V",
                                                      "detail": reading[1]}], "pending": None}
    s.steps = [Step("s1", "Replace it", "manual", "p1", "green", [], "lights", status="done", verified_by="camera")]
    return s


def test_memory_teaches_other_models(tmp_path: Path):
    store = known_fixes.store_path(tmp_path)
    assert known_fixes.record(store, finished("L1", "blown fuse", ["lamp dark, no light"], ("meter on fuse", "0 V")))
    assert known_fixes.record(store, finished("L2", "blown fuse", ["no light at all"]))
    assert known_fixes.record(store, finished("L3", "dead LED", ["light dark sometimes"]))
    found = known_fixes.similar(store, "desk lamp", "no light", exclude_model="L9")
    assert found[0]["diagnosis"] == "blown fuse" and found[0]["worked"] == 2
    text = known_fixes.similar_for_model(found)
    assert "meter on fuse -> 0 V" in text
    exact = known_fixes.for_model(known_fixes.lookup(store, "Acme", "L1", "dark"))
    assert "try that test first" in exact


def test_memory_ignores_other_kinds_of_device(tmp_path: Path):
    store = known_fixes.store_path(tmp_path)
    known_fixes.record(store, finished("L1", "blown fuse", ["no light"]))
    assert known_fixes.similar(store, "washing machine", "no light") == []
