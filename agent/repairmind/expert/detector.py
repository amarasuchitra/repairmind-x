"""Trained defect detectors for expert-mode products.

A detector turns a camera frame into an anomaly score and (optionally) a heatmap. Each product sets two
thresholds from its own validation set:

    score <= threshold_good        -> "good"
    score >= threshold_defective   -> "defective"
    anything in between            -> "uncertain"  (ask for another view, never guess)

Backends:
- ``anomalib``: PatchCore / EfficientAD models exported by ``scripts/train_detector.py``. Recommended.
- ``resnet_ae``: the original project's ResNet-50 classifier + convolutional autoencoder, kept so its
  trained weights can still be used.

torch / anomalib are optional dependencies (``pip install -e ".[detector]"``). Without them, or without
weights, the detector reports "unavailable" and the mechanic falls back to general mode.
"""

from __future__ import annotations

import base64
import io
import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal, Protocol

import numpy as np
from PIL import Image

from .products import Detector, Product

log = logging.getLogger("repairmind.detector")

Verdict = Literal["good", "defective", "uncertain", "unavailable"]


class Backend(Protocol):
    def score(self, image: Image.Image) -> tuple[float, np.ndarray | None]: ...


@dataclass
class DetectionResult:
    verdict: Verdict
    score: float | None
    reason: str
    heatmap_jpeg_b64: str | None = None
    hotspot: tuple[float, float] | None = None  # (x, y) in 0..1 of the strongest anomaly

    def for_model(self) -> str:
        if self.verdict == "unavailable":
            return f"Detector unavailable: {self.reason}"
        where = f" Strongest anomaly near x={self.hotspot[0]:.2f}, y={self.hotspot[1]:.2f}." if self.hotspot else ""
        return f"Detector verdict: {self.verdict} (score {self.score:.3f}). {self.reason}{where}"


def classify(score: float, cfg: Detector) -> tuple[Verdict, str]:
    if score <= cfg.threshold_good:
        return "good", "Below the 'good' threshold for this product."
    if score >= cfg.threshold_defective:
        return "defective", "Above the 'defective' threshold for this product."
    return "uncertain", "Between thresholds: ask for another angle or better light before concluding."


def heatmap_overlay(image: Image.Image, heat: np.ndarray, alpha: float = 0.45) -> tuple[str, tuple[float, float]]:
    """Blend a 0..1 heatmap over the image; return JPEG base64 and the hotspot location."""
    h = np.asarray(heat, dtype=np.float32)
    h = (h - h.min()) / (h.max() - h.min() + 1e-8)
    yi, xi = np.unravel_index(int(np.argmax(h)), h.shape)
    hotspot = ((xi + 0.5) / h.shape[1], (yi + 0.5) / h.shape[0])
    heat_img = Image.fromarray((h * 255).astype(np.uint8)).resize(image.size, Image.BILINEAR)
    hv = np.asarray(heat_img, dtype=np.float32) / 255.0
    color = np.stack([hv, np.clip(1.5 - np.abs(hv - 0.5) * 3, 0, 1) * 0.6, 1 - hv], axis=-1) * 255
    base = np.asarray(image.convert("RGB"), dtype=np.float32)
    mixed = (1 - alpha * hv[..., None]) * base + (alpha * hv[..., None]) * color
    buf = io.BytesIO()
    Image.fromarray(mixed.clip(0, 255).astype(np.uint8)).save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode(), hotspot


def _resolve(product_dir: Path, weights: str) -> Path:
    p = Path(weights)
    return p if p.is_absolute() else product_dir / p


class AnomalibBackend:
    def __init__(self, weights: Path, image_size: int) -> None:
        from anomalib.deploy import TorchInferencer  # optional dependency

        self.inferencer = TorchInferencer(path=weights, device="cpu")
        self.image_size = image_size

    def score(self, image: Image.Image) -> tuple[float, np.ndarray | None]:
        arr = np.asarray(image.convert("RGB").resize((self.image_size, self.image_size)))
        pred = self.inferencer.predict(image=arr)
        score = float(np.asarray(pred.pred_score).reshape(-1)[0])
        amap = getattr(pred, "anomaly_map", None)
        return score, (np.asarray(amap).squeeze() if amap is not None else None)


class ResNetAEBackend:
    """Original project's models. ``weights`` is a folder with resnet50_best.pth and autoencoder_best.pth.
    Score = max(classifier P(defective), autoencoder MSE / ae_threshold * 0.5), so 0.5 roughly means
    "at the autoencoder's own threshold"."""

    def __init__(self, weights: Path, image_size: int) -> None:
        import torch
        from torch import nn
        from torchvision import models, transforms

        class ResNet50Classifier(nn.Module):
            def __init__(self) -> None:
                super().__init__()
                self.backbone = models.resnet50(weights=None)
                self.backbone.fc = nn.Sequential(nn.Dropout(0.5), nn.Linear(self.backbone.fc.in_features, 512),
                                                 nn.ReLU(), nn.Dropout(0.3), nn.Linear(512, 2))

            def forward(self, x):
                return self.backbone(x)

        class ConvAutoencoder(nn.Module):
            def __init__(self, latent: int = 512) -> None:
                super().__init__()
                c = [3, 32, 64, 128, 256]
                enc = []
                for a, b in zip(c, c[1:]):
                    enc += [nn.Conv2d(a, b, 4, stride=2, padding=1), nn.ReLU()]
                self.encoder = nn.Sequential(*enc, nn.Flatten(), nn.Linear(256 * 14 * 14, latent), nn.ReLU())
                dec: list[nn.Module] = [nn.Linear(latent, 256 * 14 * 14), nn.ReLU(), nn.Unflatten(1, (256, 14, 14))]
                r = c[::-1]
                for i, (a, b) in enumerate(zip(r, r[1:])):
                    dec += [nn.ConvTranspose2d(a, b, 4, stride=2, padding=1),
                            nn.Sigmoid() if i == len(r) - 2 else nn.ReLU()]
                self.decoder = nn.Sequential(*dec)

            def forward(self, x):
                return self.decoder(self.encoder(x))

        self.torch = torch
        self.clf = ResNet50Classifier()
        self.clf.load_state_dict(torch.load(weights / "resnet50_best.pth", map_location="cpu"))
        self.ae = ConvAutoencoder()
        self.ae.load_state_dict(torch.load(weights / "autoencoder_best.pth", map_location="cpu"))
        self.clf.eval()
        self.ae.eval()
        self.ae_threshold = float((weights / "ae_threshold.txt").read_text(encoding="utf-8").strip().splitlines()[-1])
        self.defective_idx = 0  # class_mapping {'defective': 0, 'good': 1}
        self.norm = transforms.Compose([transforms.Resize((224, 224)), transforms.ToTensor(),
                                        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])
        self.plain = transforms.Compose([transforms.Resize((224, 224)), transforms.ToTensor()])

    def score(self, image: Image.Image) -> tuple[float, np.ndarray | None]:
        torch = self.torch
        rgb = image.convert("RGB")
        with torch.no_grad():
            p_def = float(torch.softmax(self.clf(self.norm(rgb).unsqueeze(0)), 1)[0, self.defective_idx])
            x = self.plain(rgb).unsqueeze(0)
            recon = self.ae(x)
            err = ((recon - x) ** 2).mean(dim=1).squeeze(0).numpy()
        mse = float(err.mean())
        return max(p_def, 0.5 * mse / self.ae_threshold), err


@lru_cache(maxsize=8)
def _backend(product_id: str, product_dir: str, cfg_json: str) -> Backend:
    cfg = Detector.model_validate_json(cfg_json)
    path = _resolve(Path(product_dir), cfg.weights)
    if not path.exists():
        raise FileNotFoundError(f"weights not found at {path}")
    if path.is_file() and path.stat().st_size < 1024 and path.read_bytes().startswith(b"version https://git-lfs"):
        raise FileNotFoundError(f"{path} is a Git LFS pointer, not the real weights (run git lfs pull)")
    if cfg.backend == "anomalib":
        return AnomalibBackend(path, cfg.image_size)
    return ResNetAEBackend(path, cfg.image_size)


def detect(product: Product, product_dir: Path, image: Image.Image,
           backend: Backend | None = None) -> DetectionResult:
    cfg = product.detector
    if cfg is None:
        return DetectionResult("unavailable", None, "This product has no trained detector yet.")
    try:
        be = backend or _backend(product.id, str(product_dir), cfg.model_dump_json())
        score, heat = be.score(image)
    except ImportError as e:
        return DetectionResult("unavailable", None, f"detector dependencies not installed ({e.name})")
    except Exception as e:  # weights missing, corrupt, etc.
        log.warning("detector failed: %s", e)
        return DetectionResult("unavailable", None, str(e))
    verdict, reason = classify(score, cfg)
    overlay, hotspot = heatmap_overlay(image, heat) if heat is not None and heat.size > 1 else (None, None)
    return DetectionResult(verdict, score, reason, overlay, hotspot)
