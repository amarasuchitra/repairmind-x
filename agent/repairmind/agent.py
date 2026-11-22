"""RepairMind X live mechanic agent (LiveKit Agents + Gemini Live).

Run:  python -m repairmind.agent dev
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    UserInputTranscribedEvent,
    cli,
    function_tool,
    room_io,
)
from livekit.agents.voice import VoiceActivityVideoSampler
from livekit.plugins import google

from . import safety, sources
from .prompts import GREETING, MECHANIC_INSTRUCTIONS
from .session import GateResult, Hypothesis, RepairSession

load_dotenv()
log = logging.getLogger("repairmind")

AGENT_NAME = "repairmind-mechanic"
SESSIONS_DIR = Path(os.getenv("RMX_SESSIONS_DIR", "sessions"))
GEMINI_MODEL = os.getenv("RMX_GEMINI_MODEL", "gemini-3.1-flash-live-preview")
GEMINI_VOICE = os.getenv("RMX_GEMINI_VOICE", "Charon")

TOPIC_STATE = "rmx.state"
TOPIC_MARKER = "rmx.marker"
TOPIC_ALERT = "rmx.alert"


class Mechanic(Agent):
    def __init__(self, ctx: JobContext, state: RepairSession) -> None:
        super().__init__(instructions=MECHANIC_INSTRUCTIONS)
        self.ctx = ctx
        self.state = state
        self.session_path = SESSIONS_DIR / f"{state.session_id}.json"

    # ----------------------------------------------------------------- helpers
    async def publish(self, topic: str, payload: dict) -> None:
        try:
            await self.ctx.room.local_participant.send_text(json.dumps(payload), topic=topic)
        except Exception:  # the UI being gone must never break the call
            log.exception("publish failed")

    async def _done(self, result: GateResult) -> str:
        self.state.save(SESSIONS_DIR)
        await self.publish(TOPIC_STATE, self.state.ui_state())
        if not result.allowed and result.code.startswith(("red_", "hazard")):
            await self.publish(TOPIC_ALERT, {"kind": result.code, "message": result.say})
        return result.for_model()

    # ------------------------------------------------------------- diagnosis
    @function_tool
    async def identify_device(self, context: RunContext, device: str, brand: str = "", model: str = "",
                              model_confirmed: bool = False, how_identified: str = "") -> str:
        """Record what the device is.

        Args:
            device: Plain device type, e.g. "front-loading washing machine".
            brand: Brand if known.
            model: Exact model number if known.
            model_confirmed: True only if you read it on the label or the user said it.
            how_identified: "label", "user said", or "visual guess".
        """
        return await self._done(self.state.identify_device(device, brand, model, model_confirmed, how_identified))

    @function_tool
    async def record_symptom(self, context: RunContext, symptom: str) -> str:
        """Record a symptom the user described or you observed."""
        return await self._done(self.state.record_symptom(symptom))

    @function_tool
    async def record_history_answer(self, context: RunContext, question: str, answer: str) -> str:
        """Record the user's answer to a diagnostic history question."""
        return await self._done(self.state.record_history_answer(question, answer))

    @function_tool
    async def record_test(self, context: RunContext, description: str, result: str) -> str:
        """Record a safe, reversible diagnostic test and what it showed."""
        return await self._done(self.state.record_test(description, result))

    @function_tool
    async def update_hypotheses(self, context: RunContext, causes: list[str], confidences: list[float]) -> str:
        """Replace the ranked list of possible causes.

        Args:
            causes: Possible causes, most likely first.
            confidences: Honest confidence 0..1 for each cause, same order.
        """
        hyps = [Hypothesis(c, float(p)) for c, p in zip(causes, confidences)]
        return await self._done(self.state.update_hypotheses(hyps))

    @function_tool
    async def set_diagnosis(self, context: RunContext, cause: str, confidence: float, evidence: list[str]) -> str:
        """Conclude the diagnosis. Refused until history, evidence and tests are sufficient."""
        return await self._done(self.state.set_diagnosis(cause, confidence, evidence))

    # ---------------------------------------------------------------- sources
    @function_tool
    async def find_repair_guide(self, context: RunContext, query: str) -> str:
        """Search iFixit for repair guides. Use brand, model and the repair, e.g. "Bosch WAN28 drain pump"."""
        try:
            results = await sources.search_guides(query)
        except Exception as e:
            return f"Guide search failed ({e}). Say you couldn't reach the guide library; don't improvise steps."
        if not results:
            return "No guides found. Try a broader query once; if still nothing, say so and consider escalate."
        return json.dumps(results)

    @function_tool
    async def get_guide_steps(self, context: RunContext, guide_id: int) -> str:
        """Fetch the steps, tools and cautions of one iFixit guide. Check it matches the exact model."""
        try:
            return json.dumps(await sources.get_guide_steps(guide_id))
        except Exception as e:
            return f"Couldn't load that guide ({e})."

    # ------------------------------------------------------------ precautions
    @function_tool
    async def confirm_precaution(self, context: RunContext, precaution_id: str, verified_on_camera: bool) -> str:
        """Mark a safety precaution done. Only after you actually saw it on camera.

        Args:
            precaution_id: One of unplugged, battery_checked, power_isolated, cooled_down,
                water_shut_off, protective_gear, vehicle_secured.
            verified_on_camera: True only if you saw it.
        """
        return await self._done(self.state.confirm_precaution(precaution_id, verified_on_camera))

    # ------------------------------------------------------------------ steps
    @function_tool
    async def propose_step(self, context: RunContext, text: str, source_kind: str, source_ref: str,
                           expected_result: str) -> str:
        """Ask permission to give ONE repair step. Say the step only if the answer is ALLOWED.

        Args:
            text: The exact instruction you intend to say.
            source_kind: "ifixit", "manual", "label" or "general_safe".
            source_ref: Guide URL plus step number, or manual page. Empty only for general_safe.
            expected_result: What the camera should show when the step is done.
        """
        if source_kind not in ("ifixit", "manual", "label", "general_safe"):
            return "BLOCKED (bad_source_kind). Use ifixit, manual, label or general_safe."
        return await self._done(self.state.propose_step(text, source_kind, source_ref, expected_result))  # type: ignore[arg-type]

    @function_tool
    async def mark_photo_taken(self, context: RunContext, step_id: str) -> str:
        """Note that the user photographed the current state before an irreversible step."""
        return await self._done(self.state.mark_photo_taken(step_id))

    @function_tool
    async def confirm_irreversible_step(self, context: RunContext, step_id: str, user_exact_words: str) -> str:
        """Pass the user's exact words after you asked for a clear yes to an irreversible step."""
        return await self._done(self.state.confirm_irreversible_step(step_id, user_exact_words))

    @function_tool
    async def report_step_result(self, context: RunContext, step_id: str, verified_by: str, passed: bool,
                                 observation: str) -> str:
        """Record whether a step was done correctly.

        Args:
            step_id: The step id from propose_step.
            verified_by: "camera" if you saw it, "user" if you only have their word.
            passed: Whether it matches the expected result.
            observation: What you actually saw.
        """
        if verified_by not in ("camera", "user"):
            return "BLOCKED (bad_verified_by). Use camera or user."
        return await self._done(self.state.report_step_result(step_id, verified_by, passed, observation))  # type: ignore[arg-type]

    @function_tool
    async def mark_spot(self, context: RunContext, x: float, y: float, label: str,
                        width: float = 0.0, height: float = 0.0) -> str:
        """Point at something in the CURRENT camera frame. The app freezes the frame and draws an arrow.

        Args:
            x: Horizontal centre, 0 = left edge, 1 = right edge.
            y: Vertical centre, 0 = top, 1 = bottom.
            label: Short label, e.g. "this screw".
            width: Optional box width 0..1.
            height: Optional box height 0..1.
        """
        clamp = lambda v: max(0.0, min(1.0, float(v)))  # noqa: E731
        await self.publish(TOPIC_MARKER, {"x": clamp(x), "y": clamp(y), "w": clamp(width), "h": clamp(height),
                                          "label": label[:60]})
        return "Marker shown. Tell the user to look at the arrow on the still picture."

    # ------------------------------------------------------- hazards & handoff
    @function_tool
    async def report_hazard(self, context: RunContext, detail: str) -> str:
        """Immediately stop the repair because of danger (smoke, burning, sparks, gas, shock, injury)."""
        return await self._done(self.state.hazard(detail))

    @function_tool
    async def clear_hazard(self, context: RunContext, user_words: str) -> str:
        """Only after the user clearly says the danger is gone and you have re-checked the scene."""
        return await self._done(self.state.clear_hazard(user_words))

    @function_tool
    async def escalate(self, context: RunContext, reason: str) -> str:
        """Hand off to a human expert with the full evidence package."""
        result = self.state.escalate(reason)
        await self.publish("rmx.escalation", result.data["package"])
        return await self._done(result)


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()

    # Resume a dropped call: the web app reuses the room name for the same repair.
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "", ctx.room.name)[:64] or "room"
    path = SESSIONS_DIR / f"{safe_name}.json"
    state = RepairSession.load(path) if path.exists() else RepairSession(session_id=safe_name)
    resumed = path.exists()

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_MODEL,
            voice=GEMINI_VOICE,
            temperature=0.4,
        ),
        # ~1 frame/second while the user talks, slower when quiet: enough context, low cost.
        video_sampler=VoiceActivityVideoSampler(speaking_fps=1.0, silent_fps=0.5),
        max_tool_steps=6,
    )
    mechanic = Mechanic(ctx, state)

    # Safety net that doesn't depend on the model noticing: scan every final user transcript.
    @session.on("user_input_transcribed")
    def _on_transcript(ev: UserInputTranscribedEvent) -> None:
        if not ev.is_final:
            return
        hazards = safety.detect_hazards(ev.transcript)
        if not hazards or state.hazard_stop:
            return

        async def stop() -> None:
            state.hazard(", ".join(hazards))
            state.save(SESSIONS_DIR)
            await mechanic.publish(TOPIC_STATE, state.ui_state())
            await mechanic.publish(TOPIC_ALERT, {"kind": "hazard_stop", "message": safety.HAZARD_STOP_MESSAGE})
            await session.interrupt(force=True)
            session.generate_reply(instructions="Say exactly, calmly and slowly: " + safety.HAZARD_STOP_MESSAGE)

        asyncio.create_task(stop())

    await session.start(
        agent=mechanic,
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=True),
    )
    await mechanic.publish(TOPIC_STATE, state.ui_state())
    if resumed:
        session.generate_reply(instructions=(
            "The call dropped and the user is back. Briefly say where you were, using this state: "
            + json.dumps(state.ui_state()) + ". Ask them to show the device again before continuing."))
    else:
        session.generate_reply(instructions=GREETING)


if __name__ == "__main__":
    cli.run_app(server)
