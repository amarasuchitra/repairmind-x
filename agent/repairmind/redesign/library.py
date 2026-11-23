"""Failure library: what broke, how, on which device, and whether the fix held.

Only briefs the person chose to share are added. Records hold the engineering facts (device type,
part, failure mode, material, sizes, loads) and never the room, names, images or free-text
observations, which can contain personal details. One JSON object per line, rewritten whole on
update; fine for thousands of records, and easy to move to a database later.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Literal

from . import failure_modes
from .brief import DesignBrief

Outcome = Literal["pending", "holding", "failed_again"]
OUTCOMES = ("pending", "holding", "failed_again")
_lock = threading.Lock()


def _file(root: Path) -> Path:
    return root / "failure_library.jsonl"


def record_from(b: DesignBrief) -> dict:
    return {
        "brief_id": b.id,
        "added_at": round(time.time()),
        "device": b.device[:120],
        "brand": b.brand[:60],
        "model": b.model[:60],
        "part": b.part[:120],
        "function": b.part_function[:400],
        "failure_mode": b.failure_mode,
        "certainty": b.failure_mode_certainty,
        "diagnosis": b.diagnosis[:400],
        "material": b.material[:80],
        "dimensions": [m.model_dump() for m in b.dimensions],
        "operating": [m.model_dump() for m in b.operating],
        "outcome": "pending",
    }


def all_records(root: Path) -> list[dict]:
    f = _file(root)
    if not f.exists():
        return []
    out = []
    for line in f.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # one bad line never hides the rest
    return out


def _write(root: Path, records: list[dict]) -> None:
    f = _file(root)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    tmp.replace(f)


def add(root: Path, b: DesignBrief) -> dict:
    """Add or replace the record for this brief."""
    rec = record_from(b)
    with _lock:
        records = [r for r in all_records(root) if r.get("brief_id") != b.id]
        records.append(rec)
        _write(root, records)
    return rec


def set_outcome(root: Path, brief_id: str, outcome: str) -> dict | None:
    if outcome not in OUTCOMES:
        raise ValueError(f"outcome must be one of {OUTCOMES}")
    with _lock:
        records = all_records(root)
        hit = None
        for r in records:
            if r.get("brief_id") == brief_id:
                r["outcome"], r["outcome_at"] = outcome, round(time.time())
                hit = r
        if hit:
            _write(root, records)
    return hit


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def search(root: Path, query: str = "", mode: str = "", limit: int = 50) -> list[dict]:
    """Records matching every word of the query (in device, part, material, diagnosis), newest first."""
    want = _words(query)
    out = []
    for r in all_records(root):
        if mode and r.get("failure_mode") != mode:
            continue
        hay = _words(" ".join(str(r.get(k, "")) for k in ("device", "brand", "model", "part", "function",
                                                            "material", "diagnosis")))
        if want and not want <= hay:
            continue
        out.append(r)
    out.sort(key=lambda r: -r.get("added_at", 0))
    return out[:limit]


def stats(root: Path) -> dict:
    records = all_records(root)
    modes = Counter(r.get("failure_mode", "unknown") for r in records)
    return {
        "total": len(records),
        "by_mode": [{"id": m, "name": failure_modes.BY_ID[m].name if m in failure_modes.BY_ID else "Unknown",
                     "count": n} for m, n in modes.most_common()],
        "top_parts": [{"part": p, "count": n} for p, n in
                      Counter(r.get("part", "").lower() for r in records if r.get("part")).most_common(10)],
        "outcomes": dict(Counter(r.get("outcome", "pending") for r in records)),
    }
