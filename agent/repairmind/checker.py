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

import asyncio
import base64
import logging
import os
import random
import time
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

log = logging.getLogger("repairmind.checker")

Provider = Literal["anthropic", "gemini"]
Purpose = Literal["review", "vision", "design", "translate", "guide"]

ANTHROPIC_MODEL = {"review": os.getenv("RMX_REVIEW_MODEL", "claude-opus-5-5"),
                   "vision": os.getenv("RMX_VISION_MODEL", "claude-opus-5-5"),
                   "design": os.getenv("RMX_DESIGN_MODEL", "claude-opus-5-5"),
                   "translate": os.getenv("RMX_TRANSLATE_MODEL", "claude-opus-5-5"),
                   "guide": os.getenv("RMX_GUIDE_MODEL", "claude-opus-5-5")}
GEMINI_MODEL = os.getenv("RMX_GEMINI_CHECK_MODEL", "gemini-3.5-flash")


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
    model: str = ""  # which model answered (or was tried last)


# ---- retries and backup models ------------------------------------------------------------------------------
#
# Free-tier Gemini often answers 503 "model is overloaded" or 429 "quota", and a single failed call used to end the
# request. Now each call is retried with exponential backoff and jitter, then handed to backup models: other Gemini
# models, then the other provider when its key is set and RMX_CHECK_PROVIDER is "auto". Errors that retrying can't
# fix (bad request, refused, bad key) are not retried on the same model.

def _models(var: str, default: str) -> list[str]:
    return [m.strip() for m in os.getenv(var, default).split(",") if m.strip()]


# Backups for every purpose. Must be ids the API offers (the "-latest" aliases 404 on the SDK's default API).
GEMINI_FALLBACKS = _models("RMX_GEMINI_FALLBACK_MODELS", "gemini-3.8-flash")
# Extra backups for design, analysis and translation only. A lighter model is fine for drafting a design that the
# page then checks itself, but not for the safety second opinion or camera checks, so those never use these.
GEMINI_DESIGN_FALLBACKS = _models("RMX_GEMINI_DESIGN_FALLBACK_MODELS", "gemini-3.5-flash-lite")
ATTEMPTS_PER_MODEL = max(1, int(os.getenv("RMX_MODEL_ATTEMPTS", "3")))
# How long one call may take in total, across every retry and backup: a multiple of its per-request timeout,
# capped in seconds so a busy provider can't keep the page waiting for minutes.
BUDGET = {"review": 1.5, "vision": 1.5, "design": 2.0, "translate": 2.0, "guide": 2.0}
MAX_SECONDS = {"review": 60.0, "vision": 45.0, "design": float(os.getenv("RMX_DESIGN_MAX_SECONDS", "240")), "translate": 90.0,
               # the build guide is a conversation: a reply that takes minutes is no reply
               "guide": float(os.getenv("RMX_GUIDE_MAX_SECONDS", "75"))}


_sleep = asyncio.sleep


class _Failure(Exception):
    """One failed attempt, classified. ``transient`` failures are worth retrying on the same model."""

    def __init__(self, kind: str, detail: str, transient: bool):
        super().__init__(detail)
        self.kind, self.detail, self.transient = kind, detail, transient


def _classify(e: Exception) -> _Failure:
    """Turn any provider exception into a plain-language failure."""
    if isinstance(e, _Failure):
        return e
    code = getattr(e, "code", None) or getattr(e, "status_code", None)
    try:
        code = int(code) if code is not None else None
    except (TypeError, ValueError):
        code = None
    name = type(e).__name__
    text = " ".join(str(e).split())[:300]
    if isinstance(e, (asyncio.TimeoutError, TimeoutError)) or "Timeout" in name:
        return _Failure("timeout", "took too long to answer", True)
    if "Connection" in name or "Connect" in name or isinstance(e, ConnectionError):
        return _Failure("unreachable", "couldn't be reached (network)", True)
    if code == 429 or "RESOURCE_EXHAUSTED" in text or "quota" in text.lower():
        return _Failure("quota", "is rate-limited or out of free quota (429)", True)
    if code in (500, 502, 503, 504, 529) or name in ("ServerError", "InternalServerError", "OverloadedError"):
        return _Failure("overloaded", f"is overloaded or having trouble ({code or name})", True)
    if code in (401, 403) or "API_KEY" in text or "PERMISSION_DENIED" in text:
        return _Failure("key", f"rejected the API key ({code})", False)
    if code == 404 or "not found" in text.lower():
        return _Failure("model", "doesn't offer this model to this key (404)", False)
    if code == 400 or name in ("ClientError", "BadRequestError"):
        return _Failure("request", f"rejected the request (400): {text[:160]}", False)
    if isinstance(e, (ValueError,)) or "ValidationError" in name:
        return _Failure("shape", "answered in a shape that didn't fit (incomplete or invalid JSON)", False)
    return _Failure("other", f"failed ({name}: {text[:120]})", True)


def _chain(p: Provider, purpose: Purpose) -> list[tuple[Provider, str]]:
    """The models to try, in order: the configured one first, then backups."""
    out: list[tuple[Provider, str]] = []
    extra = GEMINI_DESIGN_FALLBACKS if purpose in ("design", "translate", "guide") else []
    gem = list(dict.fromkeys([GEMINI_MODEL, *GEMINI_FALLBACKS, *extra]))
    if p == "anthropic":
        out.append(("anthropic", ANTHROPIC_MODEL[purpose]))
        if os.getenv("RMX_CHECK_PROVIDER", "auto").strip().lower() == "auto" and _google_key():
            out += [("gemini", m) for m in gem]
    else:
        out += [("gemini", m) for m in gem]
        if os.getenv("RMX_CHECK_PROVIDER", "auto").strip().lower() == "auto" and _anthropic_key():
            out.append(("anthropic", ANTHROPIC_MODEL[purpose]))
    return out


def _label(p: Provider) -> str:
    return "Claude" if p == "anthropic" else "Gemini"


def _explain(tried: list[tuple[Provider, str, _Failure]], elapsed: float) -> str:
    """One plain sentence on what went wrong, which models were tried and what to do."""
    first_p = tried[0][0]
    kinds = {f.kind for _, _, f in tried}
    per_model: dict[str, tuple[int, str]] = {}
    for _, m, f in tried:
        n, _ = per_model.get(m, (0, ""))
        per_model[m] = (n + 1, f.detail)
    names = [f"{m} {d}" + (f" ({n} tries)" if n > 1 else "") for m, (n, d) in per_model.items()]
    advice = ""
    if kinds <= {"overloaded", "timeout", "unreachable", "other"}:
        advice = " This is usually temporary: try again in a minute."
    elif "quota" in kinds:
        advice = " Per-minute limits reset within a minute and the free daily quota resets each day; a paid key avoids it."
    elif "key" in kinds:
        advice = " Check the API key in agent/.env."
    elif "model" in kinds:
        advice = " Set RMX_GEMINI_CHECK_MODEL to a model your key offers."
    if len({p for p, _, _ in tried}) == 1 and not (_anthropic_key() and _google_key()):
        advice += " Adding the other provider's key (ANTHROPIC_API_KEY or GOOGLE_API_KEY) gives an automatic backup."
    return f"{_label(first_p)} check failed after {len(tried)} tries in {elapsed:.0f} s: " + "; ".join(names) + "." + advice


async def parse(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], purpose: Purpose,
                effort: str = "medium", timeout: float = 30.0, max_tokens: int = 4000) -> Result:
    """One structured answer from the configured provider, with retries and backup models.

    Never raises: failures come back as a plain-language error. A refusal is final and is not retried on
    another model (the gates treat a refusal as "no", so shopping for a yes would defeat them).
    """
    p = provider()
    if p is None:
        return Result(None, error="No checking model configured (set GOOGLE_API_KEY or ANTHROPIC_API_KEY).")
    start = time.monotonic()
    budget = min(timeout * BUDGET.get(purpose, 2.0), MAX_SECONDS.get(purpose, 240.0))
    tried: list[tuple[Provider, str, _Failure]] = []
    for prov, model in _chain(p, purpose):
        for attempt in range(ATTEMPTS_PER_MODEL):
            left = budget - (time.monotonic() - start)
            if left < 3:
                break
            try:
                if prov == "anthropic":
                    res = await _anthropic(system, frames_b64, text, schema, purpose, effort, min(timeout, left),
                                           max_tokens, model)
                else:
                    res = await _gemini(system, frames_b64, text, schema, min(timeout, left), model)
                res.model = model
                if tried:
                    log.info("%s answered after %d failed tries", model, len(tried))
                return res
            except Exception as e:  # network, quota, bad response: classify, then retry or move on
                f = _classify(e)
                log.warning("%s %s attempt %d failed: %s (%s)", prov, model, attempt + 1, f.detail, e)
                tried.append((prov, model, f))
                if not f.transient:
                    break
                if attempt + 1 < ATTEMPTS_PER_MODEL:
                    pause = min(8.0, 1.0 * 2 ** attempt) * (0.5 + random.random())
                    if budget - (time.monotonic() - start) - pause < 3:
                        break
                    await _sleep(pause)
        if budget - (time.monotonic() - start) < 3:
            break
    if not tried:
        return Result(None, error=f"{_label(p)} check failed: no time left to try")
    return Result(None, error=_explain(tried, time.monotonic() - start), model=tried[-1][1])


async def _anthropic(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], purpose: Purpose,
                     effort: str, timeout: float, max_tokens: int = 4000, model: str = "") -> Result:
    import anthropic

    content: list[dict] = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": f}}
                           for f in frames_b64]
    content.append({"type": "text", "text": text})
    # retries are done above, across models, so the SDK's own are off
    client = anthropic.AsyncAnthropic(timeout=timeout, max_retries=0)
    resp = await client.messages.parse(
        model=model or ANTHROPIC_MODEL[purpose], max_tokens=max_tokens, system=system,
        output_config={"effort": effort}, messages=[{"role": "user", "content": content}],
        output_format=schema,
    )
    if resp.stop_reason == "refusal":
        return Result(None, refused=True)
    if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
        raise _Failure("shape", "ran out of room before finishing the answer", False)
    return Result(resp.parsed_output)


async def _gemini(system: str, frames_b64: list[str], text: str, schema: type[BaseModel], timeout: float,
                  model: str = "") -> Result:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=_google_key(),
                          http_options=types.HttpOptions(timeout=int(timeout * 1000)))
    parts = [types.Part.from_bytes(data=base64.b64decode(f), mime_type="image/jpeg") for f in frames_b64]
    parts.append(types.Part.from_text(text=text))
    resp = await asyncio.wait_for(client.aio.models.generate_content(
        model=model or GEMINI_MODEL,
        contents=[types.Content(role="user", parts=parts)],
        config=types.GenerateContentConfig(
            system_instruction=system, temperature=0.1,
            response_mime_type="application/json", response_schema=schema,
        ),
    ), timeout=timeout + 5)
    blocked = getattr(getattr(resp, "prompt_feedback", None), "block_reason", None)
    finish = str(getattr((resp.candidates or [None])[0], "finish_reason", "") or "")
    if blocked or "SAFETY" in finish or "PROHIBITED" in finish:
        return Result(None, refused=True)
    parsed = resp.parsed
    if isinstance(parsed, BaseModel):
        return Result(parsed)
    raw = resp.text or ""
    if not raw:
        raise _Failure("shape", "returned an empty answer" + (" (cut off: MAX_TOKENS)" if "MAX_TOKENS" in finish else ""), True)
    try:
        return Result(schema.model_validate_json(raw))
    except ValueError:
        if "MAX_TOKENS" in finish:
            raise _Failure("shape", "ran out of room before finishing the answer (MAX_TOKENS)", False)
        raise
