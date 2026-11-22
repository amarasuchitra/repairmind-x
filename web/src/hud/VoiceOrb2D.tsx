import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../fx/motion";

import type { OrbState } from "./VoiceOrb";

const RGB: Record<OrbState, string> = {
  speaking: "70,226,255",
  listening: "62,207,142",
  thinking: "150,130,255",
  connecting: "90,160,220",
  idle: "70,200,255",
};

/**
 * The mechanic's presence: a layered instrument dial drawn on canvas, driven by audio.
 *
 * From the outside in: a slow tick dial, counter-rotating bracket arcs, a radial spectrum of the
 * voice, an oscilloscope ring that ripples with it, an aperture of six blades that opens as the
 * voice gets louder, and a bright core with a rotating hexagon. The "full" detail level (used at
 * large sizes) adds a calibrated scale arc and a side level meter.
 *
 * Speaking follows the mechanic's voice, listening follows your mic (green), thinking sweeps a
 * violet scanner, connecting chases two arcs. State is also exposed as text for screen readers.
 */
export function VoiceOrb2D({
  state,
  bands,
  size = 96,
  detail,
  voice,
}: {
  state: OrbState;
  bands: number[];
  size?: number;
  detail?: "compact" | "full";
  /** Optional per-frame band source (used by demos) instead of the bands prop. */
  voice?: () => number[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bandsRef = useRef<number[]>(bands);
  const stateRef = useRef<OrbState>(state);
  const voiceRef = useRef(voice);
  bandsRef.current = bands;
  stateRef.current = state;
  voiceRef.current = voice;
  const full = (detail ?? (size >= 180 ? "full" : "compact")) === "full";

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const reduced = prefersReducedMotion();
    const N = full ? 96 : 60;
    const bars = new Float32Array(N);
    let level = 0, t = 0, last = 0, raf = 0;
    let colour = RGB[stateRef.current].split(",").map(Number);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      if (canvas.offsetParent === null) return; // hidden by layout: don't spend the battery
      if (!reduced) t += dt;
      const st = stateRef.current;
      // ease the colour between states instead of snapping
      const target = RGB[st].split(",").map(Number);
      colour = colour.map((c, i) => c + (target[i] - c) * Math.min(1, dt * 6));
      const rgb = colour.map((c) => Math.round(c)).join(",");

      const live = voiceRef.current ? voiceRef.current() : bandsRef.current;
      const src = live.length ? live : [0];
      const gain = st === "speaking" ? 1 : st === "listening" ? 0.7 : 0;
      let sum = 0;
      for (let i = 0; i < N; i++) {
        // mirror the bands around the ring so it's balanced left/right
        const k = i < N / 2 ? i : N - 1 - i;
        const v = (src[Math.floor((k / (N / 2)) * src.length) % src.length] ?? 0) * gain;
        const shimmer = 0.03 * (Math.sin(t * 7 + i * 0.9) + 1) * (gain > 0 ? 1 : 0.4);
        const targetV = Math.min(1, v * 2.6 + shimmer);
        bars[i] += (targetV - bars[i]) * (targetV > bars[i] ? 0.5 : 0.12);
        sum += bars[i];
      }
      let target01 = sum / N;
      if (st === "idle" || st === "connecting") target01 = 0.08 + 0.05 * Math.sin(t * 1.6);
      if (st === "thinking") target01 = 0.12 + 0.06 * Math.sin(t * 4);
      level += (target01 - level) * (target01 > level ? 0.35 : 0.08);
      draw(ctx, size, dpr, t, st, rgb, bars, Math.min(1, level * 1.6), full);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, full]);

  return (
    <canvas
      ref={ref}
      className={`orb orb-${state}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Mechanic is ${state}`}
    />
  );
}

const TAU = Math.PI * 2;

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  dpr: number,
  t: number,
  st: OrbState,
  rgb: string,
  bars: Float32Array,
  L: number,
  full: boolean,
) {
  const R = size / 2;
  const lw = Math.max(1, R / 90); // base line width that stays crisp at small sizes
  const c = (a: number) => `rgba(${rgb},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  ctx.setTransform(dpr, 0, 0, dpr, R * dpr, R * dpr);
  ctx.clearRect(-R, -R, size, size);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "butt";

  // halo
  const halo = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * (0.78 + 0.2 * L));
  halo.addColorStop(0, c(0.22 + 0.4 * L));
  halo.addColorStop(0.5, c(0.06 + 0.12 * L));
  halo.addColorStop(1, c(0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, TAU);
  ctx.fill();

  const ring = (r: number, a0: number, a1: number, w: number, a: number, glow = true) => {
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a1);
    if (glow) {
      ctx.lineWidth = w * 3.2;
      ctx.strokeStyle = c(a * 0.13);
      ctx.stroke();
    }
    ctx.lineWidth = w;
    ctx.strokeStyle = c(a);
    ctx.stroke();
  };

  // outer tick dial
  const rTick = full ? 0.86 : 0.95;
  ctx.save();
  ctx.rotate(t * 0.06);
  const ticks = full ? 144 : 72;
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * TAU;
    const major = i % (full ? 12 : 6) === 0;
    const r0 = R * rTick, r1 = R * (rTick - (major ? 0.06 : 0.03));
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.lineWidth = major ? lw * 1.4 : lw * 0.8;
    ctx.strokeStyle = c(major ? 0.75 : 0.32);
    ctx.stroke();
  }
  ctx.restore();

  if (full) scaleAndMeter(ctx, R, lw, c, L, t);

  // counter-rotating bracket arcs with end caps
  const rBr = R * (full ? 0.79 : 0.87);
  ctx.save();
  ctx.rotate(-t * 0.35);
  for (let q = 0; q < 4; q++) {
    const a0 = q * (TAU / 4) + 0.18, a1 = a0 + (q % 2 ? 0.9 : 1.15);
    ring(rBr, a0, a1, lw * 1.6, 0.8);
    for (const a of [a0, a1]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (rBr - R * 0.035), Math.sin(a) * (rBr - R * 0.035));
      ctx.lineTo(Math.cos(a) * (rBr + R * 0.035), Math.sin(a) * (rBr + R * 0.035));
      ctx.lineWidth = lw * 1.4;
      ctx.strokeStyle = c(0.9);
      ctx.stroke();
    }
  }
  ctx.restore();

  if (st === "connecting") {
    ctx.save();
    ctx.rotate(t * 3);
    ring(rBr, 0, 0.9, lw * 2.4, 0.9);
    ring(rBr, Math.PI, Math.PI + 0.9, lw * 2.4, 0.9);
    ctx.restore();
  }

  // radial spectrum
  const r0 = R * (full ? 0.56 : 0.6);
  const maxLen = R * (full ? 0.19 : 0.24);
  ctx.lineCap = "round";
  for (let i = 0; i < bars.length; i++) {
    const a = (i / bars.length) * TAU - Math.PI / 2;
    const v = bars[i];
    const len = R * 0.025 + v * maxLen;
    const cs = Math.cos(a), sn = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cs * r0, sn * r0);
    ctx.lineTo(cs * (r0 + len), sn * (r0 + len));
    ctx.lineWidth = lw * (full ? 3.6 : 3.2);
    ctx.strokeStyle = c(0.1 + v * 0.18);
    ctx.stroke();
    ctx.lineWidth = lw * (full ? 1.5 : 1.6);
    ctx.strokeStyle = c(0.45 + v * 0.55);
    ctx.stroke();
    if (v > 0.55) {
      ctx.fillStyle = `rgba(235,252,255,${((v - 0.55) * 1.8).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(cs * (r0 + len), sn * (r0 + len), lw * 1.1, 0, TAU);
      ctx.fill();
    }
  }
  ctx.lineCap = "butt";

  // oscilloscope ring: two traces with different phase for depth
  const rw = R * (full ? 0.5 : 0.53);
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    const steps = 120;
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * TAU;
      const bi = Math.floor((s / steps) * bars.length) % bars.length;
      const wob =
        Math.sin(a * 6 + t * (pass ? -2.2 : 3.1)) * 0.5 + Math.sin(a * 11 - t * 4.3 + pass) * 0.3 + bars[bi] * 0.9;
      const r = rw + wob * R * 0.035 * (0.25 + L * 1.6);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = lw * (pass ? 0.8 : 1.2);
    ctx.strokeStyle = c(pass ? 0.35 : 0.75);
    ctx.stroke();
  }

  // dashed rotating ring
  ctx.save();
  ctx.rotate(t * 0.5);
  ctx.setLineDash([R * 0.02, R * 0.03]);
  ring(R * 0.455, 0, TAU, lw, 0.5, false);
  ctx.setLineDash([]);
  ctx.restore();

  // aperture: six blades that open with the voice
  const bIn = R * 0.3, bOut = R * 0.42;
  ctx.save();
  ctx.rotate(-t * 0.4 + L * 0.6);
  const span = (TAU / 6) * (0.78 - 0.28 * L);
  for (let k = 0; k < 6; k++) {
    const a0 = k * (TAU / 6), a1 = a0 + span;
    ctx.beginPath();
    ctx.arc(0, 0, bOut, a0, a1);
    ctx.arc(0, 0, bIn, a1 - span * 0.12, a0 + span * 0.12, true);
    ctx.closePath();
    ctx.fillStyle = c(0.1 + 0.35 * L);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = c(0.8);
    ctx.stroke();
  }
  ctx.restore();

  // thinking: a rotating scanner wedge
  if (st === "thinking" && "createConicGradient" in ctx) {
    const g = ctx.createConicGradient(t * 2.4, 0, 0);
    g.addColorStop(0, c(0.45));
    g.addColorStop(0.12, c(0));
    g.addColorStop(1, c(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rBr, 0, TAU);
    ctx.arc(0, 0, bIn, 0, TAU, true);
    ctx.fill();
  }

  // core
  ring(R * 0.27, 0, TAU, lw * 1.2, 0.85);
  const cr = R * 0.25 * (0.82 + 0.35 * L);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, cr);
  core.addColorStop(0, "rgba(245,253,255,0.95)");
  core.addColorStop(0.35, c(0.75 + 0.25 * L));
  core.addColorStop(0.75, c(0.22));
  core.addColorStop(1, c(0));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(0, 0, cr, 0, TAU);
  ctx.fill();

  // hexagon in the core
  ctx.save();
  ctx.rotate(t * 0.8);
  ctx.beginPath();
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * TAU;
    const r = R * 0.14 * (0.9 + 0.25 * L);
    if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.lineWidth = lw * 1.1;
  ctx.strokeStyle = "rgba(240,252,255,0.75)";
  ctx.stroke();
  ctx.restore();

  // orbiting sparks with short trails
  const orbit = (r: number, speed: number, phase: number) => {
    const a = t * speed + phase;
    ctx.beginPath();
    ctx.arc(0, 0, r, a - 0.5 * Math.sign(speed), a, speed < 0);
    ctx.lineWidth = lw * 1.4;
    ctx.strokeStyle = c(0.35);
    ctx.stroke();
    ctx.fillStyle = "rgba(240,252,255,0.95)";
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, Math.sin(a) * r, lw * 1.6, 0, TAU);
    ctx.fill();
  };
  orbit(rBr, 0.9, 0);
  orbit(R * 0.455, -1.4, 2);
  if (full) orbit(R * 0.86, 0.4, 4);

  ctx.globalCompositeOperation = "source-over";
}

/** Large sizes only: a calibrated scale arc across the top and a segmented level meter on the right. */
function scaleAndMeter(
  ctx: CanvasRenderingContext2D,
  R: number,
  lw: number,
  c: (a: number) => string,
  L: number,
  t: number,
) {
  const rS = R * 0.97;
  const a0 = Math.PI * 1.18, a1 = Math.PI * 1.82;
  ctx.beginPath();
  ctx.arc(0, 0, rS, a0, a1);
  ctx.lineWidth = lw;
  ctx.strokeStyle = c(0.5);
  ctx.stroke();
  ctx.font = `600 ${Math.max(7, R * 0.045)}px ui-monospace, "JetBrains Mono", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 6; i++) {
    const a = a0 + ((a1 - a0) * i) / 6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * rS, Math.sin(a) * rS);
    ctx.lineTo(Math.cos(a) * (rS - R * 0.04), Math.sin(a) * (rS - R * 0.04));
    ctx.lineWidth = lw * 1.3;
    ctx.strokeStyle = c(0.8);
    ctx.stroke();
    ctx.fillStyle = c(0.6);
    ctx.fillText(String(i * 10), Math.cos(a) * (rS - R * 0.085), Math.sin(a) * (rS - R * 0.085));
  }
  // needle on the scale follows the level
  const na = a0 + (a1 - a0) * Math.min(1, L * 1.1);
  ctx.beginPath();
  ctx.moveTo(Math.cos(na) * (rS + R * 0.02), Math.sin(na) * (rS + R * 0.02));
  ctx.lineTo(Math.cos(na) * (rS - R * 0.06), Math.sin(na) * (rS - R * 0.06));
  ctx.lineWidth = lw * 2;
  ctx.strokeStyle = "rgba(240,252,255,0.9)";
  ctx.stroke();

  // right-side meter: segments light up with the level
  const segs = 14;
  const m0 = -0.42, m1 = 0.42;
  for (let i = 0; i < segs; i++) {
    const a = m0 + ((m1 - m0) * i) / (segs - 1);
    const lit = i / segs < L * 1.15;
    const len = R * (0.04 + 0.05 * (i / segs));
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * (R * 0.9), Math.sin(-a) * (R * 0.9));
    ctx.lineTo(Math.cos(a) * (R * 0.9 + len), Math.sin(-a) * (R * 0.9 + len));
    ctx.lineWidth = lw * 2.6;
    ctx.strokeStyle = c(lit ? 0.95 : 0.15);
    ctx.stroke();
  }
  // left-side bracket with a blinking status pip
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.92, Math.PI - 0.35, Math.PI + 0.35);
  ctx.lineWidth = lw * 1.2;
  ctx.strokeStyle = c(0.55);
  ctx.stroke();
  ctx.fillStyle = c(0.5 + 0.5 * Math.round((Math.sin(t * 4) + 1) / 2));
  ctx.beginPath();
  ctx.arc(-R * 0.96, 0, lw * 2, 0, TAU);
  ctx.fill();
}
