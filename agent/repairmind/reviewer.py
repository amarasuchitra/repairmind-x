"""Second-model cross-check (plan section 13, layer 5).

A different model from the one talking gets the same evidence
and answers three questions before the first repair step and before every amber or irreversible step:
is the diagnosis supported, is the step right for this exact model, and is anything unsafe or missing?

The reviewer is Claude if ANTHROPIC_API_KEY is set, otherwise a separate Gemini model on the free tier
(see checker.py). If the reviewer can't run (no key, network error, quota), the result is "unavailable",
and the session treats that as NOT approved for steps that need review. It fails closed. A refusal
escalates.
"""

from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, Field

from . import checker
from .session import RepairSession

log = logging.getLogger("repairmind.reviewer")

REVIEWER_SYSTEM = """You are a senior repair technician reviewing a junior colleague's plan before they
tell a customer to do it. You see the evidence collected on a live call: device, model, symptoms,
history, tests, hypotheses, diagnosis, the source the step comes from, and optionally camera frames.

Be strict. Approve only if:
1. the diagnosis is supported by the evidence (not just plausible);
2. the step is correct for THIS exact model and matches the cited source;
3. nothing about it is unsafe, and no required safety precaution or prior step is missing.

If something is unclear, missing or contradicts the evidence, answer "revise" with what to check.
If the job is beyond safe DIY or the evidence can't support any confident step, answer "escalate".
Never invent facts that are not in the evidence."""


class Review(BaseModel):
    diagnosis_supported: bool
    step_matches_model_and_source: bool
    safety_issues: list[str] = Field(default_factory=list)
    missing_checks: list[str] = Field(default_factory=list)
    verdict: Literal["approve", "revise", "escalate"]
    reason: str


class ReviewResult(BaseModel):
    status: Literal["approve", "revise", "escalate", "unavailable"]
    reason: str
    details: dict = Field(default_factory=dict)


def _evidence(state: RepairSession, step_text: str, source_kind: str, source_ref: str,
              source_excerpt: str, expected_result: str) -> str:
    done = [f"- {s.text} (verified by {s.verified_by}: {s.observation})" for s in state.steps if s.status == "done"]
    return "\n".join([
        f"DEVICE: {state.device} | brand: {state.brand or '?'} | model: {state.model or '?'} "
        f"| model confirmed: {state.model_confirmed} ({state.identification_source})",
        f"RISK LEVEL: {state.risk_level}. Reasons: {'; '.join(state.risk_reasons) or 'none'}",
        f"PRECAUTIONS CONFIRMED ON CAMERA: {', '.join(state.precautions_confirmed) or 'none'}",
        "SYMPTOMS: " + ("; ".join(state.symptoms) or "none"),
        "HISTORY:\n" + ("\n".join(state.history_answers) or "none"),
        "TESTS:\n" + ("\n".join(f"- {t.description}: {t.result}" for t in state.tests) or "none"),
        "HYPOTHESES:\n" + ("\n".join(f"- {h.cause} ({h.confidence:.2f})" for h in state.hypotheses) or "none"),
        f"DIAGNOSIS: {state.diagnosis} (confidence {state.diagnosis_confidence:.2f}); evidence: "
        + "; ".join(state.diagnosis_evidence),
        "STEPS ALREADY DONE:\n" + ("\n".join(done) or "none"),
        "",
        f"PROPOSED NEXT STEP: {step_text}",
        f"EXPECTED RESULT: {expected_result}",
        f"SOURCE: {source_kind} {source_ref}",
        f"SOURCE EXCERPT:\n{source_excerpt or '(none provided)'}",
    ])


async def review_step(state: RepairSession, step_text: str, source_kind: str, source_ref: str,
                      source_excerpt: str, expected_result: str,
                      frames_jpeg_b64: list[str] | None = None) -> ReviewResult:
    if checker.provider() is None:
        return ReviewResult(status="unavailable", reason="No reviewer configured (set GOOGLE_API_KEY for the free "
                                                         "Gemini reviewer, or ANTHROPIC_API_KEY).")
    evidence = _evidence(state, step_text, source_kind, source_ref, source_excerpt, expected_result)
    res = await checker.parse(REVIEWER_SYSTEM, (frames_jpeg_b64 or [])[:2], evidence, Review, "review",
                              effort="high")
    if res.refused:
        # A refused review is a strong signal: don't route around it, escalate.
        return ReviewResult(status="escalate", reason="The reviewer declined to assess this step.")
    if res.error:
        return ReviewResult(status="unavailable", reason="Reviewer unavailable: " + res.error)
    review = res.parsed
    if not isinstance(review, Review):
        return ReviewResult(status="unavailable", reason="Reviewer returned no verdict.")
    status = review.verdict
    # Belt and braces: an "approve" that contradicts its own checks is not an approval.
    if status == "approve" and (not review.diagnosis_supported or not review.step_matches_model_and_source
                                or review.safety_issues):
        status = "revise"
    return ReviewResult(status=status, reason=review.reason, details=review.model_dump())
