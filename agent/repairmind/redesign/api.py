"""HTTP endpoints for the repair-to-design bridge: design briefs and the failure library."""

from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..session import RepairSession
from . import brief as briefs
from . import failure_modes, library
from .brief import DesignBrief

router = APIRouter(prefix="/api/redesign")
ROOM_RE = re.compile(r"^rmx-[a-z0-9]{8,32}$")


def _sessions() -> Path:
    from ..agent import SESSIONS_DIR  # late import keeps this module light for tests

    return Path(os.getenv("RMX_SESSIONS_DIR", str(SESSIONS_DIR)))


def _root() -> Path:
    return Path(os.getenv("RMX_REDESIGN_ROOT", str(_sessions())))


def _answer(b: DesignBrief) -> dict:
    return {"brief": b.model_dump(), "check": briefs.check(b).model_dump()}


def _get(brief_id: str) -> DesignBrief:
    try:
        b = briefs.load(_root(), brief_id)
    except ValueError:
        b = None
    if b is None:
        raise HTTPException(404, "No such design brief.")
    return b


class FromSession(BaseModel):
    room: str


class OutcomeRequest(BaseModel):
    outcome: library.Outcome


@router.get("/failure-modes")
def modes() -> dict:
    return {"modes": failure_modes.catalog(), "analyses": failure_modes.ANALYSES}


@router.post("/briefs/from-session")
def from_session(req: FromSession) -> dict:
    """Start a brief from a finished or dropped repair call."""
    if not ROOM_RE.match(req.room):
        raise HTTPException(400, "Unknown repair session.")
    path = _sessions() / f"{req.room}.json"
    if not path.exists():
        raise HTTPException(404, "That repair call has no saved notes yet.")
    try:
        sess = RepairSession.load(path)
    except Exception:
        raise HTTPException(422, "The saved notes for that call couldn't be read.")
    return _answer(briefs.save(_root(), briefs.from_session(sess)))


@router.post("/briefs")
def save_brief(b: DesignBrief) -> dict:
    """Create a brief, or update one by id. Server-owned fields are kept."""
    if b.id:
        old = _get(b.id)
        b.created_at, b.room = old.created_at, old.room
    else:
        b.created_at, b.room = 0.0, ""
    if b.failure_mode not in failure_modes.BY_ID:
        b.failure_mode = failure_modes.UNKNOWN
    return _answer(briefs.save(_root(), b))


@router.get("/briefs/{brief_id}")
def get_brief(brief_id: str) -> dict:
    return _answer(_get(brief_id))


@router.post("/briefs/{brief_id}/lab")
def to_lab(brief_id: str) -> dict:
    """The {idea, context} the design lab takes. Refused while the brief is blocked or incomplete."""
    b = _get(brief_id)
    c = briefs.check(b)
    if c.blocked:
        raise HTTPException(409, c.blocked)
    if not c.ready:
        problems = c.errors or c.missing
        raise HTTPException(409, "Not ready for the design lab: " + "; ".join(problems[:4]) + ".")
    return briefs.to_lab(b, c)


@router.post("/briefs/{brief_id}/share")
def share(brief_id: str) -> dict:
    """Add this failure to the shared library. Calling it is the person's consent."""
    b = _get(brief_id)
    c = briefs.check(b)
    if c.blocked:
        raise HTTPException(409, c.blocked)
    if not b.part.strip() or b.failure_mode not in failure_modes.BY_ID:
        raise HTTPException(409, "Say which part failed and how before adding it to the library.")
    b.share_to_library = True
    briefs.save(_root(), b)
    return library.add(_root(), b)


@router.get("/library")
def search(q: str = "", mode: str = "", limit: int = 50) -> list[dict]:
    return library.search(_root(), q[:200], mode[:40], max(1, min(limit, 200)))


@router.get("/library/stats")
def stats() -> dict:
    return library.stats(_root())


@router.post("/library/{brief_id}/outcome")
def outcome(brief_id: str, req: OutcomeRequest) -> dict:
    """Record whether the fixed part held up in use. This is what closes the loop."""
    if not briefs.BRIEF_ID.match(brief_id):
        raise HTTPException(404, "No such library record.")
    rec = library.set_outcome(_root(), brief_id, req.outcome)
    if rec is None:
        raise HTTPException(404, "No such library record.")
    return rec
