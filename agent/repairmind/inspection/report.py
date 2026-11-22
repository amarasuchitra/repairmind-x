"""Excel report for a bulk inspection job (XlsxWriter).

Six sheets:
    1. Summary          totals, rates, chart, thresholds
    2. All items        one row per image, filterable, colour-coded
    3. Defective        defective items with their heatmap as evidence
    4. Needs review     uncertain and unreadable items, with columns for a person to record their decision
    5. Scores           score histogram with the two thresholds marked
    6. Method           how verdicts were made and what the report does not prove
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import xlsxwriter

from .batch import InspectionJob, Item

COLORS = {"good": "#C6EFCE", "defective": "#FFC7CE", "uncertain": "#FFEB9C", "error": "#D9D9D9"}
THUMB_PX = 160


def _when(ts: float | None) -> str:
    return dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else ""


def build_report(job: InspectionJob, root: Path, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    wb = xlsxwriter.Workbook(str(path))
    f = {
        "title": wb.add_format({"bold": True, "font_size": 16}),
        "h": wb.add_format({"bold": True, "bg_color": "#1F2937", "font_color": "#FFFFFF", "border": 1,
                            "text_wrap": True, "valign": "top"}),
        "b": wb.add_format({"bold": True}),
        "pct": wb.add_format({"num_format": "0.0%"}),
        "num": wb.add_format({"num_format": "0.0000"}),
        "wrap": wb.add_format({"text_wrap": True, "valign": "top"}),
        "muted": wb.add_format({"font_color": "#6B7280", "italic": True, "text_wrap": True}),
        "warn": wb.add_format({"bold": True, "font_color": "#9C0006", "text_wrap": True}),
    }
    verdict_fmt = {k: wb.add_format({"bg_color": v, "border": 1}) for k, v in COLORS.items()}
    counts = job.counts()
    n = len(job.items)
    heat_dir = job.dir(root) / "heatmaps"

    # 1. Summary ---------------------------------------------------------------------------------------------
    ws = wb.add_worksheet("Summary")
    ws.set_column(0, 0, 28)
    ws.set_column(1, 2, 18)
    ws.write(0, 0, "Bulk inspection report", f["title"])
    meta = [("Product", f"{job.product_name} ({job.product_id})"), ("Job", job.job_id),
            ("Started", _when(job.created_at)), ("Finished", _when(job.finished_at)),
            ("Status", job.status), ("Images received", job.total), ("Images inspected", n)]
    for r, (k, v) in enumerate(meta, start=2):
        ws.write(r, 0, k, f["b"])
        ws.write(r, 1, v)
    row = 2 + len(meta) + 1
    if job.status != "done":
        ws.merge_range(row, 0, row, 4, f"Incomplete: {job.message}", f["warn"])
        row += 2
    ws.write_row(row, 0, ["Verdict", "Count", "Share"], f["h"])
    labels = [("good", "Good"), ("defective", "Defective"), ("uncertain", "Needs a human look"),
              ("error", "Unreadable")]
    first = row + 1
    for i, (key, label) in enumerate(labels):
        r = first + i
        ws.write(r, 0, label, verdict_fmt[key])
        ws.write(r, 1, counts[key])
        ws.write_formula(r, 2, f"=IF(SUM($B${first + 1}:$B${first + 4})=0,0,B{r + 1}/SUM($B${first + 1}:$B${first + 4}))",
                         f["pct"], counts[key] / n if n else 0)
    last = first + len(labels) - 1
    chart = wb.add_chart({"type": "column"})
    chart.add_series({"name": "Images", "categories": ["Summary", first, 0, last, 0],
                      "values": ["Summary", first, 1, last, 1],
                      "points": [{"fill": {"color": COLORS[k]}, "border": {"color": "#6B7280"}} for k, _ in labels]})
    chart.set_title({"name": "Verdicts"})
    chart.set_legend({"none": True})
    ws.insert_chart(2, 4, chart, {"x_scale": 1.1, "y_scale": 1.0})
    r = last + 2
    ws.write(r, 0, "Thresholds", f["b"])
    ws.write(r + 1, 0, "Good at or below")
    ws.write(r + 1, 1, job.threshold_good, f["num"])
    ws.write(r + 2, 0, "Defective at or above")
    ws.write(r + 2, 1, job.threshold_defective, f["num"])
    ws.merge_range(r + 4, 0, r + 6, 6, "Defective and needs-review items should be checked by a person before "
                   "any unit is scrapped, reworked or shipped. See the Method sheet for what this report does "
                   "and does not show.", f["muted"])

    # 2. All items -------------------------------------------------------------------------------------------
    cols = ["#", "File", "Verdict", "Score", "Hotspot x", "Hotspot y", "Width", "Height", "Reason"]
    ws = wb.add_worksheet("All items")
    ws.write_row(0, 0, cols, f["h"])
    ws.set_column(0, 0, 6)
    ws.set_column(1, 1, 48)
    ws.set_column(2, 2, 12)
    ws.set_column(3, 7, 11)
    ws.set_column(8, 8, 60)
    for r, it in enumerate(job.items, start=1):
        ws.write(r, 0, it.index)
        ws.write(r, 1, it.name)
        ws.write(r, 2, it.verdict, verdict_fmt[it.verdict])
        ws.write(r, 3, it.score, f["num"]) if it.score is not None else ws.write_blank(r, 3, None)
        for c, v in ((4, it.hotspot_x), (5, it.hotspot_y)):
            ws.write(r, c, round(v, 3)) if v is not None else ws.write_blank(r, c, None)
        ws.write(r, 6, it.width or None)
        ws.write(r, 7, it.height or None)
        ws.write(r, 8, it.reason)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, max(n, 1), len(cols) - 1)

    # 3 + 4. Defective / Needs review, with heatmaps -----------------------------------------------------------
    def evidence_sheet(name: str, items: list[Item], review_cols: bool) -> None:
        ws = wb.add_worksheet(name)
        head = ["#", "File", "Verdict", "Score", "Heatmap", "Reason"]
        if review_cols:
            head += ["Reviewer decision", "Reviewer", "Notes"]
        ws.write_row(0, 0, head, f["h"])
        ws.set_column(0, 0, 6)
        ws.set_column(1, 1, 40)
        ws.set_column(2, 3, 11)
        ws.set_column(4, 4, THUMB_PX / 7)
        ws.set_column(5, 5, 40)
        if review_cols:
            ws.set_column(6, 6, 18)
            ws.set_column(7, 8, 24)
        if not items:
            ws.write(1, 0, "None.", f["muted"])
            return
        for r, it in enumerate(items, start=1):
            ws.set_row(r, THUMB_PX * 0.75 + 6)
            ws.write(r, 0, it.index, f["wrap"])
            ws.write(r, 1, it.name, f["wrap"])
            ws.write(r, 2, it.verdict, verdict_fmt[it.verdict])
            ws.write(r, 3, it.score, f["num"]) if it.score is not None else ws.write_blank(r, 3, None)
            hp = heat_dir / it.heatmap if it.heatmap else None
            if hp and hp.exists() and it.width and it.height:
                scale = THUMB_PX / max(it.width, it.height)
                ws.insert_image(r, 4, str(hp), {"x_scale": scale, "y_scale": scale, "x_offset": 3, "y_offset": 3,
                                                "object_position": 1})
            else:
                ws.write(r, 4, "no heatmap", f["muted"])
            ws.write(r, 5, it.reason, f["wrap"])
            if review_cols:
                ws.data_validation(r, 6, r, 6, {"validate": "list",
                                                "source": ["good", "defective", "re-shoot"]})
        ws.freeze_panes(1, 0)

    evidence_sheet("Defective", [i for i in job.items if i.verdict == "defective"], review_cols=False)
    evidence_sheet("Needs review", [i for i in job.items if i.verdict in ("uncertain", "error")], review_cols=True)

    # 5. Scores histogram ------------------------------------------------------------------------------------
    ws = wb.add_worksheet("Scores")
    ws.write_row(0, 0, ["From", "To", "Images", "Band"], f["h"])
    scores = [i.score for i in job.items if i.score is not None]
    ws.set_column(0, 3, 14)
    if scores:
        lo, hi = min(scores), max(scores)
        if job.threshold_good is not None and job.threshold_defective is not None:
            lo, hi = min(lo, job.threshold_good), max(hi, job.threshold_defective)
        bins = 20
        width = (hi - lo) / bins or 1.0
        for b in range(bins):
            a, z = lo + b * width, lo + (b + 1) * width
            cnt = sum(1 for s in scores if a <= s < z or (b == bins - 1 and s == z))
            mid = (a + z) / 2
            band = ("good" if job.threshold_good is not None and mid <= job.threshold_good else
                    "defective" if job.threshold_defective is not None and mid >= job.threshold_defective else
                    "uncertain")
            ws.write(b + 1, 0, a, f["num"])
            ws.write(b + 1, 1, z, f["num"])
            ws.write(b + 1, 2, cnt)
            ws.write(b + 1, 3, band, verdict_fmt[band])
        ch = wb.add_chart({"type": "column"})
        ch.add_series({"name": "Images", "categories": ["Scores", 1, 0, bins, 0], "values": ["Scores", 1, 2, bins, 2],
                       "gap": 10, "fill": {"color": "#6B7280"}})
        ch.set_title({"name": "Anomaly score distribution"})
        ch.set_x_axis({"name": "Score (bin start)", "num_format": "0.00"})
        ch.set_y_axis({"name": "Images"})
        ch.set_legend({"none": True})
        ws.insert_chart(1, 5, ch, {"x_scale": 1.4, "y_scale": 1.2})
        ws.write(bins + 3, 0, "Band colours follow this product's thresholds.", f["muted"])
    else:
        ws.write(1, 0, "No scores.", f["muted"])

    # 6. Method ----------------------------------------------------------------------------------------------
    ws = wb.add_worksheet("Method")
    ws.set_column(0, 0, 110)
    lines = [
        ("How verdicts were made", f["b"]),
        (f"Each image was scored by this product's trained anomaly detector (backend: {job.backend}). "
         f"Score at or below {job.threshold_good} = good; at or above {job.threshold_defective} = defective; "
         "anything in between = needs a human look. The thresholds were set from the product's own validation "
         "images when the detector was trained.", f["wrap"]),
        ("", None),
        ("What this report does not show", f["b"]),
        ("- It only detects things that look different from the good units the detector was trained on. "
         "A defect that looks normal from this angle, or that is outside the photo, will be missed.", f["wrap"]),
        ("- Different lighting, camera, background or product variant than in training can change scores. "
         "If many items need review, check the photo setup before trusting the rest.", f["wrap"]),
        ("- The heatmap shows where the image differs most from normal; it is evidence, not a diagnosis.", f["wrap"]),
        ("- Unreadable files are listed, never skipped, so the item count always matches the upload.", f["wrap"]),
        ("", None),
        ("Before acting", f["b"]),
        ("Have a person confirm every defective and needs-review item (use the Needs review sheet) before "
         "scrapping, reworking or shipping units.", f["wrap"]),
        ("", None),
        (f"Generated by RepairMind X on {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}.", f["muted"]),
    ]
    for r, (text, fmt) in enumerate(lines):
        ws.write(r, 0, text, fmt) if fmt else None
    wb.close()
    return path
