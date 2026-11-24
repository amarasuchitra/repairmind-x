// The product's outer body: shapes, the hollow shell, its maths, the fit, the photo trace and the STL.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MATERIALS, PRESETS, area, buildShell, engineering, fit, halfMesh, inset, meshVolume, normalize, roundedRect, scaleToFit, star, stl, volume } from "../src/sim/shell.ts";
import { trace } from "../src/sim/outline.ts";

const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b}`);
const spec = (o = {}) => ({ outline: roundedRect(1, 1, 0.001), width: 100, height: 60, depth: 40, round: 0, wall: 2, material: "pla", ...o });

test("a sharp-edged box shell has the volumes you would work out by hand", () => {
  const sh = buildShell(spec());
  near(volume(sh.outer), 100 * 60 * 40, 0.01, "outer");
  near(volume(sh.inner), 96 * 56 * 36, 0.02, "inner");
});

test("inset moves every edge in by the same distance", () => {
  const sq = normalize(roundedRect(1, 1, 0.001), 50, 50);
  const a = Math.abs(area(inset(sq, 5)));
  near(a, 40 * 40, 0.02, "square inset");
});

test("each printed half is a closed solid whose mesh volume matches the maths", () => {
  for (const p of PRESETS) {
    const s = spec({ outline: p.make(), width: 90, height: 80, depth: 36, round: 10, wall: 2.4 });
    const sh = buildShell(s);
    const both = meshVolume(halfMesh(sh, 1)) + meshVolume(halfMesh(sh, -1));
    const want = volume(sh.outer) - volume(sh.inner);
    assert.ok(both > 0, `${p.id}: the triangles face outward`);
    near(both, want, 0.03, `${p.id} material volume`);
  }
});

test("STL: 84-byte header plus 50 bytes a triangle, with the count in the header", () => {
  const tris = halfMesh(buildShell(spec({ outline: star(5, 0.5), round: 8 })), 1);
  const buf = stl(tris);
  assert.equal(buf.byteLength, 84 + 50 * tris.length);
  assert.equal(new DataView(buf).getUint32(80, true), tris.length);
});

test("the squeeze test follows Roark's plate formula and a thicker wall is stronger", () => {
  const s = spec({ wall: 2 });
  const n = engineering(s, buildShell(s), 100);
  const m = MATERIALS.find((x) => x.id === "pla");
  const a = n.spanR;
  const sigma = (3 * 100) / (2 * Math.PI * 4) * (1.35 * Math.log(a / 5) + 1);
  near(n.stressMPa, sigma, 1e-9, "stress");
  near(n.safety, (m.strength * m.across) / sigma, 1e-9, "safety factor");
  const thick = spec({ wall: n.wallFor2 });
  near(engineering(thick, buildShell(thick), 100).safety, 2, 0.05, "the suggested wall gives a safety factor of 2");
  near(n.massG, (n.materialVol / 1000) * m.density, 1e-9, "mass");
});

test("the electronics fit check: fits in a big box, not in a thin one, and scaling finds the size that works", () => {
  const parts = [{ name: "ESP32", size: [55, 28, 13] }, { name: "Battery", size: [58, 48, 16] }, { name: "Speaker", size: [40, 40, 20] }];
  assert.equal(fit(buildShell(spec({ width: 140, height: 100, depth: 40 })), parts).ok, true);
  const thin = fit(buildShell(spec({ width: 140, height: 100, depth: 18 })), parts);
  assert.equal(thin.ok, false);
  assert.match(thin.reason, /only 14 mm deep/);
  const starSpec = spec({ outline: star(5, 0.5), width: 90, height: 86, depth: 30, round: 10 });
  assert.equal(fit(buildShell(starSpec), parts).ok, false);
  const k = scaleToFit(starSpec, parts);
  assert.ok(k && k > 1 && k < 4, `scale ${k}`);
  assert.equal(fit(buildShell({ ...starSpec, width: 90 * k, height: 86 * k, depth: 30 * k }), parts).ok, true);
});

test("tracing a photo: a star on a plain background comes back as a star", () => {
  const W = 200, H = 180;
  const data = new Uint8ClampedArray(W * H * 4);
  const shape = normalize(star(5, 0.45), 150, 140).map(([x, y]) => [x + 100, 90 - y]);
  const inPoly = (x, y) => { let c = false; for (let i = 0, j = shape.length - 1; i < shape.length; j = i++) { const [xi, yi] = shape[i], [xj, yj] = shape[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const on = inPoly(x + 0.5, y + 0.5);
    // a yellow star on a light grey table, with a little noise
    const n = ((x * 13 + y * 7) % 11) - 5;
    data[i] = on ? 245 + n / 2 : 222 + n; data[i + 1] = on ? 196 + n : 222 + n; data[i + 2] = on ? 40 + n : 218 + n; data[i + 3] = 255;
  }
  const t = trace({ width: W, height: H, data });
  assert.ok(t, "traced");
  near(t.aspect, 140 / 150, 0.05, "aspect");
  near(Math.abs(area(t.outline)), Math.abs(area(shape)), 0.06, "area");
  assert.ok(t.outline.length >= 10 && t.outline.length < 200, `${t.outline.length} points`);
  assert.equal(t.note, "");
});
