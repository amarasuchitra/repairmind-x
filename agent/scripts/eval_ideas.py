"""Score the engineer's "think it through" answers on the fixed test set of 50 ideas.

    cd agent && .venv/bin/python scripts/eval_ideas.py            # all ideas
    .venv/bin/python scripts/eval_ideas.py --only solar-pump-10m,free-energy --level student

Needs ANTHROPIC_API_KEY or GOOGLE_API_KEY. Free-tier Gemini has per-minute limits, so ideas run one at a time with a
pause (--pause). Results are written to evals/results/<time>.json and compared with the previous run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

from repairmind import checker, evals  # noqa: E402
from repairmind.lab import understand  # noqa: E402
from repairmind.lab.designer import DesignError  # noqa: E402

RESULTS = Path(__file__).resolve().parents[1] / "evals" / "results"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated idea ids")
    ap.add_argument("--level", default="beginner", choices=["beginner", "student", "engineer"])
    ap.add_argument("--pause", type=float, default=4.0, help="seconds between ideas (free-tier rate limits)")
    args = ap.parse_args()
    if checker.provider() is None:
        print("No model key: set ANTHROPIC_API_KEY or GOOGLE_API_KEY in agent/.env")
        return 2
    cases = evals.load_ideas()
    if args.only:
        want = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in want]
    scores = []
    for n, c in enumerate(cases, 1):
        t0 = time.monotonic()
        try:
            b = await understand.understand(c["idea"], level=c.get("level", args.level))
            s = evals.score(c, b)
        except DesignError as e:
            s = evals.score(c, None, e.message)
        scores.append(s)
        print(f"[{n}/{len(cases)}] {c['id']}: {s.pct}% in {time.monotonic() - t0:.0f}s" + (f"  ({'; '.join(s.misses)})" if s.misses else ""))
        if n < len(cases):
            await asyncio.sleep(args.pause)
    now = evals.summary(scores) | {"at": int(time.time()), "model": checker.provider(), "level": args.level,
                                    "only": args.only}
    RESULTS.mkdir(parents=True, exist_ok=True)
    previous = sorted(RESULTS.glob("*.json"))
    before = None
    for p in reversed(previous):
        r = json.loads(p.read_text(encoding="utf-8"))
        if r.get("only", "") == args.only:
            before = r
            break
    out = RESULTS / time.strftime("%Y%m%d-%H%M%S.json")
    out.write_text(json.dumps(now, indent=1, ensure_ascii=False), encoding="utf-8")
    print("\n" + "\n".join(evals.compare(now, before)))
    print(f"Saved {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
