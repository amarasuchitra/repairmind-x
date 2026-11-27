"""Runs a build call: waits for the project from the app, then coaches."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from livekit.agents import AgentSession, JobContext, room_io

from .. import i18n
from ..frames import FrameGrabber
from .brief import Brief
from .live import TOPIC_BRIEF, Coach
from .prompt import GREETING

log = logging.getLogger("repairmind.coach")


async def run(ctx: JobContext, session: AgentSession, frames: FrameGrabber, language: str, ui_language: str,
              work_dir: Path) -> None:
    coach = Coach(ctx, frames, work_dir, i18n.call_rules(language, ui_language))
    got = asyncio.Event()

    def on_brief(reader, participant_identity: str) -> None:
        async def handle() -> None:
            try:
                brief = Brief.model_validate(json.loads(await reader.read_all()))
            except Exception:
                log.exception("unreadable build brief")
                return
            await coach.load(brief)
            got.set()

        asyncio.create_task(handle())

    ctx.room.register_text_stream_handler(TOPIC_BRIEF, on_brief)
    await session.start(agent=coach, room=ctx.room, room_options=room_io.RoomOptions(video_input=True))
    try:
        await asyncio.wait_for(got.wait(), 15)
    except asyncio.TimeoutError:
        log.warning("no build brief arrived; coaching without the project")
    session.generate_reply(instructions=GREETING + i18n.greeting_language(language, ui_language))
