"""HTTP endpoints for the engineering design lab."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .. import checker, i18n
from . import attachments, designer, understand
from .schema import Brief, Design

router = APIRouter(prefix="/api/lab")


class DesignRequest(BaseModel):
    idea: str = Field(min_length=8, max_length=4000)
    context: str = Field(default="", max_length=4000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    # Language the design is written in (e.g. "hi"); symbols, units and equations stay as they are.
    language: str = Field(default="en", max_length=16)
    # from the think-first step: the understanding the user confirmed, and their answers
    brief: Brief | None = None
    answers: list[understand.QA] = Field(default_factory=list, max_length=24)


class UnderstandRequest(BaseModel):
    idea: str = Field(min_length=8, max_length=4000)
    context: str = Field(default="", max_length=4000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    answers: list[understand.QA] = Field(default_factory=list, max_length=24)
    correction: str = Field(default="", max_length=2000)
    language: str = Field(default="en", max_length=16)


class ReviseRequest(BaseModel):
    design: Design
    findings: list[str] = Field(default_factory=list, max_length=80)
    note: str = Field(default="", max_length=2000)
    language: str = Field(default="en", max_length=16)


@router.get("/status")
def status() -> dict:
    p = checker.provider()
    return {"model": p, "ready": p is not None, "media": bool(checker._google_key()), "lessons": len(designer.load_lessons(designer.MAX_LESSONS_KEPT))}


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
    items = [a for a in (attachments.load(i) for i in req.attachment_ids) if a]
    if len(items) < len(req.attachment_ids):
        raise HTTPException(410, "Some attachments have expired or were removed. Attach them again.")
    return await _run(designer.generate(req.idea, req.context, items, req.language, req.brief, req.answers))


def _items(ids: list[str]) -> list:
    items = [a for a in (attachments.load(i) for i in ids) if a]
    if len(items) < len(ids):
        raise HTTPException(410, "Some attachments have expired or were removed. Attach them again.")
    return items


@router.post("/understand", response_model=Brief)
async def think_first(req: UnderstandRequest) -> Brief:
    """Before designing: restate, separate facts from guesses, rough feasibility numbers, the riskiest assumption
    and its cheapest test, a few concepts, and the questions that would change the design most."""
    return await _run(understand.understand(req.idea, req.context, req.answers, _items(req.attachment_ids),
                                            req.language, req.correction))


async def _read_upload(f: UploadFile) -> bytes:
    data = await f.read(attachments.MAX_BYTES + 1)
    if len(data) > attachments.MAX_BYTES:
        raise HTTPException(413, f"{f.filename} is larger than 50 MB.")
    if not data:
        raise HTTPException(400, f"{f.filename} is empty.")
    return data


@router.post("/attachments")
async def upload(files: list[UploadFile] = File(...)) -> list[dict]:
    """Read attachments into what the design engineer can use. Only the processed result is kept."""
    if len(files) > 20:
        raise HTTPException(400, "Attach at most 20 files at a time.")
    attachments.prune()
    out = []
    for f in files:
        a = await attachments.read_any(f.filename or "file", await _read_upload(f), f.content_type or "")
        attachments.save(a)
        out.append(a.public())
    return out


@router.get("/attachments/{att_id}")
def attachment(att_id: str) -> dict:
    a = attachments.load(att_id)
    if a is None:
        raise HTTPException(404, "No such attachment (it may have expired).")
    return a.public()


@router.delete("/attachments/{att_id}")
def remove(att_id: str) -> dict:
    return {"removed": attachments.delete(att_id)}


@router.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form(default="")) -> dict:
    """Speech to text for browsers without built-in dictation. Needs GOOGLE_API_KEY (Gemini hears audio)."""
    data = await _read_upload(file)
    if len(data) > attachments.MAX_MEDIA_FOR_GEMINI:
        raise HTTPException(413, "Recordings must be under 19 MB.")
    mime = (file.content_type or "audio/webm").split(";")[0]
    try:
        text = await attachments.gemini_media(data, mime, attachments.TRANSCRIBE_PROMPT + i18n.transcribe_hint(language),
                                             timeout=60.0)
    except RuntimeError:
        raise HTTPException(503, "Voice transcription needs GOOGLE_API_KEY in agent/.env. Chrome, Edge and Safari can "
                                 "dictate without it.")
    except Exception:
        raise HTTPException(502, "Couldn't transcribe that recording. Try again or type instead.")
    return {"text": text}


@router.post("/revise", response_model=Design)
async def revise(req: ReviseRequest) -> Design:
    if len(req.design.revisions) >= 12:
        raise HTTPException(400, "This design has been revised 12 times. Start a new one from the latest version.")
    findings = [" ".join(f.split())[:600] for f in req.findings]
    return await _run(designer.revise(req.design, findings, req.note, req.language))
