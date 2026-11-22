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


def _pdf_with_text() -> bytes:
    # Minimal one-page PDF with extractable text.
    import io
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    w = PdfWriter()
    page = w.add_blank_page(300, 300)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                             NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): w._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 20 250 Td (Clean the drain pump filter) Tj ET")
    page[NameObject("/Contents")] = w._add_object(stream)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def test_manual_upload_and_search(client, tmp_path, monkeypatch):
    from repairmind import manuals
    monkeypatch.setattr(token_server, "SESSIONS_DIR", tmp_path)
    r = client.post("/api/manual", data={"room": "rmx-abcdef123456"},
                    files={"file": ("Bosch WAN28.pdf", _pdf_with_text(), "application/pdf")})
    assert r.status_code == 200, r.text
    idx = manuals.ManualIndex.load(manuals.manual_path(tmp_path, "rmx-abcdef123456"))
    assert idx.search("drain pump")[0]["ref"] == "Bosch WAN28 p.1"


def test_manual_upload_rejects_non_pdf(client):
    r = client.post("/api/manual", data={"room": "rmx-abcdef123456"},
                    files={"file": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 415
