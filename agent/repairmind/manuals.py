"""Service-manual search for the live call.

The user (or a technician) uploads the device's PDF manual during the call. We split it into page-tagged
passages and search them with BM25, so every manual-based step can cite "manual p.N".
"""

from __future__ import annotations

import io
import json
import math
import re
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

_WORD = re.compile(r"[a-z0-9]+(?:[-.][a-z0-9]+)*")
_STOP = set("""a an the and or of to in on for with by at from is are be was were it this that these those as
if then than into out up down over under your you we our not no can will should must may do does""".split())

CHUNK_CHARS = 900
OVERLAP_CHARS = 150


@dataclass
class Passage:
    page: int
    text: str


def _tokens(text: str) -> list[str]:
    return [t for t in _WORD.findall(text.lower()) if t not in _STOP]


def split_pages(pages: list[str]) -> list[Passage]:
    out: list[Passage] = []
    for i, page in enumerate(pages, start=1):
        text = re.sub(r"\s+", " ", page).strip()
        if not text:
            continue
        start = 0
        while start < len(text):
            out.append(Passage(i, text[start:start + CHUNK_CHARS]))
            if start + CHUNK_CHARS >= len(text):
                break
            start += CHUNK_CHARS - OVERLAP_CHARS
    return out


def pdf_pages(data: bytes) -> list[str]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return [(p.extract_text() or "") for p in reader.pages]


class ManualIndex:
    def __init__(self, title: str, passages: list[Passage]) -> None:
        self.title = title
        self.passages = passages
        self._docs = [_tokens(p.text) for p in passages]
        self._df = Counter(t for d in self._docs for t in set(d))
        self._avg = (sum(len(d) for d in self._docs) / len(self._docs)) if self._docs else 1.0

    @classmethod
    def from_pdf(cls, title: str, data: bytes) -> "ManualIndex":
        return cls(title, split_pages(pdf_pages(data)))

    def search(self, query: str, k: int = 4) -> list[dict]:
        q = _tokens(query)
        if not q or not self._docs:
            return []
        n = len(self._docs)
        k1, b = 1.5, 0.75
        scores: list[tuple[float, int]] = []
        for i, doc in enumerate(self._docs):
            tf = Counter(doc)
            s = 0.0
            for t in q:
                if t not in tf:
                    continue
                idf = math.log(1 + (n - self._df[t] + 0.5) / (self._df[t] + 0.5))
                s += idf * tf[t] * (k1 + 1) / (tf[t] + k1 * (1 - b + b * len(doc) / self._avg))
            if s > 0:
                scores.append((s, i))
        scores.sort(reverse=True)
        return [{"page": self.passages[i].page, "ref": f"{self.title} p.{self.passages[i].page}",
                 "score": round(s, 2), "text": self.passages[i].text} for s, i in scores[:k]]

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"title": self.title, "passages": [asdict(p) for p in self.passages]}))

    @classmethod
    def load(cls, path: Path) -> "ManualIndex":
        raw = json.loads(path.read_text())
        return cls(raw["title"], [Passage(**p) for p in raw["passages"]])


def manual_path(sessions_dir: Path, room: str) -> Path:
    return sessions_dir / f"{room}.manual.json"
