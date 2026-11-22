/**
 * Keeps an on-screen box locked to a real part in the live camera video.
 *
 * The mechanic locates a part on one server-side frame (seconds old by the time it arrives). We find
 * that moment in a short buffer of recent frames, then follow the part forward to "now" and on, frame
 * by frame, with pyramidal Lucas-Kanade optical flow on corner features inside the box. Every hop is
 * checked forward and backward; when too few features survive, the tracker reports "lost" rather than
 * drawing a box in the wrong place.
 *
 * Pure functions on small grayscale images, so it runs in the browser and in Node tests.
 */

export interface Gray {
  w: number;
  h: number;
  d: Float32Array;
}

/** Normalised box: centre and size in 0..1 of the frame. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Pyramid = Gray[];
type Pt = [number, number];

export const WORK_WIDTH = 320;
const LEVELS = 4;
const WIN = 5; // half window: 11x11 patches
const ITERS = 12;
const FB_MAX = 1.2; // forward-backward error allowed, in working-resolution pixels

/** RGBA pixels (e.g. ImageData.data) to grayscale. */
export function grayFromRGBA(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { w, h, d };
}

function half(g: Gray): Gray {
  const w = Math.max(1, g.w >> 1);
  const h = Math.max(1, g.h >> 1);
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(g.h - 1, 2 * y);
    const y1 = Math.min(g.h - 1, 2 * y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(g.w - 1, 2 * x);
      const x1 = Math.min(g.w - 1, 2 * x + 1);
      d[y * w + x] = (g.d[y0 * g.w + x0] + g.d[y0 * g.w + x1] + g.d[y1 * g.w + x0] + g.d[y1 * g.w + x1]) / 4;
    }
  }
  return { w, h, d };
}

function blur(g: Gray): Gray {
  // 1-2-1 separable blur: makes gradients stable on noisy phone video.
  const { w, h } = g;
  const t = new Float32Array(w * h);
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = g.d[y * w + Math.max(0, x - 1)];
      const r = g.d[y * w + Math.min(w - 1, x + 1)];
      t[y * w + x] = (l + 2 * g.d[y * w + x] + r) / 4;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = t[Math.max(0, y - 1) * w + x];
      const dn = t[Math.min(h - 1, y + 1) * w + x];
      o[y * w + x] = (u + 2 * t[y * w + x] + dn) / 4;
    }
  return { w, h, d: o };
}

export function pyramid(g: Gray, levels = LEVELS): Pyramid {
  const out = [blur(g)];
  while (out.length < levels && out[out.length - 1].w > 24) out.push(half(out[out.length - 1]));
  return out;
}

function sample(g: Gray, x: number, y: number): number {
  const xc = Math.max(0, Math.min(g.w - 1.001, x));
  const yc = Math.max(0, Math.min(g.h - 1.001, y));
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const fx = xc - x0;
  const fy = yc - y0;
  const i = y0 * g.w + x0;
  return (
    g.d[i] * (1 - fx) * (1 - fy) + g.d[i + 1] * fx * (1 - fy) + g.d[i + g.w] * (1 - fx) * fy + g.d[i + g.w + 1] * fx * fy
  );
}

/** Shi-Tomasi corners inside a box, at most one per grid cell so they spread over the part. */
export function features(g: Gray, box: Box, max = 40): Pt[] {
  const x0 = Math.max(2, Math.floor((box.x - box.w / 2) * g.w));
  const x1 = Math.min(g.w - 3, Math.ceil((box.x + box.w / 2) * g.w));
  const y0 = Math.max(2, Math.floor((box.y - box.h / 2) * g.h));
  const y1 = Math.min(g.h - 3, Math.ceil((box.y + box.h / 2) * g.h));
  if (x1 - x0 < 6 || y1 - y0 < 6) return [];
  const cell = Math.max(3, Math.round(Math.sqrt(((x1 - x0) * (y1 - y0)) / max)));
  const best = new Map<number, [number, number, number]>();
  let top = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let sxx = 0, syy = 0, sxy = 0;
      for (let v = -2; v <= 2; v++)
        for (let u = -2; u <= 2; u++) {
          const i = (y + v) * g.w + x + u;
          const gx = (g.d[i + 1] - g.d[i - 1]) / 2;
          const gy = (g.d[i + g.w] - g.d[i - g.w]) / 2;
          sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
        }
      const tr = (sxx + syy) / 2;
      const score = tr - Math.sqrt(Math.max(0, tr * tr - (sxx * syy - sxy * sxy)));
      const key = Math.floor((y - y0) / cell) * 10000 + Math.floor((x - x0) / cell);
      const cur = best.get(key);
      if (!cur || score > cur[2]) best.set(key, [x, y, score]);
      if (score > top) top = score;
    }
  return [...best.values()]
    .filter((p) => p[2] > Math.max(top * 0.02, 1)) // drop flat regions
    .sort((a, b) => b[2] - a[2])
    .slice(0, max)
    .map(([x, y]) => [x, y]);
}

function lkOne(prev: Pyramid, next: Pyramid, p: Pt): Pt | null {
  let gx = 0, gy = 0; // guess, in pixels of the current level
  for (let L = prev.length - 1; L >= 0; L--) {
    const A = prev[L];
    const B = next[L];
    const s = 1 / (1 << L);
    const px = p[0] * s, py = p[1] * s;
    let sxx = 0, syy = 0, sxy = 0;
    const n = (2 * WIN + 1) ** 2;
    const Ix = new Float32Array(n), Iy = new Float32Array(n), I0 = new Float32Array(n);
    let k = 0;
    for (let v = -WIN; v <= WIN; v++)
      for (let u = -WIN; u <= WIN; u++, k++) {
        const x = px + u, y = py + v;
        const ix = (sample(A, x + 1, y) - sample(A, x - 1, y)) / 2;
        const iy = (sample(A, x, y + 1) - sample(A, x, y - 1)) / 2;
        Ix[k] = ix; Iy[k] = iy; I0[k] = sample(A, x, y);
        sxx += ix * ix; syy += iy * iy; sxy += ix * iy;
      }
    const det = sxx * syy - sxy * sxy;
    if (det < 1e-3) return null;
    let dx = 0, dy = 0;
    for (let it = 0; it < ITERS; it++) {
      let bx = 0, by = 0;
      k = 0;
      for (let v = -WIN; v <= WIN; v++)
        for (let u = -WIN; u <= WIN; u++, k++) {
          const diff = I0[k] - sample(B, px + gx + dx + u, py + gy + dy + v);
          bx += diff * Ix[k]; by += diff * Iy[k];
        }
      const ux = (syy * bx - sxy * by) / det;
      const uy = (sxx * by - sxy * bx) / det;
      dx += ux; dy += uy;
      if (ux * ux + uy * uy < 0.0009) break;
    }
    gx += dx; gy += dy;
    if (L > 0) { gx *= 2; gy *= 2; }
  }
  const out: Pt = [p[0] + gx, p[1] + gy];
  const g0 = next[0];
  if (!Number.isFinite(out[0]) || out[0] < 0 || out[1] < 0 || out[0] > g0.w - 1 || out[1] > g0.h - 1) return null;
  return out;
}

/** Track points forward and back; keep only those that return to where they started. */
export function trackPoints(prev: Pyramid, next: Pyramid, pts: Pt[]): { from: Pt[]; to: Pt[] } {
  const from: Pt[] = [];
  const to: Pt[] = [];
  for (const p of pts) {
    const q = lkOne(prev, next, p);
    if (!q) continue;
    const back = lkOne(next, prev, q);
    if (!back) continue;
    if (Math.hypot(back[0] - p[0], back[1] - p[1]) <= FB_MAX) {
      from.push(p);
      to.push(q);
    }
  }
  return { from, to };
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Move and scale a box by the motion of its tracked points (robust to a few bad points). */
export function moveBox(box: Box, from: Pt[], to: Pt[], g: Gray): Box {
  const dx = median(to.map((q, i) => q[0] - from[i][0]));
  const dy = median(to.map((q, i) => q[1] - from[i][1]));
  const ratios: number[] = [];
  for (let i = 0; i < from.length; i++)
    for (let j = i + 1; j < from.length; j += Math.max(1, Math.floor(from.length / 12))) {
      const d0 = Math.hypot(from[i][0] - from[j][0], from[i][1] - from[j][1]);
      if (d0 > 4) ratios.push(Math.hypot(to[i][0] - to[j][0], to[i][1] - to[j][1]) / d0);
    }
  const s = ratios.length >= 3 ? Math.max(0.8, Math.min(1.25, median(ratios))) : 1;
  return { x: box.x + dx / g.w, y: box.y + dy / g.h, w: box.w * s, h: box.h * s };
}

/** Mean absolute difference between two images after shrinking both: used to find the marker's frame. */
export function frameDistance(a: Gray, b: Gray): number {
  if (Math.abs(a.w / a.h - b.w / b.h) > 0.05) return Infinity;
  let pa = a, pb = b;
  while (pa.w > 48) pa = half(pa);
  while (pb.w > 48) pb = half(pb);
  if (pa.w !== pb.w || pa.h !== pb.h) return Infinity;
  let s = 0;
  for (let i = 0; i < pa.d.length; i++) s += Math.abs(pa.d[i] - pb.d[i]);
  return s / pa.d.length;
}

export type TrackState = "tracking" | "lost";

export interface Step {
  box: Box;
  state: TrackState;
  points: number;
}

/** Follows one box through a stream of frames. */
export class BoxTracker {
  box: Box;
  state: TrackState = "tracking";
  private pyr: Pyramid;
  private pts: Pt[];
  private startCount: number;
  private sinceSeed = 0;

  constructor(frame: Gray, box: Box) {
    this.box = { ...box };
    this.pyr = pyramid(frame);
    this.pts = features(this.pyr[0], box);
    this.startCount = this.pts.length;
    if (this.pts.length < 6) this.state = "lost";
  }

  /** Advance to the next frame. Once lost, stays lost until a new marker arrives. */
  push(frame: Gray): Step {
    if (this.state === "lost") return { box: this.box, state: "lost", points: 0 };
    const next = pyramid(frame);
    const { from, to } = trackPoints(this.pyr, next, this.pts);
    const enough = to.length >= 6 && to.length >= this.startCount * 0.3;
    if (!enough) {
      this.state = "lost";
      return { box: this.box, state: "lost", points: to.length };
    }
    this.box = moveBox(this.box, from, to, next[0]);
    const off = this.box.x < -0.1 || this.box.x > 1.1 || this.box.y < -0.1 || this.box.y > 1.1;
    if (off) this.state = "lost";
    // Keep points that stay inside the box; re-seed periodically so features don't run out.
    const inBox = (p: Pt) =>
      Math.abs(p[0] / next[0].w - this.box.x) <= this.box.w / 2 && Math.abs(p[1] / next[0].h - this.box.y) <= this.box.h / 2;
    this.pts = to.filter(inBox);
    this.pyr = next;
    if (++this.sinceSeed >= 15 || this.pts.length < this.startCount * 0.6) {
      const fresh = features(next[0], this.box);
      if (fresh.length >= 6) {
        this.pts = fresh;
        this.startCount = fresh.length;
      }
      this.sinceSeed = 0;
    }
    return { box: this.box, state: this.state, points: this.pts.length };
  }
}

/**
 * Start tracking from a marker. `anchor` is the frame the server located the part on; `recent` is
 * the client's buffer of frames, oldest first. Finds the closest buffered frame and follows the box
 * from there to the newest frame. Returns null if the part can't be followed (caller falls back to
 * showing the still picture).
 */
export function catchUp(anchor: Gray, box: Box, recent: Gray[]): BoxTracker | null {
  if (!recent.length) return null;
  let bestI = -1;
  let bestD = Infinity;
  recent.forEach((g, i) => {
    const d = frameDistance(anchor, g);
    if (d < bestD) { bestD = d; bestI = i; }
  });
  if (bestI < 0 || !Number.isFinite(bestD)) return null;
  const t = new BoxTracker(anchor, box);
  for (let i = bestI; i < recent.length && t.state === "tracking"; i++) t.push(recent[i]);
  return t.state === "tracking" ? t : null;
}
