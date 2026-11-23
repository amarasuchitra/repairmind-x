"""How parts fail, and what each failure means for the redesign.

A part that passed a static strength check can still crack in a week. Which analyses a redesign needs
depends on how the old part failed, so the brief starts here. The signs and fixes are standard
engineering practice (fractography, wear and corrosion basics), written for a person looking at a part
through a phone camera. This is guidance for asking the right questions, never a verdict on its own.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Analyses the design lab or an engineer must run for a given failure. Stable ids.
ANALYSES: dict[str, str] = {
    "static_strength": "Static strength: peak stress against yield, with a margin of safety",
    "fatigue": "Fatigue life: stress range against the material's S-N curve for the expected cycles",
    "buckling": "Buckling: critical load of slender or thin-walled sections",
    "stiffness": "Stiffness: deflection under load against what the assembly tolerates",
    "thermal": "Thermal: steady temperature and thermal stress at the hottest operating point",
    "creep": "Creep: slow deformation under load at temperature (plastics, solder, hot metals)",
    "wear": "Wear: contact pressure and sliding speed against the material pair's wear rate",
    "corrosion": "Corrosion: material and coating for the environment, no dissimilar-metal contact",
    "impact": "Impact: energy of a drop or knock against toughness, at the lowest temperature",
    "vibration": "Vibration: natural frequencies kept away from the running speed",
    "electrical": "Electrical: current, voltage rating, insulation and heat in the conductor",
    "fit_tolerance": "Fits and tolerances: clearance or interference that holds over temperature",
}


@dataclass(frozen=True)
class FailureMode:
    id: str
    name: str
    signs: tuple[str, ...]          # what you see on camera
    causes: tuple[str, ...]
    analyses: tuple[str, ...]       # ANALYSES ids the redesign must pass
    design_fixes: tuple[str, ...]
    questions: tuple[str, ...]      # what to ask the person to tell this mode apart
    keywords: tuple[str, ...]       # words in a description that point to this mode


MODES: tuple[FailureMode, ...] = (
    FailureMode(
        "overload_fracture", "Overload fracture",
        ("Rough, grainy break surface", "Bent or stretched metal near the break (ductile)",
         "Clean snap with no beach marks (brittle plastic or cast metal)"),
        ("One load far above the design load: a drop, a jam, misuse", "Undersized section", "Brittle material"),
        ("static_strength", "impact"),
        ("Thicker section or deeper rib at the break", "Larger fillet radius at the corner", "Tougher material"),
        ("Did it break all at once, during one event?", "Was it dropped, jammed or forced?"),
        ("snapped", "snap", "broke suddenly", "overload", "dropped", "forced", "jammed", "bent", "shattered"),
    ),
    FailureMode(
        "fatigue", "Fatigue crack",
        ("Smooth zone with curved beach marks spreading from one point", "Small rough final-break zone",
         "Crack starting at a hole, sharp corner, thread or weld"),
        ("Repeated loading over many cycles", "Stress concentration at a sharp corner or hole",
         "Vibration", "Surface damage that starts a crack"),
        ("fatigue", "static_strength", "vibration"),
        ("Remove sharp corners: fillet radius at least the wall thickness", "Lower the stress range",
         "Move holes away from high-stress areas", "Material with a higher endurance limit"),
        ("Did it work for a long time and then fail during normal use?", "Does the part move, flex or vibrate?",
         "Roughly how many times a day is it used?"),
        ("fatigue", "crack", "cracked", "beach mark", "after years", "over time", "vibration", "repeated",
         "hairline"),
    ),
    FailureMode(
        "wear", "Wear",
        ("Polished, grooved or flattened contact surfaces", "Rounded gear teeth or worn splines",
         "Loose fit, play or rattling", "Fine powder or debris near the contact"),
        ("Sliding or rolling contact without enough lubrication", "Contact pressure too high",
         "Soft material against a hard one", "Dirt in the contact"),
        ("wear", "fit_tolerance"),
        ("Harder or self-lubricating material (e.g. POM, PTFE-filled nylon, bronze bushing)",
         "Larger contact area", "Add lubrication or a seal against dirt"),
        ("Does it feel loose or make grinding noises?", "Is it lubricated?"),
        ("worn", "wear", "stripped", "grooved", "rounded", "loose", "play", "grinding", "slipping", "teeth"),
    ),
    FailureMode(
        "corrosion", "Corrosion",
        ("Rust, white or green powder, pitting", "Metal thinned or eaten away",
         "Damage worst where two different metals touch or where water collects"),
        ("Moisture, salt or chemicals", "Two different metals in contact (galvanic)", "Damaged coating"),
        ("corrosion", "static_strength"),
        ("Corrosion-resistant material or coating", "Insulate dissimilar metals", "Drain holes, no water traps"),
        ("Is it used outdoors, in a bathroom or kitchen, or near salt?", "Do two different metals touch there?"),
        ("rust", "rusted", "corroded", "corrosion", "pitting", "green powder", "white powder", "oxidised",
         "oxidized"),
    ),
    FailureMode(
        "thermal", "Heat damage",
        ("Discoloured, melted, blistered or warped plastic", "Burn marks or a burnt smell",
         "Brittle, yellowed plastic near a heat source"),
        ("Operating temperature above the material's rating", "Poor ventilation", "Electrical overheating nearby"),
        ("thermal", "creep", "electrical"),
        ("Material rated above the hottest temperature with margin (check heat deflection temperature)",
         "Add airflow or a heat shield", "Move the part away from the heat source"),
        ("How hot does it get in use?", "Is there a motor, heater or power supply close by?"),
        ("melted", "burnt", "burned", "scorched", "warped", "discoloured", "discolored", "overheated", "hot",
         "blistered"),
    ),
    FailureMode(
        "creep", "Creep or permanent sagging",
        ("Part slowly sagged, stretched or lost its clamp force", "Loose screws in plastic bosses",
         "Gap that grew over months"),
        ("Constant load on plastic or at high temperature", "Plastic used where metal was needed"),
        ("creep", "stiffness", "thermal"),
        ("Lower the constant stress", "Metal insert for screws in plastic", "Glass-filled or higher-temp plastic"),
        ("Did it change shape slowly rather than break?",),
        ("sagged", "sagging", "creep", "stretched", "deformed slowly", "lost tension"),
    ),
    FailureMode(
        "buckling", "Buckling",
        ("Thin wall or strut folded or kinked sideways", "Crushed tube"),
        ("Compressive load on a slender or thin-walled section",),
        ("buckling", "stiffness"),
        ("Shorter or thicker strut", "Ribs or a closed section", "Material with higher stiffness"),
        ("Was it being squeezed or pushed along its length?",),
        ("buckled", "kinked", "folded", "crumpled", "crushed"),
    ),
    FailureMode(
        "electrical", "Electrical failure",
        ("Burnt trace, connector or wire", "Swollen or leaking capacitor", "Arc marks or melted insulation"),
        ("Current above the rating", "Loose connection heating up", "Voltage spikes", "Moisture"),
        ("electrical", "thermal"),
        ("Rate parts with margin for current and voltage", "Secure connections", "Add fusing or protection"),
        ("Was there a smell, a pop or a flash?", "Does it trip a breaker?"),
        ("short", "arc", "spark", "capacitor", "trace", "connector burnt", "fuse", "tripped"),
    ),
)

BY_ID = {m.id: m for m in MODES}
UNKNOWN = "unknown"


def _hits(mode: FailureMode, text: str) -> int:
    return sum(1 for k in mode.keywords if re.search(rf"(?<![a-z]){re.escape(k)}(?![a-z])", text))


def suggest(text: str, limit: int = 3) -> list[dict]:
    """Rank likely failure modes from a free-text description. Empty when nothing matches."""
    t = text.lower()
    scored = [(m, _hits(m, t)) for m in MODES]
    scored = [(m, h) for m, h in scored if h > 0]
    scored.sort(key=lambda x: -x[1])
    return [{"id": m.id, "name": m.name, "matches": h} for m, h in scored[:limit]]


def required_analyses(mode_ids: list[str]) -> list[str]:
    """Union of analyses for the given modes, in a stable order. Static strength is always included."""
    needed = {"static_strength"}
    for mid in mode_ids:
        if mid in BY_ID:
            needed.update(BY_ID[mid].analyses)
    return [a for a in ANALYSES if a in needed]


def catalog() -> list[dict]:
    return [{"id": m.id, "name": m.name, "signs": list(m.signs), "causes": list(m.causes),
             "analyses": list(m.analyses), "design_fixes": list(m.design_fixes), "questions": list(m.questions)}
            for m in MODES]
