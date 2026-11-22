import { useEffect, useRef } from "react";
import * as THREE from "three";
import { prefersReducedMotion } from "./motion";
import { additive, createStage, glowTexture, perfGuard, ribbonGeometry, ribbonMaterial, webglAvailable } from "./gl/core";

/**
 * The layered backdrop, rendered in WebGL with real bloom:
 *  - far: a slow 3D node network fading into fog, with pointer/gyro parallax for depth
 *  - near: neon circuit glyphs (buses, 45-degree jogs, pad rings) that draw themselves in with a
 *    hot leading edge, glow, and fade, each with a soft halo behind it
 *  - lens: navy-lifted blacks, vignette and film grain from the shared grade pass
 *
 * Performance: pixel ratio capped (1 on phones), element counts scale with screen area, a frame-time
 * watchdog halves resolution if a device can't keep up, and it stops while the tab is hidden.
 * Reduced motion renders one still frame. Without WebGL the CSS base layer stands alone.
 */
export function NetworkBackground({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !webglAvailable()) return;
    const small = window.innerWidth < 700;
    const reduced = prefersReducedMotion();
    let stage: ReturnType<typeof createStage>;
    try {
      stage = createStage({
        canvas,
        fov: 45,
        pixelRatio: Math.min(window.devicePixelRatio || 1, small ? 1.25 : 1.5),
        bloom: { strength: 1.0, radius: 0.0, threshold: 0.0 },
        bloomFactors: [1.0, 0.85, 0.55, 0.3, 0.12],
        grade: { vignette: 1, grain: 0.045, aberration: 0.0005, lift: [0.002, 0.008, 0.026] },
      });
    } catch {
      return;
    }
    const { scene, camera } = stage;
    scene.fog = new THREE.FogExp2(0x01040c, 0.06);
    // deep-space fill: a huge faint blue glow far behind everything, off-centre like a key light
    const fill = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x0b2d8a, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    fill.scale.set(60, 40, 1);
    fill.position.set(6, 3, -30);
    scene.add(fill);

    let W = window.innerWidth, H = window.innerHeight;
    let px = 1; // world units per CSS pixel at z = 0
    const measure = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      stage.resize(W, H);
      px = (2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360)) / H;
    };
    measure();

    /* ---------- far layer: 3D node network ---------- */
    const area = W * H;
    const N = Math.round(Math.min(110, Math.max(45, area / 15000)) * (0.6 + 0.4 * intensity));
    const nodes = Array.from({ length: N }, () => ({
      p: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, -4 - Math.random() * 16),
      v: new THREE.Vector3((Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.18, (Math.random() - 0.5) * 0.1),
    }));
    const maxPairs = (N * (N - 1)) / 2;
    const linePos = new Float32Array(maxPairs * 6);
    const lineCol = new Float32Array(maxPairs * 6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }),
    );
    scene.add(lines);
    const ptPos = new Float32Array(N * 3);
    const ptGeo = new THREE.BufferGeometry();
    ptGeo.setAttribute("position", new THREE.BufferAttribute(ptPos, 3).setUsage(THREE.DynamicDrawUsage));
    const points = new THREE.Points(
      ptGeo,
      new THREE.PointsMaterial({ size: 0.16, map: glowTexture(), color: 0x5aa8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
    );
    scene.add(points);
    const blue = new THREE.Color(0x2f7dff);

    function stepNetwork(dt: number) {
      for (const n of nodes) {
        n.p.addScaledVector(n.v, dt);
        if (n.p.x < -15) n.p.x = 15; else if (n.p.x > 15) n.p.x = -15;
        if (n.p.y < -9) n.p.y = 9; else if (n.p.y > 9) n.p.y = -9;
        if (n.p.z < -20) n.p.z = -4; else if (n.p.z > -4) n.p.z = -20;
      }
      let k = 0;
      const maxD = 3.4, maxD2 = maxD * maxD;
      for (let i = 0; i < N; i++) {
        const a = nodes[i].p;
        ptPos[i * 3] = a.x; ptPos[i * 3 + 1] = a.y; ptPos[i * 3 + 2] = a.z;
        for (let j = i + 1; j < N; j++) {
          const b = nodes[j].p;
          const d2 = a.distanceToSquared(b);
          if (d2 > maxD2) continue;
          const f = 1 - Math.sqrt(d2) / maxD;
          const s = f * f * 0.55;
          linePos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
          lineCol.set([blue.r * s, blue.g * s, blue.b * s, blue.r * s, blue.g * s, blue.b * s], k * 6);
          k++;
        }
      }
      lineGeo.setDrawRange(0, k * 2);
      lineGeo.attributes.position.needsUpdate = true;
      lineGeo.attributes.color.needsUpdate = true;
      ptGeo.attributes.position.needsUpdate = true;
    }

    /* ---------- near layer: circuit glyphs ---------- */
    interface Glyph {
      group: THREE.Group;
      mats: THREE.ShaderMaterial[];
      pads: THREE.MeshBasicMaterial[];
      halo: THREE.Sprite;
      age: number; grow: number; hold: number; fade: number;
      drift: number;
    }
    const glyphs: Glyph[] = [];
    const traceCount = Math.round(Math.min(10, Math.max(4, area / 140000)) * intensity);
    const DIRS: [number, number][] = [[0, 1], [0.7071, 0.7071], [-0.7071, 0.7071], [1, 0], [-1, 0]];

    function makeGlyph(delay: number): Glyph {
      const group = new THREE.Group();
      const scale = (0.8 + Math.random() * 0.5) * (small ? 0.85 : 1);
      const cell = 10 * scale * px;
      const lanes = 1 + Math.floor(Math.random() * 4);
      const gap = 6.5 * scale * px;
      const steps: { dir: [number, number]; n: number }[] = [];
      let dir: [number, number] = [0, 1];
      const segs = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < segs; i++) {
        steps.push({ dir, n: 1 + Math.floor(Math.random() * (dir[0] === 0 ? 7 : 3)) });
        const choices = DIRS.filter((d) => d !== dir && !(d[0] === -dir[0] && d[1] === -dir[1]));
        dir = i % 2 === 0 ? choices[Math.floor(Math.random() * choices.length)] : [0, 1];
      }
      const mats: THREE.ShaderMaterial[] = [];
      const pads: THREE.MeshBasicMaterial[] = [];
      const width = 2.6 * scale * px;
      for (let l = 0; l < lanes; l++) {
        const off = (l - (lanes - 1) / 2) * gap;
        const pts = [new THREE.Vector2(off, (Math.random() - 0.5) * cell * 2)];
        const cut = steps.length - (l > 0 && Math.random() < 0.5 ? 1 : 0);
        for (let s = 0; s < cut; s++) {
          const n = Math.max(1, steps[s].n - (s === cut - 1 ? Math.floor(Math.random() * 2) : 0));
          const last = pts[pts.length - 1];
          pts.push(new THREE.Vector2(last.x + steps[s].dir[0] * n * cell, last.y + steps[s].dir[1] * n * cell));
        }
        const mat = ribbonMaterial(0xd6efff, 0x1f6bff);
        mat.uniforms.uProgress.value = 0;
        mats.push(mat);
        group.add(new THREE.Mesh(ribbonGeometry(pts, width), mat));
        const padMat = additive(0x9fd4ff, 0);
        pads.push(padMat);
        const end = pts[pts.length - 1];
        const pad = new THREE.Mesh(new THREE.RingGeometry(2.2 * scale * px, 3.2 * scale * px, 32), padMat);
        pad.position.set(end.x, end.y, 0);
        group.add(pad);
      }
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x1550ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar((90 + lanes * 26) * scale * px);
      halo.position.set(0, cell * 2, -0.01);
      group.add(halo);
      const visW = W * px, visH = H * px;
      const z = (Math.random() - 0.6) * 2.4;
      const depthScale = (camera.position.z - z) / camera.position.z;
      group.position.set((Math.random() - 0.5) * visW * depthScale, (Math.random() - 0.55) * visH * depthScale, z);
      scene.add(group);
      return { group, mats, pads, halo, age: -delay, grow: 0.8 + Math.random() * 0.9, hold: 1.4 + Math.random() * 2.4, fade: 1.3, drift: (6 + Math.random() * 8) * px };
    }

    function disposeGlyph(g: Glyph) {
      scene.remove(g.group);
      g.group.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }

    function stepGlyph(g: Glyph, dt: number) {
      g.age += dt;
      g.group.position.y += g.drift * dt;
      const t = g.age;
      if (t < 0) return;
      const grow = Math.min(1, t / g.grow);
      const e = 1 - Math.pow(1 - grow, 3);
      const fade = t < g.grow + g.hold ? 1 : Math.max(0, 1 - (t - g.grow - g.hold) / g.fade);
      // a short electrical flicker while it powers up
      const flick = t < g.grow ? 0.7 + 0.3 * Math.random() : t < g.grow + 0.25 ? (Math.random() < 0.15 ? 0.55 : 1) : 1;
      const o = fade * flick;
      for (const m of g.mats) {
        m.uniforms.uProgress.value = e;
        m.uniforms.uOpacity.value = o;
      }
      for (const p of g.pads) p.opacity = grow >= 1 ? o * 0.95 : 0;
      (g.halo.material as THREE.SpriteMaterial).opacity = 0.32 * o * (0.4 + 0.6 * e);
    }

    for (let i = 0; i < traceCount; i++) glyphs.push(makeGlyph(Math.random() * 3.5));

    /* ---------- camera parallax ---------- */
    const look = new THREE.Vector2(), lookT = new THREE.Vector2();
    const onPointer = (e: PointerEvent) => lookT.set((e.clientX / W - 0.5) * 2, (e.clientY / H - 0.5) * 2);
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      lookT.set(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 30)));
    };
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("deviceorientation", onTilt, { passive: true });

    let raf = 0, last = 0, time = 0, frameSkip = intensity < 1 ? 1 : 0, f = 0;
    const guard = perfGuard(small ? 22 : 20, () => {
      stage.setPixelRatio(Math.max(0.6, stage.renderer.getPixelRatio() * 0.65));
      frameSkip = 1;
    });

    function step(dt: number) {
      time += dt;
      look.lerp(lookT, Math.min(1, dt * 2));
      camera.position.x = Math.sin(time * 0.05) * 0.4 + look.x * 0.35;
      camera.position.y = Math.cos(time * 0.04) * 0.25 - look.y * 0.25;
      camera.lookAt(0, 0, -6);
      stepNetwork(dt);
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i];
        stepGlyph(g, dt);
        if (g.age > g.grow + g.hold + g.fade) {
          disposeGlyph(g);
          glyphs[i] = makeGlyph(Math.random() * 0.8);
        }
      }
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      guard(now);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      if (frameSkip && (f++ & 1)) return;
      step(frameSkip ? dt * 2 : dt);
      stage.render(time);
    };

    if (reduced) {
      for (const g of glyphs) { g.age = g.grow + 0.5; stepGlyph(g, 0); }
      stepNetwork(0);
      stage.render(0);
    } else {
      raf = requestAnimationFrame(frame);
    }

    const onResize = () => {
      measure();
      if (reduced) stage.render(0);
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      last = 0;
      if (!document.hidden && !reduced) raf = requestAnimationFrame(frame);
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);
    canvas.classList.add("ready");
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("deviceorientation", onTilt);
      document.removeEventListener("visibilitychange", onVis);
      glyphs.forEach(disposeGlyph);
      stage.dispose();
    };
  }, [intensity]);

  return (
    <div className="fx-bg" aria-hidden>
      <div className="fx-bg-base" />
      <canvas ref={ref} className="fx-bg-canvas" />
    </div>
  );
}
