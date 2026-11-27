"""Test-first diagnosis: choose the measurement that tells the causes apart best, then update from the reading.

The mechanic states its causes with rough confidences (the priors). For each test it can think of, it says what
reading each cause would give. This module:

- picks the test with the most expected information per unit of effort (``plan``), and
- after the person reads the result, updates every cause by Bayes' rule (``posterior``).

Confidences shown to the person and used by the safety gates come from this arithmetic, not from how sure the
model sounds. A reading that no cause predicted raises the weight of "something we haven't thought of", which
is the honest answer when the list of causes is wrong.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field

# how often a reading disagrees with the cause that predicts it (meter error, a bad probe contact, a misread)
SLIP = 0.1
# the share kept for causes nobody has listed; never zero, so a surprise can always show up
OTHER_PRIOR = 0.1
OTHER = "something not on the list"


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


@dataclass
class TestPlan:
    test: str
    # cause -> the reading that cause would give
    expect: dict[str, str]
    cost: float = 1.0  # 1 = a quick look or one meter reading; 3 = opening a panel

    def outcomes(self) -> list[str]:
        return list(dict.fromkeys(self.expect.values()))


@dataclass
class Measurement:
    test: str
    expect: dict[str, str]
    observed: str  # one of the predicted readings, or "" for "none of them"
    detail: str = ""  # the raw reading as said, e.g. "4.9 V"


@dataclass
class Evidence:
    priors: dict[str, float] = field(default_factory=dict)
    measurements: list[Measurement] = field(default_factory=list)
    pending: TestPlan | None = None

    # ------------------------------------------------------------- arithmetic
    def _prior(self) -> dict[str, float]:
        total = sum(max(0.0, p) for p in self.priors.values())
        if total <= 0:
            return {OTHER: 1.0}
        out = {c: (1 - OTHER_PRIOR) * max(0.0, p) / total for c, p in self.priors.items()}
        out[OTHER] = OTHER_PRIOR
        return out

    def posterior(self) -> dict[str, float]:
        """Each cause's probability after every reading so far (OTHER included). Sums to 1."""
        p = self._prior()
        for m in self.measurements:
            p = update(p, m.expect, m.observed)
        return p

    def confidence(self, cause: str) -> float | None:
        """The evidence-backed probability of a cause, or None when it isn't a listed cause."""
        want = norm(cause)
        for c, v in self.posterior().items():
            if c != OTHER and norm(c) == want:
                return v
        return None

    def to_dict(self) -> dict:
        return {"priors": self.priors, "measurements": [asdict(m) for m in self.measurements],
                "pending": asdict(self.pending) if self.pending else None}

    @classmethod
    def from_dict(cls, raw: dict | None) -> "Evidence":
        raw = raw or {}
        pend = raw.get("pending")
        return cls(priors=dict(raw.get("priors", {})),
                   measurements=[Measurement(**m) for m in raw.get("measurements", [])],
                   pending=TestPlan(**pend) if pend else None)


def _likelihood(expect: dict[str, str], cause: str, observed: str, outcomes: list[str]) -> float:
    """P(observed | cause). A cause with no prediction for this test is treated as saying nothing about it."""
    k = max(2, len(outcomes) + 1)  # the listed readings plus "something else"
    said = next((v for c, v in expect.items() if norm(c) == norm(cause)), None)
    if said is None or cause == OTHER:
        return 1.0 / k
    if observed and norm(said) == norm(observed):
        return 1.0 - SLIP
    return SLIP / (k - 1)


def update(p: dict[str, float], expect: dict[str, str], observed: str) -> dict[str, float]:
    outcomes = list(dict.fromkeys(expect.values()))
    raw = {c: v * _likelihood(expect, c, observed, outcomes) for c, v in p.items()}
    total = sum(raw.values()) or 1.0
    return {c: v / total for c, v in raw.items()}


def entropy(p: dict[str, float]) -> float:
    return -sum(v * math.log2(v) for v in p.values() if v > 0)


def information(p: dict[str, float], plan: TestPlan) -> float:
    """Expected drop in uncertainty (bits) from running this test."""
    outcomes = plan.outcomes()
    before, after = entropy(p), 0.0
    for o in [*outcomes, ""]:  # "" = a reading none of the causes predicted
        po = sum(v * _likelihood(plan.expect, c, o, outcomes) for c, v in p.items())
        if po > 0:
            after += po * entropy(update(p, plan.expect, o))
    return max(0.0, before - after)


def plan(ev: Evidence, candidates: list[TestPlan]) -> list[tuple[TestPlan, float]]:
    """Candidates ranked by information per unit of effort, best first."""
    p = ev.posterior()
    scored = [(c, information(p, c) / max(0.25, c.cost)) for c in candidates if len(c.outcomes()) >= 2]
    return sorted(scored, key=lambda x: x[1], reverse=True)


def match_outcome(plan_: TestPlan, said: str) -> str:
    """Map what the mechanic says was read onto one of the predicted readings ("" if none fits)."""
    want = norm(said)
    if not want or want in {"none", "none of them", "none of these", "other", "something else"}:
        return ""
    for o in plan_.outcomes():
        if norm(o) == want:
            return o
    hits = [o for o in plan_.outcomes() if norm(o) and (norm(o) in want or want in norm(o))]
    return hits[0] if len(hits) == 1 else ""


def certainty(p: float) -> str:
    """The words to say for a probability, so every answer carries how sure it is."""
    if p >= 0.9:
        return "sure"
    if p >= 0.75:
        return "fairly sure"
    if p >= 0.5:
        return "leaning towards it, not sure yet"
    return "not sure yet, let's check"
