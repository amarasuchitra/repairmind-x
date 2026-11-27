"""What the coach knows about the build, and where the person is in it. Pure data, so it can be tested.

The web app sends the brief when the call starts: the parts, every wire (numbered, with its colour), the board's
pins, the build steps and the generated code. The coach never invents a wire or a pin: it reads them from here.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field

FQBN = {"esp32": "esp32:esp32:esp32", "nano": "arduino:avr:nano"}


class Wire(BaseModel):
    n: int
    text: str
    from_: str = Field("", alias="from")
    to: str = ""
    colour: str = ""
    via: str = ""

    model_config = {"populate_by_name": True}


class Pin(BaseModel):
    pin: str
    use: str


class Step(BaseModel):
    title: str
    detail: list[str] = Field(default_factory=list)
    safety: list[str] = Field(default_factory=list)


class Brief(BaseModel):
    name: str = "Project"
    board: Literal["esp32", "nano", ""] = ""
    parts: list[str] = Field(default_factory=list, max_length=40)
    wires: list[Wire] = Field(default_factory=list, max_length=80)
    pins: list[Pin] = Field(default_factory=list, max_length=60)
    steps: list[Step] = Field(default_factory=list, max_length=40)
    sketch: str = "sketch"
    code: str = Field("", max_length=200_000)
    libs: list[str] = Field(default_factory=list, max_length=20)

    @property
    def fqbn(self) -> str:
        return FQBN.get(self.board, "")

    @property
    def sketch_name(self) -> str:
        """A safe folder and file name: the Arduino IDE needs the folder and the .ino to match."""
        s = re.sub(r"\.ino$", "", self.sketch or "")
        s = re.sub(r"[^A-Za-z0-9_]", "_", s).strip("_")[:48]
        return s if s and not s[0].isdigit() else f"sketch_{s}" if s else "sketch"


class BuildState(BaseModel):
    brief: Brief = Field(default_factory=Brief)
    done: list[int] = Field(default_factory=list)
    checked: list[int] = Field(default_factory=list, description="wires the camera confirmed")
    current: int = 0
    step: int = 0
    uploaded: bool = False
    serial: str = ""

    def wire(self, n: int) -> Wire | None:
        return next((w for w in self.brief.wires if w.n == n), None)

    def next_wire(self) -> Wire | None:
        return next((w for w in self.brief.wires if w.n not in self.done), None)

    def show(self, n: int) -> Wire | None:
        w = self.wire(n)
        if w:
            self.current = n
        return w

    def mark(self, n: int, seen: bool) -> Wire | None:
        w = self.wire(n)
        if not w:
            return None
        if n not in self.done:
            self.done.append(n)
        if seen and n not in self.checked:
            self.checked.append(n)
        nxt = self.next_wire()
        self.current = nxt.n if nxt else 0
        return w

    def undo(self, n: int) -> None:
        self.done = [x for x in self.done if x != n]
        self.checked = [x for x in self.checked if x != n]
        self.current = n

    @property
    def wired(self) -> bool:
        return bool(self.brief.wires) and len(self.done) >= len(self.brief.wires)

    def ui(self) -> dict:
        return {
            "name": self.brief.name, "current": self.current, "step": self.step,
            "done": self.done, "checked": self.checked, "total": len(self.brief.wires),
            "uploaded": self.uploaded, "serial": self.serial[-2000:],
        }

    def for_model(self) -> str:
        b = self.brief
        lines = [f"PROJECT: {b.name}", f"BOARD: {b.board or 'none'}", "PARTS: " + (", ".join(b.parts) or "none")]
        if b.wires:
            lines.append("WIRES (do them in this order; never invent another):")
            for w in b.wires:
                mark = " [done, seen on camera]" if w.n in self.checked else " [done]" if w.n in self.done else ""
                lines.append(f"  {w.n}. {w.text}{mark}")
        if b.pins:
            lines.append("BOARD PINS: " + "; ".join(f"{p.pin} = {p.use}" for p in b.pins))
        if b.steps:
            lines.append("BUILD STEPS:")
            for i, s in enumerate(b.steps, 1):
                lines.append(f"  {i}. {s.title}: " + " ".join(s.detail)[:400]
                             + (f" SAFETY: {' '.join(s.safety)}" if s.safety else ""))
        if b.libs:
            lines.append("LIBRARIES: " + ", ".join(b.libs))
        nxt = self.next_wire()
        lines.append(f"PROGRESS: {len(self.done)} of {len(b.wires)} wires done"
                     + (f"; next is wire {nxt.n}" if nxt else "; wiring complete")
                     + ("; code uploaded" if self.uploaded else "; code not uploaded yet"))
        return "\n".join(lines)
