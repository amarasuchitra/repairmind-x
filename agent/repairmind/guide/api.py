"""HTTP endpoints for the assistant: one conversation turn, and checking a photo of a real build."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import checker
from ..lab import attachments
from . import agent, photo_check
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


@router.post("/check-build")
async def check_build(req: photo_check.CheckRequest) -> dict:
    if checker.provider() is None:
        raise HTTPException(503, "No AI model is configured, so photos can't be checked.")
    a = attachments.load(req.attachment_id)
    if a is None:
        raise HTTPException(410, "That photo has expired. Take it again.")
    if not a.image_b64:
        raise HTTPException(422, "That file isn't a photo.")
    out = await photo_check.check(req, a.image_b64)
    if isinstance(out, str):
        raise HTTPException(502, out)
    return {**out.model_dump(), "text": photo_check.as_text(out)}
