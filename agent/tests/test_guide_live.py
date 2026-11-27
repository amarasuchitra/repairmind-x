"""The assistant's live voice: same guide, tools run on the page over RPC, state flows back into its instructions."""

import asyncio
import json
from types import SimpleNamespace

from livekit import rtc

from repairmind.agent import _mode
from repairmind.guide import live


class FakeRoom:
    def __init__(self, reply):
        self.sent = []
        self.remote_participants = {
            "agent": SimpleNamespace(identity="agent-x", kind=rtc.ParticipantKind.PARTICIPANT_KIND_AGENT),
            "me": SimpleNamespace(identity="user-1", kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD),
        }

        async def perform_rpc(**kw):
            self.sent.append(kw)
            return reply

        self.local_participant = SimpleNamespace(perform_rpc=perform_rpc)


def voice(reply):
    g = live.GuideVoice(SimpleNamespace(room=FakeRoom(reply)), "")
    seen = []

    async def update(text):
        seen.append(text)

    g.update_instructions = update
    return g, seen


def call(g, **kw):
    return asyncio.run(live.GuideVoice.use_app.__wrapped__(g, None, **kw)) if hasattr(live.GuideVoice.use_app, "__wrapped__") \
        else asyncio.run(g.use_app(None, **kw))


def test_the_page_runs_the_tool_and_the_new_state_reaches_the_guide():
    g, seen = voice(json.dumps({"result": "Showing the wiring: 14 wires.", "state": "VIEW: wiring"}))
    out = call(g, tool="show", args_json='{"view": "wiring"}', why="Showing the wires")
    assert out == "Showing the wiring: 14 wires."
    rpc = g.ctx.room.sent[0]
    assert rpc["destination_identity"] == "user-1" and rpc["method"] == live.RPC_TOOL
    assert json.loads(rpc["payload"]) == {"tool": "show", "args": [{"key": "view", "value": "wiring"}], "why": "Showing the wires"}
    assert "STATE (the project right now):\nVIEW: wiring" in seen[-1]
    assert "YOU ARE SPEAKING LIVE" in seen[-1]


def test_bad_tools_and_arguments_are_answered_without_touching_the_page():
    g, _ = voice("{}")
    assert call(g, tool="format_disk").startswith("Unknown tool")
    assert "JSON object" in call(g, tool="show", args_json="view=wiring")
    assert "JSON object" in call(g, tool="show", args_json="[1]")
    assert g.ctx.room.sent == []


def test_numbers_and_flags_become_text_arguments():
    assert live.parse_args('{"n": 2, "fit": true}') == [{"key": "n", "value": "2"}, {"key": "fit", "value": "true"}]


def test_the_guide_mode_is_dispatched():
    assert _mode(json.dumps({"mode": "guide"})) == "guide"
    assert _mode(json.dumps({"mode": "anything"})) == "repair"
