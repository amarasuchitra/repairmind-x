"""Design brief: what broke, how, and what the replacement must survive.

The bridge from a repair call to the design lab. A brief is built from the saved repair session,
completed by the person, checked here, and only then handed to the lab. The checks are code, not
model judgement:

* every dimension and load carries a unit (see :mod:`units`);
* the failure mode decides which analyses the redesign must pass (see :mod:`failure_modes`);
* anything the repair safety rules call red cannot be redesigned here, and life-critical parts
  (anything that holds a person up or holds pressure) need a qualified engineer's sign-off;
* estimates are listed as assumptions, so the lab and the reader know what was not measured.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from .. import safety
from ..safety import RiskLevel
from . import failure_modes, units

ValueSource = Literal["measured", "label", "spec", "user", "estimated", ""]
BRIEF_ID = re.compile(r"^brf-[0-9a-f]{12}$")
LAB_FIELD_MAX = 4000  # the design lab caps idea and context at 4000 characters each

# Parts whose failure can hurt someone even when the repair itself was safe. Redesigns of these
# are allowed as a draft, but are marked as needing a qualified engineer's sign-off.
LIFE_CRITICAL = (
    "ladder", "chair", "stool", "seat", "harness", "hoist", "lifting", "lift", "crane", "hook", "sling",
    "pressure vessel", "pressurised", "pressurized", "pressure cooker", "boiler", "helmet", "wheel", "axle",
    "steering", "suspension", "railing", "handrail", "balcony", "scaffold", "anchor", "bike frame",
    "bicycle frame", "fork", "handlebar", "pedal", "crank", "child", "baby", "cot", "crib", "stroller",
    "pram", "climbing", "carabiner", "tow", "jack", "bracket holding", "wall mount", "tv mount", "shelf bracket",
)


class Measure(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    value: str = Field(min_length=1, max_length=40, description='Number with unit, e.g. "12 mm"')
    source: ValueSource = ""


class DesignBrief(BaseModel):
    id: str = ""
    room: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    device: str = Field("", max_length=120)
    brand: str = Field("", max_length=60)
    model: str = Field("", max_length=60)

    part: str = Field("", max_length=120)
    part_function: str = Field("", max_length=400)
    observations: list[str] = Field(default_factory=list, max_length=30)
    diagnosis: str = Field("", max_length=400)
    failure_mode: str = failure_modes.UNKNOWN
    failure_mode_certainty: Literal["seen", "suspected", ""] = ""

    material: str = Field("", max_length=80)
    material_source: ValueSource = ""
    dimensions: list[Measure] = Field(default_factory=list, max_length=30)
    operating: list[Measure] = Field(default_factory=list, max_length=30)
    constraints: list[str] = Field(default_factory=list, max_length=20)
    manufacturing: str = Field("", max_length=120)
    safety_factor: float = Field(1.5, ge=1.0, le=10.0)

    share_to_library: bool = False


class Check(BaseModel):
    ready: bool
    blocked: str = ""
    needs_signoff: bool = False
    signoff_reason: str = ""
    errors: list[str] = []
    missing: list[str] = []
    assumptions: list[str] = []
    suggested_modes: list[dict] = []
    required_analyses: list[dict] = []
    quantities: dict[str, dict] = {}


def new_id() -> str:
    return f"brf-{secrets.token_hex(6)}"


def _text(b: DesignBrief) -> str:
    return " ".join([b.device, b.part, b.part_function, b.diagnosis, *b.observations]).lower()


def _life_critical(b: DesignBrief) -> str:
    t = " ".join([b.device, b.part, b.part_function]).lower()
    for w in LIFE_CRITICAL:
        if re.search(rf"(?<![a-z]){re.escape(w)}s?(?![a-z])", t):
            return w
    return ""


def check(b: DesignBrief) -> Check:
    """Validate a brief and say what the design lab will need. Never raises for bad user input."""
    errors: list[str] = []
    missing: list[str] = []
    assumptions: list[str] = []
    quantities: dict[str, dict] = {}

    for group, items, expect in (("dimension", b.dimensions, "length"), ("operating", b.operating, None)):
        for m in items:
            try:
                q = units.parse(m.value, expect=expect)
            except units.UnitError as e:
                errors.append(f"{m.name}: {e}")
                continue
            quantities[f"{group}:{m.name}"] = q.to_dict()
            if m.source in ("estimated", ""):
                assumptions.append(f"{m.name} = {m.value} is an estimate, not measured.")

    if not b.part.strip():
        missing.append("Which part failed")
    if not b.part_function.strip():
        missing.append("What the part has to do (hold, turn, seal, clip, carry heat...)")
    if b.failure_mode not in failure_modes.BY_ID:
        missing.append("How it failed (crack, snap, wear, heat, corrosion...)")
    elif b.failure_mode_certainty != "seen":
        assumptions.append(f"Failure mode '{failure_modes.BY_ID[b.failure_mode].name}' is suspected, not "
                           "confirmed from the break surface.")
    if not b.dimensions:
        missing.append("At least the main dimensions, with units")
    if not any(units.dimension_of(_unit_of(m.value)) in ("force", "torque", "pressure", "mass")
               for m in b.operating):
        missing.append("The load it carries (force, torque, pressure or weight), even a rough estimate")
    if not b.material.strip():
        missing.append("Material of the old part, or say unknown")
    elif b.material_source in ("estimated", ""):
        assumptions.append(f"Material '{b.material}' is a visual guess; its strength is uncertain.")

    a = safety.assess(_text(b))
    blocked = ""
    if a.level is RiskLevel.RED:
        blocked = ("This involves a red-level hazard (" + "; ".join(a.reasons) + "). RepairMind will not "
                   "design replacement parts for it. A qualified professional must handle it.")

    critical = _life_critical(b)
    signoff = (f"'{critical}' suggests the part may carry a person or hold pressure. The design can be "
               "drafted, but it must be checked and signed off by a qualified engineer before anyone makes "
               "or uses it.") if critical and not blocked else ""

    mode_ids = [b.failure_mode] if b.failure_mode in failure_modes.BY_ID else []
    analyses = failure_modes.required_analyses(mode_ids)
    return Check(
        ready=not errors and not blocked and bool(b.part.strip()) and bool(b.part_function.strip()),
        blocked=blocked,
        needs_signoff=bool(signoff),
        signoff_reason=signoff,
        errors=errors,
        missing=missing,
        assumptions=assumptions,
        suggested_modes=failure_modes.suggest(_text(b)),
        required_analyses=[{"id": x, "text": failure_modes.ANALYSES[x]} for x in analyses],
        quantities=quantities,
    )


def _unit_of(value: str) -> str:
    m = re.match(r"^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?\s*(.*)$", value, re.IGNORECASE)
    return m.group(1) if m else ""


def from_session(sess) -> DesignBrief:
    """Prefill a brief from a saved repair session (``RepairSession``)."""
    fp = getattr(sess, "failed_part", {}) or {}
    observations = [*sess.symptoms, *[f"Test: {t.description} -> {t.result}" for t in sess.tests],
                    *sess.diagnosis_evidence, *fp.get("observations", [])]
    b = DesignBrief(
        id=new_id(), room=sess.session_id, device=sess.device, brand=sess.brand,
        model=sess.model if sess.model_confirmed else "",
        part=fp.get("part", ""), part_function=fp.get("function", ""),
        observations=[o[:300] for o in observations][:30],
        diagnosis=sess.diagnosis, material=fp.get("material", ""),
        material_source=fp.get("material_source", "") if fp.get("material") else "",
        dimensions=[Measure(**d) for d in fp.get("dimensions", []) if _valid_measure(d)],
        operating=[Measure(**d) for d in fp.get("operating", []) if _valid_measure(d)],
    )
    mode = fp.get("failure_mode", "")
    if mode in failure_modes.BY_ID:
        b.failure_mode, b.failure_mode_certainty = mode, fp.get("certainty", "suspected")
    else:
        hits = failure_modes.suggest(_text(b), limit=1)
        if hits:
            b.failure_mode, b.failure_mode_certainty = hits[0]["id"], "suspected"
    return b


def _valid_measure(d: dict) -> bool:
    try:
        Measure(**d)
        return True
    except Exception:
        return False


def to_lab(b: DesignBrief, c: Check) -> dict:
    """The {idea, context} hand-off the design lab accepts (each at most 4000 characters)."""
    thing = " ".join(x for x in (b.brand, b.model) if x) or ""
    device = f"{b.device} ({thing})" if thing and b.device else (b.device or thing or "a device")
    mode = failure_modes.BY_ID.get(b.failure_mode)
    idea = f"Redesign the {b.part or 'failed part'} of {device} so it does not fail again. "
    if b.part_function:
        idea += f"It has to {b.part_function.rstrip('.')}. "
    if mode:
        idea += f"The old part failed by {mode.name.lower()} ({b.failure_mode_certainty or 'suspected'}). "
    if b.diagnosis:
        idea += f"Diagnosis from the repair call: {b.diagnosis.rstrip('.')}. "
    if c.required_analyses:
        idea += "The redesign must pass: " + "; ".join(a["text"].split(":")[0] for a in c.required_analyses) + "."

    # Most important first: the lab caps context at 4000 characters, so the tail is what gets cut.
    lines: list[str] = []
    if c.needs_signoff:
        lines.append("LIFE-CRITICAL: " + c.signoff_reason)
    lines.append(f"Design to a safety factor of {b.safety_factor:g} and report the margin of safety for each check.")
    if b.dimensions:
        lines.append("Dimensions of the old part: " + "; ".join(f"{m.name} {m.value}" for m in b.dimensions) + ".")
    if b.material:
        lines.append(f"Old material: {b.material}" + (f" ({b.material_source})" if b.material_source else "") + ".")
    if b.operating:
        lines.append("Operating conditions and loads: "
                     + "; ".join(f"{m.name} {m.value}" + (f" ({m.source})" if m.source else "") for m in b.operating)
                     + ".")
    if b.manufacturing:
        lines.append(f"Will be made by: {b.manufacturing}.")
    if c.assumptions:
        lines.append("Assumptions (not measured): " + " ".join(c.assumptions))
    if c.missing:
        lines.append("Still unknown: " + "; ".join(c.missing) + ".")
    if b.constraints:
        lines.append(("Constraints: " + "; ".join(x[:200] for x in b.constraints))[:1200] + ".")
    if mode:
        lines.append("Likely causes of this failure mode: " + "; ".join(mode.causes) + ".")
        lines.append("Known fixes to consider: " + "; ".join(mode.design_fixes) + ".")
    if b.observations:
        lines.append("Observations from the call: " + "; ".join(o[:200] for o in b.observations[:10]) + ".")
    return {"idea": idea[:LAB_FIELD_MAX], "context": "\n".join(lines)[:LAB_FIELD_MAX]}


# ------------------------------------------------------------------ storage
def brief_path(root: Path, brief_id: str) -> Path:
    if not BRIEF_ID.match(brief_id):
        raise ValueError("bad brief id")
    return root / "briefs" / f"{brief_id}.json"


def save(root: Path, b: DesignBrief) -> DesignBrief:
    now = time.time()
    if not b.id:
        b.id = new_id()
    if not b.created_at:
        b.created_at = now
    b.updated_at = now
    p = brief_path(root, b.id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(b.model_dump(), indent=2))
    return b


def load(root: Path, brief_id: str) -> DesignBrief | None:
    p = brief_path(root, brief_id)
    return DesignBrief(**json.loads(p.read_text())) if p.exists() else None
