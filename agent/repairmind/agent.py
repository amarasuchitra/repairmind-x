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
    ConversationItemAddedEvent,
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

from . import ar, ask, i18n, known_fixes, parts, summary, reviewer, safety, sources, speech_guard, vision
from .audio_warmup import warm_up_resampler
from .frames import FrameGrabber
from .manuals import ManualIndex, manual_path
from .prompts import GREETING, MECHANIC_INSTRUCTIONS
from .expert import detector as expert_detector
from .expert import products as expert_products
from .session import GateResult, Hypothesis, RepairSession

load_dotenv()
log = logging.getLogger("repairmind")

AGENT_NAME = "repairmind-mechanic"
SESSIONS_DIR = Path(os.getenv("RMX_SESSIONS_DIR", "sessions"))
GEMINI_MODEL = os.getenv("RMX_GEMINI_MODEL", "gemini-3.1-flash-live-preview")
GEMINI_VOICE = os.getenv("RMX_GEMINI_VOICE", "Charon")
# google-genai 3.x defaults to the "v1" API, which has no Live endpoint (WebSocket 404).
GEMINI_API_VERSION = os.getenv("RMX_GEMINI_API_VERSION", "v1beta")

TOPIC_STATE = "rmx.state"
TOPIC_MARKER = "rmx.marker"
TOPIC_ALERT = "rmx.alert"
TOPIC_3D = "rmx.3d"
TOPIC_AR_EVENTS = "rmx.ar"
TOPIC_ASK = "rmx.ask"  # app -> agent: circle to ask, "what next?"
TOPIC_DIAGRAM = "rmx.diagram"  # agent -> app: labelled diagram on a still
TOPIC_NOTES = "rmx.notes"  # agent -> app: the call notes so far
TOPIC_PARTS = "rmx.parts"  # agent -> app: shopping searches for parts


class Mechanic(Agent):
    def __init__(self, ctx: JobContext, state: RepairSession, frames: FrameGrabber | None = None,
                 language: str = "auto", ui_language: str = "") -> None:
        super().__init__(instructions=MECHANIC_INSTRUCTIONS + "\n\n" + i18n.call_rules(language, ui_language))
        self.ctx = ctx
        self.state = state
        self.frames = frames
        self.session_path = SESSIONS_DIR / f"{state.session_id}.json"
        self._marker_seq = 0
        self.ar_target: ar.ARTarget | None = None
        self.ask_throttle = ask.Throttle()
        self.summary = summary.SummaryWriter(state, SESSIONS_DIR)

    def _manual(self) -> ManualIndex | None:
        path = manual_path(SESSIONS_DIR, self.state.session_id)
        return ManualIndex.load(path) if path.exists() else None

    # ----------------------------------------------------------------- helpers
    async def publish(self, topic: str, payload: dict) -> None:
        try:
            await self.ctx.room.local_participant.send_text(json.dumps(payload), topic=topic)
        except Exception:  # the UI being gone must never break the call
            log.exception("publish failed")

    def _match_expert(self) -> str:
        """Switch to expert mode if the confirmed model is a supported product. Returns a note for the model."""
        if not self.state.model_confirmed or not self.state.model:
            return ""
        try:
            product = expert_products.find_product(self.state.brand, self.state.model)
        except Exception:  # a broken product file must not break the call
            log.exception("product registry failed to load")
            return ""
        if product is None:
            self.state.expert_product_id = ""
            return ""
        self.state.expert_product_id = product.id
        usable = expert_products.usable_procedures(product)
        note = (f" EXPERT MODE: this is a supported product ({product.name}). Call get_expert_procedure before "
                "using general guides.")
        if not usable:
            note += " It has no reviewed procedures yet, so continue in general mode."
        return note

    async def changed(self) -> None:
        """Save, show the new state and notes, and refresh the written summary in the background."""
        self.state.save(SESSIONS_DIR)
        await self.publish(TOPIC_STATE, self.state.ui_state())
        await self.publish(TOPIC_NOTES, {"notes": summary.notes(self.state, limit=40)})
        self.summary.touch()

    async def _done(self, result: GateResult) -> str:
        await self.changed()
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
        result = self.state.identify_device(device, brand, model, model_confirmed, how_identified)
        note = (self._match_expert() + self._known_note()) if result.allowed else ""
        return await self._done(result) + note

    def _known_note(self) -> str:
        if not self.state.model_confirmed:
            return ""
        fixes = known_fixes.lookup(known_fixes.store_path(SESSIONS_DIR), self.state.brand, self.state.model)
        if not fixes:
            return ""
        return (f" There {'is' if len(fixes) == 1 else 'are'} {len(fixes)} remembered fix"
                f"{'' if len(fixes) == 1 else 'es'} for this exact model. Once you know the symptoms, call "
                "check_known_fixes.")

    @function_tool
    async def check_known_fixes(self, context: RunContext) -> str:
        """Fixes that worked before on this exact model (learned shortcuts). Call it after hearing the symptoms.
        They are leads: still confirm the diagnosis and propose every step through the gates."""
        if not self.state.model_confirmed:
            return "The model isn't confirmed. Ask for the rating label first; remembered fixes are per exact model."
        fixes = known_fixes.lookup(known_fixes.store_path(SESSIONS_DIR), self.state.brand, self.state.model,
                                   " ".join(self.state.symptoms + self.state.history_answers))
        if fixes:
            self.state._record("known_fix", diagnosis=fixes[0].get("diagnosis", ""), worked=fixes[0].get("worked", 1))
            await self.changed()
        return known_fixes.for_model(fixes)

    @function_tool
    async def find_part(self, context: RunContext, part: str, part_number: str = "") -> str:
        """Show shopping searches for a replacement part on the user's screen. The call carries on meanwhile.

        Args:
            part: Plain part name, e.g. "drive belt" or "drain pump".
            part_number: The manufacturer part number if you read it on the part or in the manual.
        """
        found = parts.find(self.state.brand, self.state.model, part, part_number)
        if not found["query"]:
            return "Say which part to search for."
        self.state.parts = [p for p in self.state.parts if p.get("query") != found["query"]][-4:] + [found]
        self.state._record("part_search", part=found["part"], query=found["query"])
        await self.publish(TOPIC_PARTS, {"parts": self.state.parts})
        await self.changed()
        return parts.for_model(found, self.state.model_confirmed)

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

    @function_tool
    async def search_manual(self, context: RunContext, query: str) -> str:
        """Search the service manual the user uploaded for this device. Cite results as their "ref"."""
        idx = self._manual()
        if idx is None:
            return ("No manual uploaded. Ask the user to tap 'Add manual (PDF)' if they have the service or "
                    "user manual, or use find_repair_guide.")
        hits = idx.search(query)
        return json.dumps(hits) if hits else "Nothing relevant in the manual for that query."

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
                           expected_result: str, source_excerpt: str = "") -> str:
        """Ask permission to give ONE repair step. Say the step only if the answer is ALLOWED.

        Args:
            text: The exact instruction you intend to say.
            source_kind: "procedure" (expert mode), "ifixit", "manual", "label" or "general_safe".
            source_ref: For procedure: "product/procedure#step". Otherwise guide URL plus step number, or
                manual page. Empty only for general_safe.
            expected_result: What the camera should show when the step is done.
            source_excerpt: The exact source text this step comes from (guide step or manual passage).
        """
        if source_kind not in ("procedure", "ifixit", "manual", "label", "general_safe"):
            return "BLOCKED (bad_source_kind). Use procedure, ifixit, manual, label or general_safe."
        key = self.state._key(text)
        if self.state.needs_review(text, source_kind) and self.state.reviews.get(key, {}).get("status") != "approve":
            frame = self.frames.jpeg_b64() if self.frames else None
            result = await reviewer.review_step(self.state, text, source_kind, source_ref, source_excerpt,
                                                expected_result, [frame] if frame else None)
            self.state.record_review(text, result.status, result.reason)
        gate = self.state.propose_step(text, source_kind, source_ref, expected_result)  # type: ignore[arg-type]
        if gate.allowed and source_kind == "procedure":
            await self._publish_3d(source_ref)
        return await self._done(gate)

    async def _publish_3d(self, ref: str) -> None:
        product = expert_products.load_all().get(self.state.expert_product_id)
        found = product.step(ref) if product else None
        if not found:
            return
        proc, st = found
        await self.publish(TOPIC_3D, {"product_id": product.id, "procedure_id": proc.id, "step_id": st.id,
                                      "highlight": st.highlight, "move": st.move, "hide": st.hide,
                                      "caption": st.text, "illustrative": product.illustrative_3d})

    # ------------------------------------------------------------- expert mode
    @function_tool
    async def get_expert_procedure(self, context: RunContext, fault: str = "", procedure_id: str = "") -> str:
        """Expert mode only: list the reviewed procedures for this product, or get one procedure's steps.

        Args:
            fault: The diagnosed fault, used to pick the best procedure when procedure_id is empty.
            procedure_id: A procedure id from the list, to get its exact steps.
        """
        product = expert_products.load_all().get(self.state.expert_product_id)
        if product is None:
            return "Not in expert mode: no supported product is confirmed. Use general sources."
        usable = expert_products.usable_procedures(product)
        if not usable:
            return "This product has no reviewed procedures. Use general sources."
        if not procedure_id:
            words = set(re.findall(r"[a-z]+", fault.lower()))
            def overlap(p) -> int:
                return len(words & set(re.findall(r"[a-z]+", " ".join([p.title, p.fault, *p.symptoms]).lower())))
            ranked = sorted(usable, key=overlap, reverse=True)
            return "Procedures (pick the one that matches the diagnosis, then call again with its id):\n" + "\n".join(
                f"- {p.id}: {p.title}. Fault: {p.fault}. Symptoms: {', '.join(p.symptoms)}" for p in ranked)
        proc = product.procedure(procedure_id)
        if proc is None or proc not in usable:
            return "No usable procedure with that id."
        lines = [f"Procedure {product.id}/{proc.id}: {proc.title} (source: {proc.source}"
                 + ("" if proc.reviewed else "; UNREVIEWED DEMO, tell the user") + ")."]
        for st in proc.steps:
            extra = []
            if st.precautions:
                extra.append("precautions: " + ", ".join(st.precautions))
            if st.tools:
                extra.append("tools: " + ", ".join(st.tools))
            if st.irreversible:
                extra.append("IRREVERSIBLE")
            if st.caution:
                extra.append("caution: " + st.caution)
            lines.append(f"- ref {product.id}/{proc.id}#{st.id}: \"{st.text}\" expected: {st.expected_result}"
                         + (f" [{'; '.join(extra)}]" if extra else ""))
        lines.append('Propose each step with source_kind="procedure", that ref, and the text EXACTLY as written.')
        return "\n".join(lines)

    @function_tool
    async def run_defect_detector(self, context: RunContext) -> str:
        """Expert mode only: run this product's trained defect detector on the current full-resolution frame.
        Ask the user to frame the part clearly in good light first. 'uncertain' means get another view."""
        product = expert_products.load_all().get(self.state.expert_product_id)
        if product is None:
            return "Not in expert mode, so there is no trained detector. Rely on what you see."
        frame = self.frames.jpeg_b64(max_side=1280) if self.frames else None
        if frame is None:
            return "No camera frame yet."
        import base64
        import io

        from PIL import Image

        image = Image.open(io.BytesIO(base64.b64decode(frame)))
        result = await asyncio.to_thread(expert_detector.detect, product,
                                         expert_products.PRODUCTS_DIR / product.id, image)
        if result.heatmap_jpeg_b64 and result.hotspot:
            await self.publish(TOPIC_MARKER, {"x": result.hotspot[0], "y": result.hotspot[1], "w": 0.0, "h": 0.0,
                                              "label": f"detector: {result.verdict}", "precise": False,
                                              "image": "data:image/jpeg;base64," + result.heatmap_jpeg_b64})
        if result.score is not None:
            self.state.record_test("Trained defect detector on the camera frame", result.for_model())
            self.state.save(SESSIONS_DIR)
        return result.for_model()

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
    async def point_at(self, context: RunContext, description: str, label: str, action: str = "",
                       approx_x: float = -1.0, approx_y: float = -1.0) -> str:
        """Point at a part on the user's camera. The app draws a box, label and optional motion arrow that
        stay on the real part as the camera moves (live AR). If it can't follow the part it shows a still.

        Args:
            description: What to find, specific enough to locate, e.g. "the lower-left Phillips screw on the cover".
            label: Short on-screen label, e.g. "this screw".
            action: Optional motion arrow for the CURRENT ACTIVE step only: press, pull, lift, turn_cw,
                turn_ccw, slide_left or slide_right. Leave empty just to point.
            approx_x: Your own rough guess 0..1 from the left, used only if precise location is unavailable.
            approx_y: Your own rough guess 0..1 from the top, used only if precise location is unavailable.
        """
        clamp = lambda v: max(0.0, min(1.0, float(v)))  # noqa: E731
        action, step_id, note = ar.gate_action(self.state, action)
        frame = self.frames.jpeg_b64(max_side=960) if self.frames else None
        loc = await vision.locate(frame, description) if frame else None
        if loc is not None and loc.found:
            marker = {"x": clamp(loc.x_center), "y": clamp(loc.y_center), "w": clamp(loc.width),
                      "h": clamp(loc.height), "label": label[:60], "precise": True}
        elif loc is not None and not loc.found:
            return ("Couldn't clearly find that in the current view (" + (loc.note or "not visible") + "). Ask the "
                    "user to move the camera so it is in view, then try again.")
        elif approx_x >= 0 and approx_y >= 0:
            marker = {"x": clamp(approx_x), "y": clamp(approx_y), "w": 0.0, "h": 0.0, "label": label[:60],
                      "precise": False}
        else:
            return "Precise pointing is unavailable. Describe the location in words instead."
        if frame:
            marker["image"] = "data:image/jpeg;base64," + frame
        self._marker_seq += 1
        marker.update({"id": self._marker_seq, "action": action, "step_id": step_id})
        self.ar_target = ar.ARTarget(self._marker_seq, description, label[:60], action, step_id)
        await self.publish(TOPIC_MARKER, marker)
        if marker["precise"]:
            return ("Marker shown on the live view and following the part. Tell the user to look at it." + note)
        return "Marker shown on a still picture. Tell the user to look at it, and say it's approximate." + note

    async def refind_marker(self, marker_id: int) -> None:
        """The app lost the part on the live view: locate it again on a fresh frame (rate-limited)."""
        t = self.ar_target
        if t is None or t.marker_id != marker_id or not t.may_refind() or self.frames is None:
            return
        t.note_refind()
        frame = self.frames.jpeg_b64(max_side=960)
        loc = await vision.locate(frame, t.description) if frame else None
        if loc is None or not loc.found:
            return  # the app keeps saying "lost"; the user is asked to point the camera back
        clamp = lambda v: max(0.0, min(1.0, float(v)))  # noqa: E731
        # Re-check the arrow: the step may have finished since.
        action, step_id, _ = ar.gate_action(self.state, t.action)
        if step_id != t.step_id:
            action, step_id = "", ""
        self._marker_seq += 1
        t.marker_id = self._marker_seq
        await self.publish(TOPIC_MARKER, {
            "x": clamp(loc.x_center), "y": clamp(loc.y_center), "w": clamp(loc.width), "h": clamp(loc.height),
            "label": t.label, "precise": True, "image": "data:image/jpeg;base64," + frame,
            "id": t.marker_id, "action": action, "step_id": step_id,
        })

    @function_tool
    async def draw_diagram(self, context: RunContext, title: str, parts: list[str], labels: list[str]) -> str:
        """Teach mode: label several parts on a still of the camera, numbered, so you can explain how
        something works or what the parts are. Use it when the user asks "what's in here?" or "explain this".

        Args:
            title: Short heading, e.g. "Inside the pump".
            parts: Up to 6 precise descriptions to find, e.g. "the white impeller in the centre".
            labels: Short on-screen labels, same order, e.g. "impeller".
        """
        n = min(len(parts), len(labels), ask.MAX_DIAGRAM_PARTS)
        if n == 0:
            return "Give at least one part and its label."
        parts, labels = [p[:200] for p in parts[:n]], [lb[:40] for lb in labels[:n]]
        frame = self.frames.jpeg_b64(max_side=1280) if self.frames else None
        if frame is None:
            return "No camera frame yet."
        locs = await vision.locate_many(frame, parts)
        if locs is None:
            return "Diagrams are unavailable right now. Explain in words, part by part."
        boxes = [ask.Box(lc.x_center, lc.y_center, lc.width, lc.height) if lc.found else None for lc in locs]
        items = ask.diagram_items(labels, boxes)
        if items:
            await self.publish(TOPIC_DIAGRAM, {"title": title[:60], "image": "data:image/jpeg;base64," + frame,
                                               "items": items})
        return ask.diagram_result(labels, boxes)

    async def answer_circle(self, req: ask.AskRequest, session: AgentSession) -> None:
        """The user circled something on the live video: mark it, look closely, and let the mechanic answer."""
        assert req.box is not None
        b = req.box
        frame = self.frames.jpeg_b64(max_side=960) if self.frames else None
        self._marker_seq += 1
        marker = {"x": b.x, "y": b.y, "w": b.w, "h": b.h, "label": "your circle", "precise": bool(frame),
                  "id": self._marker_seq, "action": "", "step_id": ""}
        if frame:
            marker["image"] = "data:image/jpeg;base64," + frame
        self.ar_target = None  # the user's own circle isn't re-found by description
        await self.publish(TOPIC_MARKER, marker)
        close = req.image_b64
        if not close:
            full = self.frames.jpeg_b64(max_side=2048) if self.frames else None
            close = ask.crop_b64(full, b) if full else ""
        ans = await vision.ask(close, ask.vision_question(req.question, self.state.device), quick=True) if close else None
        self.state._record("circle_ask", question=req.question, answer=ans.answer if ans else "")
        await self.changed()
        session.generate_reply(instructions=ask.circle_instructions(
            req.question, ans.answer if ans else None, bool(ans and ans.confident)))

    def what_next(self, session: AgentSession) -> None:
        session.generate_reply(instructions=ask.next_instructions(self.state.ui_state()))

    @function_tool
    async def read_label(self, context: RunContext) -> str:
        """Read the brand and exact model from the rating label in the current full-resolution frame.
        Ask the user to hold the camera close and steady on the label first."""
        frame = self.frames.jpeg_b64(max_side=1600) if self.frames else None
        if frame is None:
            return "No camera frame yet. Ask the user to point the camera at the label."
        reading = await vision.read_label(frame)
        if reading is None:
            return ("Close-up reading is unavailable. Ask the user to read the model number aloud, then call "
                    "identify_device with model_confirmed=true and how_identified='user said'.")
        if not reading.readable or not reading.model:
            return "Label not readable: " + (reading.advice_if_unreadable or "ask for a closer, sharper shot.")
        result = self.state.identify_device(self.state.device or "device", reading.brand or self.state.brand,
                                            reading.model, True, "label (close-up read)")
        note = (self._match_expert() + self._known_note()) if result.allowed else ""
        out = await self._done(result) + note
        return f"Label reads: {reading.brand} {reading.model}. Read it back to the user to confirm. " + out

    @function_tool
    async def look_closer(self, context: RunContext, question: str) -> str:
        """Ask a specific question about the current full-resolution frame, e.g. "is the ribbon cable fully seated?"."""
        frame = self.frames.jpeg_b64(max_side=1600) if self.frames else None
        if frame is None:
            return "No camera frame yet."
        ans = await vision.ask(frame, question)
        if ans is None:
            return "Close-up view unavailable; rely on what you can see and say if you're unsure."
        return ans.answer if ans.confident else f"Unsure: {ans.answer}. {ans.advice_if_unsure}"

    @function_tool
    async def check_step_on_camera(self, context: RunContext, step_id: str) -> str:
        """Check the active step on two full-resolution frames. Required for risky and irreversible steps.
        Ask the user to hold the camera steady on the area first."""
        step = self.state._step(step_id)
        if step is None or step.status != "active":
            return "BLOCKED (bad_id). No active step with that id."
        frames = await self.frames.two_frames() if self.frames else []
        verdict = await vision.check_step(frames, step.text, step.expected_result)
        result = self.state.record_vision_check(step_id, verdict.status, verdict.observation)
        if verdict.status == "done":
            result = self.state.report_step_result(step_id, "camera", True, verdict.observation)
        elif verdict.status == "not_done":
            result = self.state.report_step_result(step_id, "camera", False,
                                                   verdict.observation + " " + "; ".join(verdict.problems_seen))
        return await self._done(result)

    # ------------------------------------------------------- hazards & handoff
    @function_tool
    async def report_hazard(self, context: RunContext, detail: str) -> str:
        """Immediately stop the repair because of danger (smoke, burning, sparks, gas, shock, injury)."""
        return await self._done(self.state.hazard(detail))

    @function_tool
    async def record_failed_part(self, context: RunContext, part: str, function: str, failure_mode: str,
                                 certainty: str, observations: list[str], material: str = "",
                                 material_source: str = "", dimension_names: list[str] | None = None,
                                 dimension_values: list[str] | None = None, load_names: list[str] | None = None,
                                 load_values: list[str] | None = None) -> str:
        """Record a broken physical part so the user can redesign it afterwards in the design lab.

        Args:
            part: The part that failed, e.g. "door hinge clip".
            function: What it has to do, e.g. "hold the door shut against the seal".
            failure_mode: overload_fracture, fatigue, wear, corrosion, thermal, creep, buckling, electrical or unknown.
            certainty: "seen" if the break surface shows it on camera, otherwise "suspected".
            observations: What you see on the part, e.g. "crack starts at the screw hole".
            material: Material if known, e.g. "ABS plastic".
            material_source: "label", "user" or "estimated".
            dimension_names: Names of measured sizes, e.g. ["length", "wall thickness"].
            dimension_values: Same order, each with a unit, e.g. ["42 mm", "2 mm"].
            load_names: Names of loads or conditions, e.g. ["door closing force", "max temperature"].
            load_values: Same order, each with a unit, e.g. ["20 N", "60 °C"].
        """
        dims = [{"name": n, "value": v, "source": "user"} for n, v in zip(dimension_names or [], dimension_values or [])]
        loads = [{"name": n, "value": v, "source": "estimated"} for n, v in zip(load_names or [], load_values or [])]
        return await self._done(self.state.record_failed_part(part, function, failure_mode, certainty, observations,
                                                              material, material_source, dims, loads))

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


def _mode(metadata: str) -> str:
    """ "build" for a live build call, anything else is a repair call."""
    try:
        data = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError:
        return "repair"
    mode = data.get("mode") if isinstance(data, dict) else None
    return mode if mode in ("build", "guide") else "repair"


def _languages(metadata: str) -> tuple[str, str]:
    """(language, ui_language) from the dispatch metadata; anything unreadable means "auto"."""
    try:
        data = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return i18n.normalize(str(data.get("language", ""))) or "auto", i18n.normalize(str(data.get("ui_language", "")))


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    # Must run before any audio stream exists; see audio_warmup.py (Windows crash).
    warm_up_resampler()
    await ctx.connect()

    metadata = getattr(ctx.job, "metadata", "") or ""
    if _mode(metadata) == "guide":
        from .guide import live as guide_live

        language, ui_language = _languages(metadata)
        speech_code = i18n.gemini_language_code(language)
        session = AgentSession(
            llm=google.realtime.RealtimeModel(model=GEMINI_MODEL, voice=GEMINI_VOICE, api_version=GEMINI_API_VERSION,
                                              temperature=0.5, **({"language": speech_code} if speech_code else {})),
            max_tool_steps=8,
        )
        await guide_live.run(ctx, session, language, ui_language)
        return
    if _mode(metadata) == "build":
        from .coach import entry as coach_entry

        frames = FrameGrabber()
        frames.attach(ctx.room)
        language, ui_language = _languages(metadata)
        speech_code = i18n.gemini_language_code(language)
        session = AgentSession(
            llm=google.realtime.RealtimeModel(model=GEMINI_MODEL, voice=GEMINI_VOICE, api_version=GEMINI_API_VERSION,
                                              temperature=0.4, **({"language": speech_code} if speech_code else {})),
            video_sampler=VoiceActivityVideoSampler(speaking_fps=1.0, silent_fps=0.5),
            max_tool_steps=8,
        )
        safe = re.sub(r"[^a-zA-Z0-9_-]", "", ctx.room.name)[:64] or "room"
        await coach_entry.run(ctx, session, frames, language, ui_language, SESSIONS_DIR / "builds" / safe)
        return

    # Resume a dropped call: the web app reuses the room name for the same repair.
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "", ctx.room.name)[:64] or "room"
    path = SESSIONS_DIR / f"{safe_name}.json"
    state = RepairSession.load(path) if path.exists() else RepairSession(session_id=safe_name)
    resumed = path.exists()

    frames = FrameGrabber()
    frames.attach(ctx.room)

    # The web app puts the chosen language in the dispatch metadata (see token_server.py).
    language, ui_language = _languages(getattr(ctx.job, "metadata", "") or "")
    speech_code = i18n.gemini_language_code(language)

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_MODEL,
            voice=GEMINI_VOICE,
            api_version=GEMINI_API_VERSION,
            temperature=0.4,
            **({"language": speech_code} if speech_code else {}),
        ),
        # ~1 frame/second while the user talks, slower when quiet: enough context, low cost.
        video_sampler=VoiceActivityVideoSampler(speaking_fps=1.0, silent_fps=0.5),
        max_tool_steps=6,
    )
    mechanic = Mechanic(ctx, state, frames, language, ui_language)

    async def _final_summary(*_args) -> None:
        await mechanic.summary.flush()  # the summary is ready the moment the call ends
        try:
            if await asyncio.to_thread(known_fixes.record, known_fixes.store_path(SESSIONS_DIR), state):
                log.info("remembered this fix for %s %s", state.brand, state.model)
        except Exception:
            log.exception("couldn't remember the fix")

    ctx.add_shutdown_callback(_final_summary)

    # Live AR: the app tells us when it loses the part it was tracking, so we can find it again.
    def _on_ar(reader, participant_identity: str) -> None:
        async def handle() -> None:
            try:
                msg = json.loads(await reader.read_all())
                if msg.get("event") == "lost":
                    await mechanic.refind_marker(int(msg.get("id", 0)))
            except Exception:
                log.exception("AR message failed")

        asyncio.create_task(handle())

    ctx.room.register_text_stream_handler(TOPIC_AR_EVENTS, _on_ar)

    # Circle to ask and "What next?" from the call screen. One at a time, so taps can't flood the model.
    def _on_ask(reader, participant_identity: str) -> None:
        async def handle() -> None:
            if not mechanic.ask_throttle.try_start():
                return
            try:
                req = ask.parse_ask(await reader.read_all())
                if req is None or state.hazard_stop:
                    return  # during a hazard stop nothing distracts from it
                if req.kind == "next":
                    mechanic.what_next(session)
                else:
                    await mechanic.answer_circle(req, session)
            except Exception:
                log.exception("ask failed")
            finally:
                mechanic.ask_throttle.done()

        asyncio.create_task(handle())

    ctx.room.register_text_stream_handler(TOPIC_ASK, _on_ask)

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
            session.generate_reply(instructions=i18n.say_in(language, ui_language, safety.HAZARD_STOP_MESSAGE))

        asyncio.create_task(stop())

    # Second safety net: check what the mechanic actually said against the gates.
    @session.on("conversation_item_added")
    def _on_item(ev: ConversationItemAddedEvent) -> None:
        item = ev.item
        if getattr(item, "role", None) != "assistant":
            return
        text = getattr(item, "text_content", None) or ""
        violation = speech_guard.check(text, state)
        if not violation:
            return
        state._record("speech_guard", kind=violation.kind, sentence=violation.sentence)
        state.save(SESSIONS_DIR)

        async def correct() -> None:
            await session.interrupt(force=True)
            session.generate_reply(instructions=(
                "You just said something your safety rules don't allow (" + violation.detail + "): \""
                + violation.sentence + "\". " + i18n.say_in(language, ui_language, speech_guard.CORRECTIONS[violation.kind])
                + " Then follow the gates: use propose_step before giving any step."))

        asyncio.create_task(correct())

    await session.start(
        agent=mechanic,
        room=ctx.room,
        room_options=room_io.RoomOptions(video_input=True),
    )
    await mechanic.publish(TOPIC_STATE, state.ui_state())
    if state.parts:
        await mechanic.publish(TOPIC_PARTS, {"parts": state.parts})
    if resumed:
        session.generate_reply(instructions=(
            "The call dropped and the user is back. Briefly say where you were, using this state: "
            + json.dumps(state.ui_state()) + ". Ask them to show the device again before continuing."
            + i18n.greeting_language(language, ui_language)))
    else:
        session.generate_reply(instructions=GREETING + i18n.greeting_language(language, ui_language))


if __name__ == "__main__":
    cli.run_app(server)
