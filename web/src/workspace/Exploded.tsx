import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { useI18n } from "../i18n";
import type { Project } from "../build/project.ts";
import { buildShell, halfMesh, type ShellSpec, type Tri } from "../sim/shell.ts";
import { at, explode, shapeLabel, type Piece } from "./explode.ts";

const ACCENT = "#46e2ff";

/**
 * The product pulled apart in 3D: the two halves of its body and every part inside on its own level, each with a
 * label on a leader line, over a glowing base ring. Tap a label to ask the assistant about that part.
 */
export function Exploded({ project, body, sample, onAsk }: {
  project: Project;
  body: { spec: ShellSpec; source: string };
  /** an example, not the person's own project: says so on the view */
  sample?: boolean;
  onAsk?: (label: string) => void;
}) {
  const { t, auto } = useI18n();
  const [apart, setApart] = useState(true);
  const [spin, setSpin] = useState(false);
  const [resetN, setResetN] = useState(0);
  const [view, setView] = useState({ w: 800, h: 600 });
  const compact = view.w < 560;
  const box = useRef<HTMLDivElement>(null);
  const shape = shapeLabel(body.source);
  const layout = useMemo(() => explode(project, body.spec, shape), [project, body.spec, shape]);
  const shell = useMemo(() => buildShell(body.spec, 96), [body.spec]);
  const front = useMemo(() => halfMesh(shell, 1), [shell]);
  const back = useMemo(() => halfMesh(shell, -1), [shell]);
  const reduced = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  // narrow views get numbered badges and a legend instead of long labels
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      setView((v) => (Math.abs(v.w - w) > 40 || Math.abs(v.h - h) > 40 ? { w, h } : v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const s = layout.span;
  const ringZ = layout.bottom - body.spec.depth * 0.75 - 6;
  const mid = (layout.top + body.spec.depth * 0.5 + ringZ) / 2;
  // stand back far enough that the whole stack, and the labels beside it, fit whatever the shape of the view
  const cam = useMemo(() => {
    const tan = Math.tan((36 / 2) * (Math.PI / 180));
    const aspect = Math.max(0.3, view.w / Math.max(1, view.h));
    const tall = (layout.top + body.spec.depth * 0.5 - ringZ) * (compact ? 1.4 : 1.18);
    const labelPx = compact ? 0 : 150;
    const wide = 2 * (layout.radius + 30) * 1.12 * (view.w / Math.max(80, view.w - 2 * labelPx));
    const d = Math.max(tall / 2 / tan, wide / 2 / (tan * aspect)) * 1.04;
    const dir = new THREE.Vector3(0.5, 0.36, 1).normalize().multiplyScalar(d);
    return { pos: [dir.x, dir.y, dir.z] as [number, number, number], d };
  }, [view, layout, body.spec.depth, ringZ, compact]);
  const label = (p: Piece) => (p.id ? auto(p.label) : p.kind === "shellTop" ? t("xv.top", { shape: auto(shape) }) : t("xv.bottom", { shape: auto(shape) }));

  return (
    <div className="xv" ref={box}>
      <Canvas key={`${resetN}:${view.w}x${view.h}`} camera={{ position: cam.pos, fov: 36, near: 1, far: cam.d * 10 }} dpr={[1, 2]} gl={{ alpha: true, antialias: true }}>
        <hemisphereLight args={["#cfeeff", "#0b1430", 1.0]} />
        <directionalLight position={[s, s * 2, s]} intensity={1.4} />
        <pointLight position={[0, layout.bottom - 12, 0]} color={ACCENT} intensity={2.2} distance={s * 2} decay={1} />
        <group rotation={[-Math.PI / 2, 0, 0]} position={[0, -mid, 0]}>
          {layout.pieces.map((p, i) => (
            <Moving key={p.key} piece={p} apart={apart} instant={reduced}>
              {p.kind === "shellTop" ? <Half tris={front} opacity={0.5} />
                : p.kind === "shellBottom" ? <Half tris={back} opacity={0.92} />
                : <PartMesh piece={p} />}
              {apart && (
                <Callout piece={p} n={i + 1} radius={layout.radius} compact={compact} text={label(p)}
                  onClick={onAsk ? () => onAsk(label(p)) : undefined} />
              )}
            </Moving>
          ))}
          <BaseRing radius={layout.radius} z={ringZ} />
        </group>
        <OrbitControls makeDefault enablePan={false} autoRotate={spin} autoRotateSpeed={0.8} minDistance={s * 0.5} maxDistance={cam.d * 2.5} target={[0, 0, 0]} />
      </Canvas>

      <div className="xv-tools" role="group" aria-label={t("xv.controls")}>
        <button className={apart ? "on" : ""} aria-pressed={apart} onClick={() => setApart((x) => !x)} title={apart ? t("xv.together") : t("xv.apart")}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 3 4 7l8 4 8-4-8-4ZM4 12l8 4 8-4M4 17l8 4 8-4" /></svg>
          <span>{apart ? t("xv.together") : t("xv.apart")}</span>
        </button>
        <button className={spin ? "on" : ""} aria-pressed={spin} onClick={() => setSpin((x) => !x)} title={t("xv.spin")}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" /></svg>
          <span>{t("xv.spin")}</span>
        </button>
        <button onClick={() => { setSpin(false); setResetN((n) => n + 1); }} title={t("xv.reset")}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" /></svg>
          <span>{t("xv.reset")}</span>
        </button>
      </div>

      <div className="xv-name">
        <span className="xv-kicker">{sample ? t("xv.example") : t("xv.yours")}</span>
        <b>{auto(project.name || t("xv.untitled"))}</b>
      </div>

      {compact && apart && (
        <ol className="xv-legend" aria-label={t("xv.parts")}>
          {layout.pieces.map((p, i) => (
            <li key={p.key}><button onClick={onAsk ? () => onAsk(label(p)) : undefined}><b>{i + 1}</b>{label(p)}</button></li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Eases a piece between its place in the product and its place in the pulled-apart stack. */
function Moving({ piece, apart, instant, children }: { piece: Piece; apart: boolean; instant: boolean; children: React.ReactNode }) {
  const g = useRef<THREE.Group>(null);
  const k = useRef(apart ? 1 : 0);
  useFrame((_, dt) => {
    const want = apart ? 1 : 0;
    k.current = instant ? want : k.current + (want - k.current) * Math.min(1, dt * 4);
    const [x, y, z] = at(piece, k.current);
    g.current?.position.set(x, y, z);
  });
  const [x, y, z] = at(piece, k.current);
  return <group ref={g} position={[x, y, z]}>{children}</group>;
}

function Callout({ piece, n, radius, compact, text, onClick }: {
  piece: Piece; n: number; radius: number; compact: boolean; text: string; onClick?: () => void;
}) {
  // the line runs out sideways from the piece to a point past the body's edge, at the piece's own level
  const reach = compact ? 0 : piece.side * (radius * 0.95 + 26) - piece.apart[0];
  const end: [number, number, number] = [reach, 0, 0];
  return (
    <>
      {!compact && <Line points={[[0, 0, 0], end]} color={ACCENT} lineWidth={1.2} transparent opacity={0.75} />}
      <Html position={end} zIndexRange={[30, 0]} style={{ pointerEvents: "auto" }}>
        <button className={`xv-callout${compact ? " num" : ""}${piece.side < 0 ? " left" : ""}`} onClick={onClick} tabIndex={-1} aria-hidden={compact || undefined}>
          {compact ? <b>{n}</b> : <><i aria-hidden />{text}</>}
        </button>
      </Html>
    </>
  );
}

function Half({ tris, opacity }: { tris: Tri[]; opacity: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(tris.flat()), 3));
    g.computeVertexNormals();
    return g;
  }, [tris]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group>
      <mesh geometry={geo}>
        <meshPhysicalMaterial color="#d9ecff" roughness={0.35} metalness={0} transmission={0} transparent opacity={opacity}
          side={THREE.DoubleSide} depthWrite={opacity > 0.8} emissive="#103a66" emissiveIntensity={0.35} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[geo, 30]} />
        <lineBasicMaterial color={ACCENT} transparent opacity={0.55} />
      </lineSegments>
    </group>
  );
}

const LED_COLORS = ["#ff4d6d", "#ffb703", "#ffe66d", "#3ecf8e", "#46e2ff", "#4d7cff", "#9b5de5", "#f15bb5"];

/** A recognisable stand-in for each kind of part, at its real size. */
function PartMesh({ piece }: { piece: Piece }) {
  const [w, h, d] = piece.size;
  switch (piece.kind) {
    case "board":
      return (
        <group>
          <mesh><boxGeometry args={[w, h, Math.max(1.6, d * 0.25)]} /><meshStandardMaterial color="#1d6e8c" roughness={0.6} /></mesh>
          <mesh position={[0, 0, d * 0.25]}><boxGeometry args={[w * 0.32, h * 0.38, Math.max(1.5, d * 0.35)]} /><meshStandardMaterial color="#111823" roughness={0.4} /></mesh>
          {Array.from({ length: Math.max(2, Math.round(w / 6)) }, (_, i) => (
            <mesh key={i} position={[-w / 2 + 3 + i * ((w - 6) / Math.max(1, Math.round(w / 6) - 1)), h / 2 - 2, d * 0.12]}>
              <boxGeometry args={[1.4, 1.4, 1.2]} /><meshStandardMaterial color="#e0c36a" metalness={0.8} roughness={0.3} />
            </mesh>
          ))}
        </group>
      );
    case "speaker":
      return (
        <group rotation={[Math.PI / 2, 0, 0]}>
          <mesh><cylinderGeometry args={[w / 2, w / 2.4, d, 40]} /><meshStandardMaterial color="#2a3242" metalness={0.5} roughness={0.4} /></mesh>
          <mesh position={[0, d / 2 + 0.2, 0]}><cylinderGeometry args={[w / 2.4, w / 2.4, 0.6, 40]} /><meshStandardMaterial color="#0b0f17" roughness={0.9} /></mesh>
          <mesh position={[0, d / 2 + 0.8, 0]}><cylinderGeometry args={[w / 7, w / 7, 1.2, 24]} /><meshStandardMaterial color="#a6b4c8" metalness={0.7} roughness={0.3} /></mesh>
        </group>
      );
    case "ring": {
      const r = Math.max(w, h) / 2;
      return (
        <group>
          <mesh><torusGeometry args={[r * 0.82, r * 0.16, 12, 48]} /><meshStandardMaterial color="#14202f" roughness={0.6} /></mesh>
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i / 12) * Math.PI * 2;
            return (
              <mesh key={i} position={[Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82, r * 0.14]}>
                <sphereGeometry args={[r * 0.11, 10, 10]} />
                <meshBasicMaterial color={LED_COLORS[i % LED_COLORS.length]} toneMapped={false} />
              </mesh>
            );
          })}
        </group>
      );
    }
    case "led":
      return (
        <group>
          <mesh><boxGeometry args={[w, h, Math.max(1, d * 0.3)]} /><meshStandardMaterial color="#1b2431" /></mesh>
          <mesh position={[0, 0, d * 0.4]}><sphereGeometry args={[Math.min(w, h) * 0.3, 14, 14]} /><meshBasicMaterial color="#ffd166" toneMapped={false} /></mesh>
        </group>
      );
    case "battery":
      return <mesh><boxGeometry args={[w, h, d]} /><meshStandardMaterial color="#26324a" metalness={0.3} roughness={0.5} /></mesh>;
    case "motor":
      return <mesh><boxGeometry args={[w, h, d]} /><meshStandardMaterial color="#2f62d9" roughness={0.45} /></mesh>;
    default:
      return <mesh><boxGeometry args={[w, h, d]} /><meshStandardMaterial color="#596a86" roughness={0.5} /></mesh>;
  }
}

/** The glowing stand the product floats over. */
function BaseRing({ radius, z }: { radius: number; z: number }) {
  return (
    <group position={[0, 0, z]}>
      <mesh><ringGeometry args={[radius * 0.98, radius * 1.04, 128]} /><meshBasicMaterial color={ACCENT} toneMapped={false} side={THREE.DoubleSide} /></mesh>
      <mesh><ringGeometry args={[radius * 0.7, radius * 1.25, 128]} /><meshBasicMaterial color={ACCENT} transparent opacity={0.12} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      <mesh position={[0, 0, -0.5]}><circleGeometry args={[radius * 0.98, 96]} /><meshBasicMaterial color="#0d2a4a" transparent opacity={0.45} side={THREE.DoubleSide} depthWrite={false} /></mesh>
    </group>
  );
}
