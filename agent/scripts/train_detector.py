"""Train and calibrate an expert-mode defect detector with Anomalib.

Folder layout (your own photos of ONE product, taken with the real camera, several angles and lights):

    data/<product-id>/
        train/good/*.jpg          # only good units; PatchCore learns what "normal" looks like
        val/good/*.jpg            # held-out good units
        val/defect/<type>/*.jpg   # held-out defective units, one folder per defect type

Usage:
    pip install -e ".[detector]"
    python scripts/train_detector.py --data data/example-desk-fan --product example-desk-fan

It trains PatchCore, scores the validation set, picks the two thresholds, exports the model next to
product.yaml and prints the `detector:` block to paste into product.yaml, along with honest metrics.

Thresholds:
    threshold_good       = highest score where at least 99% of validation GOOD images are at or below
    threshold_defective  = lowest score where at least 99% of validation DEFECT images are at or above
If the two cross (the model can't separate them that cleanly), the script says so and refuses to write
the config: collect more or better data instead.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def pick_thresholds(good: np.ndarray, defect: np.ndarray, coverage: float = 0.99) -> tuple[float, float] | None:
    t_good = float(np.quantile(good, coverage))
    t_def = float(np.quantile(defect, 1 - coverage))
    if t_def <= t_good:
        return None
    return t_good, t_def


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--product", required=True)
    ap.add_argument("--image-size", type=int, default=256)
    args = ap.parse_args()

    from anomalib.data import Folder
    from anomalib.deploy import ExportType, TorchInferencer
    from anomalib.engine import Engine
    from anomalib.models import Patchcore

    dm = Folder(name=args.product, root=args.data, normal_dir="train/good", abnormal_dir="val/defect",
                normal_test_dir="val/good")
    model = Patchcore()
    engine = Engine(max_epochs=1)
    engine.fit(model=model, datamodule=dm)

    out_dir = Path(__file__).resolve().parents[1] / "products" / args.product / "detector"
    out_dir.mkdir(parents=True, exist_ok=True)
    exported = engine.export(model=model, export_type=ExportType.TORCH, export_root=out_dir)
    inferencer = TorchInferencer(path=exported, device="cpu")

    def scores(folder: Path) -> np.ndarray:
        files = [p for p in folder.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
        return np.array([float(np.asarray(inferencer.predict(image=str(f)).pred_score).reshape(-1)[0]) for f in files])

    good, defect = scores(args.data / "val/good"), scores(args.data / "val/defect")
    th = pick_thresholds(good, defect)
    report = {"val_good": len(good), "val_defect": len(defect)}
    if th is None:
        report["result"] = "NOT SEPARABLE at 99% coverage: collect more varied data before using this detector."
        print(json.dumps(report, indent=2))
        raise SystemExit(1)
    t_good, t_def = th
    report.update({
        "good_correct": float((good <= t_good).mean()),
        "defect_caught": float((defect >= t_def).mean()),
        "uncertain_share": float(((good > t_good) | (defect < t_def)).mean()),
    })
    print(json.dumps(report, indent=2))
    rel = Path(exported).relative_to(out_dir.parent)
    print("\nPaste into product.yaml:\n")
    print(f"detector:\n  backend: anomalib\n  weights: {rel}\n  threshold_good: {t_good:.4f}\n"
          f"  threshold_defective: {t_def:.4f}\n  image_size: {args.image_size}")


if __name__ == "__main__":
    main()
