"""Bulk inspection jobs.

A job takes many photos of one product (loose images or ZIP files), runs that product's trained detector on
each, and records a verdict per item: good, defective, uncertain (needs a human look), or error. Nothing is
ever silently dropped: an unreadable file is an "error" row, not a missing row.

Jobs live in ``<sessions>/inspections/<job_id>/``: ``job.json`` (progress and results) and ``heatmaps/``
(overlays for defective and uncertain items, used as evidence in the report).
"""

from __future__ import annotations

import base64
import io
import json
import secrets
import time
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath
from typing import Literal

from PIL import Image, UnidentifiedImageError

from ..expert import detector
from ..expert.products import Product

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}
MAX_ITEMS = 5000
MAX_TOTAL_BYTES = 2 * 1024**3  # uncompressed, across all inputs; stops zip bombs
MAX_IMAGE_PIXELS = 40_000_000

ItemVerdict = Literal["good", "defective", "uncertain", "error"]
JobStatus = Literal["queued", "running", "done", "failed"]


class InputError(ValueError):
    """The upload can't be inspected (too big, too many files, no images)."""


@dataclass
class Item:
    index: int
    name: str
    verdict: ItemVerdict = "uncertain"
    score: float | None = None
    reason: str = ""
    hotspot_x: float | None = None
    hotspot_y: float | None = None
    heatmap: str = ""  # file name in heatmaps/
    width: int = 0
    height: int = 0


@dataclass
class InspectionJob:
    job_id: str
    product_id: str
    product_name: str
    threshold_good: float | None
    threshold_defective: float | None
    backend: str
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    status: JobStatus = "queued"
    message: str = ""
    total: int = 0
    items: list[Item] = field(default_factory=list)

    # ------------------------------------------------------------ persistence
    def dir(self, root: Path) -> Path:
        return root / "inspections" / self.job_id

    def save(self, root: Path) -> None:
        d = self.dir(root)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "job.json.tmp"
        tmp.write_text(json.dumps(asdict(self)), encoding="utf-8")
        tmp.replace(d / "job.json")

    @classmethod
    def load(cls, root: Path, job_id: str) -> "InspectionJob":
        raw = json.loads((root / "inspections" / job_id / "job.json").read_text(encoding="utf-8"))
        raw["items"] = [Item(**i) for i in raw.get("items", [])]
        return cls(**raw)

    # ---------------------------------------------------------------- summary
    def counts(self) -> dict[str, int]:
        out = {"good": 0, "defective": 0, "uncertain": 0, "error": 0}
        for it in self.items:
            out[it.verdict] += 1
        return out

    def summary(self) -> dict:
        c = self.counts()
        done = len(self.items)
        return {
            "job_id": self.job_id, "product_id": self.product_id, "product_name": self.product_name,
            "status": self.status, "message": self.message, "total": self.total, "processed": done,
            "counts": c,
            "items": [{"index": i.index, "name": i.name, "verdict": i.verdict, "score": i.score, "reason": i.reason}
                      for i in self.items],
        }


def new_job(product: Product) -> InspectionJob:
    cfg = product.detector
    return InspectionJob(
        job_id="insp-" + secrets.token_hex(8), product_id=product.id, product_name=product.name,
        threshold_good=cfg.threshold_good if cfg else None,
        threshold_defective=cfg.threshold_defective if cfg else None,
        backend=cfg.backend if cfg else "none",
    )


def _safe_name(name: str) -> str:
    # Keep the path inside the ZIP for traceability, but never let it be absolute or climb out.
    parts = [p for p in PurePosixPath(name.replace("\\", "/")).parts if p not in ("", ".", "..", "/")]
    return "/".join(parts)[-200:] or "unnamed"


def collect_inputs(files: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """Expand uploaded files (images or ZIPs of images) into (name, bytes), in a stable order."""
    out: list[tuple[str, bytes]] = []
    total = 0

    def add(name: str, data: bytes) -> None:
        nonlocal total
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise InputError("Upload is too large (over 2 GB of images).")
        out.append((name, data))
        if len(out) > MAX_ITEMS:
            raise InputError(f"Too many images (over {MAX_ITEMS}). Split the batch.")

    for fname, data in files:
        name = _safe_name(fname)
        suffix = PurePosixPath(name).suffix.lower()
        if suffix == ".zip":
            try:
                zf = zipfile.ZipFile(io.BytesIO(data))
            except zipfile.BadZipFile:
                raise InputError(f"{name} is not a valid ZIP file.") from None
            members = sorted((m for m in zf.infolist() if not m.is_dir()), key=lambda m: m.filename)
            declared = sum(m.file_size for m in members)
            if total + declared > MAX_TOTAL_BYTES:
                raise InputError("Upload is too large (over 2 GB of images).")
            for m in members:
                inner = _safe_name(m.filename)
                base = PurePosixPath(inner).name
                if base.startswith(".") or "__MACOSX" in inner:
                    continue
                if PurePosixPath(inner).suffix.lower() in IMAGE_SUFFIXES:
                    add(f"{name}/{inner}", zf.read(m))
        elif suffix in IMAGE_SUFFIXES:
            add(name, data)
    if not out:
        raise InputError("No images found. Upload JPG/PNG files or a ZIP of them.")
    return out


def _open_image(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise ValueError(f"image too large ({img.width}x{img.height})")
    img.load()
    return img.convert("RGB")


def run_job(job: InspectionJob, inputs: list[tuple[str, bytes]], product: Product, product_dir: Path,
            root: Path, backend: detector.Backend | None = None, save_every: int = 10) -> InspectionJob:
    """Inspect every input in order. Safe to call in a background thread."""
    job.status, job.total, job.items = "running", len(inputs), []
    job.save(root)
    heat_dir = job.dir(root) / "heatmaps"
    try:
        if product.detector is None:
            raise RuntimeError("This product has no trained detector, so it can't be bulk-inspected yet.")
        for i, (name, data) in enumerate(inputs):
            item = Item(index=i + 1, name=name)
            try:
                img = _open_image(data)
                item.width, item.height = img.size
                res = detector.detect(product, product_dir, img, backend=backend)
                if res.verdict == "unavailable":
                    # The detector itself is broken, not this image: stop instead of filling the report with noise.
                    raise RuntimeError("Detector unavailable: " + res.reason)
                item.verdict, item.score, item.reason = res.verdict, res.score, res.reason
                if res.hotspot:
                    item.hotspot_x, item.hotspot_y = res.hotspot
                if res.heatmap_jpeg_b64 and res.verdict in ("defective", "uncertain"):
                    heat_dir.mkdir(parents=True, exist_ok=True)
                    item.heatmap = f"{item.index:05d}.jpg"
                    (heat_dir / item.heatmap).write_bytes(base64.b64decode(res.heatmap_jpeg_b64))
            except RuntimeError:
                raise
            except (UnidentifiedImageError, OSError, ValueError) as e:
                item.verdict, item.reason = "error", f"Could not read image: {e}"
            job.items.append(item)
            if (i + 1) % save_every == 0:
                job.save(root)
        job.status = "done"
        c = job.counts()
        job.message = (f"{c['good']} good, {c['defective']} defective, {c['uncertain']} uncertain (for a person to check), "
                       f"{c['error']} unreadable.")
    except Exception as e:
        job.status, job.message = "failed", str(e)
    job.finished_at = time.time()
    job.save(root)
    return job
