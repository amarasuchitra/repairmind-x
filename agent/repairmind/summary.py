"""Session copilot: automatic notes and a repair summary for every call.

Built only from what the session actually recorded (the gates, the event log and the steps), never from the
model's memory, so the summary can't claim a step was done or checked when it wasn't. It is rewritten in the
background while the call runs (see SummaryWriter), so it is ready the moment the call ends, and survives a
dropped call.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from . import safety
from .session import RepairSession

log = logging.getLogger("repairmind.summary")

# Which log events become a note, and how. Anything else stays in the full session file only.
_NOTE = {
    "identify_device": lambda d, st: f"Device: {' '.join(x for x in (d.get('brand'), d.get('model')) if x) or d.get('device', '')}"
                                     + (" (model confirmed)" if d.get("confirmed") else ""),
    "symptom": lambda d, st: f"Symptom: {d.get('text', '')}",
    "test": lambda d, st: f"Test: {d.get('description', '')}: {d.get('result', '')}",
    "diagnosis": lambda d, st: f"Diagnosis: {d.get('cause', '')}",
    "precaution": lambda d, st: f"Safety check done: {safety.PRECAUTION_TEXT.get(d.get('id', ''), d.get('id', ''))}",
    "step_active": lambda d, st: f"Step started: {d.get('text', '')}",
    "irreversible_confirmed": lambda d, st: f"You confirmed a step that can't be undone: {st.get(d.get('id'), '')}",
    "step_done": lambda d, st: f"Step done ({'checked on camera' if d.get('by') == 'camera' else 'confirmed by you'}): {st.get(d.get('id'), '')}",
    "step_failed": lambda d, st: f"Step didn't work: {st.get(d.get('id'), '')}. {d.get('obs', '')}",
    "failed_part": lambda d, st: f"Broken part recorded: {d.get('part', '')}",
    "hazard_stop": lambda d, st: f"STOPPED for danger: {d.get('detail', '')}",
    "hazard_cleared": lambda d, st: "Danger cleared, repair resumed",
    "escalate": lambda d, st: f"Handed to a human expert: {d.get('reason', '')}",
    "circle_ask": lambda d, st: f"You asked about a circled part: {(d.get('question') or '(by voice)').rstrip('.')}"
                                + (f" Answer: {d['answer']}" if d.get("answer") else ""),
    "known_fix": lambda d, st: f"Found a fix that worked before on this model: {d.get('diagnosis', '')}",
    "part_search": lambda d, st: f"Searched shops for a part: {d.get('query', '')}",
    "speech_guard": lambda d, st: "The mechanic corrected itself after saying something the safety rules don't allow",
}



def _when(t: float, start: float) -> str:
    s = max(0, int(t - start))
    return f"{s // 60:02d}:{s % 60:02d}"


def notes(state: RepairSession, limit: int = 200) -> list[dict]:
    """A readable timeline of the call: time since start, and one plain line per thing that happened."""
    out = []
    step_text = {s.id: s.text for s in state.steps}
    for e in state.log:
        fn = _NOTE.get(e.get("event", ""))
        if fn is None:
            continue
        try:
            text = " ".join(str(fn(e, step_text)).split()).rstrip(": .")
            at = _when(float(e.get("t", state.created_at)), state.created_at)
        except Exception:  # an odd log entry must not break the summary
            continue
        if text and (not out or out[-1]["text"] != text):
            out.append({"at": at, "text": text[:300]})
    return out[-limit:]


def outcome(state: RepairSession) -> tuple[str, str]:
    """(code, plain words) for how the repair stands."""
    steps = state.steps
    if state.hazard_stop:
        return "stopped", "Stopped for safety: " + state.hazard_stop
    if state.escalated:
        return "escalated", "Handed to a human expert" + (f": {state.escalation_reason}" if state.escalation_reason else "")
    if steps and all(s.status == "done" for s in steps):
        return "fixed", "All repair steps done and checked"
    if any(s.status == "failed" for s in steps):
        return "needs_attention", "A step didn't go as expected"
    if steps:
        done = sum(s.status == "done" for s in steps)
        return "in_progress", f"In progress: {done} of {len(steps)} steps done"
    if state.diagnosis:
        return "diagnosed", "Diagnosed, no repair steps started"
    return "started", "Still working out what's wrong"


def build(state: RepairSession) -> dict:
    code, words = outcome(state)
    end = max([state.created_at, *(e["t"] for e in state.log if isinstance(e.get("t"), (int, float)))])
    device = " ".join(x for x in (state.brand, state.model) if x) or state.device
    steps = [{"n": i + 1, "text": s.text, "status": s.status, "source": s.source_ref or s.source_kind,
              "checked": {"camera": "checked on camera", "user": "confirmed by you"}.get(s.verified_by or "", ""),
              "observation": s.observation, "irreversible": s.irreversible} for i, s in enumerate(state.steps)]
    open_steps = [s for s in steps if s["status"] not in ("done",)]
    next_time = []
    if state.hazard_stop:
        next_time.append("Don't continue until the danger is gone and the device has been checked.")
    if open_steps and not state.hazard_stop:
        next_time.append(f"Pick up at step {open_steps[0]['n']}: {open_steps[0]['text']}")
    if state.device and not state.model_confirmed:
        next_time.append("Show the rating label so the exact model can be confirmed.")
    if state.failed_part:
        next_time.append(f"The broken {state.failed_part.get('part', 'part')} can be redesigned in the design lab.")
    return {
        "session_id": state.session_id,
        "started": time.strftime("%Y-%m-%d %H:%M", time.localtime(state.created_at)),
        "minutes": round((end - state.created_at) / 60, 1),
        "device": device,
        "model_confirmed": state.model_confirmed,
        "outcome": code,
        "outcome_text": words,
        "symptoms": list(state.symptoms),
        "diagnosis": state.diagnosis,
        "confidence": round(state.diagnosis_confidence, 2),
        "evidence": list(state.diagnosis_evidence),
        "tests": [{"description": t.description, "result": t.result} for t in state.tests],
        "risk_level": state.risk_level,
        "precautions": [{"text": safety.PRECAUTION_TEXT.get(p, p), "done": p in state.precautions_confirmed}
                        for p in state.precautions_required],
        "steps": steps,
        "failed_part": state.failed_part.get("part", "") if state.failed_part else "",
        "parts": [{"part": p.get("part", ""), "number": p.get("number", ""), "links": p.get("links", [])}
                  for p in state.parts],
        "next_time": next_time,
        "notes": notes(state),
    }


def to_markdown(s: dict) -> str:
    lines = [f"# Repair summary: {s['device'] or 'unidentified device'}", "",
             f"**Outcome:** {s['outcome_text']}  ", f"**When:** {s['started']}, about {s['minutes']} minutes  ",
             f"**Safety level:** {s['risk_level']}", ""]
    if s["symptoms"]:
        lines += ["## What was wrong", *[f"- {x}" for x in s["symptoms"]], ""]
    if s["diagnosis"]:
        lines += ["## Diagnosis", f"{s['diagnosis']} ({round(s['confidence'] * 100)}% sure)", *[f"- {x}" for x in s["evidence"]], ""]
    if s["tests"]:
        lines += ["## Tests", *[f"- {t['description']}: {t['result']}" for t in s["tests"]], ""]
    if s["precautions"]:
        lines += ["## Safety checks", *[f"- [{'x' if p['done'] else ' '}] {p['text']}" for p in s["precautions"]], ""]
    if s["steps"]:
        lines += ["## Steps"]
        for st in s["steps"]:
            extra = "; ".join(x for x in (st["checked"], f"source: {st['source']}" if st["source"] else "",
                                          "can't be undone" if st["irreversible"] else "") if x)
            lines.append(f"{st['n']}. [{st['status']}] {st['text']}" + (f" ({extra})" if extra else ""))
        lines.append("")
    if s.get("parts"):
        lines += ["## Parts to look for"]
        for p in s["parts"]:
            links = ", ".join(f"[{lk['shop']}]({lk['url']})" for lk in p["links"])
            lines.append(f"- {p['part']}" + (f" ({p['number']})" if p["number"] else "") + f": {links}")
        lines += ["", "_Check the part number on the old part before buying._", ""]
    if s["next_time"]:
        lines += ["## Next time", *[f"- {x}" for x in s["next_time"]], ""]
    if s["notes"]:
        lines += ["## Call notes", *[f"- {n['at']} {n['text']}" for n in s["notes"]], ""]
    lines.append("_Written automatically from what was recorded during the call._")
    return "\n".join(lines) + "\n"


def paths(directory: Path, session_id: str) -> tuple[Path, Path]:
    return directory / f"{session_id}.summary.json", directory / f"{session_id}.summary.md"


def write(state: RepairSession, directory: Path) -> dict:
    s = build(state)
    directory.mkdir(parents=True, exist_ok=True)
    pj, pm = paths(directory, state.session_id)
    pj.write_text(json.dumps(s, indent=2), encoding="utf-8")
    pm.write_text(to_markdown(s), encoding="utf-8")
    return s


class SummaryWriter:
    """Rewrites the summary in the background a moment after things change, never more than once per `delay`."""

    def __init__(self, state: RepairSession, directory: Path, delay: float = 2.0):
        self.state, self.directory, self.delay = state, directory, delay
        self._task: asyncio.Task | None = None

    def touch(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._later())

    async def _later(self) -> None:
        await asyncio.sleep(self.delay)
        await self.flush()

    async def flush(self) -> dict | None:
        try:
            return await asyncio.to_thread(write, self.state, self.directory)
        except Exception:
            log.exception("summary write failed")
            return None
