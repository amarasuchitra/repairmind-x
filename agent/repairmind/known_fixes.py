"""Learned shortcuts: remember fixes that worked, so a repeat fault on the same model goes faster.

A fix is remembered only when a call ends with the exact model confirmed, a diagnosis set, and every step
done and verified (on camera, or confirmed by the user). Next time the same model shows up, the mechanic is
told about it as a lead. It is never a shortcut past safety: the diagnosis gate still needs history and tests,
and every step still goes through propose_step, the second-opinion review and the camera checks. The win is
skipping the search for a guide and the guesswork about which fault it is.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from .session import RepairSession

MAX_FIXES = 500
_lock = threading.Lock()


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if len(w) > 2}


def store_path(directory: Path) -> Path:
    return directory / "known_fixes.json"


def load(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return [f for f in data if isinstance(f, dict)] if isinstance(data, list) else []


def _save(path: Path, fixes: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(fixes, indent=1), encoding="utf-8")
    os.replace(tmp, path)  # never a half-written file, even if the agent stops mid-write


def eligible(state: RepairSession) -> bool:
    return bool(state.model_confirmed and state.model and state.diagnosis and state.steps and not state.hazard_stop
                and not state.escalated and all(s.status == "done" and s.verified_by for s in state.steps))


def record(path: Path, state: RepairSession) -> bool:
    """Remember this call's fix if it qualifies. Returns True when something was stored or counted."""
    if not eligible(state):
        return False
    key = (_norm(state.brand), _norm(state.model), _norm(state.diagnosis))
    # the readings that settled it, so next time the deciding test can come first
    readings = [{"test": m["test"], "reading": m.get("detail") or m.get("observed", "")}
                for m in state.evidence.get("measurements", [])][-6:]
    steps = [{"text": s.text, "source_kind": s.source_kind, "source_ref": s.source_ref,
              "expected_result": s.expected_result, "irreversible": bool(s.irreversible)} for s in state.steps]
    with _lock:
        fixes = load(path)
        for f in fixes:
            if (_norm(f.get("brand", "")), _norm(f.get("model", "")), _norm(f.get("diagnosis", ""))) == key:
                if state.session_id in f.get("sessions", []):
                    return False  # the same call ending twice (resume) counts once
                f["worked"] = int(f.get("worked", 0)) + 1
                f["sessions"] = [*f.get("sessions", []), state.session_id][-20:]
                f["symptoms"] = list(dict.fromkeys([*f.get("symptoms", []), *state.symptoms]))[-12:]
                f["steps"], f["last"] = steps, time.time()  # the newest verified sequence wins
                if readings:
                    f["readings"] = readings
                break
        else:
            fixes.append({"brand": state.brand, "model": state.model, "device": state.device,
                          "diagnosis": state.diagnosis, "symptoms": list(state.symptoms)[-12:], "steps": steps,
                          "readings": readings,
                          "worked": 1, "sessions": [state.session_id], "last": time.time()})
        fixes.sort(key=lambda f: f.get("last", 0))
        _save(path, fixes[-MAX_FIXES:])
    return True


def lookup(path: Path, brand: str, model: str, symptoms: str = "", limit: int = 3) -> list[dict]:
    """Fixes for exactly this model, best symptom match first, then most proven."""
    b, m = _norm(brand), _norm(model)
    if not m:
        return []
    want = _words(symptoms)
    same = [f for f in load(path) if _norm(f.get("model", "")) == m and (not b or not f.get("brand")
                                                                      or _norm(f["brand"]) == b)]

    def score(f: dict) -> tuple:
        have = _words(" ".join([f.get("diagnosis", ""), *f.get("symptoms", [])]))
        return (len(want & have), int(f.get("worked", 0)), f.get("last", 0))

    return sorted(same, key=score, reverse=True)[:limit]


def similar(path: Path, device: str, symptoms: str, exclude_model: str = "", limit: int = 4) -> list[dict]:
    """What fixed similar symptoms on other models of the same kind of device: causes with how often they
    worked, best match first. This is how a repair on one model teaches the next, different one."""
    kind = _words(device)
    want = _words(symptoms)
    if not kind or not want:
        return []
    skip = _norm(exclude_model)
    by_cause: dict[str, dict] = {}
    for f in load(path):
        if skip and _norm(f.get("model", "")) == skip:
            continue
        if not kind & _words(f.get("device", "")):
            continue
        overlap = len(want & _words(" ".join(f.get("symptoms", []))))
        if overlap == 0:
            continue
        key = _norm(f.get("diagnosis", ""))
        agg = by_cause.setdefault(key, {"diagnosis": f.get("diagnosis", ""), "worked": 0, "models": [], "match": 0,
                                         "readings": []})
        agg["worked"] += int(f.get("worked", 1))
        agg["match"] = max(agg["match"], overlap)
        model = " ".join(x for x in (f.get("brand", ""), f.get("model", "")) if x)
        if model and model not in agg["models"]:
            agg["models"].append(model)
        agg["readings"] = agg["readings"] or f.get("readings", [])
    return sorted(by_cause.values(), key=lambda a: (a["match"], a["worked"]), reverse=True)[:limit]


def similar_for_model(found: list[dict]) -> str:
    if not found:
        return ""
    total = sum(a["worked"] for a in found) or 1
    out = ["On other models of this kind of device, these causes fixed similar symptoms (use the shares as starting "
           "confidences in update_hypotheses, then test; never skip the diagnosis gate):"]
    for a in found:
        out.append(f"- {a['diagnosis']}: fixed it {a['worked']} time{'s' if a['worked'] != 1 else ''} "
                   f"({round(100 * a['worked'] / total)}% of similar repairs; {', '.join(a['models'][:3])})")
        if a["readings"]:
            out.append("  the reading that settled it: " + "; ".join(f"{r['test']} -> {r['reading']}" for r in a["readings"][:2]))
    return "\n".join(out)


def for_model(fixes: list[dict]) -> str:
    if not fixes:
        return "No remembered fixes for this exact model yet. Diagnose as usual."
    out = ["Remembered fixes for this exact model (leads only: confirm the diagnosis with the usual history and "
           "tests first, then propose each step through propose_step with the same source, and check it as usual):"]
    for i, f in enumerate(fixes, 1):
        times = f"worked {f.get('worked', 1)} time" + ("s" if int(f.get("worked", 1)) != 1 else "")
        out.append(f"{i}. {f.get('diagnosis')} ({times}). Symptoms then: {'; '.join(f.get('symptoms', [])[:4]) or 'n/a'}.")
        for n, s in enumerate(f.get("steps", []), 1):
            src = s.get("source_kind", "") + (f" {s['source_ref']}" if s.get("source_ref") else "")
            out.append(f"   {n}) \"{s.get('text')}\" [source: {src}; expected: {s.get('expected_result', '')}]"
                       + (" IRREVERSIBLE" if s.get("irreversible") else ""))
        if f.get("readings"):
            out.append("   The readings that settled it last time (try that test first): "
                       + "; ".join(f"{r['test']} -> {r['reading']}" for r in f["readings"][:3]))
    return "\n".join(out)
