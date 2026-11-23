import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { Design, SimBody } from "./design.ts";
import type { Analysis } from "./analysis.ts";
import { DT, Sandbox, loadRapier, simFindings, type ProbeResult } from "./physics.ts";
import { fmt } from "./units.ts";

type RapierLib = Awaited<ReturnType<typeof loadRapier>>;

/** Runs a design's simulation to the end without drawing it: used for the checks and the rethink loop. */
export async function runHeadless(design: Design, analysis: Analysis) {
  const R = await loadRapier();
  const sb = new Sandbox(R, design, analysis);
  try {
    while (!sb.done) sb.step(20);
    const results = sb.results();
    return { results, findings: simFindings(results, sb.warnings, sb) };
  } finally {
    sb.free();
  }
}

const PALETTE = ["#38d6e8", "#8b7bff", "#f5b544", "#3ecf8e", "#ff7a9a", "#9fb4d6"];

function BodyMesh({ spec, index, sandbox }: { spec: SimBody; index: number; sandbox: Sandbox }) {
  const ref = useRef<THREE.Group>(null);
  const geo = useMemo(() => {
    const s = spec.size ?? [];
    if (spec.shape === "sphere") return new THREE.SphereGeometry(s[0] || 0.1, 32, 16);
    if (spec.shape === "cylinder") return new THREE.CylinderGeometry(s[0] || 0.1, s[0] || 0.1, s[1] || 0.1, 32);
    return new THREE.BoxGeometry(s[0] || 0.2, s[1] || 0.2, s[2] || 0.2);
  }, [spec]);
  const shapeRot = useMemo(() => {
    const [x, y, z] = (spec.rotation_deg ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
    return new THREE.Euler(x || 0, y || 0, z || 0, "XYZ");
  }, [spec]);
  const color = /^#[0-9a-f]{3,8}$/i.test(spec.color) ? spec.color : spec.fixed ? "#3b465c" : PALETTE[index % PALETTE.length];
  useFrame(() => {
    if (sandbox.freed) return;
    const b = sandbox.bodies.get(spec.id);
    if (!b || !ref.current) return;
    const t = b.translation(), r = b.rotation();
    ref.current.position.set(t.x, t.y, t.z);
    ref.current.quaternion.set(r.x, r.y, r.z, r.w);
  });
  return (
    <group ref={ref}>
      <mesh geometry={geo} rotation={shapeRot} castShadow receiveShadow>
        <meshStandardMaterial color={color} metalness={spec.fixed ? 0.1 : 0.45} roughness={0.45} />
      </mesh>
      {spec.shape === "cylinder" && (
        <mesh rotation={shapeRot}>
          {/* a spoke so rotation is visible */}
          <boxGeometry args={[(spec.size[0] || 0.1) * 1.6, (spec.size[1] || 0.1) * 1.04, (spec.size[0] || 0.1) * 0.18]} />
          <meshStandardMaterial color="#9fb4d6" />
        </mesh>
      )}
    </group>
  );
}

/** Springs drawn as a coil between their anchors, so the assembly reads as an assembly. */
function Springs({ sandbox, design }: { sandbox: Sandbox; design: Design }) {
  const springs = design.simulation.joints.filter((j) => j.kind === "spring" && sandbox.bodies.has(j.a) && sandbox.bodies.has(j.b));
  const lines = useMemo(() => springs.map(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(42 * 3), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#38d6e8" }));
  }), [springs.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(() => {
    if (sandbox.freed) return;
    springs.forEach((j, k) => {
      const a = sandbox.bodies.get(j.a)!, b = sandbox.bodies.get(j.b)!;
      const pa = new THREE.Vector3(...(j.anchor_a.length === 3 ? j.anchor_a : [0, 0, 0])).applyQuaternion(new THREE.Quaternion(...Object.values(a.rotation()) as [number, number, number, number])).add(new THREE.Vector3(...Object.values(a.translation()) as [number, number, number]));
      const pb = new THREE.Vector3(...(j.anchor_b.length === 3 ? j.anchor_b : [0, 0, 0])).applyQuaternion(new THREE.Quaternion(...Object.values(b.rotation()) as [number, number, number, number])).add(new THREE.Vector3(...Object.values(b.translation()) as [number, number, number]));
      const dir = pb.clone().sub(pa);
      const side = new THREE.Vector3(1, 0, 0).cross(dir).lengthSq() > 1e-9 ? new THREE.Vector3(1, 0, 0).cross(dir).normalize() : new THREE.Vector3(0, 0, 1);
      const side2 = dir.clone().cross(side).normalize();
      const pos = lines[k].geometry.getAttribute("position") as THREE.BufferAttribute;
      const n = pos.count;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const r = i === 0 || i === n - 1 ? 0 : 0.035;
        const ang = t * Math.PI * 2 * 10;
        const p = pa.clone().addScaledVector(dir, t).addScaledVector(side, Math.cos(ang) * r).addScaledVector(side2, Math.sin(ang) * r);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
    });
  });
  return <>{lines.map((l, i) => <primitive key={i} object={l} />)}</>;
}

function Stepper({ sandbox, playing, speed, onTick }: { sandbox: Sandbox; playing: boolean; speed: number; onTick: () => void }) {
  const acc = useRef(0);
  const last = useRef(0);
  useFrame((_, delta) => {
    if (!playing || sandbox.freed || sandbox.done) return;
    acc.current += Math.min(delta, 0.05) * speed;
    const n = Math.floor(acc.current / DT);
    if (n > 0) {
      sandbox.step(Math.min(n, 240));
      acc.current -= n * DT;
    }
    if (sandbox.time - last.current > 0.1 || sandbox.done) {
      last.current = sandbox.time;
      onTick();
    }
  });
  return null;
}

function Spark({ r }: { r: ProbeResult }) {
  const pts = r.series.filter((_, i) => i % 4 === 0).filter(Number.isFinite);
  if (pts.length < 2) return <svg className="lab-spark" viewBox="0 0 100 28" aria-hidden />;
  const all = r.predicted !== null ? [...pts, r.predicted] : pts;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const y = (v: number) => 26 - ((v - lo) / (hi - lo)) * 24;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * 100).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg className="lab-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      {r.predicted !== null && <line x1="0" x2="100" y1={y(r.predicted)} y2={y(r.predicted)} className="pred" />}
      <path d={d} />
    </svg>
  );
}

/** The 3D physics sandbox for a design: watch the assembly, compare probes against the hand calculations. */
export function SimView({ design, analysis }: { design: Design; analysis: Analysis }) {
  const [R, setR] = useState<RapierLib | null>(null);
  const [err, setErr] = useState("");
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [run, setRun] = useState(0);
  const [, setTick] = useState(0);

  useEffect(() => {
    loadRapier().then(setR).catch(() => setErr("The physics engine couldn't load in this browser."));
  }, []);

  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  // one world per design, inputs and restart; released when replaced (StrictMode-safe)
  useEffect(() => {
    if (!R) return;
    let sb: Sandbox | null = null;
    try {
      sb = new Sandbox(R, design, analysis);
      setErr("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setSandbox(sb);
    return () => sb?.free();
  }, [R, design, analysis, run]);

  const sim = design.simulation;
  const results = sandbox && !sandbox.freed ? sandbox.results() : [];
  // frame every body and the ground beneath them
  const [focus, span] = useMemo(() => {
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
    for (const b of sim.bodies) {
      const p = b.position ?? [0, 0, 0];
      const r = Math.max(...(b.size ?? [0.2]).map((x) => Math.abs(x) || 0)) / 2;
      box.expandByPoint(new THREE.Vector3((p[0] || 0) - r, (p[1] || 0) - r, (p[2] || 0) - r));
      box.expandByPoint(new THREE.Vector3((p[0] || 0) + r, (p[1] || 0) + r, (p[2] || 0) + r));
    }
    const size = box.getSize(new THREE.Vector3()).length();
    return [box.getCenter(new THREE.Vector3()), Math.min(Math.max(size * 0.9, 1.2), 40)] as const;
  }, [sim]);

  return (
    <section className="lab-sim" aria-label="Physics simulation">
      <div className="lab-sim-head">
        <div>
          <span className="lab-kicker">Physics sandbox</span>
          <h3>{sim.title || "Simulation"}</h3>
        </div>
        <div className="lab-sim-ctl">
          <button className="lab-btn" onClick={() => setPlaying((p) => !p)} disabled={!sandbox}>{playing ? "Pause" : "Play"}</button>
          <button className="lab-btn" onClick={() => { setRun((r) => r + 1); setPlaying(true); }} disabled={!sandbox}>Restart</button>
          <label className="lab-speed">
            <span>Speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              <option value={0.25}>¼×</option><option value={0.5}>½×</option><option value={1}>1×</option><option value={2}>2×</option>
            </select>
          </label>
        </div>
      </div>
      <div className="lab-canvas">
        {err && <p className="lab-err">{err}</p>}
        {!R && !err && <p className="lab-loading">Loading the physics engine…</p>}
        {sandbox && (
          <Canvas key={design.title} shadows camera={{ position: [focus.x + span * 0.9, focus.y + span * 0.55, focus.z + span * 1.1], fov: 40, near: 0.01, far: 500 }} dpr={[1, 2]}>
            <color attach="background" args={["#060b16"]} />
            <hemisphereLight args={["#cfeeff", "#1a2440", 1.1]} />
            <directionalLight position={[4, 8, 5]} intensity={1.4} castShadow shadow-mapSize={[1024, 1024]} />
            {sim.ground && (
              <>
                <mesh rotation-x={-Math.PI / 2} receiveShadow position={[0, -0.0005, 0]}>
                  <planeGeometry args={[100, 100]} />
                  <meshStandardMaterial color="#111d36" />
                </mesh>
                <gridHelper args={[40, 80, "#3a6aa8", "#1d3050"]} position={[0, 0.001, 0]} />
              </>
            )}
            {sandbox.specs.map((s, i) => <BodyMesh key={`${run}-${s.id}-${i}`} spec={s} index={i} sandbox={sandbox} />)}
            <Springs sandbox={sandbox} design={design} />
            <Stepper sandbox={sandbox} playing={playing} speed={speed} onTick={() => setTick((t) => t + 1)} />
            <OrbitControls target={focus} makeDefault />
          </Canvas>
        )}
        {sandbox && !sandbox.freed && <span className="lab-clock">t = {sandbox.time.toFixed(2)} s / {sandbox.duration.toFixed(1)} s{sandbox.done ? " · done" : ""}</span>}
      </div>
      {sim.description && <p className="lab-muted">{sim.description}</p>}
      {sandbox && sandbox.warnings.length > 0 && <ul className="lab-warn">{sandbox.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {results.length > 0 && (
        <div className="lab-scroll"><table className="lab-table lab-probes">
          <thead><tr><th>Probe</th><th>Simulated</th><th>Hand calc</th><th>Trace</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.probe.id}>
                <td>{r.probe.label}<small>{r.probe.compare} {r.probe.quantity}</small></td>
                <td className="num">{Number.isFinite(r.value) ? `${fmt(r.value)} ${r.unit}` : "–"}</td>
                <td className="num">
                  {r.predicted === null ? <span className="lab-muted">–</span> : <>
                    {fmt(r.predicted)} {r.unit}
                    {sandbox?.done && r.pass !== null && (
                      <span className={`lab-pill ${r.pass ? "ok" : "bad"}`}>{r.pass ? "agrees" : "differs"} {r.errorPct!.toFixed(1)}%</span>
                    )}
                    <small>{r.probe.predicted_by}</small>
                  </>}
                </td>
                <td><Spark r={r} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}
