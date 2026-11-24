"""HTTP endpoints for understanding an existing product and planning its enhancement."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import checker
from ..lab import attachments
from . import assess as analyst
from .schema import Assessment

router = APIRouter(prefix="/api/upgrade")


@router.get("/status")
def status() -> dict:
    p = checker.provider()
    return {"model": p, "ready": p is not None, "learned": len(analyst.corrections(analyst.MAX_KEPT)),
            "precedents": len(analyst.precedents(analyst.MAX_KEPT))}


@router.post("/assess", response_model=Assessment)
async def assess(req: analyst.AssessRequest) -> Assessment:
    items = [a for a in (attachments.load(i) for i in req.attachment_ids) if a]
    if len(items) < len(req.attachment_ids):
        raise HTTPException(410, "Some photos or files have expired or were removed. Attach them again.")
    try:
        return await analyst.assess(req, items)
    except analyst.AssessError as e:
        raise HTTPException(e.status, e.message)
