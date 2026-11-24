/**
 * Traces a product's outline from a photo taken straight on against a plain background: it learns the background
 * colour from the photo's border, marks every pixel that differs from it, keeps the biggest solid shape, fills
 * its holes, and follows its edge. The result is a polygon the shell builder can use (shell.ts). Plain pixel
 * data in, so it runs the same in the page and the tests.
 */
import { simplify, type Pt } from "./shell.ts";

export interface Pixels { width: number; height: number; data: Uint8ClampedArray | Uint8Array }

export interface Traced { outline: Pt[]; aspect: number; coverage: number; note: string }

export function trace(img: Pixels): Traced | null {
  const { width: W, height: H, data } = img;
  if (W < 8 || H < 8) return null;
  // the background: the median colour round the border
  const border: number[][] = [];
  for (let x = 0; x < W; x++) { border.push(px(data, W, x, 0), px(data, W, x, H - 1)); }
  for (let y = 0; y < H; y++) { border.push(px(data, W, 0, y), px(data, W, W - 1, y)); }
  const bg = [0, 1, 2].map((c) => median(border.map((p) => p[c])));
  // how different each pixel is from the background, and a cut-off between the two groups (Otsu)
  const diff = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    diff[i] = a < 40 ? 0 : Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
  }
  const cut = Math.max(28, otsu(diff));
  let mask: Uint8Array = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = diff[i] > cut ? 1 : 0;
  mask = close(mask, W, H);
  // keep the biggest shape
  const label = new Int32Array(W * H).fill(-1);
  let bestId = -1, bestN = 0;
  for (let i = 0, id = 0; i < W * H; i++) {
    if (!mask[i] || label[i] >= 0) continue;
    const n = flood(mask, label, W, H, i, id, 1);
    if (n > bestN) { bestN = n; bestId = id; }
    id++;
  }
  if (bestId < 0 || bestN < W * H * 0.01) return null;
  const shape = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) shape[i] = label[i] === bestId ? 1 : 0;
  // fill holes: anything the outside can't reach is part of the shape
  const outside = new Int32Array(W * H).fill(-1);
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (!shape[y * W + x] && outside[y * W + x] < 0) flood(shape, outside, W, H, y * W + x, 0, 0);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (!shape[y * W + x] && outside[y * W + x] < 0) flood(shape, outside, W, H, y * W + x, 0, 0);
  let filled = 0;
  for (let i = 0; i < W * H; i++) { if (!shape[i] && outside[i] < 0) shape[i] = 1; filled += shape[i]; }
  const edge = follow(shape, W, H);
  if (edge.length < 8) return null;
  // image rows run downward; the outline's y runs up
  const pts: Pt[] = edge.map(([x, y]) => [x, H - y]);
  const simple = simplify([...pts, pts[0]], Math.max(W, H) * 0.004).slice(0, -1);
  const xs = simple.map((p) => p[0]), ys = simple.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  const touches = edge.some(([x, y]) => x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1);
  return {
    outline: simple,
    aspect: h / Math.max(w, 1),
    coverage: filled / (W * H),
    note: touches ? "The shape touches the photo's edge, so part of it may be cut off. Take the photo from further back." : "",
  };
}

const px = (d: Pixels["data"], W: number, x: number, y: number) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
const median = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

function otsu(v: Float32Array): number {
  const hist = new Float64Array(256);
  let max = 1;
  for (const x of v) max = Math.max(max, x);
  for (const x of v) hist[Math.min(255, Math.floor((x / max) * 255))]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = v.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return ((t + 0.5) / 255) * max;
}

/** Dilate then erode once: closes hairline gaps such as a seam or a highlight. */
function close(m: Uint8Array, W: number, H: number): Uint8Array {
  const pass = (src: Uint8Array, grow: boolean) => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
        const s = src[yy * W + xx];
        if (grow && s) v = 1;
        if (!grow && !s) v = 0;
      }
      out[y * W + x] = v;
    }
    return out;
  };
  return pass(pass(m, true), false);
}

function flood(m: Uint8Array, label: Int32Array, W: number, H: number, start: number, id: number, want: number): number {
  const stack = [start];
  label[start] = id;
  let n = 0;
  while (stack.length) {
    const i = stack.pop()!;
    n++;
    const x = i % W, y = (i / W) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j >= 0 && label[j] < 0 && m[j] === want) { label[j] = id; stack.push(j); }
    }
  }
  return n;
}

/** Moore-neighbour edge following, clockwise in image coordinates. */
function follow(m: Uint8Array, W: number, H: number): Pt[] {
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] === 1;
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (at(x, y)) { sx = x; sy = y; break outer; }
  if (sx < 0) return [];
  const dirs: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const out: Pt[] = [[sx, sy]];
  let x = sx, y = sy, d = 6;
  for (let guard = 0; guard < W * H * 2; guard++) {
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8;
      const nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (at(nx, ny)) { x = nx; y = ny; d = nd; found = true; break; }
    }
    if (!found || (x === sx && y === sy)) break;
    out.push([x, y]);
  }
  return out;
}
