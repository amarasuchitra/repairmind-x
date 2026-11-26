"""Session copilot: notes and the repair summary come only from what the session recorded."""

import asyncio
import json

from fastapi.testclient import TestClient

from repairmind import checker, summary, token_server
from repairmind.session import RepairSession
from tests.test_phase2 import bike


def test_summary_of_a_diagnosed_call():
    s = bike()
    s.symptoms.append("chain slips")
    out = summary.build(s)
    assert out["device"] == "Trek FX 2" and out["model_confirmed"]
    assert out["outcome"] == "diagnosed" and out["diagnosis"] == "Chain derailed"
    texts = [n["text"] for n in out["notes"]]
    assert "Device: Trek FX 2 (model confirmed)" in texts
    assert any(t.startswith("Diagnosis: Chain derailed") for t in texts)
    md = summary.to_markdown(out)
    assert "# Repair summary: Trek FX 2" in md and "## Diagnosis" in md and "90% sure" in md


def test_steps_and_outcome_follow_the_gates():
    s = bike()
    s.propose_step("Lift the chain back onto the small ring", "general_safe", "", "chain on ring")
    out = summary.build(s)
    assert out["outcome"] == "in_progress"
    assert out["next_time"][0].startswith("Pick up at step 1")
    sid = out["steps"][0]
    step = s.steps[0]
    s.report_step_result(step.id, "camera", True, "chain seated")
    out = summary.build(s)
    assert out["outcome"] == "fixed" and out["steps"][0]["checked"] == "checked on camera"
    assert any("Step done (checked on camera)" in n["text"] for n in out["notes"])
    assert sid["status"] != "done"  # the earlier summary isn't rewritten


def test_hazard_wins_over_everything():
    s = bike()
    s.hazard("smoke from the hub motor")
    out = summary.build(s)
    assert out["outcome"] == "stopped"
    assert out["next_time"][0].startswith("Don't continue")
    assert any(n["text"].startswith("STOPPED for danger") for n in out["notes"])


def test_odd_log_entries_are_skipped():
    s = RepairSession()
    s.log += [{"t": "bad", "event": "symptom", "text": "x"}, {"event": "unknown"}, {"t": 1, "event": "symptom"}]
    assert isinstance(summary.notes(s), list)


def test_writer_and_endpoint(tmp_path, monkeypatch):
    s = bike()
    s.session_id = "rmx-abcdef123456"
    w = summary.SummaryWriter(s, tmp_path, delay=0)

    async def run():
        w.touch()
        await asyncio.sleep(0.05)
        await w.flush()

    asyncio.run(run())
    pj, pm = summary.paths(tmp_path, s.session_id)
    assert json.loads(pj.read_text(encoding="utf-8"))["device"] == "Trek FX 2" and pm.read_text(encoding="utf-8").startswith("# Repair summary")

    monkeypatch.setattr(token_server, "SESSIONS_DIR", tmp_path)
    c = TestClient(token_server.app)
    assert c.get(f"/api/sessions/{s.session_id}/summary").json()["diagnosis"] == "Chain derailed"
    r = c.get(f"/api/sessions/{s.session_id}/summary?format=md")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    assert c.get("/api/sessions/../etc/summary").status_code in (400, 404)
    assert c.get("/api/sessions/rmx-000000000000/summary").status_code == 404
    # built on the fly from the session file when the summary hasn't been written yet
    pj.unlink()
    s.save(tmp_path)
    assert c.get(f"/api/sessions/{s.session_id}/summary").json()["outcome"] == "diagnosed"


def test_quick_routing_never_touches_safety_checks(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_API_KEY", "x")
    monkeypatch.setenv("RMX_CHECK_PROVIDER", "gemini")
    quick = [m for _, m in checker._chain("gemini", "quick")]
    assert quick[0] == checker.GEMINI_QUICK_MODEL and checker.GEMINI_MODEL in quick[1:]
    for purpose in ("review", "vision"):
        assert checker.GEMINI_QUICK_MODEL not in [m for _, m in checker._chain("gemini", purpose)]
    assert checker.ANTHROPIC_MODEL["quick"] != checker.ANTHROPIC_MODEL["review"]
