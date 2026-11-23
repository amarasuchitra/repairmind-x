"""Repair session state and the gates that keep the mechanic from guessing.

The agent's tools call into :class:`RepairSession`. Every gate returns a
:class:`GateResult` that tells the model exactly what it may say next, so the
rules from the plan (diagnose first, confidence threshold, sourced steps,
precautions, irreversible-step confirmation, step checks) are enforced in code.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

from . import safety
from .safety import Assessment, RiskLevel

# Confidence needed before the mechanic may instruct. Set conservatively for the
# MVP; Phase 2 tunes these from the evaluation set.
THRESHOLD_GREEN = 0.75
THRESHOLD_AMBER = 0.85
THRESHOLD_IRREVERSIBLE = 0.90

MIN_HISTORY_QUESTIONS = 2
MIN_SAFE_TESTS_BEFORE_IRREVERSIBLE = 1

SourceKind = Literal["ifixit", "manual", "label", "general_safe", "procedure"]
VerifyKind = Literal["camera", "user"]
StepStatus = Literal["pending", "awaiting_confirmation", "active", "done", "failed", "blocked"]


@dataclass
class GateResult:
    allowed: bool
    say: str
    code: str = "ok"
    data: dict = field(default_factory=dict)

    def for_model(self) -> str:
        prefix = "ALLOWED" if self.allowed else f"BLOCKED ({self.code})"
        extra = f" DATA: {json.dumps(self.data)}" if self.data else ""
        return f"{prefix}. {self.say}{extra}"


@dataclass
class Hypothesis:
    cause: str
    confidence: float
    evidence_for: list[str] = field(default_factory=list)
    evidence_against: list[str] = field(default_factory=list)


@dataclass
class SafeTest:
    description: str
    result: str


@dataclass
class Step:
    id: str
    text: str
    source_kind: SourceKind
    source_ref: str
    risk: str
    irreversible: list[str]
    expected_result: str
    status: StepStatus = "pending"
    verified_by: VerifyKind | None = None
    observation: str = ""
    photo_taken: bool = False
    user_confirmed_irreversible: bool = False
    vision_verified: bool = False
    vision_attempts: int = 0
    created_at: float = field(default_factory=time.time)


@dataclass
class RepairSession:
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    created_at: float = field(default_factory=time.time)

    device: str = ""
    brand: str = ""
    model: str = ""
    model_confirmed: bool = False
    identification_source: str = ""

    symptoms: list[str] = field(default_factory=list)
    history_answers: list[str] = field(default_factory=list)
    tests: list[SafeTest] = field(default_factory=list)
    hypotheses: list[Hypothesis] = field(default_factory=list)

    diagnosis: str = ""
    diagnosis_confidence: float = 0.0
    diagnosis_evidence: list[str] = field(default_factory=list)

    risk_level: str = "green"
    risk_reasons: list[str] = field(default_factory=list)
    precautions_required: list[str] = field(default_factory=list)
    precautions_confirmed: list[str] = field(default_factory=list)

    steps: list[Step] = field(default_factory=list)
    expert_product_id: str = ""
    failed_part: dict = field(default_factory=dict)  # for the redesign brief; see record_failed_part
    reviews: dict = field(default_factory=dict)  # normalised step text -> {"status", "reason"}
    review_required: bool = True
    hazard_stop: str = ""
    escalated: bool = False
    escalation_reason: str = ""
    log: list[dict] = field(default_factory=list)

    # ------------------------------------------------------------------ utils
    @property
    def assessment(self) -> Assessment:
        return Assessment(
            level=RiskLevel[self.risk_level.upper()],
            reasons=list(self.risk_reasons),
            precautions=list(self.precautions_required),
        )

    def _apply_assessment(self, a: Assessment) -> None:
        self.risk_level = a.level.label
        self.risk_reasons = a.reasons
        self.precautions_required = a.precautions

    def _record(self, event: str, **data) -> None:
        self.log.append({"t": round(time.time(), 2), "event": event, **data})

    def _reassess(self, *texts: str) -> Assessment:
        a = self.assessment
        a.matched_rules = []
        for t in texts:
            a = safety.assess(t, base=a)
        self._apply_assessment(a)
        return a

    @property
    def current_step(self) -> Step | None:
        for s in self.steps:
            if s.status in ("active", "awaiting_confirmation"):
                return s
        return None

    def _step(self, step_id: str) -> Step | None:
        return next((s for s in self.steps if s.id == step_id), None)

    # ------------------------------------------------------------- diagnosis
    def identify_device(self, device: str, brand: str = "", model: str = "",
                        model_confirmed: bool = False, source: str = "") -> GateResult:
        self.device, self.brand, self.model = device.strip(), brand.strip(), model.strip()
        self.model_confirmed = bool(model_confirmed and self.model)
        self.identification_source = source
        a = self._reassess(device, brand, model)
        self._record("identify_device", device=device, brand=brand, model=model,
                     confirmed=self.model_confirmed, level=a.level.label)

        if a.level is RiskLevel.RED:
            return GateResult(False, safety.red_refusal_message(a), "red_device", a.to_dict())
        msg = f"Device recorded as {self.device}" + (f" ({self.brand} {self.model})" if self.model else "") + "."
        if not self.model_confirmed:
            msg += (" The exact model is NOT confirmed. Ask the user to show the rating label or say the model "
                    "number. Until then give only general, non-model-specific guidance.")
        if a.level is RiskLevel.AMBER:
            msg += " This is an AMBER-level device. Precautions will be required before any repair step: " + \
                   "; ".join(safety.PRECAUTION_TEXT[p] for p in a.precautions)
        return GateResult(True, msg, data={"risk": a.to_dict()})

    def record_symptom(self, symptom: str) -> GateResult:
        self.symptoms.append(symptom)
        a = self._reassess(symptom)
        self._record("symptom", text=symptom)
        if a.level is RiskLevel.RED:
            return GateResult(False, safety.red_refusal_message(a), "red_symptom", a.to_dict())
        return GateResult(True, "Symptom recorded.")

    def record_history_answer(self, question: str, answer: str) -> GateResult:
        self.history_answers.append(f"Q: {question} A: {answer}")
        a = self._reassess(answer)
        self._record("history", q=question, a=answer)
        if a.level is RiskLevel.RED:
            return GateResult(False, safety.red_refusal_message(a), "red_history", a.to_dict())
        return GateResult(True, "Answer recorded.")

    def record_test(self, description: str, result: str) -> GateResult:
        self.tests.append(SafeTest(description, result))
        self._record("test", description=description, result=result)
        return GateResult(True, "Test result recorded. Update the hypotheses with it.")

    def update_hypotheses(self, hypotheses: list[Hypothesis]) -> GateResult:
        self.hypotheses = sorted(hypotheses, key=lambda h: h.confidence, reverse=True)
        self._record("hypotheses", items=[asdict(h) for h in self.hypotheses])
        return GateResult(True, "Hypotheses updated.")

    def set_diagnosis(self, cause: str, confidence: float, evidence: list[str]) -> GateResult:
        confidence = max(0.0, min(1.0, float(confidence)))
        problems: list[str] = []
        if not self.device:
            problems.append("identify the device first")
        if len(self.history_answers) < MIN_HISTORY_QUESTIONS:
            problems.append(f"ask at least {MIN_HISTORY_QUESTIONS} history questions (what happened, when, "
                            "what changed, sounds, smells, error codes, what was already tried)")
        if not evidence:
            problems.append("give the visible or test evidence that supports this cause")
        if len(self.hypotheses) >= 2:
            top, second = self.hypotheses[0], self.hypotheses[1]
            if top.confidence - second.confidence < 0.2:
                problems.append(f"the top two causes ('{top.cause}' and '{second.cause}') are too close; "
                                "run another safe test to separate them")
        if problems:
            self._record("diagnosis_blocked", cause=cause, problems=problems)
            return GateResult(False, "Not ready to conclude. You must: " + "; ".join(problems) + ".",
                              "diagnosis_not_ready")

        self.diagnosis, self.diagnosis_confidence, self.diagnosis_evidence = cause, confidence, evidence
        a = self._reassess(cause)
        self._record("diagnosis", cause=cause, confidence=confidence, evidence=evidence)
        if a.level is RiskLevel.RED:
            return GateResult(False, safety.red_refusal_message(a), "red_diagnosis", a.to_dict())
        if confidence < THRESHOLD_GREEN:
            return GateResult(False, f"Diagnosis recorded with confidence {confidence:.2f}, below the "
                              f"{THRESHOLD_GREEN:.2f} needed to instruct. Tell the user what you suspect and why, "
                              "say you are not sure yet, and gather more evidence or offer to escalate.",
                              "low_confidence")
        return GateResult(True, f"Diagnosis recorded ({confidence:.2f}). Explain it to the user: what you think, "
                          "why, and how sure you are, before proposing any step.")

    # ------------------------------------------------------------ redesign
    def record_failed_part(self, part: str, function: str, failure_mode: str, certainty: str,
                           observations: list[str], material: str = "", material_source: str = "",
                           dimensions: list[dict] | None = None, operating: list[dict] | None = None) -> GateResult:
        """Note the broken part for a redesign brief. Sizes and loads must carry units."""
        from .redesign import failure_modes, units  # local: keeps the call's import path unchanged

        if not part.strip():
            return GateResult(False, "Say which part failed.", "missing_part")
        if failure_mode not in failure_modes.BY_ID and failure_mode != failure_modes.UNKNOWN:
            return GateResult(False, "failure_mode must be one of: " + ", ".join(failure_modes.BY_ID)
                              + ", unknown.", "bad_mode")
        bad: list[str] = []
        kept: dict[str, list[dict]] = {"dimensions": [], "operating": []}
        for key, items, expect in (("dimensions", dimensions or [], "length"), ("operating", operating or [], None)):
            for d in items:
                name, value = str(d.get("name", "")).strip()[:80], str(d.get("value", "")).strip()[:40]
                try:
                    units.parse(value, expect=expect)
                except units.UnitError as e:
                    bad.append(f"{name or 'value'}: {e}")
                    continue
                kept[key].append({"name": name or "value", "value": value,
                                  "source": d.get("source", "") if d.get("source") in
                                  ("measured", "label", "spec", "user", "estimated") else ""})
        self.failed_part = {
            "part": part.strip()[:120], "function": function.strip()[:400], "failure_mode": failure_mode,
            "certainty": "seen" if certainty == "seen" else "suspected",
            "observations": [o[:300] for o in observations][:10], "material": material.strip()[:80],
            "material_source": material_source if material_source in ("label", "user", "estimated") else "",
            **kept,
        }
        self._record("failed_part", part=part, mode=failure_mode)
        msg = "Broken part recorded for a redesign brief."
        if bad:
            msg += " These values were left out because of their units, ask again with a unit: " + "; ".join(bad)
        return GateResult(True, msg, data={"skipped": bad} if bad else {})

    # ------------------------------------------------------------ precautions
    def confirm_precaution(self, precaution_id: str, verified_on_camera: bool) -> GateResult:
        if precaution_id not in safety.PRECAUTION_TEXT:
            return GateResult(False, f"Unknown precaution. Valid ids: {list(safety.PRECAUTION_TEXT)}", "bad_id")
        if not verified_on_camera:
            return GateResult(False, "Precautions must be seen on camera. Ask the user to show it: "
                              + safety.PRECAUTION_TEXT[precaution_id], "needs_camera")
        if precaution_id not in self.precautions_confirmed:
            self.precautions_confirmed.append(precaution_id)
        self._record("precaution", id=precaution_id)
        return GateResult(True, "Precaution confirmed.")

    def missing_precautions(self) -> list[str]:
        return [p for p in self.precautions_required if p not in self.precautions_confirmed]

    # ---------------------------------------------------------------- reviews
    @staticmethod
    def _key(text: str) -> str:
        return re.sub(r"\W+", " ", text.lower()).strip()

    def needs_review(self, text: str, source_kind: str) -> bool:
        """Second-model cross-check before the first real step and every amber or irreversible step.
        Steps from a human-reviewed expert procedure skip it, unless they are irreversible."""
        if not self.review_required or source_kind == "general_safe":
            return False
        if source_kind == "procedure":
            return bool(safety.irreversible_actions(text))
        first_real = not any(s.source_kind != "general_safe" for s in self.steps)
        level = safety.assess(text, base=self.assessment).level
        return first_real or level >= RiskLevel.AMBER or bool(safety.irreversible_actions(text))

    def record_review(self, text: str, status: str, reason: str) -> None:
        self.reviews[self._key(text)] = {"status": status, "reason": reason}
        self._record("review", text=text, status=status, reason=reason)

    # ------------------------------------------------------------------ steps
    def propose_step(self, text: str, source_kind: SourceKind, source_ref: str,
                     expected_result: str) -> GateResult:
        """Gate a repair step before the mechanic says it."""
        if self.hazard_stop:
            return GateResult(False, "A hazard stop is active. " + safety.HAZARD_STOP_MESSAGE, "hazard_stop")
        if self.escalated:
            return GateResult(False, "This session was handed to a human expert. Do not give repair steps.",
                              "escalated")
        cur = self.current_step
        if cur is not None:
            return GateResult(False, f"Step '{cur.text}' is not finished. Check its result on camera first.",
                              "step_open", {"step_id": cur.id})
        if not self.diagnosis:
            # Universal, low-risk actions (unplug, take a photo) are allowed while diagnosing.
            if source_kind != "general_safe":
                return GateResult(False, "No diagnosis yet. Finish diagnosing before giving repair steps. "
                                  "Only general_safe actions (like unplugging or taking a photo) are allowed now.",
                                  "no_diagnosis")

        step_assessment = safety.assess(text, base=self.assessment)
        irreversible = safety.irreversible_actions(text)
        level = step_assessment.level

        if level is RiskLevel.RED:
            self._apply_assessment(step_assessment)
            self._record("step_blocked_red", text=text)
            return GateResult(False, safety.red_refusal_message(step_assessment), "red_step",
                              step_assessment.to_dict())

        if source_kind == "general_safe" and (irreversible or level is RiskLevel.AMBER and
                                              any(k in text.lower() for k in ("open", "remove", "unscrew", "disassemble"))):
            return GateResult(False, "This step is not a universal safe action. It needs a real source "
                              "(iFixit guide, manufacturer manual or device label).", "needs_source")
        procedure_precautions: list[str] = []
        if source_kind == "procedure":
            check, procedure_precautions = self._check_procedure_step(text, source_ref)
            if check is not None:
                return check
        if source_kind in ("ifixit", "manual", "label") and not source_ref.strip():
            return GateResult(False, "Give the source reference (guide URL or manual page) for this step.",
                              "needs_source_ref")
        if source_kind != "general_safe" and not self.model_confirmed and source_kind != "label":
            return GateResult(False, "The exact model is not confirmed, so model-specific steps are not allowed. "
                              "Ask the user to show the rating label or tell you the model number.",
                              "model_unconfirmed")

        needed = THRESHOLD_GREEN
        if level is RiskLevel.AMBER:
            needed = THRESHOLD_AMBER
        if irreversible:
            needed = max(needed, THRESHOLD_IRREVERSIBLE)
        if source_kind != "general_safe" and self.diagnosis_confidence < needed:
            return GateResult(False, f"Confidence {self.diagnosis_confidence:.2f} is below the {needed:.2f} "
                              "required for this step. Gather more evidence, or offer a human expert.",
                              "low_confidence", {"needed": needed})

        self._apply_assessment(step_assessment)
        for pc in procedure_precautions:
            if pc not in self.precautions_required:
                self.precautions_required.append(pc)
        missing = self.missing_precautions()
        if missing and source_kind != "general_safe":
            return GateResult(False, "Before this step the user must do these, and you must see them on camera: "
                              + "; ".join(safety.PRECAUTION_TEXT[p] for p in missing),
                              "precautions_missing", {"missing": missing})

        if self.needs_review(text, source_kind):
            review = self.reviews.get(self._key(text))
            if review is None:
                return GateResult(False, "This step needs the second-model cross-check first.", "needs_review")
            if review["status"] == "unavailable":
                return GateResult(False, "The cross-check is unavailable, so this step can't be given. Tell the "
                                  "user, and offer a human expert. Reason: " + review["reason"], "review_unavailable")
            if review["status"] == "escalate":
                return GateResult(False, "The reviewer says this needs a human expert: " + review["reason"]
                                  + " Call escalate.", "review_escalate")
            if review["status"] != "approve":
                return GateResult(False, "The reviewer disagreed: " + review["reason"] + " Gather what it asks "
                                  "for, then try again. Do not pick a side.", "review_revise")

        step = Step(id=f"s{len(self.steps) + 1}", text=text, source_kind=source_kind, source_ref=source_ref,
                    risk=level.label, irreversible=irreversible, expected_result=expected_result)
        self.steps.append(step)

        if irreversible:
            step.status = "awaiting_confirmation"
            self._record("step_irreversible_pending", id=step.id, text=text, actions=irreversible)
            return GateResult(
                False,
                "This step CANNOT BE UNDONE (" + ", ".join(irreversible) + "). Before giving it: "
                "1) say plainly that it can't be undone and what happens if it goes wrong; "
                "2) re-check the diagnosis still holds; 3) ask if a reversible test could confirm it first; "
                "4) have the user photograph the current state (cables, screws) and call mark_photo_taken; "
                "5) wait for an explicit spoken 'yes, go ahead' and call confirm_irreversible_step.",
                "irreversible_needs_confirmation", {"step_id": step.id, "actions": irreversible})

        step.status = "active"
        self._record("step_active", id=step.id, text=text)
        return GateResult(True, f"Give this step now, then ask to see the result. Expected: {expected_result}",
                          data={"step_id": step.id})

    def _check_procedure_step(self, text: str, source_ref: str) -> tuple[GateResult | None, list[str]]:
        from .expert import products

        product = products.load_all().get(self.expert_product_id) if self.expert_product_id else None
        if product is None:
            return GateResult(False, "No expert product is active for this device.", "no_expert_product"), []
        resolved = product.step(source_ref)
        if resolved is None:
            return GateResult(False, "Unknown procedure step reference. Use 'product/procedure#step'.", "bad_ref"), []
        proc, pstep = resolved
        if not proc.reviewed and not products.allow_unreviewed():
            return GateResult(False, "That procedure has not been reviewed by a qualified technician.",
                              "procedure_unreviewed"), []
        if self._key(text) != self._key(pstep.text):
            return GateResult(False, "Say the procedure step exactly as written: " + pstep.text,
                              "procedure_text_mismatch"), []
        return None, list(pstep.precautions)

    def mark_photo_taken(self, step_id: str) -> GateResult:
        s = self._step(step_id)
        if not s:
            return GateResult(False, "Unknown step id.", "bad_id")
        s.photo_taken = True
        self._record("photo", id=step_id)
        return GateResult(True, "Photo noted.")

    def confirm_irreversible_step(self, step_id: str, user_words: str) -> GateResult:
        s = self._step(step_id)
        if not s or s.status != "awaiting_confirmation":
            return GateResult(False, "No irreversible step is waiting for confirmation with that id.", "bad_id")
        if not s.photo_taken:
            return GateResult(False, "Have the user photograph the current state first.", "needs_photo")
        words = user_words.lower()
        said_yes = re.search(r"\b(yes|yeah|yep|go ahead|do it|proceed|confirm(ed)?)\b", words)
        said_no = re.search(r"\b(no|nope|wait|stop|hold on|not sure|don'?t|cancel)\b", words)
        if not said_yes or said_no:
            return GateResult(False, "That is not a clear yes. Ask again and wait for an explicit 'yes, go ahead'.",
                              "not_confirmed")
        if len(self.tests) < MIN_SAFE_TESTS_BEFORE_IRREVERSIBLE:
            return GateResult(False, "Run at least one safe, reversible test that supports the diagnosis before "
                              "an irreversible step.", "needs_test")
        s.user_confirmed_irreversible = True
        s.status = "active"
        self._record("irreversible_confirmed", id=step_id, words=user_words)
        return GateResult(True, f"Confirmed. Give the step carefully and slowly: {s.text}. Expected: "
                          f"{s.expected_result}", data={"step_id": s.id})

    def record_vision_check(self, step_id: str, status: str, observation: str) -> GateResult:
        s = self._step(step_id)
        if not s or s.status != "active":
            return GateResult(False, "No active step with that id.", "bad_id")
        s.vision_attempts += 1
        self._record("vision_check", id=step_id, status=status, obs=observation)
        if status == "done":
            s.vision_verified = True
            return GateResult(True, "Camera check passed on two frames.")
        if status == "not_done":
            return GateResult(False, "The camera shows the step is not done correctly: " + observation,
                              "vision_not_done")
        if status == "unavailable":
            return GateResult(False, "The camera check can't run right now. For a green step, ask the user to "
                              "confirm; for anything riskier, stop and offer a human expert.", "vision_unavailable")
        if s.vision_attempts >= 3:
            return GateResult(False, "Still unclear after three tries. Don't guess: offer a human expert.",
                              "vision_unclear_escalate")
        return GateResult(False, "Unclear: " + observation + " Ask for a closer, steadier, better-lit view "
                          "of the area, then check again.", "vision_unclear")

    def report_step_result(self, step_id: str, verified_by: VerifyKind, passed: bool,
                           observation: str) -> GateResult:
        s = self._step(step_id)
        if not s or s.status != "active":
            return GateResult(False, "No active step with that id.", "bad_id")
        if passed and verified_by == "camera" and (s.risk != "green" or s.irreversible) and not s.vision_verified:
            return GateResult(False, "Run check_step_on_camera first: risky and irreversible steps need the "
                              "two-frame camera check to pass.", "needs_vision_check")
        if passed and verified_by == "user" and (s.risk != "green" or s.irreversible):
            return GateResult(False, "This step must be checked on camera, not just by the user saying it's done. "
                              "Ask them to show it clearly.", "needs_camera")
        s.verified_by, s.observation = verified_by, observation
        if passed:
            s.status = "done"
            self._record("step_done", id=step_id, by=verified_by, obs=observation)
            return GateResult(True, "Step verified. Briefly say what you saw, then move on.")
        s.status = "failed"
        self._record("step_failed", id=step_id, obs=observation)
        return GateResult(False, "The result doesn't match. Stop, describe what you see, and go back to "
                          "diagnosis. If anything unexpected appeared (a broken clip, a different layout), "
                          "do not improvise; re-check the source or escalate.", "step_failed")

    # ------------------------------------------------------- hazards & handoff
    def hazard(self, detail: str) -> GateResult:
        self.hazard_stop = detail
        for s in self.steps:
            if s.status in ("active", "awaiting_confirmation"):
                s.status = "blocked"
        self._record("hazard_stop", detail=detail)
        return GateResult(False, safety.HAZARD_STOP_MESSAGE, "hazard_stop")

    def clear_hazard(self, user_words: str) -> GateResult:
        if not self.hazard_stop:
            return GateResult(True, "No hazard stop is active.")
        self._record("hazard_cleared", words=user_words)
        self.hazard_stop = ""
        return GateResult(True, "Hazard cleared by the user. Re-check the device on camera before continuing.")

    def escalate(self, reason: str) -> GateResult:
        self.escalated = True
        self.escalation_reason = reason
        self._record("escalate", reason=reason)
        return GateResult(True, "Escalation package prepared. Tell the user a human expert will get the full "
                          "history, photos and tests, and what they should do meanwhile (keep it unplugged).",
                          data={"package": self.escalation_package()})

    def escalation_package(self) -> dict:
        return {
            "session_id": self.session_id,
            "device": {"type": self.device, "brand": self.brand, "model": self.model,
                       "model_confirmed": self.model_confirmed},
            "symptoms": self.symptoms,
            "history": self.history_answers,
            "tests": [asdict(t) for t in self.tests],
            "hypotheses": [asdict(h) for h in self.hypotheses],
            "diagnosis": {"cause": self.diagnosis, "confidence": self.diagnosis_confidence,
                          "evidence": self.diagnosis_evidence},
            "risk": {"level": self.risk_level, "reasons": self.risk_reasons},
            "steps": [asdict(s) for s in self.steps],
            "stopped_because": self.escalation_reason or self.hazard_stop,
        }

    # ------------------------------------------------------------ persistence
    def ui_state(self) -> dict:
        """The compact view the web app renders (checklist, risk banner, diagnosis)."""
        return {
            "session_id": self.session_id,
            "device": " ".join(x for x in (self.brand, self.model) if x) or self.device,
            "device_type": self.device,
            "model_confirmed": self.model_confirmed,
            "risk_level": self.risk_level,
            "risk_reasons": self.risk_reasons,
            "precautions": [{"id": p, "text": safety.PRECAUTION_TEXT[p], "done": p in self.precautions_confirmed}
                            for p in self.precautions_required],
            "diagnosis": self.diagnosis,
            "confidence": self.diagnosis_confidence,
            "hypotheses": [{"cause": h.cause, "confidence": h.confidence} for h in self.hypotheses[:3]],
            "steps": [{"id": s.id, "text": s.text, "status": s.status, "risk": s.risk,
                       "irreversible": s.irreversible, "source": s.source_ref or s.source_kind,
                       "cross_checked": self.reviews.get(self._key(s.text), {}).get("status") == "approve"}
                      for s in self.steps],
            "hazard": self.hazard_stop,
            "expert_product": self.expert_product_id,
            "escalated": self.escalated,
        }

    def save(self, directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{self.session_id}.json"
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
        return path

    @classmethod
    def load(cls, path: Path) -> "RepairSession":
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["tests"] = [SafeTest(**t) for t in raw.get("tests", [])]
        raw["hypotheses"] = [Hypothesis(**h) for h in raw.get("hypotheses", [])]
        raw["steps"] = [Step(**s) for s in raw.get("steps", [])]
        return cls(**raw)
