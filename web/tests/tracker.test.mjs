// Run with: npm test   (Node 22+ strips the TypeScript types itself)
import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxTracker, catchUp, WORK_WIDTH } from "../src/ar/tracker.ts";

const W = WORK_WIDTH;
const H = 240;

// A textured "device" (random blobs) on a smooth background, viewed by a camera that moves.
function scene(seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blobs = Array.from({ length: 120 }, () => [rnd() * 2 - 1, rnd() * 2 - 1, 0.02 + rnd() * 0.06, rnd() * 200]);
  // world -> intensity
  return (wx, wy) => {
    let v = 60 + 30 * Math.sin(wx * 2) * Math.cos(wy * 3);
    for (const [bx, by, r, c] of blobs) {
      const d = (wx - bx) ** 2 + (wy - by) ** 2;
      if (d < r * r) v = c;
    }
    return v;
  };
}

// Render the world through a camera at (cx, cy) with zoom z.
function render(world, cx, cy, z) {
  const d = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) d[y * W + x] = world(cx + ((x - W / 2) / W) * 2 / z, cy + ((y - H / 2) / W) * 2 / z);
  return { w: W, h: H, d };
}

// Where a world point appears in normalised frame coordinates.
function project(wx, wy, cx, cy, z) {
  return [((wx - cx) * z * W) / 2 / W + 0.5, ((wy - cy) * z * W) / 2 / H + 0.5];
}

test("follows a part while the camera pans and zooms", () => {
  const world = scene();
  const target = [0.2, -0.1]; // the part, in world units
  let cam = [0, 0, 1];
  const [px, py] = project(...target, ...cam);
  const t = new BoxTracker(render(world, ...cam), { x: px, y: py, w: 0.2, h: 0.25 });
  for (let i = 1; i <= 30; i++) {
    cam = [0.012 * i, 0.006 * i, 1 + 0.008 * i];
    const step = t.push(render(world, ...cam));
    assert.equal(step.state, "tracking", `lost at frame ${i}`);
  }
  const [ex, ey] = project(...target, ...cam);
  assert.ok(Math.abs(t.box.x - ex) < 0.02, `x ${t.box.x} vs ${ex}`);
  assert.ok(Math.abs(t.box.y - ey) < 0.02, `y ${t.box.y} vs ${ey}`);
  assert.ok(t.box.w > 0.2 * 1.15, "box grew with zoom");
});

test("reports lost instead of guessing when the view changes completely", () => {
  const a = scene(1);
  const b = scene(99);
  const t = new BoxTracker(render(a, 0, 0, 1), { x: 0.5, y: 0.5, w: 0.25, h: 0.25 });
  const step = t.push(render(b, 0.5, 0.5, 1));
  assert.equal(step.state, "lost");
});

test("lost on a blank region (nothing to track)", () => {
  const flat = { w: W, h: H, d: new Float32Array(W * H).fill(90) };
  const t = new BoxTracker(flat, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 });
  assert.equal(t.state, "lost");
});

test("catches up from an older server frame to the newest client frame", () => {
  const world = scene(3);
  const frames = [];
  for (let i = 0; i < 25; i++) frames.push(render(world, 0.015 * i, -0.01 * i, 1));
  const anchorIdx = 5; // the server analysed this frame; the client has moved on since
  const target = [0.1, 0.05];
  const [px, py] = project(...target, 0.015 * anchorIdx, -0.01 * anchorIdx, 1);
  const t = catchUp(frames[anchorIdx], { x: px, y: py, w: 0.2, h: 0.2 }, frames);
  assert.ok(t, "caught up");
  const [ex, ey] = project(...target, 0.015 * 24, -0.01 * 24, 1);
  assert.ok(Math.abs(t.box.x - ex) < 0.02 && Math.abs(t.box.y - ey) < 0.02, `${t.box.x},${t.box.y} vs ${ex},${ey}`);
});
