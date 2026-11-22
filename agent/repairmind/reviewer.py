"""Second-model cross-check (plan section 13, layer 5).

A different model from the one talking (Claude, while the live voice is Gemini) gets the same evidence
and answers three questions before the first repair step and before every amber or irreversible step:
is the diagnosis supported, is the step right for this exact model, and is anything unsafe or missing?

If the reviewer can't run (no key, network error, refusal), the result is "unavailable", and the
session treats that as NOT approved for steps that need review. It fails closed.
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, Field

from .session import RepairSession

log = logging.getLogger("repairmind.reviewer")

REVIEW_MODEL = os.getenv("RMX_REVIEW_MODEL", "claude-opus-5-5")

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
    if not os.getenv("ANTHROPIC_API_KEY") and not os.getenv("ANTHROPIC_AUTH_TOKEN"):
        return ReviewResult(status="unavailable", reason="No reviewer credentials configured.")
    try:
        import anthropic
    except ImportError:  # pragma: no cover
        return ReviewResult(status="unavailable", reason="anthropic package not installed.")

    content: list[dict] = []
    for b64 in (frames_jpeg_b64 or [])[:2]:
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}})
    content.append({"type": "text", "text": _evidence(state, step_text, source_kind, source_ref,
                                                      source_excerpt, expected_result)})
    try:
        client = anthropic.AsyncAnthropic(timeout=30.0, max_retries=1)
        response = await client.messages.parse(
            model=REVIEW_MODEL,
            max_tokens=4000,
            system=REVIEWER_SYSTEM,
            output_config={"effort": "high"},
            messages=[{"role": "user", "content": content}],
            output_format=Review,
        )
    except anthropic.APIConnectionError as e:
        return ReviewResult(status="unavailable", reason=f"Reviewer unreachable: {e}")
    except anthropic.APIStatusError as e:
        return ReviewResult(status="unavailable", reason=f"Reviewer error {e.status_code}")

    if response.stop_reason == "refusal":
        # A refused review is a strong signal: don't route around it, escalate.
        return ReviewResult(status="escalate", reason="The reviewer declined to assess this step.")
    review = response.parsed_output
    if review is None:
        return ReviewResult(status="unavailable", reason="Reviewer returned no verdict.")
    status = review.verdict
    # Belt and braces: an "approve" that contradicts its own checks is not an approval.
    if status == "approve" and (not review.diagnosis_supported or not review.step_matches_model_and_source
                                or review.safety_issues):
        status = "revise"
    return ReviewResult(status=status, reason=review.reason, details=review.model_dump())
