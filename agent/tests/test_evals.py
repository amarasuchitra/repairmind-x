"""The idea test set is well-formed and the scorer rewards what a strong answer contains."""

from typing import get_args

from repairmind import evals
from repairmind.lab.schema import Brief, Feasibility
from tests.test_lab_understand import brief

VERDICTS = set(get_args(Feasibility.model_fields["verdict"].annotation))


def test_fifty_ideas_with_valid_expectations():
    ideas = evals.load_ideas()
    assert len(ideas) == 50
    assert len({c["id"] for c in ideas}) == 50
    for c in ideas:
        assert len(c["idea"]) >= 8 and c["verdicts"] and set(c["verdicts"]) <= VERDICTS, c["id"]
        assert all(isinstance(g, list) and g for g in c["must"]), c["id"]
    assert sum(1 for c in ideas if c.get("refuse")) == 1
    assert sum(1 for c in ideas if "beyond_known_physics" in c["verdicts"]) >= 4


def strong() -> Brief:
    b = brief()
    b.feasibility.path.append(b.feasibility.path[0].model_copy(update={"name": "Field system", "kind": "build"}))
    b.riskiest.statement = "A surface pump can't lift from 10 m (suction limit); we need a submersible"
    b.feasibility.deciding_numbers = ["1000 kg x 9.81 m/s^2 x 10 m = 98 kJ = 27 Wh per day"]
    return b


def test_strong_answer_scores_full_marks():
    case = next(c for c in evals.load_ideas() if c["id"] == "solar-pump-10m")
    s = evals.score(case, strong())
    assert s.pct == 100.0, s.misses


def test_weak_answer_loses_points_with_reasons():
    case = next(c for c in evals.load_ideas() if c["id"] == "solar-pump-10m")
    b = strong()
    b.feasibility.verdict = "beyond_known_physics"
    b.feasibility.path = []
    b.feasibility.deciding_numbers = ["it is fine"]
    b.riskiest.statement = b.riskiest.pass_if = "works"
    s = evals.score(case, b)
    assert s.pct < 50
    assert any("verdict" in m for m in s.misses) and any("numbers" in m for m in s.misses)


def test_refusal_case_and_errors():
    case = next(c for c in evals.load_ideas() if c.get("refuse"))
    assert evals.score(case, strong()).pct == 0
    b = strong()
    b.feasibility.path, b.concepts = [], []
    assert evals.score(case, b).pct == 100
    assert evals.score(case, None, "overloaded").error == "overloaded"


def test_compare_reports_regressions():
    a = evals.summary([evals.Score("x", 90), evals.Score("y", 50)])
    b = evals.summary([evals.Score("x", 60), evals.Score("y", 70)])
    lines = evals.compare(b, a)
    assert "Worse: x 90.0->60.0" in " ".join(lines) and "Better: y" in " ".join(lines)
    assert evals.compare(a, None)[0].startswith("First run")
