"""HTTP endpoint for the build guide."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import checker
from ..lab import attachments
from . import agent
from .schema import GuideTurn

router = APIRouter(prefix="/api/guide")


@router.get("/status")
def status() -> dict:
    p = checker.provider()
    return {"ready": p is not None, "model": p, "media": bool(checker._google_key())}


@router.post("/turn", response_model=GuideTurn)
async def turn(req: agent.TurnRequest) -> GuideTurn:
    items = [a for a in (attachments.load(i) for i in req.attachment_ids) if a]
    if len(items) < len(req.attachment_ids):
        raise HTTPException(410, "Some photos or files have expired. Attach them again.")
    try:
        return await agent.turn(req, items)
    except agent.TurnError as e:
        raise HTTPException(e.status, e.message)
