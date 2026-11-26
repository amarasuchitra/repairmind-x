// Circle to ask: turn a finger stroke on the (cover-scaled, maybe mirrored) live video into a box on the real
// camera frame, and the crop to send for a close look. Pure, so it runs under `node --test`.

export interface Pt { x: number; y: number }
export interface NBox { x: number; y: number; w: number; h: number } // centre + size, fractions of the frame

/** A point on the camera element (px) -> fractions of the camera frame, for object-fit: cover. */
export function toFrame(p: Pt, elW: number, elH: number, vw: number, vh: number, mirrored: boolean): Pt {
  const scale = Math.max(elW / vw, elH / vh);
  const dw = vw * scale, dh = vh * scale;
  let u = (p.x - (elW - dw) / 2) / dw;
  const v = (p.y - (elH - dh) / 2) / dh;
  if (mirrored) u = 1 - u;
  return { x: u, y: v };
}

/** Is this stroke a deliberate circle or scribble, rather than a stray tap? */
export function strokeOk(px: Pt[], minLen = 60, minSide = 24): boolean {
  if (px.length < 4) return false;
  let len = 0;
  for (let i = 1; i < px.length; i++) len += Math.hypot(px[i].x - px[i - 1].x, px[i].y - px[i - 1].y);
  const xs = px.map((p) => p.x), ys = px.map((p) => p.y);
  return len >= minLen && Math.max(...xs) - Math.min(...xs) >= minSide && Math.max(...ys) - Math.min(...ys) >= minSide;
}

/** The box around the stroke, cut to the frame. null if nothing of it is on the frame. */
export function boundsOf(pts: Pt[]): NBox | null {
  if (!pts.length) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = c(Math.min(...pts.map((p) => p.x))), x1 = c(Math.max(...pts.map((p) => p.x)));
  const y0 = c(Math.min(...pts.map((p) => p.y))), y1 = c(Math.max(...pts.map((p) => p.y)));
  if (x1 - x0 < 0.01 || y1 - y0 < 0.01) return null;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/** Pixel crop of the camera frame: the circle plus a margin, never tighter than minSide of the frame. */
export function cropRect(b: NBox, vw: number, vh: number, pad = 0.15, minSide = 0.12) {
  const w = Math.min(1, Math.max(minSide, b.w * (1 + 2 * pad)));
  const h = Math.min(1, Math.max(minSide, b.h * (1 + 2 * pad)));
  const x0 = Math.max(0, b.x - w / 2), y0 = Math.max(0, b.y - h / 2);
  const x1 = Math.min(1, b.x + w / 2), y1 = Math.min(1, b.y + h / 2);
  return { sx: Math.round(x0 * vw), sy: Math.round(y0 * vh), sw: Math.round((x1 - x0) * vw), sh: Math.round((y1 - y0) * vh) };
}
