"""Repair-guide lookup.

Phase 1 uses iFixit's public API. iFixit content is CC BY-NC-SA: fine for this
prototype, but a commercial launch needs iFixit's paid API plan or a licence,
and their terms forbid training AI models on the content. From 1 January 2027
the API needs a key (set IFIXIT_API_KEY).
"""

from __future__ import annotations

import os
import re

import httpx

IFIXIT = "https://www.ifixit.com/api/2.0"
TIMEOUT = httpx.Timeout(8.0)


def _headers() -> dict:
    h = {"User-Agent": "RepairMindX-prototype/0.1"}
    key = os.getenv("IFIXIT_API_KEY")
    if key:
        h["Authorization"] = f"api {key}"
    return h


def _clean(text: str | None, limit: int = 400) -> str:
    text = re.sub(r"<[^>]+>", "", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


async def search_guides(query: str, limit: int = 5) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=_headers()) as c:
        r = await c.get(f"{IFIXIT}/search/{query}", params={"filter": "guide", "limit": limit})
        r.raise_for_status()
        out = []
        for item in r.json().get("results", [])[:limit]:
            out.append({
                "guide_id": item.get("guideid"),
                "title": item.get("title"),
                "device": item.get("category"),
                "difficulty": item.get("difficulty"),
                "url": item.get("url"),
                "summary": _clean(item.get("summary")),
            })
        return out


async def get_guide_steps(guide_id: int, max_steps: int = 40) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT, headers=_headers()) as c:
        r = await c.get(f"{IFIXIT}/guides/{guide_id}")
        r.raise_for_status()
        g = r.json()
    steps = []
    for i, st in enumerate(g.get("steps", [])[:max_steps], start=1):
        lines = [_clean(l.get("text_rendered") or l.get("text_raw"), 300) for l in st.get("lines", [])]
        cautions = [_clean(l.get("text_rendered") or l.get("text_raw"), 300)
                    for l in st.get("lines", []) if l.get("bullet") in ("icon_caution", "icon_note", "icon_reminder")]
        steps.append({"n": i, "title": _clean(st.get("title"), 120), "lines": [l for l in lines if l],
                      "cautions": [c for c in cautions if c]})
    return {
        "guide_id": guide_id,
        "title": g.get("title"),
        "device": g.get("category"),
        "url": g.get("url"),
        "difficulty": g.get("difficulty"),
        "tools": [t.get("text") for t in g.get("tools", [])],
        "parts": [p.get("text") for p in g.get("parts", [])],
        "steps": steps,
        "license": "CC BY-NC-SA 3.0, iFixit (prototype use only)",
    }
