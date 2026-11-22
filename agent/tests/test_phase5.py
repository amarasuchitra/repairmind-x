import io
import shutil
import time
import zipfile
from pathlib import Path

import numpy as np
import openpyxl
import pytest
import yaml
from fastapi.testclient import TestClient
from PIL import Image

from repairmind.expert import detector, products
from repairmind.inspection import batch
from repairmind.inspection.report import build_report

EXAMPLE = Path(__file__).resolve().parents[1] / "products" / "example-desk-fan"


class Brightness:
    """Fake detector: brighter image = more anomalous."""

    def score(self, image):
        arr = np.asarray(image.convert("L"), dtype=np.float32) / 255.0
        return float(arr.mean()), arr


def png(level: int, size=(32, 24)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (level, level, level)).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def product_dir(tmp_path, monkeypatch):
    d = tmp_path / "products" / "example-desk-fan"
    shutil.copytree(EXAMPLE, d)
    raw = yaml.safe_load((d / "product.yaml").read_text())
    raw["detector"] = {"backend": "anomalib", "weights": "detector/model.pt", "threshold_good": 0.3,
                       "threshold_defective": 0.7}
    (d / "product.yaml").write_text(yaml.safe_dump(raw))
    monkeypatch.setattr(products, "PRODUCTS_DIR", tmp_path / "products")
    products.load_all.cache_clear()
    yield d
    products.load_all.cache_clear()


def zip_of(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in entries.items():
            z.writestr(k, v)
    return buf.getvalue()


def test_collect_inputs_expands_zip_and_sanitises_paths():
    z = zip_of({"a/1.png": png(10), "../../evil.png": png(10), "__MACOSX/._1.png": b"x", "notes.txt": b"hi"})
    out = batch.collect_inputs([("batch.zip", z), ("loose.jpg", png(5)), ("readme.md", b"x")])
    names = [n for n, _ in out]
    assert names == ["batch.zip/evil.png", "batch.zip/a/1.png", "loose.jpg"]
    assert all(".." not in n for n in names)


def test_collect_inputs_rejects_empty_and_bad_zip():
    with pytest.raises(batch.InputError):
        batch.collect_inputs([("x.txt", b"hi")])
    with pytest.raises(batch.InputError):
        batch.collect_inputs([("x.zip", b"not a zip")])


def test_collect_inputs_limits(monkeypatch):
    monkeypatch.setattr(batch, "MAX_ITEMS", 2)
    with pytest.raises(batch.InputError, match="Too many"):
        batch.collect_inputs([(f"{i}.png", png(1)) for i in range(3)])


def test_run_job_verdicts_errors_and_heatmaps(tmp_path, product_dir):
    product = products.load_all()["example-desk-fan"]
    job = batch.new_job(product)
    inputs = [("good.png", png(20)), ("mid.png", png(128)), ("bad.png", png(240)), ("broken.png", b"nope")]
    batch.run_job(job, inputs, product, product_dir, tmp_path, backend=Brightness())
    assert job.status == "done"
    assert [i.verdict for i in job.items] == ["good", "uncertain", "defective", "error"]
    assert job.counts() == {"good": 1, "defective": 1, "uncertain": 1, "error": 1}
    heat = job.dir(tmp_path) / "heatmaps"
    assert sorted(p.name for p in heat.iterdir()) == ["00002.jpg", "00003.jpg"]
    again = batch.InspectionJob.load(tmp_path, job.job_id)
    assert again.counts() == job.counts() and again.items[2].score == pytest.approx(240 / 255, abs=0.01)


def test_run_job_without_detector_fails_honestly(tmp_path):
    product = products.load_all(str(EXAMPLE.parent))["example-desk-fan"]
    job = batch.new_job(product)
    batch.run_job(job, [("a.png", png(1))], product, EXAMPLE, tmp_path)
    assert job.status == "failed" and "no trained detector" in job.message


def test_run_job_stops_when_detector_unavailable(tmp_path, product_dir):
    product = products.load_all()["example-desk-fan"]
    job = batch.new_job(product)
    batch.run_job(job, [("a.png", png(1)), ("b.png", png(2))], product, product_dir, tmp_path)  # no weights
    assert job.status == "failed" and "unavailable" in job.message.lower()


def test_report_has_six_sheets_and_matching_counts(tmp_path, product_dir):
    product = products.load_all()["example-desk-fan"]
    job = batch.new_job(product)
    inputs = [(f"{i}.png", png(lvl)) for i, lvl in enumerate([10, 20, 128, 240, 250])] + [("x.png", b"bad")]
    batch.run_job(job, inputs, product, product_dir, tmp_path, backend=Brightness())
    path = build_report(job, tmp_path, tmp_path / "r.xlsx")
    wb = openpyxl.load_workbook(path)
    assert wb.sheetnames == ["Summary", "All items", "Defective", "Needs review", "Scores", "Method"]
    assert wb["All items"].max_row == 1 + len(inputs)
    assert wb["Defective"].max_row == 1 + 2
    assert wb["Needs review"].max_row == 1 + 2  # one uncertain, one unreadable
    assert len(wb["Defective"]._images) == 2
    hist = [r[2] for r in wb["Scores"].iter_rows(min_row=2, max_row=21, values_only=True)]
    assert sum(hist) == 5


def test_api_disabled_without_token(monkeypatch):
    from repairmind.token_server import app

    monkeypatch.delenv("RMX_INSPECTION_TOKEN", raising=False)
    r = TestClient(app).post("/api/inspections", data={"product_id": "x"}, files={"files": ("a.png", png(1))})
    assert r.status_code == 503


def test_api_end_to_end(tmp_path, product_dir, monkeypatch):
    from repairmind.token_server import app

    monkeypatch.setenv("RMX_INSPECTION_TOKEN", "s3cret")
    monkeypatch.setenv("RMX_INSPECTIONS_ROOT", str(tmp_path / "data"))
    monkeypatch.setattr(detector, "_backend", lambda *a: Brightness())
    c = TestClient(app)
    auth = {"Authorization": "Bearer s3cret"}
    files = [("files", ("batch.zip", zip_of({"1.png": png(10), "2.png": png(250)}))), ("files", ("3.png", png(128)))]
    assert c.post("/api/inspections", data={"product_id": "example-desk-fan"}, files=files,
                  headers={"Authorization": "Bearer wrong"}).status_code == 401
    r = c.post("/api/inspections", data={"product_id": "example-desk-fan"}, files=files, headers=auth)
    assert r.status_code == 200, r.text
    job_id = r.json()["job_id"]
    for _ in range(50):
        s = c.get(f"/api/inspections/{job_id}", headers=auth).json()
        if s["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    assert s["status"] == "done" and s["counts"] == {"good": 1, "defective": 1, "uncertain": 1, "error": 0}
    rep = c.get(f"/api/inspections/{job_id}/report.xlsx", headers=auth)
    assert rep.status_code == 200 and rep.content[:2] == b"PK"
    assert c.get("/api/inspections/../../etc", headers=auth).status_code == 404
    assert c.get("/api/inspections/insp-0000000000000000", headers=auth).status_code == 404
    lst = c.get("/api/products").json()
    assert {"id": "example-desk-fan", "name": "Example 30 cm desk fan", "has_detector": True} in lst


def test_api_rejects_product_without_detector(monkeypatch):
    from repairmind.token_server import app

    products.load_all.cache_clear()
    monkeypatch.setenv("RMX_INSPECTION_TOKEN", "s3cret")
    r = TestClient(app).post("/api/inspections", data={"product_id": "example-desk-fan"},
                             files={"files": ("a.png", png(1))}, headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 409
