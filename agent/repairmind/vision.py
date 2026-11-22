"""Close-up vision: read labels, locate parts and check steps on full-resolution frames.

The live voice model sees about one low-resolution frame per second, which is enough to talk but not
to read a rating label or judge whether a clip is seated. These helpers send the newest full frame to
a vision model (Claude) with a narrow question and a structured answer.

Step checks require TWO frames taken a moment apart to agree, with high confidence, before a step
counts as verified on camera. Anything else comes back as "unclear", and the mechanic asks for a
better view. When no vision model is configured, every check returns "unavailable" (fails closed).
"""

from __future__ import annotations

import logging
import os
from typing import Literal

from pydantic import BaseModel, Field

log = logging.getLogger("repairmind.vision")

VISION_MODEL = os.getenv("RMX_VISION_MODEL", "claude-opus-5-5")
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


def available() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


async def _parse(frames_b64: list[str], prompt: str, schema: type[BaseModel]) -> BaseModel | None:
    import anthropic

    content: list[dict] = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": f}}
                           for f in frames_b64]
    content.append({"type": "text", "text": prompt})
    try:
        client = anthropic.AsyncAnthropic(timeout=25.0, max_retries=1)
        resp = await client.messages.parse(
            model=VISION_MODEL,
            max_tokens=2000,
            system=("You inspect photos from a live repair video call. Describe only what is actually visible. "
                    "If the view is blurry, dark, cropped or ambiguous, say so instead of guessing."),
            output_config={"effort": "medium"},
            messages=[{"role": "user", "content": content}],
            output_format=schema,
        )
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
        log.warning("vision call failed: %s", e)
        return None
    if resp.stop_reason == "refusal":
        return None
    return resp.parsed_output


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
    return await _parse([frame_b64], f"Find this in the photo: {description}. Give its bounding box as fractions "
                        "of the image size. If it's not clearly visible, set found=false.", Location)


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
