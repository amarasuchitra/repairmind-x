"""The live build coach agent: guides wiring on the camera, checks it, and does the computer work."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from livekit.agents import Agent, JobContext, RunContext, function_tool

from .. import vision
from ..frames import FrameGrabber
from . import board
from .brief import Brief, BuildState
from .prompt import COACH_INSTRUCTIONS

log = logging.getLogger("repairmind.coach")

TOPIC_BUILD = "rmx.build"        # agent -> app: wiring progress, upload state, serial output
TOPIC_BRIEF = "rmx.build.brief"  # app -> agent: the project
TOPIC_APP = "rmx.app"            # agent -> app: run something on the RepairMind screen
TOPIC_MARKER = "rmx.marker"      # agent -> app: the circle on the live camera

TABS = {"3d", "spec", "code", "tools", "shop"}
APP_ACTIONS = {"show_tab", "save_folder", "download_pack", "go_to_step"}


def clamp(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


class Coach(Agent):
    def __init__(self, ctx: JobContext, frames: FrameGrabber | None, work_dir: Path, rules: str = "") -> None:
        self.rules = rules
        super().__init__(instructions=self._instructions(BuildState()))
        self.ctx = ctx
        self.frames = frames
        self.state = BuildState()
        self.work_dir = work_dir
        self._seq = 0
        self._busy = asyncio.Lock()  # one upload at a time

    def _instructions(self, state: BuildState) -> str:
        return COACH_INSTRUCTIONS + "\n\n" + state.for_model() + ("\n\n" + self.rules if self.rules else "")

    async def publish(self, topic: str, payload: dict) -> None:
        try:
            await self.ctx.room.local_participant.send_text(json.dumps(payload), topic=topic)
        except Exception:  # the screen being gone must never break the call
            log.exception("publish failed")

    async def changed(self) -> None:
        await self.publish(TOPIC_BUILD, self.state.ui())

    async def load(self, brief: Brief) -> None:
        self.state.brief = brief
        try:
            await self.update_instructions(self._instructions(self.state))
        except Exception:
            log.exception("couldn't update the coach's instructions")
        await self.changed()

    async def _refresh(self) -> None:
        try:
            await self.update_instructions(self._instructions(self.state))
        except Exception:
            log.exception("couldn't update the coach's instructions")
        await self.changed()

    # ------------------------------------------------------------------ wiring
    @function_tool
    async def show_wire(self, context: RunContext, number: int) -> str:
        """Highlight one wire of the project on the screen and make it the current one.

        Args:
            number: The wire's number from the WIRES list.
        """
        w = self.state.show(number)
        if not w:
            return f"There is no wire {number}. The project has {len(self.state.brief.wires)} wires."
        await self._refresh()
        return (f"Wire {w.n} is on screen: {w.text}. Say it in one sentence, then point_at where it goes "
                f"({w.to or 'its end'}).")

    @function_tool
    async def point_at(self, context: RunContext, description: str, label: str,
                       approx_x: float = -1.0, approx_y: float = -1.0) -> str:
        """Circle something on the person's live camera: a pin, a breadboard hole, a part. The circle follows it
        as the camera moves.

        Args:
            description: What to find, precise enough to locate, e.g. "the pin labelled D6 on the Arduino Nano".
            label: A short label shown beside the circle, e.g. "D6: yellow wire here".
            approx_x: Your rough guess 0..1 from the left, used only if precise finding isn't available.
            approx_y: Your rough guess 0..1 from the top, used only if precise finding isn't available.
        """
        frame = self.frames.jpeg_b64(max_side=960) if self.frames else None
        if not frame:
            return "The camera isn't on yet. Ask them to turn it on and point it at the board."
        loc = await vision.locate(frame, description)
        if loc is not None and loc.found:
            marker = {"x": clamp(loc.x_center), "y": clamp(loc.y_center), "w": clamp(loc.width),
                      "h": clamp(loc.height), "label": label[:60], "precise": True}
        elif loc is not None:
            return ("Couldn't clearly see that (" + (loc.note or "not in view") + "). Ask them to bring the camera "
                    "closer to it, then point again.")
        elif approx_x >= 0 and approx_y >= 0:
            marker = {"x": clamp(approx_x), "y": clamp(approx_y), "w": 0.0, "h": 0.0, "label": label[:60],
                      "precise": False}
        else:
            return "Precise pointing isn't available. Describe where it is in words."
        self._seq += 1
        marker.update({"id": self._seq, "action": "", "step_id": "", "image": "data:image/jpeg;base64," + frame})
        await self.publish(TOPIC_MARKER, marker)
        return "Circled on their camera. Tell them to look at it." + ("" if marker["precise"] else " It's approximate.")

    @function_tool
    async def check_wire(self, context: RunContext, number: int) -> str:
        """Check on the camera that a wire is connected where the project says. Marks it done if it is.

        Args:
            number: The wire's number.
        """
        w = self.state.wire(number)
        if not w:
            return f"There is no wire {number}."
        shots = await self.frames.two_frames() if self.frames else []
        if not shots:
            return "No camera picture to check. Ask them to point the camera at the wire."
        colour = f"{w.colour} " if w.colour else ""
        verdict = await vision.check_step(
            shots, f"Connect a {colour}wire from {w.from_ or 'the part'} to {w.to or 'the board'}",
            f"A {colour}wire runs from {w.from_} to {w.to}" + (f" through {w.via}" if w.via else "")
            + ", pushed fully in, with no bare metal touching a neighbouring pin.")
        if verdict.status == "done":
            self.state.mark(number, seen=True)
            await self._refresh()
            nxt = self.state.next_wire()
            return (f"Confirmed on camera: {verdict.observation}. Wire {number} is done. "
                    + (f"Next is wire {nxt.n}: {nxt.text}." if nxt else "All wires are done: do the short check "
                       "with the multimeter before power, then offer to upload the code."))
        if verdict.status == "not_done":
            return (f"Not right yet: {verdict.observation}"
                    + (f" Problems: {'; '.join(verdict.problems_seen)}." if verdict.problems_seen else "")
                    + " Tell them exactly what to change and point at the right place.")
        return (f"The camera can't tell ({verdict.observation}). Ask them to hold it closer and steady, or to "
                "confirm in words.")

    @function_tool
    async def mark_wire_done(self, context: RunContext, number: int, verified_on_camera: bool = False) -> str:
        """Mark a wire as done when the person confirms it and the camera couldn't check it.

        Args:
            number: The wire's number.
            verified_on_camera: True only if check_wire confirmed it.
        """
        w = self.state.mark(number, seen=verified_on_camera)
        if not w:
            return f"There is no wire {number}."
        await self._refresh()
        nxt = self.state.next_wire()
        return f"Wire {number} is done. " + (f"Next is wire {nxt.n}: {nxt.text}." if nxt else "All wires are done.")

    @function_tool
    async def undo_wire(self, context: RunContext, number: int) -> str:
        """Put a wire back to not done, for example when they pulled it out to fix it.

        Args:
            number: The wire's number.
        """
        if not self.state.wire(number):
            return f"There is no wire {number}."
        self.state.undo(number)
        await self._refresh()
        return f"Wire {number} is back on the list."

    # ------------------------------------------------------------------ the RepairMind screen
    @function_tool
    async def app_action(self, context: RunContext, action: str, target: str = "") -> str:
        """Do something on the person's RepairMind screen.

        Args:
            action: show_tab (target: 3d, spec, code, tools or shop), save_folder (saves the whole project folder:
                code, wiring, tests, parts list), download_pack (the build guide as one file), go_to_step (target:
                the step number).
            target: What the action needs, as above.
        """
        action = (action or "").strip()
        if action not in APP_ACTIONS:
            return f"Unknown action. Use one of: {', '.join(sorted(APP_ACTIONS))}."
        if action == "show_tab" and target not in TABS:
            return f"Unknown tab. Use one of: {', '.join(sorted(TABS))}."
        if action == "go_to_step":
            try:
                n = int(target)
            except ValueError:
                return "go_to_step needs the step number."
            if not 1 <= n <= max(1, len(self.state.brief.steps)):
                return f"There are {len(self.state.brief.steps)} steps."
            self.state.step = n
            await self.changed()
        await self.publish(TOPIC_APP, {"action": action, "target": target})
        return "Done on their screen." + (" The browser may ask where to save it." if action == "save_folder" else "")

    # ------------------------------------------------------------------ the board on this computer
    @function_tool
    async def list_ports(self, context: RunContext) -> str:
        """List the boards plugged into this computer by USB."""
        why = board.unavailable()
        if why:
            return why
        found = await board.ports()
        if not found:
            return "No board found on USB. Check the cable is a data cable, not charge-only, and try another port."
        return "; ".join(f"{p.address}: {p.board or p.label or 'unknown board'}" for p in found)

    @function_tool
    async def upload_code(self, context: RunContext, port: str = "") -> str:
        """Compile the project's code and upload it to the board over USB. Only when the person asked to upload.

        Args:
            port: The port to use, only if they named one or there are several boards, e.g. "COM5".
        """
        if self._busy.locked():
            return "An upload is already running."
        async with self._busy:
            await self.publish(TOPIC_BUILD, {**self.state.ui(), "busy": "upload"})
            r = await board.upload(self.state.brief, self.work_dir, port)
            self.state.uploaded = r.ok or self.state.uploaded
            await self.publish(TOPIC_BUILD, {**self.state.ui(), "busy": "", "log": r.text[-1500:]})
            return r.text + (" Now call read_serial to see whether it runs." if r.ok else "")

    @function_tool
    async def read_serial(self, context: RunContext, seconds: float = 6.0) -> str:
        """Listen to what the board prints over USB for a few seconds (the Serial Monitor), to check it runs.

        Args:
            seconds: How long to listen, 1 to 20.
        """
        await self.publish(TOPIC_BUILD, {**self.state.ui(), "busy": "serial"})
        r = await board.read_serial(self.state.brief, seconds)
        if r.ok:
            self.state.serial = r.text
        await self.publish(TOPIC_BUILD, {**self.state.ui(), "busy": ""})
        return r.text
