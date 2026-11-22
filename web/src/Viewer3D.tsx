import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html, OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Part3D, Product3D, Step3D } from "./types";

/** Shows the current expert-procedure step on a 3D model of the product.
 *  Parts in `highlight` glow, parts in `move` slide to their offset (an exploded view), parts in `hide`
 *  disappear. "Replay" animates the step again from the assembled position. */
export function Viewer3D({ step }: { step: Step3D }) {
  const [product, setProduct] = useState<Product3D | null>(null);
  const [error, setError] = useState("");
  const [play, setPlay] = useState(0);
  const [explode, setExplode] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/products/${encodeURIComponent(step.product_id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p) => live && setProduct(p))
      .catch(() => live && setError("Couldn't load the 3D model."));
    return () => {
      live = false;
    };
  }, [step.product_id]);

  useEffect(() => setPlay((n) => n + 1), [step.step_id]);

  if (error) return <div className="viewer3d-msg">{error}</div>;
  if (!product) return <div className="viewer3d-msg">Loading 3D model…</div>;

  return (
    <section className="viewer3d" aria-label="3D view of this step">
      <div className="viewer3d-canvas">
        <Canvas camera={{ position: [2.6, 2.4, 3.2], fov: 45 }} dpr={[1, 2]}>
          <ambientLight intensity={0.6} />
          <directionalLight position={[4, 6, 5]} intensity={1.1} />
          <Suspense fallback={<Html center>Loading…</Html>}>
            {product.model_url ? (
              <GlbModel url={product.model_url} step={step} />
            ) : (
              <group position={[0, -0.9, 0]}>
                {product.parts.map((p) => (
                  <PrimitivePart key={p.name} part={p} step={step} play={play} explode={explode} />
                ))}
              </group>
            )}
          </Suspense>
          <OrbitControls enablePan={false} target={[0, 0.6, 0]} />
        </Canvas>
        {product.illustrative && (
          <span className="badge-illustrative" title="Shapes are approximate, not the real product's CAD">
            Illustrative model
          </span>
        )}
      </div>
      <div className="viewer3d-bar">
        <span className="viewer3d-caption">{step.caption}</span>
        <div className="viewer3d-actions">
          <button className="ghost" onClick={() => setPlay((n) => n + 1)}>Replay</button>
          <button className="ghost" aria-pressed={explode} onClick={() => setExplode((e) => !e)}>
            {explode ? "Assemble" : "Explode"}
          </button>
        </div>
      </div>
    </section>
  );
}

function PrimitivePart({ part, step, play, explode }: { part: Part3D; step: Step3D; play: number; explode: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const start = useRef(0);
  const home = useMemo(() => new THREE.Vector3(...(part.position as [number, number, number])), [part.position]);
  const offset = step.move[part.name] ?? [0, 0, 0];
  const lit = step.highlight.includes(part.name);
  const hidden = step.hide.includes(part.name);
  const explodeDir = useMemo(() => {
    const v = home.clone().setY(home.y - 1);
    return v.lengthSq() < 1e-4 ? new THREE.Vector3(0, 0, 0) : v.normalize().multiplyScalar(0.6);
  }, [home]);

  useEffect(() => {
    start.current = performance.now();
    ref.current?.position.copy(home);
  }, [play, home]);

  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const t = Math.min(1, (performance.now() - start.current) / 1200);
    const ease = t * t * (3 - 2 * t);
    const target = home.clone().add(new THREE.Vector3(...(offset as [number, number, number])).multiplyScalar(ease));
    if (explode) target.add(explodeDir);
    m.position.lerp(target, 0.25);
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = lit ? 0.35 + 0.25 * Math.sin(performance.now() / 250) : 0;
  });

  if (hidden) return null;
  const [a = 1, b = 1, c = 1] = part.size;
  return (
    <mesh ref={ref} position={home} rotation={part.rotation as [number, number, number]}>
      {part.shape === "box" && <boxGeometry args={[a, b, c]} />}
      {part.shape === "cylinder" && <cylinderGeometry args={[a / 2, b / 2, c, 40]} />}
      {part.shape === "sphere" && <sphereGeometry args={[a / 2, 32, 16]} />}
      {part.shape === "torus" && <torusGeometry args={[a / 2, b, 12, 48]} />}
      <meshStandardMaterial color={part.color} emissive={lit ? "#38d6e8" : "#000000"} roughness={0.55}
        transparent opacity={lit || step.highlight.length === 0 ? 1 : 0.55} />
      {lit && (
        <Html center className="part-label" style={{ transform: "translateY(-28px)" }}>{part.label || part.name}</Html>
      )}
    </mesh>
  );
}

/** A real CAD-derived GLB. Mesh names must match part names in product.yaml for highlight/move/hide. */
function GlbModel({ url, step }: { url: string; step: Step3D }) {
  const { scene } = useGLTF(url);
  const homes = useRef(new Map<string, THREE.Vector3>());
  useEffect(() => {
    scene.traverse((o) => {
      if (!homes.current.has(o.name)) homes.current.set(o.name, o.position.clone());
      const home = homes.current.get(o.name)!;
      const off = step.move[o.name];
      o.position.copy(off ? home.clone().add(new THREE.Vector3(...(off as [number, number, number]))) : home);
      o.visible = !step.hide.includes(o.name);
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material && "emissive" in mesh.material) {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.emissive = new THREE.Color(step.highlight.includes(o.name) ? "#38d6e8" : "#000000");
        mat.emissiveIntensity = step.highlight.includes(o.name) ? 0.5 : 0;
      }
    });
  }, [scene, step]);
  return <primitive object={scene} />;
}
