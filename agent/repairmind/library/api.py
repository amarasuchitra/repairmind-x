"""HTTP endpoints for the engineering library."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from .. import library

router = APIRouter(prefix="/api/library")


@router.get("")
def overview() -> dict:
    topics: dict[str, int] = {}
    for e in library.core_entries():
        topics[e["topic"]] = topics.get(e["topic"], 0) + 1
    return {"core": len(library.core_entries()), "topics": topics, "yours": library.list_docs()}


@router.get("/search")
def search(q: str, k: int = 8) -> list[dict]:
    """What the engineer would look up for this text."""
    return [h.public() for h in library.search(q[:2000], k=max(1, min(k, 20)))]


@router.post("/docs")
async def add(file: UploadFile = File(...), title: str = Form(default="")) -> dict:
    """Add a datasheet, handbook, paper or standard (text PDF or plain text) to the library."""
    data = await file.read(library.MAX_DOC_BYTES + 1)
    if len(data) > library.MAX_DOC_BYTES:
        raise HTTPException(413, "References must be under 30 MB.")
    if not data:
        raise HTTPException(400, "That file is empty.")
    try:
        return library.add_doc(title, file.filename or "reference", data)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception:
        raise HTTPException(422, "Couldn't read that file. Add a text PDF or a .txt/.md file.")


@router.delete("/docs/{doc_id}")
def remove(doc_id: str) -> dict:
    return {"removed": library.remove_doc(doc_id)}
