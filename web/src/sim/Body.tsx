import { useEffect, useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { BY_ID } from "../build/parts.ts";
import { short } from "../build/engine.ts";
import type { Project } from "../build/project.ts";
import { useI18n } from "../i18n";
import { trace } from "./outline.ts";
import { MATERIALS, PRESETS, buildShell, engineering, fit, halfMesh, scaleToFit, stl, type Box3, type Pt, type ShellSpec, type Tri } from "./shell.ts";
import "./sim.css";

const STORE = "rmx.build.body";

interface Saved { spec: ShellSpec; source: string; keep: boolean; squeeze: number }

function load(): Saved | null {
  try { const raw = localStorage.getItem(STORE); return raw ? (JSON.parse(raw) as Saved) : null; } catch { return null; }
}

const fresh = (): Saved => ({ spec: { outline: PRESETS[0].make(), width: 100, height: 70, depth: 45, round: 8, wall: 2.4, material: "petg" }, source: "box", keep: true, squeeze: 100 });

/**
 * The product's body: its outer shape in 3D from a photo or a preset and the measured size, remodelled with
 * sliders, the electronics placed inside, the maths behind the shell, and printable STL halves.
 */
export function BodyView({ project }: { project: Project }) {
  const { t, auto } = useI18n();
  const [s, setS] = useState<Saved>(() => load() ?? fresh());
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(true);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* kept for this visit */ } }, [s]);
  const spec = s.spec;
  const set = (p: Partial<ShellSpec>) => setS((x) => ({ ...x, spec: { ...x.spec, ...p, round: Math.min(p.round ?? x.spec.round, (p.depth ?? x.spec.depth) / 2) } }));

  const shell = useMemo(() => buildShell(spec), [spec]);
  const front = useMemo(() => halfMesh(shell, 1), [shell]);
  const back = useMemo(() => halfMesh(shell, -1), [shell]);
  const parts: Box3[] = useMemo(() => project.parts.map((p) => BY_ID[p.id]).filter(Boolean).filter((p) => p.id !== "switch").map((p) => ({ name: short(p), size: p.size })), [project.parts]);
  const f = useMemo(() => fit(shell, parts), [shell, parts]);
  const eng = useMemo(() => engineering(spec, shell, s.squeeze), [spec, shell, s.squeeze]);
  const material = MATERIALS.find((m) => m.id === spec.material) ?? MATERIALS[0];

  const fromImage = async (src: string) => {
    setErr(""); setNote("");
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      const k = Math.min(1, 260 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(8, Math.round(img.width * k)); c.height = Math.max(8, Math.round(img.height * k));
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0, c.width, c.height);
      const tr = trace(g.getImageData(0, 0, c.width, c.height));
      if (!tr) { setErr(t("body.traceFail")); return; }
      setS((x) => ({ ...x, source: "photo", spec: { ...x.spec, outline: tr.outline, height: x.keep ? Math.round(x.spec.width * tr.aspect) : x.spec.height } }));
      if (tr.note) setNote(tr.note);
    } catch { setErr(t("body.traceFail")); }
  };

  const download = (side: 1 | -1) => {
    const buf = stl(halfMesh(shell, side), `${project.name || "product"} ${side === 1 ? "front" : "back"}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "model/stl" }));
    a.download = `${(project.name || "product").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40) || "product"}_${side === 1 ? "front" : "back"}.stl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const grow = () => {
    const k = scaleToFit(spec, parts);
    if (k === null) { setErr(t("body.cantGrow")); return; }
    set({ width: Math.ceil(spec.width * k), height: Math.ceil(spec.height * k), depth: Math.ceil(spec.depth * k) });
  };

  const aspect = useMemo(() => { const xs = spec.outline.map((p) => p[0]), ys = spec.outline.map((p) => p[1]); return (Math.max(...ys) - Math.min(...ys)) / Math.max(1e-9, Math.max(...xs) - Math.min(...xs)); }, [spec.outline]);
  const span = Math.max(spec.width, spec.height, spec.depth);

  return (
    <div className="body">
      <p className="lab-muted">{t("body.intro")}</p>
      <div className="body-grid">
        <div className="body-view">
          <Canvas key={Math.round(span / 15)} camera={{ position: [span * 0.55, span * 0.45, span * 1.7], fov: 40, near: 1, far: span * 20 }} dpr={[1, 2]}>
            <color attach="background" args={["#060b16"]} />
            <hemisphereLight args={["#cfeeff", "#1a2440", 1.1]} />
            <directionalLight position={[span, span * 2, span * 1.5]} intensity={1.3} />
            <Half tris={front} offset={open ? spec.depth * 1.2 : 0} opacity={open ? 0.22 : 0.38} />
            <Half tris={back} offset={0} opacity={open ? 0.9 : 0.38} />
            {f.placed.map((p, i) => (
              <mesh key={i} position={[p.x, p.y, 0]} rotation={[0, 0, (f.angle * Math.PI) / 180]}>
                <boxGeometry args={[p.w, p.h, p.d]} />
                <meshStandardMaterial color={BOX_COLORS[i % BOX_COLORS.length]} />
              </mesh>
            ))}
            <OrbitControls makeDefault />
          </Canvas>
          <span className={`body-fit ${f.ok ? "ok" : "bad"}`}>{f.ok ? t("body.fits") : t("body.noFit")} · {auto(f.reason)}</span>
        </div>

        <div className="body-side">
          <section className="lab-card">
            <span className="lab-kicker">{t("body.shape")}</span>
            <div className="sim-btns">
              <label className={`lab-btn${s.source === "photo" ? " held" : ""}`}>{t("body.photo")}
                <input type="file" accept="image/*" hidden onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const url = URL.createObjectURL(file);
                  await fromImage(url);
                  URL.revokeObjectURL(url);
                }} />
              </label>
              {project.product.photo && <button className="lab-btn" onClick={() => fromImage(project.product.photo!)}>{t("body.usePhoto")}</button>}
              {PRESETS.map((p) => <button key={p.id} className={`lab-btn${s.source === p.id ? " held" : ""}`} onClick={() => setS((x) => ({ ...x, source: p.id, spec: { ...x.spec, outline: p.make() } }))}>{auto(p.name)}</button>)}
            </div>
            <p className="lab-muted">{t("body.photoTip")}</p>
            {err && <p className="lab-err">{err}</p>}
            {note && <p className="bd-note">{auto(note)}</p>}
          </section>

          <section className="lab-card">
            <span className="lab-kicker">{t("body.size")}</span>
            <Num label={t("body.width")} value={spec.width} min={10} max={600} set={(v) => set(s.keep ? { width: v, height: Math.round(v * aspect) } : { width: v })} />
            <Num label={t("body.height")} value={spec.height} min={10} max={600} set={(v) => set(s.keep ? { height: v, width: Math.round(v / aspect) } : { height: v })} />
            <label className="sim-toggle"><input type="checkbox" checked={s.keep} onChange={(e) => setS((x) => ({ ...x, keep: e.target.checked }))} /><span>{t("body.keep")}</span></label>
            <Num label={t("body.depth")} value={spec.depth} min={6} max={400} set={(v) => set({ depth: v })} />
            <Num label={t("body.round")} value={spec.round} min={0} max={Math.floor(spec.depth / 2)} set={(v) => set({ round: v })} />
            <Num label={t("body.wall")} value={spec.wall} min={0.8} max={8} step={0.2} set={(v) => set({ wall: v })} />
            <label className="sim-row"><span>{t("body.material")}</span>
              <select value={spec.material} onChange={(e) => set({ material: e.target.value })}>
                {MATERIALS.map((m) => <option key={m.id} value={m.id}>{auto(m.name)}</option>)}
              </select>
            </label>
            <p className="lab-muted">{auto(material.note)}</p>
            <div className="sim-btns">
              {!f.ok && <button className="lab-btn solid" onClick={grow}>{t("body.grow")}</button>}
              {eng.safety < 2 && <button className="lab-btn" onClick={() => set({ wall: Math.ceil(eng.wallFor2 * 5) / 5 })}>{t("body.thicken", { mm: (Math.ceil(eng.wallFor2 * 5) / 5).toFixed(1) })}</button>}
              <button className="lab-btn" onClick={() => setOpen((o) => !o)}>{open ? t("body.close") : t("body.open")}</button>
            </div>
          </section>
        </div>
      </div>

      <section className="lab-card body-math">
        <div className="body-math-head">
          <span className="lab-kicker">{t("body.math")}</span>
          <label className="sim-row"><span>{t("body.squeeze")}</span>
            <select value={s.squeeze} onChange={(e) => setS((x) => ({ ...x, squeeze: Number(e.target.value) }))}>
              <option value={50}>{t("body.sq.gentle")}</option><option value={100}>{t("body.sq.firm")}</option><option value={300}>{t("body.sq.stand")}</option>
            </select>
          </label>
        </div>
        <div className="lab-scroll">
          <table className="lab-table">
            <tbody>{eng.lines.map((l) => <tr key={l.label} className={l.label === "Safety factor" ? (eng.safety >= 2 ? "body-good" : "body-bad") : ""}><td>{auto(l.label)}</td><td className="body-f">{auto(l.formula)}</td><td className="num">{l.value}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="lab-muted">{eng.safety >= 2 ? t("body.strongOk", { sf: eng.safety.toFixed(1) }) : t("body.strongLow", { sf: eng.safety.toFixed(2), mm: eng.wallFor2.toFixed(1) })}</p>
      </section>

      <section className="lab-card">
        <span className="lab-kicker">{t("body.export")}</span>
        <div className="sim-btns">
          <button className="lab-btn solid" onClick={() => download(1)}>{t("body.front")}</button>
          <button className="lab-btn solid" onClick={() => download(-1)}>{t("body.back")}</button>
        </div>
        <p className="lab-muted">{t("body.exportP")}</p>
      </section>
    </div>
  );
}

const BOX_COLORS = ["#38d6e8", "#f5b544", "#8b7bff", "#3ecf8e", "#ff7a9a", "#9fb4d6"];

function Half({ tris, offset, opacity }: { tris: Tri[]; offset: number; opacity: number }) {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(tris.flat()), 3));
    g.computeVertexNormals();
    return g;
  }, [tris]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} position={[0, 0, offset]}>
      <meshStandardMaterial color="#cfd8ea" metalness={0.05} roughness={0.55} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={opacity > 0.6} />
    </mesh>
  );
}

function Num({ label, value, min, max, step = 1, set }: { label: string; value: number; min: number; max: number; step?: number; set: (v: number) => void }) {
  return (
    <label className="sim-slider">
      <span>{label}<b className="mono">{Number(value.toFixed(1))} mm</b></span>
      <span className="body-num">
        <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => set(Number(e.target.value))} />
        <input type="number" min={min} max={max} step={step} value={Number(value.toFixed(1))} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= min && v <= max) set(v); }} aria-label={label} />
      </span>
    </label>
  );
}

export type { Pt };
