import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import gsap from "gsap";
import { prefersReducedMotion } from "./motion";
import { createStage, glowTexture, ringMaterial, ringMesh, webglAvailable } from "./gl/core";
import { sound } from "./sound";

const SEEN_KEY = "rmx.introSeen";

export function shouldPlayIntro(): boolean {
  if (window.location.hash === "#intro") return true;
  if (prefersReducedMotion() || !webglAvailable()) return false;
  try {
    return sessionStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

/**
 * Opening title, ~6.5 s, rendered in WebGL with bloom and a graded lens, choreographed on one GSAP
 * timeline:
 *   ignite    a point of light flares with an anamorphic streak
 *   assemble  instrument rings sweep on at different depths and counter-rotate as the camera pushes in
 *   breach    the rings collapse and a segmented ring blasts past the camera
 *   warp      dust streaks toward the lens
 *   network   the camera flies through a 3D node network as the wordmark resolves
 *   settle    a final core flare, then the whole frame dissolves into the start page
 * It opens on a single point of light with "Enter": that first tap is what lets the browser play the
 * score (see ./sound.ts), which is scheduled against the same timeline. After that, a tap, click or Esc
 * skips. Plays once per browser session.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  const [armed, setArmed] = useState(false);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  useEffect(() => sound.subscribe(setSoundOn), []);
  const finishRef = useRef<() => void>(() => undefined);
  const enterRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current, root = rootRef.current;
    if (!canvas || !root) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      sound.endIntro();
      try { sessionStorage.setItem(SEEN_KEY, "1"); } catch { /* plays again next time */ }
      gsap.to(root, {
        opacity: 0, scale: 1.04, filter: "blur(8px)", duration: 0.8, ease: "power2.inOut",
        onComplete: () => { setGone(true); onDone(); },
      });
    };
    finishRef.current = finish;

    let stage: ReturnType<typeof createStage>;
    try {
      stage = createStage({
        canvas,
        fov: 50,
        pixelRatio: Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.5 : 2),
        bloom: { strength: 0.8, radius: 0.0, threshold: 0.18 },
        bloomFactors: [1.0, 0.7, 0.35, 0.15, 0.06],
        grade: { vignette: 1, grain: 0.03, aberration: 0.0006, lift: [0.006, 0.026, 0.085] },
      });
    } catch {
      finish();
      return;
    }
    const { scene, camera } = stage;
    const W = () => window.innerWidth, H = () => window.innerHeight;
    stage.resize(W(), H());
    const onResize = () => stage.resize(W(), H());
    window.addEventListener("resize", onResize);
    const portrait = H() > W();
    const fit = portrait ? 0.62 : 1; // keep the ring cluster inside a phone's width

    const CYAN = 0x56d8ff, BLUE = 0x2b7bff, WHITE = 0xe8f8ff;

    /* --- deep field: a big soft blue light behind everything --- */
    const field = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x0d3fae, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    field.scale.set(70, 45, 1);
    field.position.z = -30;
    scene.add(field);

    /* --- ignition flare --- */
    const flare = new THREE.Group();
    scene.add(flare);
    const flareCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: WHITE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const flareGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: BLUE, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    const streak = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x7fc8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    flare.add(flareGlow, flareCore, streak);

    /* --- HUD rings, layered in depth --- */
    const hud = new THREE.Group();
    hud.scale.setScalar(fit);
    scene.add(hud);
    type R = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; spin: number };
    const rings: R[] = [];
    const add = (r: number, w: number, z: number, spin: number, o: Parameters<typeof ringMaterial>[1] = {}, color = CYAN) => {
      const mat = ringMaterial(color, { opacity: 0.62, ...o });
      mat.uniforms.uSweep.value = 0;
      const mesh = ringMesh(r, w, mat, 160);
      mesh.position.z = z;
      hud.add(mesh);
      rings.push({ mesh, mat, spin });
      return mat;
    };
    add(3.1, 0.018, 0, 0.02);
    add(3.25, 0.07, 0.1, 0.25, { arc: 0.16, start: 0.05 });
    add(3.25, 0.07, 0.1, 0.25, { arc: 0.06, start: 0.55 });
    add(2.82, 0.12, -0.2, -0.08, { dash: 120, duty: 0.25, opacity: 0.6 });
    add(2.6, 0.16, 0.15, 0.18, { dash: 48, duty: 0.55, arc: 0.72, start: 0.6, opacity: 0.75 });
    add(2.3, 0.025, -0.1, 0, { opacity: 0.6 });
    add(2.08, 0.14, 0.25, -0.35, { arc: 0.3, start: 0.1 });
    add(2.08, 0.14, 0.25, -0.35, { arc: 0.12, start: 0.62 });
    add(1.85, 0.09, -0.3, 0.12, { dash: 72, duty: 0.4, opacity: 0.55 });
    add(1.55, 0.06, 0.05, 0, { opacity: 1 }, 0x7fe8ff);
    add(1.38, 0.03, 0.4, 0.5, { arc: 0.55, start: 0.3, opacity: 0.8 });

    /* --- the breach ring: big segments that blast past the camera --- */
    const breachMat = ringMaterial(CYAN, { dash: 40, duty: 0.45, opacity: 0 });
    const breach = ringMesh(1, 0.12, breachMat, 160);
    scene.add(breach);
    const breachInnerMat = ringMaterial(CYAN, { dash: 64, duty: 0.35, opacity: 0 });
    const breachInner = ringMesh(0.6, 0.1, breachInnerMat, 160);
    scene.add(breachInner);

    /* --- warp dust --- */
    const DUST = 500;
    const dPos = new Float32Array(DUST * 3);
    for (let i = 0; i < DUST; i++) dPos.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, -Math.random() * 60], i * 3);
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dPos, 3));
    const dustMat = new THREE.PointsMaterial({ size: 0.07, map: glowTexture(), color: 0x7ab8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const dust = new THREE.Points(dustGeo, dustMat);
    scene.add(dust);

    /* --- 3D node network --- */
    const NN = window.innerWidth < 700 ? 150 : 230;
    const nodes: THREE.Vector3[] = [];
    for (let i = 0; i < NN; i++) {
      // denser toward the centre, like a nebula
      const r = Math.pow(Math.random(), 1.6) * 9;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      nodes.push(new THREE.Vector3(Math.sin(ph) * Math.cos(th) * r * 1.5, Math.sin(ph) * Math.sin(th) * r * 0.9, Math.cos(ph) * r * 1.6 - 6));
    }
    const segs: number[] = [];
    const segCol: number[] = [];
    const c1 = new THREE.Color(0x4fb4ff), c2 = new THREE.Color(0x9fe6ff);
    for (let i = 0; i < NN; i++) {
      const near = nodes
        .map((p, j) => ({ j, d: p.distanceTo(nodes[i]) }))
        .filter((x) => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
      for (const { j, d } of near) {
        if (j < i || d > 4.2) continue;
        segs.push(nodes[i].x, nodes[i].y, nodes[i].z, nodes[j].x, nodes[j].y, nodes[j].z);
        const c = Math.random() < 0.15 ? c2 : c1;
        const k = 0.3 + Math.random() * 0.45;
        segCol.push(c.r * k, c.g * k, c.b * k, c.r * k, c.g * k, c.b * k);
      }
    }
    const netGeo = new THREE.BufferGeometry();
    netGeo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
    netGeo.setAttribute("color", new THREE.Float32BufferAttribute(segCol, 3));
    const netMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const net = new THREE.LineSegments(netGeo, netMat);
    const nodePts = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(nodes),
      new THREE.PointsMaterial({ size: 0.12, map: glowTexture(), color: 0xbfeaff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const network = new THREE.Group();
    network.add(net, nodePts);
    network.visible = false;
    scene.add(network);

    /* --- the light sweep: a thin bright bar of light that crosses the lens --- */
    const sweep = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x5fd4ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    sweep.scale.set(30, 0.5, 1);
    sweep.position.set(-20, 0, 2);
    sweep.material.rotation = -0.12;
    scene.add(sweep);

    /* --- state the timeline animates --- */
    // before Enter: the navy field is up and a single point of light waits in the middle
    const S = {
      field: 0.7, flare: 0.5, flareSize: 0.02, streak: 0, rings: 0, hudScale: 0.92, hudFade: 1, camZ: 10,
      breachR: 0.3, breach: 0, dust: 0, warp: 0, net: 0, netZ: -8, netSpin: 0, core: 0,
    };
    const ringSweeps = rings.map(() => ({ v: 0 }));

    const tl = gsap.timeline({ onComplete: finish, paused: true });
    let gated = true;
    const enter = () => {
      if (!gated) return;
      gated = false;
      setArmed(true);
      sound.start();
      sound.intro(rings.length);
      tl.play(0);
    };
    enterRef.current = enter;
    if (import.meta.env.DEV) (window as unknown as { __rmxIntroTl: gsap.core.Timeline }).__rmxIntroTl = tl; // lets visual QA seek frames
    tl.to(S, { field: 1, duration: 1.2, ease: "power1.out" }, 0)
      // ignite
      .to(S, { flare: 1, flareSize: 1, duration: 0.45, ease: "expo.out" }, 0.35)
      .to(S, { streak: 1, duration: 0.35, ease: "power2.out" }, 0.45)
      .to(S, { flare: 0.35, flareSize: 0.45, streak: 0.25, duration: 0.6, ease: "power2.inOut" }, 0.85)
      // assemble: staggered sweeps from outside in, camera pushes
      .to(S, { rings: 1, duration: 0.4 }, 0.8)
      .to(S, { camZ: 8.4, hudScale: 1, duration: 2.6, ease: "power1.inOut" }, 0.8);
    ringSweeps.forEach((r, i) => tl.to(r, { v: 1, duration: 0.9, ease: "power3.out" }, 0.85 + i * 0.09));
    // breach
    tl.to(S, { hudScale: 0.25, hudFade: 0, flare: 0.15, duration: 0.55, ease: "power3.in" }, 3.0)
      .to(S, { breach: 1, duration: 0.15 }, 3.35)
      .to(S, { breachR: 9, duration: 0.95, ease: "power2.in" }, 3.35)
      .to(S, { breach: 0, duration: 0.3 }, 4.0)
      // warp
      .to(S, { dust: 1, warp: 1, duration: 0.4 }, 3.45)
      .to(S, { warp: 0, dust: 0.25, duration: 0.8, ease: "power2.out" }, 4.1)
      // network fly-through
      .set(network, { visible: true }, 4.0)
      .to(S, { net: 1, duration: 0.6, ease: "power2.out" }, 4.0)
      .fromTo(S, { netZ: -16 }, { netZ: 3.5, duration: 2.6, ease: "power2.out" }, 4.0)
      .to(S, { netSpin: 0.5, duration: 2.6, ease: "none" }, 4.0)
      .fromTo(sweep.position, { x: -22 }, { x: 22, duration: 0.7, ease: "power2.inOut" }, 4.55)
      .to(sweep.material, { opacity: 0.9, duration: 0.2, yoyo: true, repeat: 1 }, 4.6)
      .to(S, { core: 1, duration: 0.5, ease: "power2.out" }, 5.4)
      .to(S, { net: 0.28, duration: 0.8 }, 5.6);

    // wordmark
    const letters = root.querySelectorAll<HTMLElement>(".intro-title span");
    tl.fromTo(letters, { opacity: 0, y: 26, filter: "blur(12px)", scale: 1.25 },
      { opacity: 1, y: 0, filter: "blur(0px)", scale: 1, duration: 0.9, ease: "expo.out", stagger: 0.045 }, 4.55)
      .fromTo(root.querySelector(".intro-rule"), { scaleX: 0 }, { scaleX: 1, duration: 1, ease: "expo.inOut" }, 4.95)
      .fromTo(root.querySelector(".intro-tag"), { opacity: 0, letterSpacing: "1.2em" }, { opacity: 0.9, letterSpacing: "0.55em", duration: 1.1, ease: "expo.out" }, 5.15)
      .to({}, { duration: 0.6 });

    /* --- render loop --- */
    let raf = 0;
    const clock = new THREE.Clock();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = clock.getElapsedTime();
      (field.material as THREE.SpriteMaterial).opacity = 0.7 * S.field;
      const wait = gated ? 0.75 + 0.25 * Math.sin(t * 2.4) : 1;
      (flareCore.material as THREE.SpriteMaterial).opacity = Math.min(1, S.flare + S.core) * wait;
      flareCore.scale.setScalar(0.5 + 1.3 * S.flareSize + S.core * 0.8);
      (flareGlow.material as THREE.SpriteMaterial).opacity = 0.8 * Math.max(S.flare, S.core * 0.8);
      flareGlow.scale.setScalar(2 + 7 * S.flareSize + S.core * 5);
      (streak.material as THREE.SpriteMaterial).opacity = 0.9 * Math.max(S.streak, S.core * 0.6);
      streak.scale.set(4 + 26 * Math.max(S.streak, S.core), 0.16 + 0.1 * S.streak, 1);

      hud.visible = S.hudFade > 0.01;
      hud.scale.setScalar(S.hudScale * fit);
      hud.rotation.x = -0.12 + Math.sin(t * 0.4) * 0.05;
      hud.rotation.y = 0.18 + Math.cos(t * 0.3) * 0.06;
      rings.forEach((r, i) => {
        r.mat.uniforms.uSweep.value = ringSweeps[i].v;
        r.mat.uniforms.uOpacity.value = (r.mat.userData.base ??= r.mat.uniforms.uOpacity.value * 0.85) * S.rings * S.hudFade;
        r.mesh.rotation.z = t * r.spin;
      });

      breach.scale.setScalar(S.breachR);
      breachInner.scale.setScalar(S.breachR * 0.45);
      breachMat.uniforms.uOpacity.value = S.breach;
      breachInnerMat.uniforms.uOpacity.value = S.breach * 0.7;
      breach.rotation.z = t * 0.3;
      breach.position.z = breachInner.position.z = 2 - S.breachR * 0.2;

      dustMat.opacity = S.dust;
      if (S.warp > 0.01 || S.dust > 0.01) {
        for (let i = 0; i < DUST; i++) {
          let z = dPos[i * 3 + 2] + (0.15 + S.warp * 1.8) * 0.6;
          if (z > camera.position.z) z -= 60;
          dPos[i * 3 + 2] = z;
        }
        dustGeo.attributes.position.needsUpdate = true;
        dustMat.size = 0.06 + S.warp * 0.12;
      }

      network.position.z = S.netZ;
      network.rotation.y = S.netSpin + Math.sin(t * 0.3) * 0.04;
      network.rotation.z = S.netSpin * 0.3;
      netMat.opacity = S.net;
      (nodePts.material as THREE.PointsMaterial).opacity = S.net;

      camera.position.z = S.camZ;
      camera.position.x = Math.sin(t * 0.5) * 0.12;
      camera.position.y = Math.cos(t * 0.4) * 0.08;
      camera.lookAt(0, 0, -10);
      stage.render(t);
    };
    loop();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      else if (["Enter", " "].includes(e.key)) {
        e.preventDefault();
        if (gated) enter();
        else finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      tl.kill();
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      stage.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (gone) return null;
  return (
    <div ref={rootRef} className={`intro${armed ? " armed" : ""}`} onClick={() => (armed ? finishRef.current() : enterRef.current())} role="presentation">
      <canvas ref={canvasRef} className="intro-canvas" aria-hidden />
      <div className="intro-word" aria-label="RepairMind X">
        <div className="intro-title">
          {"REPAIRMIND".split("").map((c, i) => <span key={i}>{c}</span>)}
          <span className="intro-x">X</span>
        </div>
        <div className="intro-rule" />
        <div className="intro-tag">LIVE AI REPAIR MECHANIC</div>
      </div>
      <div className="intro-gate">
        <button className="intro-enter" onClick={(e) => { e.stopPropagation(); enterRef.current(); }} autoFocus>Enter</button>
        <span className="intro-hint">{soundOn ? "Sound on · best with headphones" : "Sound off"}</span>
      </div>
      <button className="intro-sound" aria-pressed={soundOn} onClick={(e) => { e.stopPropagation(); sound.toggle(); }}>
        {soundOn ? "Sound on" : "Sound off"}
      </button>
      <div className="intro-corner tl" aria-hidden /><div className="intro-corner br" aria-hidden />
      <button className="intro-skip" onClick={(e) => { e.stopPropagation(); finishRef.current(); }}>{armed ? "Skip intro" : "Skip"}</button>
    </div>
  );
}
