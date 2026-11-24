/**
 * The product's outer body: a hollow shell made from a front outline (traced from a photo, or a preset), the
 * measured size, a depth, how rounded its edges are, and a wall thickness. From those it builds the 3D shape,
 * splits it into two printable halves, checks the electronics fit inside, and works out the engineering: volume,
 * mass, print time and cost, and how hard the wall can be squeezed before it cracks (Roark's flat-plate
 * formulas). Plain functions over plain data, so the page and the tests use the same maths.
 *
 * Units are millimetres unless a name says otherwise. The outline lies in x (width) and y (height); depth is z,
 * and the shell splits at z = 0 into a front and a back half.
 */

export type Pt = [number, number];

export interface Material { id: string; name: string; density: number; E: number; strength: number; across: number; inrPerG: number; note: string }

/** Typical values for printed parts; "across" is how much weaker it is between FDM layers. */
export const MATERIALS: Material[] = [
  { id: "pla", name: "PLA (3D print)", density: 1.24, E: 3500, strength: 50, across: 0.6, inrPerG: 1.3, note: "Easy to print and stiff, but softens at 55 °C: not for a hot car or near a bulb." },
  { id: "petg", name: "PETG (3D print)", density: 1.27, E: 2000, strength: 45, across: 0.7, inrPerG: 1.5, note: "Tougher than PLA and fine to 70 °C; a good default for toys and gadgets." },
  { id: "abs", name: "ABS (3D print)", density: 1.04, E: 2200, strength: 40, across: 0.6, inrPerG: 1.4, note: "Takes heat to about 90 °C. Needs an enclosed printer; fumes need ventilation." },
  { id: "resin", name: "Standard resin (SLA)", density: 1.15, E: 2500, strength: 55, across: 1, inrPerG: 4, note: "Fine detail and smooth, but brittle: avoid thin walls on things that get dropped." },
  { id: "abs-im", name: "ABS (injection moulded)", density: 1.04, E: 2300, strength: 45, across: 1, inrPerG: 0.3, note: "For volume production; tooling costs far more than the parts." },
];

export interface ShellSpec {
  /** the front outline, any size; it is scaled to width × height */
  outline: Pt[];
  width: number;
  height: number;
  depth: number;
  /** edge rounding radius, 0 = sharp edges; up to half the depth for a pillow shape */
  round: number;
  wall: number;
  material: string;
}

// --- 2D helpers -------------------------------------------------------------------------------------------------

export function area(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}

export function centroid(p: Pt[]): Pt {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
    const k = x1 * y2 - x2 * y1;
    a += k; cx += (x1 + x2) * k; cy += (y1 + y2) * k;
  }
  if (Math.abs(a) < 1e-12) return [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(p: Pt[]) {
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Counter-clockwise, centred on its centroid, scaled to w × h. */
export function normalize(p: Pt[], w: number, h: number): Pt[] {
  let q = p.slice();
  if (area(q) < 0) q.reverse();
  const b = bbox(q);
  const sx = w / Math.max(b.x1 - b.x0, 1e-9), sy = h / Math.max(b.y1 - b.y0, 1e-9);
  q = q.map(([x, y]) => [(x - b.x0) * sx, (y - b.y0) * sy]);
  const c = centroid(q);
  return q.map(([x, y]) => [x - c[0], y - c[1]]);
}

export function inside(p: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Shortest distance from a point to the outline's edges. */
export function edgeDist(p: Pt[], x: number, y: number): number {
  let d = Infinity;
  for (let i = 0; i < p.length; i++) {
    const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
}

/** Move a counter-clockwise outline inward by d (a mitred offset, mitres capped so sharp tips don't overshoot). */
export function inset(p: Pt[], d: number): Pt[] {
  if (d <= 0) return p.slice();
  const n = p.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
    const e1 = norm([b[0] - a[0], b[1] - a[1]]), e2 = norm([c[0] - b[0], c[1] - b[1]]);
    // inward normals of a CCW outline point left of each edge
    const n1: Pt = [-e1[1], e1[0]], n2: Pt = [-e2[1], e2[0]];
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = Math.max(0.25, m[0] * n1[0] + m[1] * n1[1]);
    const k = d / cos;
    out.push([b[0] + m[0] * k, b[1] + m[1] * k]);
  }
  // an inset larger than the shape collapses toward the centroid rather than turning inside out
  const c = centroid(p);
  return out.map((q, i) => {
    const r0 = Math.hypot(p[i][0] - c[0], p[i][1] - c[1]);
    const r1 = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const dot = (q[0] - c[0]) * (p[i][0] - c[0]) + (q[1] - c[1]) * (p[i][1] - c[1]);
    return dot < 0 || r1 > r0 ? ([c[0] + (p[i][0] - c[0]) * 0.02, c[1] + (p[i][1] - c[1]) * 0.02] as Pt) : q;
  });
}

const norm = (v: Pt): Pt => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/** Fewer points along nearly straight runs (Douglas–Peucker). */
export function simplify(p: Pt[], tol: number): Pt[] {
  if (p.length < 4) return p.slice();
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(p[i], p[a], p[b]);
      if (d > best) { best = d; idx = i; }
    }
    if (best > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return p.filter((_, i) => keep[i]);
}

function segDist(q: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
}

/** Even spacing along the outline, so the 3D surface has regular quads. */
export function resample(p: Pt[], n: number): Pt[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < p.length; i++) { const l = Math.hypot(p[(i + 1) % p.length][0] - p[i][0], p[(i + 1) % p.length][1] - p[i][1]); seg.push(l); total += l; }
  const out: Pt[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (acc + seg[i] < target && i < p.length - 1) { acc += seg[i]; i++; }
    const t = seg[i] ? (target - acc) / seg[i] : 0;
    const a = p[i], b = p[(i + 1) % p.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// --- presets -------------------------------------------------------------------------------------------------------

export const PRESETS: { id: string; name: string; make: () => Pt[] }[] = [
  { id: "box", name: "Rounded box", make: () => roundedRect(1, 0.7, 0.12) },
  { id: "round", name: "Round", make: () => ellipse(1, 1) },
  { id: "oval", name: "Oval / egg", make: () => Array.from({ length: 96 }, (_, i) => { const a = (i / 96) * Math.PI * 2; return [0.42 * Math.cos(a) * (1 + 0.12 * Math.sin(a)), 0.55 * Math.sin(a)] as Pt; }) },
  { id: "star", name: "Star", make: () => star(5, 0.48) },
  { id: "heart", name: "Heart", make: () => Array.from({ length: 120 }, (_, i) => { const t = (i / 120) * Math.PI * 2; return [16 * Math.sin(t) ** 3, 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)] as Pt; }) },
];

export function star(points: number, innerRatio: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? innerRatio : 1;
    const a = Math.PI / 2 + (i * Math.PI) / points;
    out.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  // soften the tips a little, as a moulded or stuffed star has
  return roundCorners(out, 0.06);
}

export function ellipse(w: number, h: number, n = 96): Pt[] {
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [(w / 2) * Math.cos(a), (h / 2) * Math.sin(a)] as Pt; });
}

export function roundedRect(w: number, h: number, r: number): Pt[] {
  const out: Pt[] = [];
  const cs: [number, number, number][] = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, 90], [-w / 2 + r, -h / 2 + r, 180], [w / 2 - r, -h / 2 + r, 270]];
  for (const [cx, cy, a0] of cs) for (let k = 0; k <= 8; k++) { const a = ((a0 + k * 11.25) * Math.PI) / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

function roundCorners(p: Pt[], f: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
    const q1: Pt = [b[0] + (a[0] - b[0]) * f * 2, b[1] + (a[1] - b[1]) * f * 2];
    const q2: Pt = [b[0] + (c[0] - b[0]) * f * 2, b[1] + (c[1] - b[1]) * f * 2];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      // a quadratic curve through the corner
      out.push([(1 - t) ** 2 * q1[0] + 2 * (1 - t) * t * b[0] + t * t * q2[0], (1 - t) ** 2 * q1[1] + 2 * (1 - t) * t * b[1] + t * t * q2[1]]);
    }
  }
  return out;
}

// --- the 3D shell ----------------------------------------------------------------------------------------------------

export interface Layer { z: number; ring: Pt[] }

/** Outline rings from the middle (z = 0) up to the face (z = halfDepth), rounded over the last r millimetres. */
export function layers(profile: Pt[], halfDepth: number, r: number, steps = 10): Layer[] {
  const out: Layer[] = [];
  const rr = Math.max(0, Math.min(r, halfDepth));
  const flat = halfDepth - rr;
  out.push({ z: 0, ring: profile });
  if (flat > 1e-6) out.push({ z: flat, ring: profile });
  if (rr > 1e-6) {
    for (let k = 1; k <= steps; k++) {
      const a = (k / steps) * (Math.PI / 2);
      const z = flat + rr * Math.sin(a);
      out.push({ z, ring: inset(profile, rr * (1 - Math.cos(a))) });
    }
  }
  return out;
}

export interface Shell {
  profile: Pt[];
  outer: Layer[];
  inner: Layer[];
  innerProfile: Pt[];
  innerHalf: number;
}

export function buildShell(s: ShellSpec, samples = 120): Shell {
  const profile = resample(normalize(s.outline, s.width, s.height), samples);
  const wall = Math.max(0.4, s.wall);
  const outer = layers(profile, s.depth / 2, s.round);
  const innerProfile = inset(profile, wall);
  const innerHalf = Math.max(0.2, s.depth / 2 - wall);
  const inner = layers(innerProfile, innerHalf, Math.max(0, s.round - wall));
  return { profile, outer, inner, innerProfile, innerHalf };
}

/** Volume between z = 0 and the face, doubled for both halves (mm³). */
export function volume(ls: Layer[]): number {
  let v = 0;
  for (let i = 1; i < ls.length; i++) v += ((Math.abs(area(ls[i].ring)) + Math.abs(area(ls[i - 1].ring))) / 2) * (ls[i].z - ls[i - 1].z);
  return 2 * v;
}

// --- triangles and STL ------------------------------------------------------------------------------------------------

export type Tri = [number, number, number, number, number, number, number, number, number];

/**
 * One half of the shell as a closed, printable solid: the outer skin, the inner skin, the face caps and the rim
 * where the halves meet. side = 1 is the front (z ≥ 0), −1 the back. Triangles wind counter-clockwise seen from
 * outside the material.
 */
export function halfMesh(sh: Shell, side: 1 | -1): Tri[] {
  const tris: Tri[] = [];
  const P = (q: Pt, z: number) => [q[0], q[1], z * side] as [number, number, number];
  const push = (a: number[], b: number[], c: number[]) => tris.push(side === 1 ? [...a, ...b, ...c] as Tri : [...a, ...c, ...b] as Tri);
  const skin = (ls: Layer[], out: boolean) => {
    for (let i = 1; i < ls.length; i++) {
      const A = ls[i - 1], B = ls[i];
      const n = A.ring.length;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const a = P(A.ring[k], A.z), b = P(A.ring[k2], A.z), c = P(B.ring[k2], B.z), d = P(B.ring[k], B.z);
        if (out) { push(a, b, c); push(a, c, d); } else { push(a, c, b); push(a, d, c); }
      }
    }
  };
  const cap = (l: Layer, out: boolean) => {
    const c = centroid(l.ring);
    const n = l.ring.length;
    const C = P(c, l.z);
    for (let k = 0; k < n; k++) {
      const a = P(l.ring[k], l.z), b = P(l.ring[(k + 1) % n], l.z);
      if (out) push(C, a, b); else push(C, b, a);
    }
  };
  skin(sh.outer, true);
  skin(sh.inner, false);
  cap(sh.outer[sh.outer.length - 1], true);
  cap(sh.inner[sh.inner.length - 1], false);
  // the rim at z = 0: a ring between the outer and inner outlines, facing the other half
  const o = sh.outer[0].ring, inn = sh.inner[0].ring;
  const n = o.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const a = P(o[k], 0), b = P(o[k2], 0), c = P(inn[k2], 0), d = P(inn[k], 0);
    push(a, c, b); push(a, d, c);
  }
  return tris;
}

/** Binary STL, the format every slicer reads. */
export function stl(tris: Tri[], name = "repairmind shell"): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const header = name.slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const t of tris) {
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz, ...t]) { dv.setFloat32(o, v, true); o += 4; }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/** Signed volume of a closed mesh (divergence theorem); positive when it winds outward. */
export function meshVolume(tris: Tri[]): number {
  let v = 0;
  for (const t of tris) v += (t[0] * (t[4] * t[8] - t[5] * t[7]) - t[1] * (t[3] * t[8] - t[5] * t[6]) + t[2] * (t[3] * t[7] - t[4] * t[6])) / 6;
  return v;
}

// --- fit ---------------------------------------------------------------------------------------------------------------

export interface Box3 { name: string; size: [number, number, number] }
export interface Placed3 { name: string; x: number; y: number; z: number; w: number; h: number; d: number }

/** Lay the parts flat (thinnest side down) in rows, like packing a box by hand. */
export function pack(parts: Box3[], rowWidth: number, gap = 3): { placed: Placed3[]; w: number; h: number; d: number } {
  const flat = parts.map((p) => { const s = [...p.size].sort((a, b) => b - a); return { name: p.name, w: s[0], h: s[1], d: s[2] }; })
    .sort((a, b) => b.h - a.h);
  const placed: Placed3[] = [];
  let x = 0, y = 0, rowH = 0, W = 0;
  for (const p of flat) {
    if (x > 0 && x + p.w > rowWidth) { y += rowH + gap; x = 0; rowH = 0; }
    placed.push({ name: p.name, x, y, z: 0, w: p.w, h: p.h, d: p.d });
    x += p.w + gap;
    rowH = Math.max(rowH, p.h);
    W = Math.max(W, x - gap);
  }
  const H = y + rowH;
  const D = Math.max(0, ...flat.map((p) => p.d));
  // centre the block on the origin
  for (const p of placed) { p.x -= W / 2; p.y -= H / 2; }
  return { placed, w: W, h: H, d: D };
}

/** space to leave round the parts for wires and assembly, mm */
export const CLEARANCE = 2;

export interface Fit { ok: boolean; reason: string; placed: Placed3[]; angle: number; marginMm: number; block: [number, number, number] }

/** Does the packed block fit in the cavity? It tries several row widths, turns and positions. */
export function fit(sh: Shell, parts: Box3[]): Fit {
  if (!parts.length) return { ok: true, reason: "No electronics to fit yet.", placed: [], angle: 0, marginMm: Infinity, block: [0, 0, 0] };
  const innerDepth = sh.innerHalf * 2;
  const b = bbox(sh.innerProfile);
  const maxW = b.x1 - b.x0;
  let best: Fit | null = null;
  const tall = Math.max(...parts.map((p) => Math.min(...p.size)));
  if (tall > innerDepth) {
    return { ok: false, reason: `The thickest part is ${tall.toFixed(0)} mm thick even lying flat, but the inside is only ${innerDepth.toFixed(0)} mm deep.`, placed: [], angle: 0, marginMm: innerDepth - tall, block: [0, 0, tall] };
  }
  for (const frac of [1, 0.85, 0.7, 0.55, 0.4]) {
    const pk = pack(parts, maxW * frac);
    // the block must sit inside the outline at its own height (rounded faces get smaller toward the front)
    const ring = ringAt(sh.inner, pk.d / 2);
    for (let ang = 0; ang < 180; ang += 15) {
      const ca = Math.cos((ang * Math.PI) / 180), sa = Math.sin((ang * Math.PI) / 180);
      for (const [ox, oy] of offsets(b)) {
        const corners: Pt[] = [];
        for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const x = (u * pk.w) / 2, y = (v * pk.h) / 2;
          corners.push([ox + x * ca - y * sa, oy + x * sa + y * ca]);
        }
        if (!corners.every((c) => inside(ring, c[0], c[1]))) continue;
        const margin = Math.min(...corners.map((c) => edgeDist(ring, c[0], c[1])), sh.innerHalf - pk.d / 2);
        // leave room for wires and fingers
        if (margin < CLEARANCE) continue;
        if (!best || margin > best.marginMm) {
          best = {
            ok: true, reason: "", angle: ang, marginMm: margin, block: [pk.w, pk.h, pk.d],
            placed: pk.placed.map((p) => {
              const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
              return { ...p, x: ox + cx * ca - cy * sa, y: oy + cx * sa + cy * ca, z: 0 };
            }),
          };
        }
      }
    }
    if (best) break;
  }
  const found = best as Fit | null;
  if (found) return { ...found, reason: `Fits with ${found.marginMm.toFixed(1)} mm to spare at the tightest point.` };
  const pk = pack(parts, maxW);
  return { ok: false, reason: `The parts need about ${pk.w.toFixed(0)} × ${pk.h.toFixed(0)} × ${pk.d.toFixed(0)} mm laid out flat, which doesn't fit the cavity.`, placed: [], angle: 0, marginMm: -1, block: [pk.w, pk.h, pk.d] };
}

function ringAt(ls: Layer[], z: number): Pt[] {
  for (const l of ls) if (l.z >= z) return l.ring;
  return ls[ls.length - 1].ring;
}

function offsets(b: ReturnType<typeof bbox>): Pt[] {
  const out: Pt[] = [[0, 0]];
  const sx = (b.x1 - b.x0) / 8, sy = (b.y1 - b.y0) / 8;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (i || j) out.push([i * sx, j * sy]);
  return out;
}

/** The smallest uniform scale (1–4×) that makes the parts fit, or null. */
export function scaleToFit(s: ShellSpec, parts: Box3[]): number | null {
  const ok = (k: number) => fit(buildShell({ ...s, width: s.width * k, height: s.height * k, depth: s.depth * k }, 72), parts).ok;
  if (ok(1)) return 1;
  if (!ok(4)) return null;
  let lo = 1, hi = 4;
  for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return Math.ceil(hi * 100) / 100;
}

// --- the engineering ---------------------------------------------------------------------------------------------------

export interface Numbers {
  outerVol: number;
  innerVol: number;
  materialVol: number;
  massG: number;
  printH: number;
  costInr: number;
  /** the largest flat-ish span of wall: the radius of the biggest circle inside the inner outline, mm */
  spanR: number;
  /** squeeze test: a fingertip load in the middle of that span */
  squeezeN: number;
  stressMPa: number;
  allowMPa: number;
  safety: number;
  deflectMm: number;
  /** the wall needed for a safety factor of 2 */
  wallFor2: number;
  lines: { label: string; formula: string; value: string }[];
}

const NU = 0.35;
const FINGER = 5;

export function engineering(s: ShellSpec, sh: Shell, squeezeN = 100): Numbers {
  const m = MATERIALS.find((x) => x.id === s.material) ?? MATERIALS[0];
  const outerVol = volume(sh.outer);
  const innerVol = volume(sh.inner);
  const materialVol = Math.max(0, outerVol - innerVol);
  const massG = (materialVol / 1000) * m.density;
  // a printer lays down roughly 8 mm³ of plastic a second on walls, plus time for travel and layer changes
  const printH = m.id.startsWith("abs-im") ? 0 : (materialVol / 8 / 3600) * 1.35 + 0.15;
  const costInr = massG * m.inrPerG;
  const c = centroid(sh.innerProfile);
  const spanR = Math.max(FINGER + 1, edgeDist(sh.innerProfile, c[0], c[1]));
  const t = Math.max(0.4, s.wall);
  const allow = m.strength * m.across;
  // Roark: circular plate, simply supported edge, load W spread over a small central circle of radius r0
  const plate = (tt: number) => ((3 * squeezeN) / (2 * Math.PI * tt * tt)) * ((1 + NU) * Math.log(spanR / FINGER) + 1);
  const stress = plate(t);
  const D = (m.E * t ** 3) / (12 * (1 - NU * NU));
  const deflect = ((squeezeN * spanR * spanR) / (16 * Math.PI * D)) * ((3 + NU) / (1 + NU));
  const wallFor2 = Math.sqrt(((3 * squeezeN) / (2 * Math.PI)) * ((1 + NU) * Math.log(spanR / FINGER) + 1) / (allow / 2));
  const f1 = (x: number, d = 1) => x.toLocaleString("en", { maximumFractionDigits: d });
  return {
    outerVol, innerVol, materialVol, massG, printH, costInr, spanR, squeezeN, stressMPa: stress, allowMPa: allow, safety: allow / stress, deflectMm: deflect, wallFor2,
    lines: [
      { label: "Outer volume", formula: "Σ (layer area × layer height), both halves", value: `${f1(outerVol / 1000)} cm³` },
      { label: "Inside space", formula: "the same for the cavity, the wall's thickness in from every side", value: `${f1(innerVol / 1000)} cm³` },
      { label: "Plastic", formula: "outer − inside", value: `${f1(materialVol / 1000)} cm³` },
      { label: "Mass", formula: `plastic × ${m.density} g/cm³ (${m.name})`, value: `${f1(massG)} g` },
      { label: "Print time", formula: printH ? "plastic ÷ ~8 mm³/s × 1.35 for travel and layers" : "moulded: seconds per part", value: printH ? `${f1(printH)} h` : "–" },
      { label: "Material cost", formula: `mass × ₹${m.inrPerG}/g`, value: `₹${f1(costInr, 0)}` },
      { label: "Widest unsupported wall", formula: "biggest circle inside the outline, radius a", value: `a = ${f1(spanR)} mm` },
      { label: "Squeeze stress", formula: `σ = 3W/(2πt²)·[(1+ν)·ln(a/r₀) + 1], W = ${squeezeN} N, t = ${t} mm, r₀ = ${FINGER} mm (a fingertip), ν = ${NU}`, value: `${f1(stress)} MPa` },
      { label: "Strength it can take", formula: m.across < 1 ? `${m.strength} MPa × ${m.across} (weaker between printed layers)` : `${m.strength} MPa`, value: `${f1(allow)} MPa` },
      { label: "Safety factor", formula: "strength ÷ stress (aim for 2 or more)", value: f1(allow / stress, 2) },
      { label: "How far it flexes", formula: `y = W·a²/(16πD)·(3+ν)/(1+ν), D = E·t³/(12(1−ν²)), E = ${m.E} MPa`, value: `${f1(deflect, 2)} mm` },
      { label: "Wall for a safety factor of 2", formula: "solve σ = strength ÷ 2 for t", value: `${f1(wallFor2, 2)} mm` },
    ],
  };
}
