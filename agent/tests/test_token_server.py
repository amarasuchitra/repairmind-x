import jwt as _jwt  # PyJWT ships with livekit-api
import pytest
from fastapi.testclient import TestClient

from repairmind import token_server


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "devkey")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "x" * 32)
    return TestClient(token_server.app)


def test_requires_notice(client):
    assert client.post("/api/token", json={}).status_code == 400


def test_issues_token_with_agent_dispatch(client):
    r = client.post("/api/token", json={"accepted_notice": True})
    assert r.status_code == 200
    body = r.json()
    assert body["room"].startswith("rmx-")
    claims = _jwt.decode(body["participant_token"], "x" * 32, algorithms=["HS256"], options={"verify_aud": False})
    assert claims["video"]["room"] == body["room"]
    assert "repairmind-mechanic" in str(claims.get("roomConfig"))


def test_resume_keeps_room(client):
    r = client.post("/api/token", json={"accepted_notice": True, "room": "rmx-abcdef123456"})
    assert r.json()["room"] == "rmx-abcdef123456"


def test_rejects_bad_room_name(client):
    r = client.post("/api/token", json={"accepted_notice": True, "room": "../../etc"})
    assert r.json()["room"] != "../../etc"
