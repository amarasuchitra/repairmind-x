"""Expert-mode product registry.

Each supported product lives in ``products/<id>/product.yaml``: how to recognise it, its parts (for
the 3D viewer), an optional trained defect detector, and repair procedures written as structured data
that a qualified person has reviewed. In expert mode the mechanic follows these procedures instead of
general guides.

Procedures are only served if they are marked reviewed. ``RMX_ALLOW_UNREVIEWED=1`` lets example or
draft products load for demos, and the app labels them as unreviewed.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, model_validator

from .. import safety

PRODUCTS_DIR = Path(os.getenv("RMX_PRODUCTS_DIR", Path(__file__).resolve().parents[2] / "products"))


class Part(BaseModel):
    name: str
    label: str = ""
    shape: Literal["box", "cylinder", "sphere", "torus"] = "box"
    size: list[float] = Field(default_factory=lambda: [1, 1, 1])
    position: list[float] = Field(default_factory=lambda: [0, 0, 0])
    rotation: list[float] = Field(default_factory=lambda: [0, 0, 0])
    color: str = "#8a96a8"


class ProcedureStep(BaseModel):
    id: str
    text: str
    expected_result: str
    tools: list[str] = Field(default_factory=list)
    precautions: list[str] = Field(default_factory=list)
    irreversible: bool = False
    highlight: list[str] = Field(default_factory=list)
    move: dict[str, list[float]] = Field(default_factory=dict)
    hide: list[str] = Field(default_factory=list)
    caution: str = ""

    @model_validator(mode="after")
    def _irreversible_matches_text(self) -> "ProcedureStep":
        # A step that reads irreversible must be marked so; the gates rely on it.
        if safety.irreversible_actions(self.text) and not self.irreversible:
            raise ValueError(f"step {self.id} looks irreversible ({self.text!r}) but irreversible is false")
        for p in self.precautions:
            if p not in safety.PRECAUTION_TEXT:
                raise ValueError(f"step {self.id}: unknown precaution {p}")
        return self


class Procedure(BaseModel):
    id: str
    title: str
    fault: str
    symptoms: list[str] = Field(default_factory=list)
    source: str
    reviewed_by: str = ""
    reviewed_on: str = ""
    steps: list[ProcedureStep]

    @property
    def reviewed(self) -> bool:
        return bool(self.reviewed_by and self.reviewed_on)


class Detector(BaseModel):
    backend: Literal["anomalib", "resnet_ae"]
    weights: str
    threshold_good: float = Field(description="score at or below = good")
    threshold_defective: float = Field(description="score at or above = defective; between = uncertain")
    image_size: int = 256


class Product(BaseModel):
    id: str
    name: str
    category: str
    brands: list[str] = Field(default_factory=list)
    model_patterns: list[str] = Field(default_factory=list, description="regexes matched against the model number")
    illustrative_3d: bool = True
    model_url: str = ""
    parts: list[Part] = Field(default_factory=list)
    detector: Detector | None = None
    procedures: list[Procedure] = Field(default_factory=list)

    def matches(self, brand: str, model: str) -> bool:
        if self.brands and brand and brand.lower() not in [b.lower() for b in self.brands]:
            return False
        return any(re.fullmatch(p, model.strip(), re.I) for p in self.model_patterns)

    def procedure(self, procedure_id: str) -> Procedure | None:
        return next((p for p in self.procedures if p.id == procedure_id), None)

    def step(self, ref: str) -> tuple[Procedure, ProcedureStep] | None:
        """Resolve "product/procedure#step"."""
        m = re.fullmatch(r"([\w-]+)/([\w-]+)#([\w-]+)", ref.strip())
        if not m or m.group(1) != self.id:
            return None
        proc = self.procedure(m.group(2))
        if not proc:
            return None
        st = next((s for s in proc.steps if s.id == m.group(3)), None)
        return (proc, st) if st else None


def allow_unreviewed() -> bool:
    return os.getenv("RMX_ALLOW_UNREVIEWED") == "1"


@lru_cache(maxsize=1)
def load_all(directory: str | None = None) -> dict[str, Product]:
    root = Path(directory) if directory else PRODUCTS_DIR
    out: dict[str, Product] = {}
    for f in sorted(root.glob("*/product.yaml")):
        product = Product.model_validate(yaml.safe_load(f.read_text(encoding="utf-8")))
        out[product.id] = product
    return out


def find_product(brand: str, model: str, directory: str | None = None) -> Product | None:
    if not model:
        return None
    return next((p for p in load_all(directory).values() if p.matches(brand, model)), None)


def usable_procedures(product: Product) -> list[Procedure]:
    return [p for p in product.procedures if p.reviewed or allow_unreviewed()]
