"""Which model runs the second-opinion review and the close-up vision checks.

Two providers, both returning the same structured answers:

- ``anthropic``: Claude. Needs ANTHROPIC_API_KEY (paid).
- ``gemini``: a Gemini model on the free tier of the Google AI API, using the GOOGLE_API_KEY the live
  voice already needs. It is a different model from the live voice model and gets its own strict
  reviewer prompt, so it is still a second opinion, though from the same model family.

``RMX_CHECK_PROVIDER`` picks one: ``auto`` (default: Claude if its key is set, else Gemini if the Google
key is set), ``anthropic``, ``gemini`` or ``off``. With no provider, every check is "unavailable" and the
session blocks the steps that need one. The gates never relax because a provider is missing.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

log = logging.getLogger("repairmind.checker")

Provider = Literal["anthropic", "gemini"]
Purpose = Literal["review", "vision"]

ANTHROPIC_MODEL = {"review": os.getenv("RMX_REVIEW_MODEL", "claude-opus-5-5"),
                   "vision": os.getenv("RMX_VISION_MODEL", "claude-opus-5-5")}
GEMINI_MODEL = os.getenv("RMX_GEMINI_CHECK_MODEL", "gemini-2.5-flash")


def _anthropic_key() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN"))


def _google_key() -> str:
    return os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY") or ""


def provider() -> Provider | None:
    choice = os.getenv("RMX_CHECK_PROVIDER", "auto").strip().lower()
    if choice == "off":
        return None
    if choice == "anthropic":
        return "anthropic" if _anthropic_key() else None
    if choice == "gemini":
        return "gemini" if _google_key() else None
    if _anthropic_key():
        return "anthropic"
    if _google_key():
        return "gemini"
    return None


@dataclass
class Result:
    parsed: BaseModel | None
    refused: bool = False
    error: str = ""


async def parse(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], purpose: Purpose,
                effort: str = "medium", timeout: float = 30.0) -> Result:
    """One structured call to the configured provider. Never raises: failures come back as errors."""
    p = provider()
    if p is None:
        return Result(None, error="No checking model configured (set GOOGLE_API_KEY or ANTHROPIC_API_KEY).")
    try:
        if p == "anthropic":
            return await _anthropic(system, frames_b64, text, schema, purpose, effort, timeout)
        return await _gemini(system, frames_b64, text, schema, timeout)
    except Exception as e:  # network, quota, bad response: fail closed
        log.warning("%s check failed: %s", p, e)
        return Result(None, error=f"{p} check failed: {type(e).__name__}")


async def _anthropic(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], purpose: Purpose,
                     effort: str, timeout: float) -> Result:
    import anthropic

    content: list[dict] = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": f}}
                           for f in frames_b64]
    content.append({"type": "text", "text": text})
    client = anthropic.AsyncAnthropic(timeout=timeout, max_retries=1)
    try:
        resp = await client.messages.parse(
            model=ANTHROPIC_MODEL[purpose], max_tokens=4000, system=system,
            output_config={"effort": effort}, messages=[{"role": "user", "content": content}],
            output_format=schema,
        )
    except anthropic.APIConnectionError as e:
        return Result(None, error=f"unreachable: {e}")
    except anthropic.APIStatusError as e:
        return Result(None, error=f"error {e.status_code}")
    if resp.stop_reason == "refusal":
        return Result(None, refused=True)
    return Result(resp.parsed_output)


async def _gemini(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], timeout: float) -> Result:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=_google_key(),
                          http_options=types.HttpOptions(timeout=int(timeout * 1000)))
    parts = [types.Part.from_bytes(data=base64.b64decode(f), mime_type="image/jpeg") for f in frames_b64]
    parts.append(types.Part.from_text(text=text))
    resp = await client.aio.models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            system_instruction=system, temperature=0.1,
            response_mime_type="application/json", response_schema=schema,
        ),
    )
    blocked = getattr(getattr(resp, "prompt_feedback", None), "block_reason", None)
    finish = str(getattr((resp.candidates or [None])[0], "finish_reason", "") or "")
    if blocked or "SAFETY" in finish or "PROHIBITED" in finish:
        return Result(None, refused=True)
    parsed = resp.parsed
    if isinstance(parsed, BaseModel):
        return Result(parsed)
    raw = resp.text or ""
    return Result(schema.model_validate_json(raw)) if raw else Result(None, error="empty answer")
