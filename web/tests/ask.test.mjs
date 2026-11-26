// Circle to ask geometry: screen stroke -> camera frame box -> crop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { toFrame, strokeOk, boundsOf, cropRect } from "../src/ask/geometry.ts";

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("maps a tap on a cover-scaled video back to the camera frame", () => {
  // 1280x720 video in a 400x800 portrait element: height fills, sides are cropped.
  const scale = 800 / 720, dw = 1280 * scale, off = (400 - dw) / 2;
  const p = toFrame({ x: 200, y: 400 }, 400, 800, 1280, 720, false);
  near(p.x, 0.5); near(p.y, 0.5);
  const left = toFrame({ x: 0, y: 0 }, 400, 800, 1280, 720, false);
  near(left.x, -off / dw); near(left.y, 0);
});

test("mirrors x for the selfie camera", () => {
  const a = toFrame({ x: 100, y: 300 }, 400, 800, 1280, 720, false);
  const b = toFrame({ x: 100, y: 300 }, 400, 800, 1280, 720, true);
  near(a.x + b.x, 1); near(a.y, b.y);
});

test("a tap is not a circle; a loop is", () => {
  assert.equal(strokeOk([{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 11 }, { x: 12, y: 12 }]), false);
  const loop = Array.from({ length: 24 }, (_, i) => ({ x: 100 + 40 * Math.cos(i / 4), y: 100 + 40 * Math.sin(i / 4) }));
  assert.equal(strokeOk(loop), true);
});

test("bounds are cut to the frame; off-frame strokes give nothing", () => {
  const b = boundsOf([{ x: -0.2, y: 0.4 }, { x: 0.2, y: 0.6 }]);
  near(b.x, 0.1); near(b.w, 0.2); near(b.h, 0.2);
  assert.equal(boundsOf([{ x: -0.5, y: 0.5 }, { x: -0.2, y: 0.6 }]), null);
});

test("crop adds a margin and keeps a minimum size, inside the frame", () => {
  const r = cropRect({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 1000, 1000);
  assert.deepEqual(r, { sx: 370, sy: 370, sw: 260, sh: 260 });
  const tiny = cropRect({ x: 0.99, y: 0.5, w: 0.01, h: 0.01 }, 1000, 1000);
  assert.ok(tiny.sx + tiny.sw <= 1000 && tiny.sw >= 60);
});

import { matchesWake } from "../src/ask/wakeWord.ts";

test("wake phrase survives the usual mishearings, and nothing else wakes it", () => {
  for (const t of ["Hey RepairMind", "hey repair mind, what next?", "OK, repair mine", "so... hi Repair-Mind!"]) {
    assert.equal(matchesWake(t), true, t);
  }
  for (const t of ["repair my mind", "hey there", "I need to repair mindfully", "they repairmind"]) {
    assert.equal(matchesWake(t), false, t);
  }
});
