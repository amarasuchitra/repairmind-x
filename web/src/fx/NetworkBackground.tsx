import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./motion";

/**
 * The layered backdrop: a slow-drifting node network (plexus) in the back, and neon circuit traces
 * that draw themselves in, glow, and fade out in front, each with a soft halo behind it.
 *
 * One 2D canvas, no libraries. Glow is faked with stacked strokes in additive blending instead of
 * shadowBlur (which is slow on phones). Element counts scale with screen area, the device pixel
 * ratio is capped, phones run at ~30 fps, and the loop stops while the tab is hidden. With
 * prefers-reduced-motion it paints a single still frame.
 */
export function NetworkBackground({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0, h = 0, dpr = 1, raf = 0, last = 0, t = 0;
    const reduced = prefersReducedMotion();
    let small = false;
    let nodes: Node[] = [];
    let traces: Trace[] = [];

    function resize() {
      small = window.innerWidth < 700;
      dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      const area = w * h;
      const nodeCount = Math.round(Math.min(110, Math.max(28, area / 16000)) * intensity);
      nodes = Array.from({ length: nodeCount }, () => makeNode(w, h));
      const traceCount = Math.round(Math.min(14, Math.max(5, area / 90000)) * intensity);
      traces = Array.from({ length: traceCount }, () => makeTrace(w, h, Math.random() * 4));
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const minDt = small || intensity < 1 ? 1000 / 32 : 1000 / 61;
      if (last && now - last < minDt) return;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      t += dt;
      draw(dt);
    }

    function draw(dt: number) {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = "lighter";
      drawNetwork(ctx!, nodes, w, h, dt, t);
      for (let i = 0; i < traces.length; i++) {
        const tr = traces[i];
        tr.age += dt;
        tr.y -= tr.drift * dt;
        if (tr.age > tr.life) traces[i] = makeTrace(w, h, 0);
        else drawTrace(ctx!, tr);
      }
      ctx!.globalCompositeOperation = "source-over";
    }

    function onVisibility() {
      cancelAnimationFrame(raf);
      last = 0;
      if (!document.hidden && !reduced) raf = requestAnimationFrame(frame);
    }

    resize();
    if (reduced) {
      // One still frame with traces caught mid-life so the scene still reads.
      traces.forEach((tr) => (tr.age = tr.grow + 0.2));
      draw(0);
    } else {
      raf = requestAnimationFrame(frame);
    }
    const onResize = () => {
      resize();
      if (reduced) draw(0);
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intensity]);

  return (
    <div className="fx-bg" aria-hidden>
      <div className="fx-bg-base" />
      <canvas ref={ref} className="fx-bg-canvas" />
      <div className="fx-bg-grain" />
    </div>
  );
}

/* ---------------------------------------------------------------- node network (back layer) */

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  z: number; // depth 0.35..1: far nodes are smaller, dimmer and slower
  tw: number; // twinkle phase
}

function makeNode(w: number, h: number): Node {
  const z = 0.35 + Math.random() * 0.65;
  const a = Math.random() * Math.PI * 2;
  const s = (4 + Math.random() * 10) * z;
  return { x: Math.random() * w, y: Math.random() * h, vx: Math.cos(a) * s, vy: Math.sin(a) * s, z, tw: Math.random() * 6 };
}

function drawNetwork(ctx: CanvasRenderingContext2D, nodes: Node[], w: number, h: number, dt: number, t: number) {
  const pad = 40;
  for (const n of nodes) {
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    if (n.x < -pad) n.x = w + pad; else if (n.x > w + pad) n.x = -pad;
    if (n.y < -pad) n.y = h + pad; else if (n.y > h + pad) n.y = -pad;
  }
  const maxD = Math.min(170, Math.max(110, Math.sqrt(w * h) / 7));
  const maxD2 = maxD * maxD;
  ctx.lineWidth = 0.7;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxD2) continue;
      const k = 1 - Math.sqrt(d2) / maxD;
      const alpha = k * k * 0.32 * Math.min(a.z, b.z);
      ctx.strokeStyle = `rgba(70,150,255,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  for (const n of nodes) {
    const tw = 0.55 + 0.45 * Math.sin(t * 1.3 + n.tw);
    const r = 0.7 + n.z * 1.5;
    ctx.fillStyle = `rgba(120,200,255,${(0.25 + 0.5 * n.z * tw).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n.z > 0.9 && tw > 0.85) {
      // the odd bright node gets a small flare
      ctx.fillStyle = "rgba(90,170,255,0.08)";
      ctx.beginPath();
      ctx.arc(n.x, n.y, r * 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/* ---------------------------------------------------------------- circuit traces (front layer) */

interface Trace {
  x: number;
  y: number;
  paths: { d: Path2D; len: number; pad: [number, number] }[];
  halo: number;
  age: number;
  grow: number;
  hold: number;
  life: number;
  drift: number;
  scale: number;
}

// Mostly vertical runs with 45-degree jogs, like a circuit board.
const DIRS: [number, number][] = [[0, -1], [0.7071, -0.7071], [-0.7071, -0.7071], [1, 0], [-1, 0]];

function makeTrace(w: number, h: number, delay: number): Trace {
  const scale = 0.7 + Math.random() * 0.6;
  const cell = 9 * scale;
  const lanes = 1 + Math.floor(Math.random() * 4); // a bus of parallel lines
  const gap = 6 * scale;
  const steps: { dir: [number, number]; n: number }[] = [];
  let dir: [number, number] = [0, -1];
  const segs = 2 + Math.floor(Math.random() * 4);
  for (let i = 0; i < segs; i++) {
    steps.push({ dir, n: 1 + Math.floor(Math.random() * (dir[0] === 0 ? 6 : 3)) });
    const choices = DIRS.filter((d) => d !== dir && !(d[0] === -dir[0] && d[1] === -dir[1]));
    dir = i % 2 === 0 ? choices[Math.floor(Math.random() * choices.length)] : [0, -1];
  }
  const paths = [];
  for (let l = 0; l < lanes; l++) {
    const off = (l - (lanes - 1) / 2) * gap;
    const p = new Path2D();
    let x = off, y = (Math.random() - 0.5) * cell * 2;
    p.moveTo(x, y);
    let len = 0;
    // lanes end at different lengths so the bus looks hand-routed
    const cut = steps.length - (l > 0 && Math.random() < 0.5 ? 1 : 0);
    for (let s = 0; s < cut; s++) {
      const n = Math.max(1, steps[s].n - (s === cut - 1 ? Math.floor(Math.random() * 2) : 0));
      const dx = steps[s].dir[0] * n * cell, dy = steps[s].dir[1] * n * cell;
      x += dx;
      y += dy;
      len += Math.hypot(dx, dy);
      p.lineTo(x, y);
    }
    paths.push({ d: p, len, pad: [x, y] as [number, number] });
  }
  const grow = 0.7 + Math.random() * 0.8;
  const hold = 1.2 + Math.random() * 2.2;
  return {
    x: Math.random() * w,
    y: h * 0.15 + Math.random() * h * 0.9,
    paths,
    halo: 50 + lanes * 14 * scale,
    age: -delay,
    grow,
    hold,
    life: grow + hold + 1.2,
    drift: 4 + Math.random() * 8,
    scale,
  };
}

function drawTrace(ctx: CanvasRenderingContext2D, tr: Trace) {
  if (tr.age < 0) return;
  const grown = Math.min(1, tr.age / tr.grow);
  const ease = 1 - Math.pow(1 - grown, 3);
  const fade = tr.age < tr.grow + tr.hold ? 1 : Math.max(0, 1 - (tr.age - tr.grow - tr.hold) / 1.2);
  const flicker = tr.age < tr.grow ? 0.75 + 0.25 * Math.random() : 1;
  const a = fade * flicker;
  if (a <= 0.01) return;

  ctx.save();
  ctx.translate(tr.x, tr.y);

  // soft halo behind the cluster
  const g = ctx.createRadialGradient(0, -tr.halo * 0.3, 0, 0, -tr.halo * 0.3, tr.halo * 1.6);
  g.addColorStop(0, `rgba(30,110,255,${(0.16 * a).toFixed(3)})`);
  g.addColorStop(1, "rgba(30,110,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-tr.halo * 1.6, -tr.halo * 1.9, tr.halo * 3.2, tr.halo * 3.2);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const p of tr.paths) {
    const shown = p.len * ease;
    ctx.setLineDash([shown, p.len + 10]);
    // three passes: wide faint bloom, mid glow, bright core
    ctx.strokeStyle = `rgba(25,110,255,${(0.14 * a).toFixed(3)})`;
    ctx.lineWidth = 7 * tr.scale;
    ctx.stroke(p.d);
    ctx.strokeStyle = `rgba(40,150,255,${(0.35 * a).toFixed(3)})`;
    ctx.lineWidth = 3.2 * tr.scale;
    ctx.stroke(p.d);
    ctx.strokeStyle = `rgba(200,235,255,${(0.9 * a).toFixed(3)})`;
    ctx.lineWidth = 1.1 * tr.scale;
    ctx.stroke(p.d);
    if (grown >= 1) {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(p.pad[0], p.pad[1], 2.4 * tr.scale, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(170,225,255,${(0.85 * a).toFixed(3)})`;
      ctx.lineWidth = 1.1 * tr.scale;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.restore();
}
