"""Tiny API that lets the web app join a call.

Run:  uvicorn repairmind.token_server:app --port 8000
"""

from __future__ import annotations

import os
import re
import secrets
from datetime import timedelta

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

from .agent import AGENT_NAME

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
