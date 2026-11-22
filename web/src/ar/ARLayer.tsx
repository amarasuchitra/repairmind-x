import { useEffect, useRef, useState } from "react";
import type { Marker } from "../types";
import type { Box } from "./tracker";
import { WORK_WIDTH } from "./tracker";

type Status = "idle" | "starting" | "tracking" | "lost" | "failed";

interface Props {
  /** The element that contains the live <video>. */
  host: HTMLElement | null;
  marker: Marker | null;
  mirrored: boolean;
  /** Hide everything (danger, alerts): nothing may be drawn over the user's view then. */
  suppressed: boolean;
  /** Tracking couldn't start: show the still picture instead. */
  onFallback: (m: Marker) => void;
  /** Tracking was lost: ask the mechanic to find the part again. */
  onLost: (m: Marker) => void;
  onShowStill: () => void;
}

/** Live AR: keeps the mechanic's box, label and motion arrow on the real part as the camera moves. */
export function ARLayer({ host, marker, mirrored, suppressed, onFallback, onLost, onShowStill }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [box, setBox] = useState<Box | null>(null);
  const [rect, setRect] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const worker = useRef<Worker | null>(null);
  const shown = useRef<Box | null>(null);
  const current = useRef<Marker | null>(null);
  const lostSent = useRef(-1);

  // Worker + frame pump.
  useEffect(() => {
    if (!host) return;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let busy = false;
    let last = 0;
    let raf = 0;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") busy = false;
      const mk = current.current;
      if (!mk || m.id !== (mk.id ?? 0)) return;
      if (m.type === "failed") {
        setStatus("failed");
        onFallback(mk);
      } else if (m.type === "box") {
        // Light smoothing so the box doesn't jitter; snaps on big moves.
        const prev = shown.current;
        const b: Box = prev && Math.hypot(m.box.x - prev.x, m.box.y - prev.y) < 0.08
          ? { x: prev.x * 0.4 + m.box.x * 0.6, y: prev.y * 0.4 + m.box.y * 0.6, w: prev.w * 0.5 + m.box.w * 0.5, h: prev.h * 0.5 + m.box.h * 0.5 }
          : m.box;
        shown.current = b;
        setBox(b);
        setStatus(m.state);
        if (m.state === "lost" && lostSent.current !== (mk.id ?? 0)) {
          lostSent.current = mk.id ?? 0;
          onLost(mk);
        }
      }
    };
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      const video = host.querySelector("video");
      if (!video || !video.videoWidth || !ctx) return;
      const r = host.getBoundingClientRect();
      const vr = video.videoWidth / video.videoHeight;
      const er = r.width / r.height;
      // object-fit: cover
      const width = er > vr ? r.width : r.height * vr;
      const height = er > vr ? r.width / vr : r.height;
      setRect((o) => (Math.abs(o.width - width) + Math.abs(o.height - height) < 1 ? o : {
        left: (r.width - width) / 2, top: (r.height - height) / 2, width, height,
      }));
      if (busy || t - last < 80) return; // ~12 fps
      last = t;
      canvas.width = WORK_WIDTH;
      canvas.height = Math.round(WORK_WIDTH / vr);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
      busy = true;
      w.postMessage({ type: "frame", w: px.width, h: px.height, rgba: px.data.buffer }, [px.data.buffer]);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      w.terminate();
      worker.current = null;
    };
  }, [host]); // eslint-disable-line react-hooks/exhaustive-deps

  // New marker: send the frame the server analysed, so the worker can find that moment and catch up.
  useEffect(() => {
    current.current = marker;
    shown.current = null;
    setBox(null);
    if (!marker) {
      setStatus("idle");
      worker.current?.postMessage({ type: "clear" });
      return;
    }
    const usable = marker.precise && marker.image && marker.w > 0.01 && marker.h > 0.01;
    if (!usable) {
      setStatus("failed");
      onFallback(marker);
      return;
    }
    setStatus("starting");
    const img = new Image();
    img.onload = () => {
      if (current.current !== marker || !worker.current) return;
      const c = document.createElement("canvas");
      c.width = WORK_WIDTH;
      c.height = Math.round((WORK_WIDTH * img.naturalHeight) / img.naturalWidth);
      const cx = c.getContext("2d", { willReadFrequently: true });
      if (!cx) return;
      cx.drawImage(img, 0, 0, c.width, c.height);
      const px = cx.getImageData(0, 0, c.width, c.height);
      worker.current.postMessage(
        { type: "marker", id: marker.id ?? 0, w: px.width, h: px.height, rgba: px.data.buffer,
          box: { x: marker.x, y: marker.y, w: marker.w, h: marker.h } },
        [px.data.buffer],
      );
    };
    img.onerror = () => onFallback(marker);
    img.src = marker.image!;
  }, [marker]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!marker || suppressed || status === "idle" || status === "failed") return null;

  return (
    <>
      <div className="ar-layer" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        {box && status === "tracking" && (
          <svg className={`ar-svg${mirrored ? " mirror" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <rect x={(box.x - box.w / 2) * 100} y={(box.y - box.h / 2) * 100} width={box.w * 100} height={box.h * 100}
              rx="1.5" className="ar-box" />
            <ActionGlyph action={marker.action ?? ""} box={box} />
          </svg>
        )}
        {box && status === "tracking" && (
          <span className="ar-label" style={{
            left: `${(mirrored ? 1 - box.x : box.x) * 100}%`,
            top: `${Math.max(0, box.y - box.h / 2) * 100}%`,
          }}>
            {marker.label}
          </span>
        )}
      </div>
      {/* Outside the cover-scaled layer so it is never cropped off-screen. */}
      <div className="ar-status" role="status">
        {status === "starting" && <span>Finding “{marker.label}” in your live view…</span>}
        {status === "tracking" && <span>Following “{marker.label}”</span>}
        {status === "lost" && <span>Lost “{marker.label}”. Point the camera back at it; the mechanic will find it again.</span>}
        <button className="ghost" onClick={onShowStill}>See still</button>
      </div>
    </>
  );
}

/** Motion hint drawn on the part. Shown only for the mechanic's current approved step. */
function ActionGlyph({ action, box }: { action: string; box: Box }) {
  if (!action) return null;
  const cx = box.x * 100, cy = box.y * 100;
  const r = Math.max(box.w, box.h) * 50 + 4;
  const arrow = (x1: number, y1: number, x2: number, y2: number) => (
    <g className="ar-arrow">
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      <polygon points={head(x1, y1, x2, y2)} />
    </g>
  );
  switch (action) {
    case "turn_cw":
    case "turn_ccw": {
      const cw = action === "turn_cw";
      // 270-degree arc around the part, arrowhead at the end, in the direction of rotation.
      const a0 = -Math.PI / 2, a1 = cw ? a0 + 1.5 * Math.PI : a0 - 1.5 * Math.PI;
      const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
      const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      const t = [p1[0] + (cw ? -1 : 1) * Math.sin(a1) * -3, p1[1] + (cw ? 1 : -1) * Math.cos(a1) * -3];
      return (
        <g className="ar-arrow spin">
          <path d={`M ${p0[0]} ${p0[1]} A ${r} ${r} 0 1 ${cw ? 1 : 0} ${p1[0]} ${p1[1]}`} fill="none" />
          <polygon points={head(t[0], t[1], p1[0], p1[1])} />
        </g>
      );
    }
    case "press": return arrow(cx, cy - r - 10, cx, cy - box.h * 50);
    case "pull": return arrow(cx, cy - box.h * 50, cx, cy - r - 10);
    case "lift": return arrow(cx, cy - box.h * 50 - 2, cx, cy - box.h * 50 - 16);
    case "slide_left": return arrow(cx + 6, cy, cx - r - 8, cy);
    case "slide_right": return arrow(cx - 6, cy, cx + r + 8, cy);
    default: return null;
  }
}

function head(x1: number, y1: number, x2: number, y2: number): string {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const s = 3.2;
  const l = [x2 - s * Math.cos(a - 0.5), y2 - s * Math.sin(a - 0.5)];
  const r = [x2 - s * Math.cos(a + 0.5), y2 - s * Math.sin(a + 0.5)];
  return `${x2},${y2} ${l[0]},${l[1]} ${r[0]},${r[1]}`;
}
