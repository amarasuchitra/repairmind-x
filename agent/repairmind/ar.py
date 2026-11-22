"""Rules for the live AR overlay.

The app keeps the mechanic's marker on the real part as the camera moves (tracking runs on the phone).
Two rules live here so they can be tested without a call:

- Motion arrows (turn, press, pull...) are instructions, so they may only be drawn for the step the
  gates have already made active. Pointing at a part without an arrow is always allowed.
- When the phone loses the part, the mechanic re-finds it on a fresh frame, but only a few times per
  target and not too often, so a lost view can't turn into a loop of vision calls.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from .session import RepairSession

ACTIONS = {"", "press", "pull", "lift", "turn_cw", "turn_ccw", "slide_left", "slide_right"}
MAX_REFINDS = 3
REFIND_GAP_S = 4.0


def gate_action(state: RepairSession, action: str) -> tuple[str, str, str]:
    """Return (action to draw, step id it belongs to, note for the model)."""
    action = (action or "").strip().lower()
    if action not in ACTIONS:
        return "", "", f" Unknown action '{action}', so no motion arrow was drawn."
    if not action:
        return "", "", ""
    if state.hazard_stop:
        return "", "", " No motion arrow during a hazard stop."
    active = next((s for s in state.steps if s.status == "active"), None)
    if active is None:
        return "", "", (" No motion arrow drawn: there is no active approved step. Propose the step first; "
                        "pointing alone is fine.")
    return action, active.id, ""


@dataclass
class ARTarget:
    marker_id: int
    description: str
    label: str
    action: str = ""
    step_id: str = ""
    refinds: int = 0
    last_refind: float = field(default=0.0)

    def may_refind(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return self.refinds < MAX_REFINDS and now - self.last_refind >= REFIND_GAP_S

    def note_refind(self, now: float | None = None) -> None:
        self.refinds += 1
        self.last_refind = time.monotonic() if now is None else now
