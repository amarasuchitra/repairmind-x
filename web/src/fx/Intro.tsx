import { useEffect, useRef, useState } from "react";
import { easeInOut, easeOut, prefersReducedMotion, span } from "./motion";

const SEEN_KEY = "rmx.introSeen";
const DURATION = 5.6; // seconds

export function shouldPlayIntro(): boolean {
  if (window.location.hash === "#intro") return true;
  if (prefersReducedMotion()) return false;
  try {
    return sessionStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

/**
 * Opening sequence, about five seconds, drawn on one canvas:
 *  1. a point of light ignites with an anamorphic streak
 *  2. concentric instrument rings sweep in and counter-rotate
 *  3. they collapse into a segmented ring that blasts outward
 *  4. a node network bursts from the core while the wordmark resolves
 * Plays once per browser session. Click, tap, Esc, Enter or Space skips it.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  function finish() {
    if (doneRef.current) return;
    doneRef.current = true;
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* fine: it just plays again next time */
    }
    setLeaving(true);
    window.setTimeout(onDone, 650);
  }

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      finish();
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0;
    const resize = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const burst = Array.from({ length: Math.round(Math.min(150, Math.max(70, (window.innerWidth * window.innerHeight) / 9000))) }, () => {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.25 + Math.pow(Math.random(), 0.6) * 0.95;
      return { a, sp, z: 0.4 + Math.random() * 0.6, wob: Math.random() * 6 };
    });

    let start = 0, raf = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      const t = (now - start) / 1000;
      draw(ctx, w, h, dpr, t, burst);
      if (t >= DURATION) finish();
      else raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onKey = (e: KeyboardEvent) => {
      if (["Escape", "Enter", " "].includes(e.key)) finish();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`intro ${leaving ? "intro-out" : ""}`} onClick={finish} role="presentation">
      <canvas ref={ref} className="intro-canvas" aria-hidden />
      <div className="intro-word" aria-label="RepairMind X">
        <div className="intro-title">
          {"REPAIRMIND".split("").map((c, i) => (
            <span key={i} style={{ animationDelay: `${3.45 + i * 0.045}s` }}>{c}</span>
          ))}
          <span className="intro-x" style={{ animationDelay: "4.0s" }}>X</span>
        </div>
        <div className="intro-rule" />
        <div className="intro-tag">LIVE AI REPAIR MECHANIC</div>
      </div>
      <div className="intro-boot" aria-hidden>
        <span>SYS.BOOT</span><span>OPTICS</span><span>VOICE LINK</span><span>SAFETY GUARD</span><span>READY</span>
      </div>
      <button className="intro-skip" onClick={(e) => { e.stopPropagation(); finish(); }}>Skip intro</button>
    </div>
  );
}

type Burst = { a: number; sp: number; z: number; wob: number }[];

const C = {
  core: "230,248,255",
  hud: "80,200,255",
  blue: "40,130,255",
};

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, t: number, burst: Burst) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // deep navy field with a lit centre, like a lens looking into the machine
  const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
  const lift = 0.5 + 0.5 * span(t, 0, 1.2);
  bg.addColorStop(0, `rgba(10,48,110,${0.9 * lift})`);
  bg.addColorStop(0.55, "rgba(4,18,46,1)");
  bg.addColorStop(1, "rgba(1,5,14,1)");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2, cy = h / 2 - Math.min(h * 0.06, 40);
  const R = Math.min(w, h) * 0.3;
  ctx.globalCompositeOperation = "lighter";

  // 1. ignition: point + streak
  const ign = easeOut(span(t, 0.1, 0.9));
  const ignFade = 1 - span(t, 1.6, 2.4) * 0.7;
  flare(ctx, cx, cy, 6 + 34 * ign, ign * ignFade, w * 0.45 * ign);

  // 2. instrument rings
  const ringsIn = span(t, 0.7, 2.3);
  const ringsOut = span(t, 2.55, 3.1);
  if (ringsIn > 0 && ringsOut < 1) {
    const s = 1 + easeInOut(ringsOut) * 0.5;
    const a = 1 - ringsOut;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    rings(ctx, R, t, ringsIn, a);
    ctx.restore();
  }

  // 3. segmented blast ring
  const seg = span(t, 2.6, 3.8);
  if (seg > 0 && seg < 1) {
    const r = R * (0.35 + easeOut(seg) * 1.9);
    const a = Math.sin(seg * Math.PI);
    segRing(ctx, cx, cy, r, 44, a, R * 0.07);
    segRing(ctx, cx, cy, r * 0.42, 48, a * 0.8, R * 0.035);
  }

  // 4. network burst and settled core
  const b = span(t, 3.0, 5.2);
  if (b > 0) network(ctx, cx, cy, Math.max(w, h), b, burst, t);
  const coreIn = span(t, 3.0, 3.5);
  if (coreIn > 0) flare(ctx, cx, cy, 10 + 26 * easeOut(coreIn), 0.85 * (1 - span(t, 4.9, 5.6)), w * 0.3);

  ctx.globalCompositeOperation = "source-over";
  // vignette
  const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.8);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.7)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

function flare(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, streak: number) {
  if (a <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
  g.addColorStop(0, `rgba(${C.core},${a})`);
  g.addColorStop(0.12, `rgba(${C.hud},${0.7 * a})`);
  g.addColorStop(0.4, `rgba(${C.blue},${0.18 * a})`);
  g.addColorStop(1, `rgba(${C.blue},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 4, 0, Math.PI * 2);
  ctx.fill();
  if (streak > 0) {
    const s = ctx.createLinearGradient(x - streak, y, x + streak, y);
    s.addColorStop(0, `rgba(${C.blue},0)`);
    s.addColorStop(0.5, `rgba(${C.core},${0.75 * a})`);
    s.addColorStop(1, `rgba(${C.blue},0)`);
    ctx.fillStyle = s;
    ctx.fillRect(x - streak, y - 1, streak * 2, 2);
    ctx.globalAlpha = 0.35;
    ctx.fillRect(x - streak * 0.6, y - 4, streak * 1.2, 8);
    ctx.globalAlpha = 1;
  }
}

function arc(ctx: CanvasRenderingContext2D, r: number, a0: number, a1: number, width: number, alpha: number, rgb = C.hud) {
  ctx.beginPath();
  ctx.arc(0, 0, r, a0, a1);
  ctx.lineWidth = width * 3;
  ctx.strokeStyle = `rgba(${rgb},${0.12 * alpha})`;
  ctx.stroke();
  ctx.lineWidth = width;
  ctx.strokeStyle = `rgba(${rgb},${0.9 * alpha})`;
  ctx.stroke();
}

function rings(ctx: CanvasRenderingContext2D, R: number, t: number, p: number, alpha: number) {
  const TAU = Math.PI * 2;
  const sweep = (d: number) => easeOut(span(p, d, d + 0.55)) * TAU;
  ctx.lineCap = "butt";
  // outer thin ring with two heavy arcs
  let s = sweep(0);
  arc(ctx, R, -Math.PI / 2, -Math.PI / 2 + s, 1, alpha);
  ctx.save();
  ctx.rotate(t * 0.6);
  arc(ctx, R * 1.04, 0.2, 0.2 + Math.min(s, 1.1), 3, alpha);
  arc(ctx, R * 1.04, Math.PI + 0.2, Math.PI + 0.2 + Math.min(s, 0.6), 3, alpha);
  ctx.restore();
  // tick ring
  s = sweep(0.15);
  ctx.save();
  ctx.rotate(-t * 0.25);
  const ticks = 90;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * TAU;
    if (a > s) break;
    const long = i % 5 === 0;
    const r0 = R * 0.86, r1 = R * (long ? 0.92 : 0.895);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineWidth = long ? 1.6 : 1;
    ctx.strokeStyle = `rgba(${C.hud},${(long ? 0.85 : 0.5) * alpha})`;
    ctx.stroke();
  }
  ctx.restore();
  // block meter ring (short bars that fill around)
  s = sweep(0.3);
  ctx.save();
  ctx.rotate(t * 0.9);
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU;
    if (a > s) break;
    if (i % 16 > 11) continue;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.74, a, a + (TAU / 64) * 0.55);
    ctx.lineWidth = R * 0.05;
    ctx.strokeStyle = `rgba(${C.hud},${0.55 * alpha})`;
    ctx.stroke();
  }
  ctx.restore();
  // inner rings
  s = sweep(0.45);
  arc(ctx, R * 0.62, Math.PI / 2, Math.PI / 2 + s, 1.2, alpha);
  ctx.save();
  ctx.rotate(-t * 1.4);
  arc(ctx, R * 0.56, 0, Math.min(s, 2.2), 4, alpha * 0.9);
  arc(ctx, R * 0.56, Math.PI, Math.PI + Math.min(s, 0.8), 4, alpha * 0.9);
  ctx.restore();
  arc(ctx, R * 0.46, 0, s, 2.2, alpha);
}

function segRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, n: number, a: number, len: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(c * r, s * r);
    ctx.lineTo(c * (r + len), s * (r + len));
    ctx.lineWidth = Math.max(2, len * 0.28);
    ctx.strokeStyle = `rgba(${C.hud},${0.18 * a})`;
    ctx.stroke();
    ctx.lineWidth = Math.max(1, len * 0.14);
    ctx.strokeStyle = `rgba(${C.hud},${0.9 * a})`;
    ctx.stroke();
  }
  ctx.restore();
}

function network(ctx: CanvasRenderingContext2D, cx: number, cy: number, span_: number, p: number, burst: Burst, t: number) {
  const e = easeOut(p);
  const pts = burst.map((n) => {
    const d = n.sp * e * span_ * 0.62;
    const wob = Math.sin(t * 0.8 + n.wob) * 10 * e;
    return [cx + Math.cos(n.a) * d + wob, cy + Math.sin(n.a) * d * 0.8 + wob * 0.5, n.z] as const;
  });
  const fadeIn = span(p, 0, 0.15);
  const maxD = 150 + 60 * e;
  ctx.lineWidth = 0.8;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
      const d = Math.hypot(dx, dy);
      if (d > maxD) continue;
      const k = 1 - d / maxD;
      ctx.strokeStyle = `rgba(110,200,255,${(k * 0.5 * fadeIn * Math.min(pts[i][2], pts[j][2])).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.stroke();
    }
  }
  for (const [x, y, z] of pts) {
    ctx.fillStyle = `rgba(190,235,255,${(0.8 * z * fadeIn).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.8 + z * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
}
