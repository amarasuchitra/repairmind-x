import { useEffect, useRef } from "react";
import * as THREE from "three";
import { prefersReducedMotion } from "../fx/motion";
import { additive, arcMesh, createStage, glowTexture, radialBlocks, webglAvailable } from "../fx/gl/core";
import { NOISE3D } from "../fx/gl/noise";
import { VoiceOrb2D } from "./VoiceOrb2D";

export type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

const HEX: Record<OrbState, number> = {
  speaking: 0x48e6ff,
  listening: 0x3ee8a0,
  thinking: 0x9a86ff,
  connecting: 0x4f8fd8,
  idle: 0x48d2ff,
};

interface Props {
  state: OrbState;
  bands: number[];
  size?: number;
  detail?: "compact" | "full";
  /** Optional per-frame band source (used by demos) instead of the bands prop. */
  voice?: () => number[];
}

/**
 * The mechanic's presence, rendered in WebGL with bloom.
 *
 * A cluster of instrument layers sits at different depths on a tilted plane, so the camera sees it
 * in perspective and the layers parallax as it sways. At the centre is a plasma core: a sphere whose
 * surface is displaced by 3D noise in proportion to the voice, with a Fresnel rim and a hot inner
 * light. Around it a shell of particles breathes with the frequency bands, a radial spectrum follows
 * the voice, aperture blades open with loudness, and segment meters light up block by block.
 *
 * Cyan while the mechanic speaks (its own audio), green while it listens (your mic), violet with a
 * scanning sweep while it thinks. Falls back to the 2D canvas dial without WebGL.
 */
export function VoiceOrb(props: Props) {
  const ok = useRef<boolean | null>(null);
  if (ok.current === null) ok.current = webglAvailable();
  return ok.current ? <VoiceOrbGL {...props} /> : <VoiceOrb2D {...props} />;
}

function VoiceOrbGL({ state, bands, size = 96, detail, voice }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, bands, voice });
  live.current = { state, bands, voice };
  const full = (detail ?? (size >= 180 ? "full" : "compact")) === "full";

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduced = prefersReducedMotion();
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    let stage: ReturnType<typeof createStage>;
    try {
      stage = createStage({
        canvas,
        fov: 32,
        pixelRatio: pr,
        bloom: full ? { strength: 0.85, radius: 0.0, threshold: 0.42 } : { strength: 0.9, radius: 0.0, threshold: 0.4 },
        bloomFactors: [1.0, 0.55, 0.16, 0.03, 0.0],
        grade: { vignette: 0, grain: 0, aberration: 0, lift: [0, 0, 0] },
      });
    } catch {
      return;
    }
    const { scene, camera } = stage;
    // render at the size it is actually shown (CSS may scale the canvas up), never blurrier
    const fitSize = () => Math.max(size, Math.round(canvas.clientWidth || size));
    stage.resize(fitSize(), fitSize());
    const ro = new ResizeObserver(() => stage.resize(fitSize(), fitSize()));
    ro.observe(canvas);
    camera.position.set(0, 0, full ? 10.6 : 7.6);

    const colour = new THREE.Color(HEX[live.current.state]);
    const white = new THREE.Color(0xeafcff);
    const rig = new THREE.Group();
    scene.add(rig);
    const tilt = new THREE.Group();
    rig.add(tilt);
    tilt.rotation.set(full ? -0.48 : -0.25, full ? 0.42 : 0.15, 0);

    const mats: { m: THREE.Material & { color?: THREE.Color }; k: number }[] = [];
    const tinted = (k: number, opacity = 1) => {
      const m = additive(colour.clone(), opacity);
      mats.push({ m, k });
      return m;
    };

    /* ---- core ---- */
    const BANDS = 16;
    const coreU = {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uColor: { value: colour.clone() },
      uBands: { value: new Array(BANDS).fill(0) },
    };
    const core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.78, full ? 24 : 12),
      new THREE.ShaderMaterial({
        uniforms: coreU,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          ${NOISE3D}
          uniform float uTime, uLevel;
          varying vec3 vN; varying vec3 vView; varying float vDisp;
          void main() {
            float n = snoise(position * 1.7 + vec3(0.0, uTime * 0.35, uTime * 0.2));
            float n2 = snoise(position * 4.2 - vec3(uTime * 0.6));
            float d = n * (0.04 + uLevel * 0.3) + n2 * (0.015 + uLevel * 0.08);
            vDisp = d;
            vec3 p = position + normal * d;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vN = normalize(normalMatrix * normal);
            vView = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uLevel;
          varying vec3 vN; varying vec3 vView; varying float vDisp;
          void main() {
            float f = 1.0 - max(dot(normalize(vN), normalize(vView)), 0.0);
            float rim = pow(f, 2.2);
            float facing = pow(1.0 - f, 3.0);
            vec3 col = uColor * (rim * (0.9 + uLevel * 1.4) + 0.09) + vec3(0.85, 0.97, 1.0) * pow(1.0 - f, 8.0) * (0.04 + uLevel * 0.25);
            col += uColor * max(vDisp, 0.0) * 2.0 * rim;
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    tilt.add(core);
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: white, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    coreGlow.scale.setScalar(1.6);
    tilt.add(coreGlow);

    /* ---- particle shell ---- */
    const PN = full ? 1400 : 500;
    const pPos = new Float32Array(PN * 3);
    const pSeed = new Float32Array(PN);
    for (let i = 0; i < PN; i++) {
      // fibonacci sphere: an even, non-random distribution reads as engineered
      const y = 1 - (i / (PN - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * 2.399963;
      pPos.set([Math.cos(th) * r, y, Math.sin(th) * r], i * 3);
      pSeed[i] = Math.random();
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute("seed", new THREE.BufferAttribute(pSeed, 1));
    const shellU = { uTime: coreU.uTime, uLevel: coreU.uLevel, uColor: coreU.uColor, uBands: coreU.uBands, uPx: { value: pr * (full ? 1 : 0.8) } };
    const shell = new THREE.Points(
      pGeo,
      new THREE.ShaderMaterial({
        uniforms: shellU,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: /* glsl */ `
          ${NOISE3D}
          uniform float uTime, uLevel, uPx; uniform float uBands[${BANDS}];
          attribute float seed; varying float vA;
          void main() {
            float lat = acos(clamp(position.y, -1.0, 1.0)) / 3.14159;
            int bi = int(clamp(abs(lat - 0.5) * 2.0 * ${BANDS - 1}.0, 0.0, ${BANDS - 1}.0));
            float b = 0.0;
            for (int i = 0; i < ${BANDS}; i++) if (i == bi) b = uBands[i];
            float n = snoise(position * 2.3 + uTime * 0.3);
            float r = 1.22 + n * 0.05 + b * 0.55 + uLevel * 0.12;
            vec4 mv = modelViewMatrix * vec4(position * r, 1.0);
            vA = 0.06 + b * 0.3 + 0.35 * step(0.96, fract(seed + uTime * 0.15));
            gl_PointSize = uPx * (1.2 + b * 2.0) * (6.0 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; varying float vA;
          void main() {
            float d = length(gl_PointCoord - 0.5);
            if (d > 0.5) discard;
            gl_FragColor = vec4(mix(uColor, vec3(0.9, 0.98, 1.0), 0.35) * vA * smoothstep(0.5, 0.0, d), 1.0);
          }
        `,
      }),
    );
    tilt.add(shell);

    /* ---- flat instrument layers, each at its own depth ---- */
    const layer = (z: number) => {
      const g = new THREE.Group();
      g.position.z = z;
      tilt.add(g);
      return g;
    };

    // aperture blades
    const blades = layer(0.05);
    for (let k = 0; k < 6; k++) blades.add(arcMesh(1.0, 0.13, (k / 6) * Math.PI * 2, 0.78, tinted(1, 0.55), 48));
    // thin inner ring
    const inner = layer(0.12);
    inner.add(arcMesh(1.12, 0.012, 0, Math.PI * 2, tinted(1, 0.9)));

    // radial spectrum
    const SPEC = full ? 96 : 64;
    const blocks = (m: THREE.InstancedMesh, k = 1) => {
      mats.push({ m: m.material as THREE.MeshBasicMaterial, k });
      return m;
    };
    const spec = radialBlocks(SPEC, 1.62, 1, full ? 0.028 : 0.04, 0xffffff);
    (spec.material as THREE.MeshBasicMaterial).opacity = 0.95;
    const specL = layer(0);
    specL.add(spec);
    const specVal = new Float32Array(SPEC);
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), pv = new THREE.Vector3(), sv = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);

    // dashed ring and tick dial
    const ticksL = layer(-0.18);
    ticksL.add(blocks(radialBlocks(full ? 144 : 72, 2.18, 0.07, 0.014, 0xffffff), 0.55));
    ticksL.add(blocks(radialBlocks(full ? 24 : 12, 2.12, 0.15, 0.03, 0xffffff), 1));
    const dash = layer(0.22);
    dash.add(blocks(radialBlocks(60, 1.36, 0.04, 0.055, 0xffffff, { skip: (i) => i % 5 === 4 }), 0.7));

    // bracket arcs (counter-rotating), with heavy end caps
    const brackets = layer(0.32);
    for (let k = 0; k < 4; k++) {
      const a0 = k * (Math.PI / 2) + 0.2, len = k % 2 ? 0.8 : 1.05;
      brackets.add(arcMesh(1.95, 0.03, a0, len, tinted(1, 1)));
      brackets.add(arcMesh(1.95, 0.11, a0, 0.05, tinted(1, 1)));
      brackets.add(arcMesh(1.95, 0.11, a0 + len - 0.05, 0.05, tinted(1, 1)));
    }

    // scanner sweep for "thinking"
    const sweepMat = additive(colour.clone(), 0);
    mats.push({ m: sweepMat, k: 1 });
    const sweep = arcMesh(1.65, 0.62, 0, 0.7, sweepMat, 32);
    sweep.position.z = 0.02;
    tilt.add(sweep);

    // full detail: outer scale with ticks, segment meter, and side readouts
    let meter: THREE.InstancedMesh | null = null;
    const METER = 22;
    const meterLit = new THREE.Color(), meterDim = new THREE.Color();
    if (full) {
      const outer = layer(-0.5);
      outer.add(arcMesh(2.75, 0.012, Math.PI * 0.18, Math.PI * 0.64, tinted(0.7, 0.7)));
      outer.add(blocks(radialBlocks(13, 2.75, 0.14, 0.018, 0xffffff, { arc: Math.PI * 0.64, start: Math.PI * 0.18 }), 0.9));
      outer.add(blocks(radialBlocks(61, 2.75, 0.07, 0.01, 0xffffff, { arc: Math.PI * 0.64, start: Math.PI * 0.18 }), 0.5));
      outer.add(arcMesh(2.95, 0.05, Math.PI * 0.2, Math.PI * 0.1, tinted(1, 0.8)));
      const m = layer(-0.3);
      meter = radialBlocks(METER, 2.4, 0.26, 0.11, colour, { arc: 1.25, start: -0.62 });
      m.add(meter);
      const left = layer(-0.25);
      left.add(arcMesh(2.42, 0.02, Math.PI - 0.5, 1.0, tinted(0.6, 0.6)));
      left.add(blocks(radialBlocks(9, 2.5, 0.08, 0.05, 0xffffff, { arc: 0.8, start: Math.PI - 0.4 }), 0.8));
    }

    /* ---- animation ---- */
    const raw = new Float32Array(BANDS);
    const sm = new Float32Array(BANDS);
    let level = 0, t = 0, last = 0, raf = 0;
    const target = new THREE.Color();

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      if (canvas.offsetParent === null) return; // hidden by layout
      if (!reduced) t += dt;
      const { state: st, bands: b, voice: v } = live.current;
      const src = v ? v() : b;
      const gain = st === "speaking" ? 1 : st === "listening" ? 0.75 : 0;
      let sum = 0;
      for (let i = 0; i < BANDS; i++) {
        const x = src.length ? src[Math.floor((i / BANDS) * src.length)] ?? 0 : 0;
        raw[i] = Math.min(1, x * 2.0 * gain);
        sm[i] += (raw[i] - sm[i]) * (raw[i] > sm[i] ? 0.45 : 0.1);
        sum += sm[i];
        coreU.uBands.value[i] = sm[i];
      }
      let lv = sum / BANDS;
      if (st === "idle" || st === "connecting") lv = 0.06 + 0.04 * Math.sin(t * 1.5);
      if (st === "thinking") lv = 0.1 + 0.05 * Math.sin(t * 5);
      level += (lv - level) * (lv > level ? 0.3 : 0.07);
      const L = Math.min(1, level * 1.3);
      coreU.uTime.value = t;
      coreU.uLevel.value = L;

      target.setHex(HEX[st]);
      colour.lerp(target, Math.min(1, dt * 5));
      coreU.uColor.value.copy(colour);
      for (const { m, k } of mats) m.color?.copy(colour).multiplyScalar(k);
      (spec.material as THREE.MeshBasicMaterial).color.copy(colour);

      // spectrum bars: mirrored around the ring
      for (let i = 0; i < SPEC; i++) {
        const k = i < SPEC / 2 ? i : SPEC - 1 - i;
        const bi = Math.floor((k / (SPEC / 2)) * BANDS) % BANDS;
        const shimmer = 0.025 * (Math.sin(t * 6 + i * 0.8) + 1);
        specVal[i] += (sm[bi] + shimmer - specVal[i]) * 0.5;
        const a = (i / SPEC) * Math.PI * 2 + Math.PI / 2;
        pv.set(Math.cos(a) * 1.62, Math.sin(a) * 1.62, 0);
        q.setFromAxisAngle(Z, a - Math.PI / 2);
        sv.set(1, 0.04 + specVal[i] * 0.42, 1);
        mtx.compose(pv, q, sv);
        spec.setMatrixAt(i, mtx);
      }
      spec.instanceMatrix.needsUpdate = true;

      if (meter) {
        meterDim.copy(colour).multiplyScalar(0.12);
        meterLit.copy(colour).lerp(white, 0.25);
        for (let i = 0; i < METER; i++) meter.setColorAt(i, i / METER < L * 1.1 ? meterLit : meterDim);
        if (meter.instanceColor) meter.instanceColor.needsUpdate = true;
      }

      blades.rotation.z = -t * 0.35 + L * 0.8;
      blades.scale.setScalar(1 + L * 0.12);
      inner.rotation.z = t * 0.2;
      ticksL.rotation.z = t * 0.05;
      dash.rotation.z = t * 0.45;
      brackets.rotation.z = -t * (st === "connecting" ? 2.2 : 0.3);
      sweep.rotation.z = -t * 3.2;
      sweepMat.opacity += ((st === "thinking" ? 0.55 : 0) - sweepMat.opacity) * Math.min(1, dt * 6);
      shell.rotation.y = t * 0.12;
      core.rotation.y = t * 0.2;
      (coreGlow.material as THREE.SpriteMaterial).color.copy(colour).lerp(white, 0.55);
      coreGlow.scale.setScalar(0.55 + L * 0.9);
      (coreGlow.material as THREE.SpriteMaterial).opacity = 0.45 + L * 0.5;
      // the whole cluster sways a little in 3D so the depth reads
      rig.rotation.y = Math.sin(t * 0.35) * 0.18;
      rig.rotation.x = Math.cos(t * 0.27) * 0.08;

      stage.render(t);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      stage.dispose();
    };
  }, [size, full]);

  return (
    <canvas
      ref={ref}
      className={`orb orb-gl orb-${state}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Mechanic is ${state}`}
    />
  );
}
