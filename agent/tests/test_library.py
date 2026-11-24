"""The engineering library: built-in references, the user's own references, and lookups in every prompt."""

import json

import pytest
from fastapi.testclient import TestClient

from repairmind import checker, library, token_server
from repairmind.lab.schema import Design
from tests.test_lab import EXAMPLES, fake_model


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("RMX_LIBRARY_DIR", str(tmp_path / "lib"))
    monkeypatch.setenv("RMX_LAB_DIR", str(tmp_path / "lab"))
    library._index.cache_clear()
    yield TestClient(token_server.app)
    library._index.cache_clear()


def test_core_entries_are_complete_and_cite_sources():
    entries = library.core_entries()
    assert len(entries) >= 50
    assert len({e["id"] for e in entries}) == len(entries)
    for e in entries:
        for k in ("id", "topic", "title", "text", "source"):
            assert e[k].strip(), (e["id"], k)


@pytest.mark.parametrize("query, expected", [
    ("solar water pump for a 10 m deep well", "Pumps: suction limit"),
    ("a drone that carries 2 kg", "Hovering and flying"),
    ("talking toy for kids", "Designing for children"),
    ("3d printed bracket for a shelf", "3D printing"),
    ("free energy magnet generator", "Energy conservation"),
])
def test_search_finds_what_an_engineer_would_look_up(client, query, expected):
    titles = [h.title for h in library.search(query, 5)]
    assert any(expected in t for t in titles), titles


def test_numbers_alone_dont_match():
    assert library.search("10 12 2.5") == []


def test_users_own_reference_is_searched_and_cited(client):
    r = client.post("/api/library/docs", files={"file": ("pump.txt", b"The Kirloskar KDS-0.5 submersible pump delivers 1800 litres per hour at 12 m head and draws 6 A at 24 V.", "text/plain")},
                    data={"title": "Pump catalogue"})
    assert r.status_code == 200, r.text
    doc = r.json()
    hits = client.get("/api/library/search", params={"q": "submersible pump litres per hour head"}).json()
    assert hits[0]["kind"] == "yours" and hits[0]["title"] == "Pump catalogue" and hits[0]["ref"] == "L1"
    assert client.get("/api/library").json()["yours"][0]["id"] == doc["id"]
    assert client.delete(f"/api/library/docs/{doc['id']}").json()["removed"]
    assert all(h["kind"] == "core" for h in client.get("/api/library/search", params={"q": "submersible pump head"}).json())


def test_bad_files_are_refused_plainly(client):
    assert client.post("/api/library/docs", files={"file": ("x.txt", b"", "text/plain")}).status_code == 400
    assert client.post("/api/library/docs", files={"file": ("scan.pdf", b"%PDF-1.4 not really", "application/pdf")}).status_code == 422
    assert client.delete("/api/library/docs/../../etc").status_code in (404, 200)


def test_design_and_think_first_get_library_entries(client, monkeypatch):
    calls = fake_model(monkeypatch, Design.model_validate(EXAMPLES[0]))
    client.post("/api/lab/design", json={"idea": "solar water pump for my farm well, 10 m deep"})
    assert "ENGINEERING LIBRARY" in calls[0]["system"] and "suction" in calls[0]["system"]
    assert "[L1]" in calls[0]["system"]


def test_idea_analyst_gets_library_entries(client, monkeypatch):
    from tests.test_upgrade import answer, body, fake

    calls = fake(monkeypatch, answer)
    client.post("/api/upgrade/assess", json=body(idea="make my soft toy talk for my kids"))
    assert "Designing for children" in calls[-1]["system"]
