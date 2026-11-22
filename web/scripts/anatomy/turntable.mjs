// Builds the record-player anatomy figure (isometric SVG) used by the diagnosis view.
// Run: node scripts/anatomy/turntable.mjs   ->   writes src/anatomy/turntable.gen.ts
//
// Drawn with the Anatomy kit (vendor/anatomy, MIT). The deck is built the way a belt-drive turntable is:
// a plinth on isolation feet, a motor pulley at the back left, a sub-platter on the main bearing with the
// drive belt looped round both, the platter with strobe dots, mat and record on top, a tonearm with a
// counterweight, headshell and cartridge, an arm rest, two speed buttons, a power knob and a pitch slider.
// The platter assembly is wrapped in <g data-asm> with its lift projected to screen units, so the page can
// raise it with CSS alone and show the belt underneath.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../../vendor/anatomy/iso-kit.mjs";
import * as G from "../../vendor/anatomy/lathe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../src/anatomy/turntable.gen.ts");

const W = 600, H = 420;

/* ---------------------------------------------------------------- world plan (x: right end, y: front edge, z: up) */
const FOOT_H = 5;
const PLINTH = { x: -110, y: -82, w: 220, d: 164, r: 6 };
const TOP = 23;
const PC = [-27.5, 2.5]; // platter centre
const PU = [-81, -49]; // motor pulley
const SUB_R = 29, PULLEY_R = 4;
const BELT_Z = TOP + 4;
const PLATTER_Z = TOP + 8, PLATTER_H = 8, PLATTER_R = 75;
const ARM = [69, -46]; // tonearm pivot
const ARM_Z = TOP + 21;
const ARM_LEN = 104;
const LIFT = 118; // how far the platter rises when it comes off

const P = k.fitProjection(
  [
    ...k.boxCorners(PLINTH, 0, TOP),
    ...Array.from({ length: 16 }, (_, i) => {
      const a = (i / 16) * Math.PI * 2;
      return [PC[0] + Math.cos(a) * PLATTER_R, PC[1] + Math.sin(a) * PLATTER_R, PLATTER_Z + PLATTER_H + LIFT + 4];
    }),
  ],
  W, H, { pad: 26, azimuth: 36, elevation: 30 },
);
const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const path3 = (pts, closed = false) => k.pathOf(pts.map(at), closed);
const part = (name, body) => `<g data-part="${name}">${body}</g>`;
const UP = (x, y, z) => G.frameOf([x, y, z], [0, 0, 1], [1, 0, 0], [0, 1, 0]);

/* ---------------------------------------------------------------- plinth and feet */
function plinth() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLINTH, 0, TOP, P)}"/>`];
  for (const [x, y] of k.corners(PLINTH, 16).sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P))) {
    out.push(S(k.cylinder(x, y, 9, 0, FOOT_H, P, 28, 0.6), { tone: "lo" }));
  }
  out.push(S(k.slabOf(PLINTH, FOOT_H, TOP - FOOT_H, P, 6, 1.4), { tone: "mid", inner: L(k.sideSeam(PLINTH, FOOT_H + 6, P, 6), { tone: "faint" }) }));
  out.push(L(k.planOutline(k.insetPlan(PLINTH, 4), TOP, P, 6), { tone: "faint" }));
  // dust-cover hinges at the back
  for (const x of [-68, 62]) out.push(S(k.slabOf({ x: x - 10, y: -84, w: 20, d: 7, r: 1.5 }, TOP, 6, P, 3, 0.4), { tone: "lo" }));
  return out.join("");
}

function power() {
  const out = [];
  out.push(S(k.cylinder(-94, -62, 8, TOP, 6, P, 32, 0.6), { tone: "mid" }));
  out.push(k.fadedSvg(G.ribsOf(UP(-94, -62, 0), TOP + 0.6, TOP + 5.4, 8, 26, P, { fade: [0.05, 0.4] }), { tone: "lo" }));
  out.push(D([at([-79, -62, TOP])], { size: 0.8, tone: "hi" }));
  return out.join("");
}

/* ---------------------------------------------------------------- drive: pulley, sub-platter, belt */
function pulley() {
  const out = [];
  out.push(S(k.cylinder(PU[0], PU[1], 6, TOP, 1.5, P, 28), { tone: "lo" }));
  out.push(S(k.cylinder(PU[0], PU[1], PULLEY_R, TOP + 1.5, 7, P, 24, 0.3), { tone: "hi" }));
  out.push(L(k.sideArc(PU[0], PU[1], PULLEY_R, BELT_Z, P, 16), { tone: "lo" }));
  return out.join("");
}

function subPlatter() {
  const out = [];
  out.push(S(k.cylinder(PC[0], PC[1], 10, TOP, 2, P, 32), { tone: "lo" }));
  out.push(S(k.cylinder(PC[0], PC[1], SUB_R, TOP + 2, 6, P, 72, 0.5), { tone: "mid" }));
  out.push(S(k.cylinder(PC[0], PC[1], 5, TOP + 8, 3, P, 24, 0.3), { tone: "hi" }));
  return out.join("");
}

function belt() {
  // a closed loop: round the far side of the sub-platter, straight runs, round the pulley
  const dx = PU[0] - PC[0], dy = PU[1] - PC[1];
  const ang = Math.atan2(dy, dx), dist = Math.hypot(dx, dy);
  const t = Math.acos((SUB_R + 0.6 - PULLEY_R) / dist);
  const R = SUB_R + 0.6, r = PULLEY_R + 0.6;
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = ang + t + (i / 64) * (Math.PI * 2 - t * 2);
    pts.push([PC[0] + Math.cos(a) * R, PC[1] + Math.sin(a) * R, BELT_Z]);
  }
  for (let i = 0; i <= 16; i++) {
    const a = ang - t + (i / 16) * t * 2;
    pts.push([PU[0] + Math.cos(a) * r, PU[1] + Math.sin(a) * r, BELT_Z]);
  }
  return L(path3(pts, true), { tone: "hi" }) + L(path3(pts.map(([x, y, z]) => [x, y, z + 1.2]), true), { tone: "hi" });
}

/* ---------------------------------------------------------------- platter, mat, record (lift together) */
function platter() {
  const out = [];
  const z0 = PLATTER_Z;
  out.push(S(k.cylinder(PC[0], PC[1], PLATTER_R, z0, PLATTER_H, P, 160, 0.8), { tone: "mid" }));
  // strobe dots round the rim, on the side the viewer sees
  out.push(D(Array.from({ length: 120 }, (_, i) => (i / 120) * Math.PI * 2)
    .filter((a) => Math.cos(a) * Math.cos((36 * Math.PI) / 180) * 0 + (Math.cos(a) * 0.59 + Math.sin(a) * 0.81) > 0.05)
    .map((a) => at([PC[0] + Math.cos(a) * PLATTER_R, PC[1] + Math.sin(a) * PLATTER_R, z0 + PLATTER_H * 0.45])), { size: 0.45, tone: "lo" }));
  out.push(S(k.cylinder(PC[0], PC[1], PLATTER_R - 3, z0 + PLATTER_H, 1.2, P, 150), { tone: "lo", crease: "none" }));
  return out.join("");
}

function record() {
  const out = [];
  const z = PLATTER_Z + PLATTER_H + 1.2;
  out.push(S(k.cylinder(PC[0], PC[1], 70, z, 1, P, 150), { tone: "lo", crease: "none" }));
  const grooves = [];
  for (let r = 26; r <= 68; r += 3.5) grooves.push(k.ring(PC[0], PC[1], r, z + 1, P, 96));
  out.push(L(grooves.join(""), { tone: "faint" }));
  out.push(L([31, 44, 57].map((r) => k.ring(PC[0], PC[1], r, z + 1, P, 96)).join(""), { tone: "lo" }));
  out.push(S(k.cylinder(PC[0], PC[1], 22, z + 1, 0.3, P, 64), { tone: "hi", crease: "none" }));
  out.push(L(k.ring(PC[0], PC[1], 19, z + 1.3, P, 64), { tone: "mid" }));
  out.push(S(k.cylinder(PC[0], PC[1], 1.4, z + 1.3, 7, P, 12), { tone: "hi" }));
  return out.join("");
}

/* ---------------------------------------------------------------- tonearm */
function armBase() {
  const out = [];
  out.push(S(k.cylinder(ARM[0], ARM[1], 15, TOP, 4, P, 48, 0.6), { tone: "lo" }));
  out.push(S(k.cylinder(ARM[0], ARM[1], 5, TOP + 4, ARM_Z - TOP - 8, P, 28), { tone: "hi", crease: "none" }));
  out.push(S(k.cylinder(ARM[0], ARM[1], 6.5, ARM_Z - 4, 7, P, 28, 0.4), { tone: "mid" }));
  return out.join("");
}

const FA = G.frameAlong([ARM[0], ARM[1], ARM_Z], [0, 1, 0]); // s runs from the pivot toward the front
function tonearm() {
  const out = [];
  out.push(S(G.disc(-30, -18, 7, FA, P, { bevel: 0.6 }), { tone: "mid" }));
  out.push(S(G.disc(-18, 0, 2, FA, P), { tone: "hi" }));
  out.push(S(G.disc(0, ARM_LEN - 8, 1.5, FA, P), { tone: "hi" }));
  return out.join("");
}

function cartridge() {
  const out = [];
  const hx = ARM[0], hy = ARM[1] + ARM_LEN;
  out.push(S(k.slabOf({ x: hx - 5.5, y: hy - 12, w: 11, d: 16, r: 1.5 }, ARM_Z - 1, 2, P, 3, 0.3), { tone: "mid" }));
  out.push(S(k.slabOf({ x: hx - 4, y: hy - 9, w: 8, d: 10, r: 1 }, ARM_Z - 6, 5, P, 3, 0.3), { tone: "hi" }));
  // finger lift
  out.push(L(path3([[hx + 5.5, hy - 2, ARM_Z], [hx + 10, hy - 2, ARM_Z + 1.5]]), { tone: "mid" }));
  return out.join("");
}

function armRest() {
  const out = [];
  const x = ARM[0] + 4, y = ARM[1] + 78;
  out.push(S(k.cylinder(x, y, 1.6, TOP, ARM_Z - TOP - 4, P, 16), { tone: "hi", crease: "none" }));
  out.push(S(k.slabOf({ x: x - 4, y: y - 3.5, w: 8, d: 7, r: 1.5 }, ARM_Z - 4, 2.5, P, 3, 0.3), { tone: "lo" }));
  // cue lever
  out.push(S(k.slabOf({ x: ARM[0] + 18, y: ARM[1] + 4, w: 4, d: 12, r: 1.2 }, TOP, 6, P, 3, 0.3), { tone: "lo" }));
  return out.join("");
}

/* ---------------------------------------------------------------- controls */
function speed() {
  const out = [];
  [-92, -74].forEach((x, i) => {
    out.push(S(k.cylinder(x, 64, 6, TOP, 2.5, P, 32, 0.5), { tone: "mid" }));
    out.push(D([at([x, 54, TOP])], { size: 0.7, tone: i === 0 ? "hi" : "lo" }));
  });
  return out.join("");
}

function pitch() {
  const out = [];
  out.push(S(k.slabOf({ x: 93, y: 18, w: 4, d: 40, r: 1.5 }, TOP, 0.6, P, 3), { tone: "lo", crease: "none" }));
  out.push(S(k.slabOf({ x: 90, y: 34, w: 10, d: 6, r: 1.5 }, TOP, 4, P, 3, 0.4), { tone: "mid" }));
  out.push(L([20, 28, 38, 48, 56].map((y) => k.lineOnTop([100, y], [103, y], TOP, P)).join(""), { tone: "faint" }));
  return out.join("");
}

/* ---------------------------------------------------------------- assemble */
const lift = k.axisVector(P, [0, 0, LIFT]);
const asm = (name, body) => `<g data-asm="${name}" style="--ax:${lift[0].toFixed(2)}px;--ay:${lift[1].toFixed(2)}px">${body}</g>`;

const svg = k.figureSvg({
  width: W,
  height: H,
  className: "anat-svg",
  label: "Isometric anatomy of a belt-drive record player: plinth on four feet, motor pulley at the back left, the sub-platter with the drive belt looped round it and the pulley, the platter with mat and record, the tonearm with counterweight, headshell and cartridge, an arm rest, speed buttons, power knob and pitch slider.",
  body: [
    part("plinth", plinth()),
    part("power", power()),
    part("pulley", pulley()),
    part("sub-platter", subPlatter()),
    part("belt", belt()),
    part("tonearm", armBase()),
    asm("platter", part("platter", platter()) + part("record", record())),
    part("tonearm", armRest()),
    part("tonearm", tonearm()),
    part("cartridge", cartridge()),
    part("speed", speed()),
    part("pitch", pitch()),
  ],
});

// screen points to pin a marker to each part, at rest and with the platter off
const pin = (name, p, lifted = false) => {
  const a = at(p), b = lifted ? at([p[0], p[1], p[2] + LIFT]) : a;
  return [name, { x: +a[0].toFixed(1), y: +a[1].toFixed(1), ax: +b[0].toFixed(1), ay: +b[1].toFixed(1) }];
};
const front = Math.atan2(0.81, 0.59); // the plan direction that faces the viewer
const PINS = Object.fromEntries([
  pin("plinth", [40, 82, TOP - 8]),
  pin("power", [-94, -62, TOP + 6]),
  pin("pulley", [PU[0], PU[1], TOP + 8.5]),
  pin("sub-platter", [PC[0] + Math.cos(front) * SUB_R, PC[1] + Math.sin(front) * SUB_R, TOP + 6]),
  pin("belt", [PC[0] + Math.cos(front - 0.5) * (SUB_R + 0.6), PC[1] + Math.sin(front - 0.5) * (SUB_R + 0.6), BELT_Z]),
  pin("platter", [PC[0] + Math.cos(front) * PLATTER_R, PC[1] + Math.sin(front) * PLATTER_R, PLATTER_Z + 4], true),
  pin("record", [PC[0] + 30, PC[1] + 20, PLATTER_Z + PLATTER_H + 2.2], true),
  pin("tonearm", [ARM[0], ARM[1] + 50, ARM_Z]),
  pin("cartridge", [ARM[0], ARM[1] + ARM_LEN - 4, ARM_Z - 4]),
  pin("speed", [-83, 64, TOP + 2.5]),
  pin("pitch", [95, 37, TOP + 4]),
]);

const ts = `// Generated by scripts/anatomy/turntable.mjs with the Anatomy kit (MIT). Do not edit by hand.
export const DECK_W = ${W};
export const DECK_H = ${H};
export const DECK_PINS: Record<string, { x: number; y: number; ax: number; ay: number }> = ${JSON.stringify(PINS)};
export const DECK_SVG = ${JSON.stringify(svg)};
`;
writeFileSync(OUT, ts);
console.log("wrote", OUT, (svg.length / 1024).toFixed(0) + " KB");
