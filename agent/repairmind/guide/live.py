"""The assistant's live voice: the same Gemini Live voice as the repair call, always listening, interruptible.

It is the same guide (the same instructions and the same app tools), but it talks instead of typing. The tools
still run in the person's browser, where the parts checker, the bench and the 3D body live: the voice agent asks
the page to run one over a LiveKit RPC call and hears back what happened, together with the project's new state.
"""

from __future__ import annotations

import asyncio
import json
import logging
import typing

from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, RunContext, function_tool, room_io

from .. import i18n
from .agent import SYSTEM, safety_block
from .schema import Tool

log = logging.getLogger("repairmind.guide.live")

TOPIC_CONTEXT = "rmx.guide.ctx"  # page -> agent: {state, catalog}
RPC_TOOL = "rmx.guide.tool"      # agent -> page: run one app tool, get {result, state}
TOOLS = set(typing.get_args(Tool))
MAX_RESULT = 6000

LIVE_RULES = """

YOU ARE SPEAKING LIVE, BY VOICE
This is a real-time voice conversation, like a phone call. The person hears you and can interrupt you at any
time; they don't see a chat box. Ignore the parts above about JSON fields, chips, checkpoints, "remember",
"stage" and then_continue: they are for the typed version.
- Talk like a friendly engineer beside them: short, warm, natural sentences, one idea at a time, then let them
  speak. Never read out lists, ids, JSON or tool names.
- To drive the app, call use_app with the tool name and its arguments as a JSON object, exactly as described in
  WHAT YOU DRIVE (for example tool "show", args_json {"view": "wiring"}). Say in a few words what you're doing,
  call it, then tell them what came back. You can call it several times in a row.
- Questions you would offer as chips, ask out loud with the two or three likely answers.
- If they go quiet, wait. Don't fill silence."""


def instructions(state: str, catalog: str, rules: str) -> str:
    return "\n\n".join(filter(None, [
        SYSTEM + LIVE_RULES,
        rules,
        "CATALOGUE:\n" + catalog.strip() if catalog.strip() else "",
        "STATE (the project right now):\n" + (state.strip() or "(nothing yet: a new project)"),
    ]))


def parse_args(args_json: str) -> list[dict] | str:
    """The model's JSON arguments as the page's key/value list, or an error to tell it."""
    try:
        data = json.loads(args_json or "{}")
    except json.JSONDecodeError:
        return "args_json must be a JSON object, like {\"view\": \"wiring\"}."
    if not isinstance(data, dict):
        return "args_json must be a JSON object."
    return [{"key": str(k)[:200], "value": (v if isinstance(v, str) else json.dumps(v))[:1200]} for k, v in data.items()][:16]


class GuideVoice(Agent):
    def __init__(self, ctx: JobContext, rules: str) -> None:
        self.rules = rules
        self.state = ""
        self.catalog = ""
        super().__init__(instructions=instructions("", "", rules))
        self.ctx = ctx

    def page(self) -> str | None:
        """The person's browser: the one non-agent participant."""
        for p in self.ctx.room.remote_participants.values():
            if p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
                return p.identity
        return None

    async def context(self, state: str, catalog: str = "") -> None:
        self.state = state[:16000]
        if catalog:
            self.catalog = catalog[:12000]
        try:
            await self.update_instructions(instructions(self.state, self.catalog, self.rules
                                                        + safety_block([self.state[-2000:]])))
        except Exception:
            log.exception("couldn't update the guide's instructions")

    @function_tool
    async def use_app(self, context: RunContext, tool: str, args_json: str = "{}", why: str = "") -> str:
        """Run one of the app's tools on the person's screen (see WHAT YOU DRIVE) and get back what happened.

        Args:
            tool: The tool name, e.g. understand_idea, start_build, check, show, test_on_bench, shape_body,
                show_step, step_done, open_panel, show_buy_list, export_build_pack, ask_for_photo.
            args_json: Its arguments as a JSON object, e.g. {"view": "wiring"} or {"n": "2"}. {} when none.
            why: A few words the screen shows while it runs, in the person's language.
        """
        tool = (tool or "").strip()
        if tool not in TOOLS:
            return f"Unknown tool '{tool}'. Use one of: {', '.join(sorted(TOOLS))}."
        args = parse_args(args_json)
        if isinstance(args, str):
            return args
        who = self.page()
        if who is None:
            return "The person's screen isn't connected."
        try:
            raw = await self.ctx.room.local_participant.perform_rpc(
                destination_identity=who, method=RPC_TOOL,
                payload=json.dumps({"tool": tool, "args": args, "why": why[:160]}), response_timeout=90.0)
        except Exception as e:  # the page closed, timed out or the tool threw
            return f"{tool} failed on the screen: {e}"
        try:
            back = json.loads(raw)
        except json.JSONDecodeError:
            return str(raw)[:MAX_RESULT]
        if back.get("state"):
            await self.context(str(back["state"]))
        return str(back.get("result", ""))[:MAX_RESULT]


GREETING = ("Greet them in one short, warm sentence. If STATE shows a project in progress, say where they are and "
            "the next move; otherwise ask what they'd like to make, fix or improve today.")


async def run(ctx: JobContext, session: AgentSession, language: str, ui_language: str) -> None:
    guide = GuideVoice(ctx, i18n.call_rules(language, ui_language))
    got = asyncio.Event()

    def on_context(reader, participant_identity: str) -> None:
        async def handle() -> None:
            try:
                data = json.loads(await reader.read_all())
                await guide.context(str(data.get("state", "")), str(data.get("catalog", "")))
            except Exception:
                log.exception("unreadable guide context")
            got.set()

        asyncio.create_task(handle())

    ctx.room.register_text_stream_handler(TOPIC_CONTEXT, on_context)
    await session.start(agent=guide, room=ctx.room, room_options=room_io.RoomOptions(video_input=False))
    try:
        await asyncio.wait_for(got.wait(), 10)
    except asyncio.TimeoutError:
        log.warning("no guide context arrived")
    session.generate_reply(instructions=GREETING + i18n.greeting_language(language, ui_language))
