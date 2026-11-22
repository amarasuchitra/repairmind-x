"""Close-up vision: read labels, locate parts and check steps on full-resolution frames.

The live voice model sees about one low-resolution frame per second, which is enough to talk but not
to read a rating label or judge whether a clip is seated. These helpers send the newest full frame to
a vision model (Claude, or a free Gemini model; see checker.py) with a narrow question and a structured
answer.

Step checks require TWO frames taken a moment apart to agree, with high confidence, before a step
counts as verified on camera. Anything else comes back as "unclear", and the mechanic asks for a
better view. When no vision model is configured, every check returns "unavailable" (fails closed).
"""

from __future__ import annotations

import logging
from typing import Literal

from pydantic import BaseModel, Field

from . import checker

log = logging.getLogger("repairmind.vision")

STEP_CONFIDENCE = 0.8


class LabelReading(BaseModel):
    readable: bool
    brand: str = ""
    model: str = ""
    other_text: str = ""
    advice_if_unreadable: str = ""


class Answer(BaseModel):
    answer: str
    confident: bool
    advice_if_unsure: str = ""


class Location(BaseModel):
    found: bool
    x_center: float = Field(0.0, description="0 = left edge, 1 = right edge")
    y_center: float = Field(0.0, description="0 = top edge, 1 = bottom edge")
    width: float = Field(0.0, description="fraction of image width")
    height: float = Field(0.0, description="fraction of image height")
    note: str = ""


class StepCheck(BaseModel):
    outcome: Literal["done", "not_done", "unclear"]
    confidence: float = Field(description="0..1")
    observation: str
    problems_seen: list[str] = Field(default_factory=list)


class StepVerdict(BaseModel):
    status: Literal["done", "not_done", "unclear", "unavailable"]
    observation: str
    problems_seen: list[str] = Field(default_factory=list)


VISION_SYSTEM = ("You inspect photos from a live repair video call. Describe only what is actually visible. "
                 "If the view is blurry, dark, cropped or ambiguous, say so instead of guessing.")


class GeminiBox(BaseModel):
    """Gemini's native detection format: box_2d = [ymin, xmin, ymax, xmax] scaled 0..1000."""
    found: bool
    box_2d: list[int] = Field(default_factory=list)
    note: str = ""


def available() -> bool:
    return checker.provider() is not None


async def _parse(frames_b64: list[str], prompt: str, schema: type[BaseModel]) -> BaseModel | None:
    res = await checker.parse(VISION_SYSTEM, frames_b64, prompt, schema, "vision")
    return None if res.refused or res.error else res.parsed


async def read_label(frame_b64: str) -> LabelReading | None:
    if not available():
        return None
    return await _parse([frame_b64], "Read the product rating label or nameplate in this photo: brand and exact "
                        "model number. Copy characters exactly; if any character is uncertain, mark the label "
                        "not readable and say how to get a better shot.", LabelReading)


async def ask(frame_b64: str, question: str) -> Answer | None:
    if not available():
        return None
    return await _parse([frame_b64], f"Question about this photo: {question}", Answer)


async def locate(frame_b64: str, description: str) -> Location | None:
    if not available():
        return None
    if checker.provider() == "gemini":
        # Gemini is trained to output boxes in this exact format, which is more accurate than fractions.
        g = await _parse([frame_b64], f"Detect: {description}. Return found and box_2d as [ymin, xmin, ymax, "
                         "xmax] normalised to 0-1000. If it's not clearly visible, set found=false.", GeminiBox)
        if not isinstance(g, GeminiBox):
            return None
        return gemini_box_to_location(g)
    return await _parse([frame_b64], f"Find this in the photo: {description}. Give its bounding box as fractions "
                        "of the image size. If it's not clearly visible, set found=false.", Location)


def gemini_box_to_location(g: GeminiBox) -> Location:
    if not g.found or len(g.box_2d) != 4:
        return Location(found=False, note=g.note or "not visible")
    ymin, xmin, ymax, xmax = (max(0, min(1000, int(v))) / 1000 for v in g.box_2d)
    if xmax <= xmin or ymax <= ymin:
        return Location(found=False, note="invalid box")
    return Location(found=True, x_center=(xmin + xmax) / 2, y_center=(ymin + ymax) / 2,
                    width=xmax - xmin, height=ymax - ymin, note=g.note)


async def check_step(frames_b64: list[str], step_text: str, expected_result: str) -> StepVerdict:
    """Both frames must independently show the step done with high confidence."""
    if not available():
        return StepVerdict(status="unavailable", observation="No vision model configured.")
    if len(frames_b64) < 2:
        return StepVerdict(status="unclear", observation="Not enough camera frames yet. Ask the user to hold "
                                                         "the camera steady on the area.")
    prompt = (f"The user was asked to do this repair step: \"{step_text}\".\nWhen done correctly, the camera "
              f"should show: \"{expected_result}\".\nJudge only from this photo: is the step done correctly? "
              "List anything wrong you see (broken clip, part missing, wrong orientation, loose screw).")
    results: list[StepCheck] = []
    for f in frames_b64[:2]:
        r = await _parse([f], prompt, StepCheck)
        if r is None:
            return StepVerdict(status="unavailable", observation="The vision check could not run.")
        results.append(r)  # type: ignore[arg-type]

    problems = [p for r in results for p in r.problems_seen]
    observation = " / ".join(r.observation for r in results)
    if any(r.outcome == "not_done" and r.confidence >= 0.6 for r in results):
        return StepVerdict(status="not_done", observation=observation, problems_seen=problems)
    if problems:
        return StepVerdict(status="unclear", observation=observation, problems_seen=problems)
    if all(r.outcome == "done" and r.confidence >= STEP_CONFIDENCE for r in results):
        return StepVerdict(status="done", observation=observation)
    return StepVerdict(status="unclear", observation=observation, problems_seen=problems)
