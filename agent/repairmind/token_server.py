"""Tiny API that lets the web app join a call.

Run:  uvicorn repairmind.token_server:app --port 8000
"""

from __future__ import annotations

import os
import re
import secrets
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from .agent import AGENT_NAME, SESSIONS_DIR
from .expert import products as expert_products
from .inspection.api import router as inspection_router
from .manuals import ManualIndex, manual_path

load_dotenv()

app = FastAPI(title="RepairMind X token server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("RMX_ALLOWED_ORIGINS", "http://localhost:5173").split(",")],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

ROOM_RE = re.compile(r"^rmx-[a-z0-9]{8,32}$")


class TokenRequest(BaseModel):
    # Pass the previous room to resume a dropped call; omit for a new repair.
    room: str | None = None
    name: str = "Technician"
    accepted_notice: bool = False


class TokenResponse(BaseModel):
    server_url: str
    participant_token: str
    room: str


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


app.include_router(inspection_router)


@app.get("/api/products")
def product_list() -> list[dict]:
    return [{"id": p.id, "name": p.name, "has_detector": p.detector is not None}
            for p in expert_products.load_all().values()]


@app.get("/api/products/{product_id}")
def product(product_id: str) -> dict:
    """Public product data for the 3D viewer: parts and the steps' highlight/move/hide (no detector paths)."""
    p = expert_products.load_all().get(product_id)
    if p is None:
        raise HTTPException(404, "unknown product")
    procs = expert_products.usable_procedures(p)
    return {
        "id": p.id, "name": p.name, "illustrative": p.illustrative_3d, "model_url": p.model_url,
        "parts": [part.model_dump() for part in p.parts],
        "procedures": [{"id": pr.id, "title": pr.title, "reviewed": pr.reviewed,
                        "steps": [{"id": st.id, "text": st.text, "highlight": st.highlight, "move": st.move,
                                   "hide": st.hide} for st in pr.steps]} for pr in procs],
    }


@app.post("/api/token", response_model=TokenResponse)
def token(req: TokenRequest) -> TokenResponse:
    if not req.accepted_notice:
        raise HTTPException(400, "The safety and privacy notice must be accepted before a call.")
    url, key, secret = (os.getenv(k) for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"))
    if not (url and key and secret):
        raise HTTPException(500, "LiveKit is not configured on the server (LIVEKIT_URL / API key / secret).")

    room = req.room if req.room and ROOM_RE.match(req.room) else f"rmx-{secrets.token_hex(6)}"
    identity = f"user-{secrets.token_hex(4)}"
    jwt = (
        api.AccessToken(key, secret)
        .with_identity(identity)
        .with_name(req.name[:40])
        .with_ttl(timedelta(hours=2))
        .with_grants(api.VideoGrants(room_join=True, room=room, can_publish=True, can_subscribe=True,
                                     can_publish_data=True))
        .with_room_config(api.RoomConfiguration(agents=[api.RoomAgentDispatch(agent_name=AGENT_NAME)]))
        .to_jwt()
    )
    return TokenResponse(server_url=url, participant_token=jwt, room=room)


MAX_MANUAL_BYTES = 40 * 1024 * 1024


@app.post("/api/manual")
async def upload_manual(room: str = Form(...), file: UploadFile = File(...)) -> dict:
    """Attach a PDF service manual to a repair so the mechanic can search and cite it."""
    if not ROOM_RE.match(room):
        raise HTTPException(400, "Unknown repair session.")
    data = await file.read(MAX_MANUAL_BYTES + 1)
    if len(data) > MAX_MANUAL_BYTES:
        raise HTTPException(413, "The manual is larger than 40 MB.")
    if not data.startswith(b"%PDF"):
        raise HTTPException(415, "Please upload a PDF.")
    title = re.sub(r"[^\w .()-]", "", (file.filename or "manual").rsplit(".", 1)[0])[:60] or "manual"
    try:
        idx = ManualIndex.from_pdf(title, data)
    except Exception:
        raise HTTPException(422, "Couldn't read that PDF.")
    if not idx.passages:
        raise HTTPException(422, "That PDF has no readable text (it may be scanned images).")
    idx.save(manual_path(SESSIONS_DIR, room))
    pages = max(p.page for p in idx.passages)
    return {"title": title, "pages": pages, "passages": len(idx.passages)}
