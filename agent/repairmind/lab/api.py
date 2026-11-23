"""HTTP endpoints for the engineering design lab."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import checker
from . import designer
from .schema import Design

router = APIRouter(prefix="/api/lab")


class DesignRequest(BaseModel):
    idea: str = Field(min_length=8, max_length=4000)
    context: str = Field(default="", max_length=4000)


class ReviseRequest(BaseModel):
    design: Design
    findings: list[str] = Field(default_factory=list, max_length=80)
    note: str = Field(default="", max_length=2000)


@router.get("/status")
def status() -> dict:
    p = checker.provider()
    return {"model": p, "ready": p is not None, "lessons": len(designer.load_lessons(designer.MAX_LESSONS_KEPT))}


@router.get("/lessons")
def lessons() -> list[dict]:
    return designer.load_lessons(designer.MAX_LESSONS_KEPT)


async def _run(coro):
    try:
        return await coro
    except designer.DesignError as e:
        raise HTTPException(e.status, e.message)


@router.post("/design", response_model=Design)
async def design(req: DesignRequest) -> Design:
    return await _run(designer.generate(req.idea, req.context))


@router.post("/revise", response_model=Design)
async def revise(req: ReviseRequest) -> Design:
    if len(req.design.revisions) >= 12:
        raise HTTPException(400, "This design has been revised 12 times. Start a new one from the latest version.")
    findings = [" ".join(f.split())[:600] for f in req.findings]
    return await _run(designer.revise(req.design, findings, req.note))
