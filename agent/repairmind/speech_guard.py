"""Checks what the mechanic actually SAID against what the gates allowed.

The live model is told to give a repair step only after propose_step allows it, but a model can still
say something it shouldn't. This guard reads every finished mechanic utterance and flags:

- red_instruction:      an instruction for a red-level job (e.g. "open the microwave cover");
- irreversible_unapproved: an irreversible action instructed without a confirmed, active step for it;
- ungated_step:         a hands-on repair instruction while no step is active at all.

The agent then interrupts and corrects itself out loud ("Hold on, don't do that yet...").
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from . import safety
from .safety import RiskLevel
from .session import RepairSession

ACTION_VERBS = (
    r"open|remove|unscrew|undo|loosen|disconnect|unplug the (?:ribbon|connector|cable)|detach|pull (?:out|off)|"
    r"lift (?:off|out)|take (?:off|out)|replace|install|insert|reconnect|cut|snip|pry|prise|lever|desolder|"
    r"solder|drill|glue|apply|heat|bend|discharge|press (?:out|in)|tighten|screw"
)
SAFE_ACTIONS = re.compile(
    r"^(unplug (it|the (device|machine|appliance|cable|power))|switch (it )?off|turn (it )?off|take a photo|"
    r"show me|point the camera|move the camera|hold it|step back|stop)", re.I)
IMPERATIVE = re.compile(
    rf"(?:^|[.!?]\s+)(?:(?:ok(?:ay)?|now|next|then|first|great|good|so|alright|please|go ahead and|you can|"
    rf"you'?ll want to|you need to|i need you to)[, ]+)*(?P<verb>{ACTION_VERBS})\b(?P<rest>[^.!?]*)",
    re.I)


@dataclass
class Violation:
    kind: str
    sentence: str
    detail: str


def _instructions(text: str) -> list[str]:
    out = []
    for m in IMPERATIVE.finditer(text):
        sentence = (m.group("verb") + m.group("rest")).strip()
        if not SAFE_ACTIONS.match(sentence):
            out.append(sentence)
    return out


def check(utterance: str, state: RepairSession) -> Violation | None:
    instructions = _instructions(utterance)
    if not instructions:
        return None
    active = state.current_step
    active_ok = active is not None and active.status == "active"
    for sentence in instructions:
        level = safety.assess(sentence, base=state.assessment).level
        if level is RiskLevel.RED:
            return Violation("red_instruction", sentence, "instruction for a red-level job")
        irr = safety.irreversible_actions(sentence)
        if irr and not (active_ok and active.irreversible and active.user_confirmed_irreversible):
            return Violation("irreversible_unapproved", sentence, ", ".join(irr))
        if not active_ok:
            return Violation("ungated_step", sentence, "no step is active")
    return None


CORRECTIONS = {
    "red_instruction": "Hold on, please don't do that. That part of the job is dangerous and needs a professional.",
    "irreversible_unapproved": "Hold on, don't do that yet. That step can't be undone, and we haven't checked it "
                               "properly. Let's confirm a couple of things first.",
    "ungated_step": "Sorry, hold on a second before you do that. Let me check that step properly first.",
}
