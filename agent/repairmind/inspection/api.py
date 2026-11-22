"""HTTP endpoints for bulk inspection.

Disabled unless ``RMX_INSPECTION_TOKEN`` is set; every request must then send ``Authorization: Bearer <token>``.
Bulk uploads are heavy and the results are factory data, so there is no anonymous access.
"""

from __future__ import annotations

import os
import re
import secrets
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..expert import products as expert_products
from . import batch
from .report import build_report

router = APIRouter(prefix="/api/inspections")
MAX_UPLOAD_BYTES = 1024**3  # 1 GB per request, compressed
JOB_ID = re.compile(r"^insp-[0-9a-f]{16}$")


def _root() -> Path:
    from ..agent import SESSIONS_DIR  # late import keeps this module light for tests

    return Path(os.getenv("RMX_INSPECTIONS_ROOT", str(SESSIONS_DIR)))


def require_token(authorization: str = Header(default="")) -> None:
    expected = os.getenv("RMX_INSPECTION_TOKEN", "")
    if not expected:
        raise HTTPException(503, "Bulk inspection is disabled. Set RMX_INSPECTION_TOKEN in agent/.env.")
    given = authorization.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(401, "Wrong or missing inspection token.")


def _job(job_id: str) -> batch.InspectionJob:
    if not JOB_ID.fullmatch(job_id):
        raise HTTPException(404, "unknown job")
    try:
        return batch.InspectionJob.load(_root(), job_id)
    except FileNotFoundError:
        raise HTTPException(404, "unknown job") from None


def _run(job: batch.InspectionJob, inputs: list[tuple[str, bytes]], product_id: str) -> None:
    product = expert_products.load_all()[product_id]
    root = _root()
    batch.run_job(job, inputs, product, expert_products.PRODUCTS_DIR / product.id, root)
    build_report(job, root, job.dir(root) / "report.xlsx")


@router.post("", dependencies=[Depends(require_token)])
async def create(background: BackgroundTasks, product_id: str = Form(...),
                 files: list[UploadFile] = File(...)) -> dict:
    product = expert_products.load_all().get(product_id)
    if product is None:
        raise HTTPException(404, "unknown product")
    if product.detector is None:
        raise HTTPException(409, "This product has no trained detector yet. Train one with scripts/train_detector.py.")
    raw: list[tuple[str, bytes]] = []
    total = 0
    for f in files:
        data = await f.read()
        total += len(data)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Upload over 1 GB. Split it into smaller batches.")
        raw.append((f.filename or "upload", data))
    try:
        inputs = batch.collect_inputs(raw)
    except batch.InputError as e:
        raise HTTPException(400, str(e)) from None
    job = batch.new_job(product)
    job.total = len(inputs)
    job.save(_root())
    background.add_task(_run, job, inputs, product.id)  # sync function: runs in the thread pool
    return {"job_id": job.job_id, "total": job.total}


@router.get("/{job_id}", dependencies=[Depends(require_token)])
def status(job_id: str) -> dict:
    return _job(job_id).summary()


@router.get("/{job_id}/report.xlsx", dependencies=[Depends(require_token)])
def report(job_id: str) -> FileResponse:
    job = _job(job_id)
    path = job.dir(_root()) / "report.xlsx"
    if job.status in ("queued", "running") or not path.exists():
        raise HTTPException(409, "The report is not ready yet.")
    return FileResponse(path, filename=f"{job.product_id}-{job.job_id}.xlsx",
                        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
