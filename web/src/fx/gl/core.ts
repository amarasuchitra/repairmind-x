import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";

/**
 * Shared rendering pipeline for every WebGL piece: scene -> bloom -> output (sRGB) -> grade.
 * The grade pass adds the "lens": navy-lifted blacks, a gentle tone curve, vignette, a touch of
 * chromatic aberration at the edges, and animated film grain.
 */
export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  resize: (w: number, h: number) => void;
  render: (time: number) => void;
  setPixelRatio: (r: number) => void;
  dispose: () => void;
}

export interface StageOptions {
  canvas: HTMLCanvasElement;
  fov?: number;
  pixelRatio?: number;
  bloom?: { strength: number; radius: number; threshold: number };
  grade?: { vignette?: number; grain?: number; aberration?: number; lift?: [number, number, number] };
  transparent?: boolean;
  /** Per-mip bloom weights, small blur first. Lower tail weights keep glow tight instead of hazy. */
  bloomFactors?: [number, number, number, number, number];
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.9 },
    uGrain: { value: 0.06 },
    uAberration: { value: 0.0015 },
    uLift: { value: new THREE.Vector3(0.004, 0.012, 0.035) },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uAberration;
    uniform vec3 uLift;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * uAberration * (1.0 + r2 * 4.0);
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, base.g, texture2D(tDiffuse, vUv - off).b);
      // tone: soft shoulder so bloom cores roll off instead of clipping flat
      col = col / (1.0 + max(col - 0.85, 0.0) * 0.9);
      // lift the blacks toward deep navy, like a graded film
      col = col + uLift * (1.0 - col);
      // vignette
      col *= mix(1.0, smoothstep(0.85, 0.15, r2 * 2.2), uVignette);
      // grain, luminance-weighted so it lives in the shadows and mids
      float g = hash(vUv * uRes + fract(uTime * 13.7) * 91.0) - 0.5;
      col += g * uGrain * (0.6 + 0.4 * (1.0 - dot(col, vec3(0.333))));
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export function createStage(o: StageOptions): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas: o.canvas,
    antialias: false,
    alpha: !!o.transparent,
    powerPreference: "high-performance",
    premultipliedAlpha: false,
  });
  renderer.setClearColor(0x000000, o.transparent ? 0 : 1);
  let pr = o.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pr);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(o.fov ?? 45, 1, 0.1, 200);
  camera.position.set(0, 0, 10);

  const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 0 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const b = o.bloom ?? { strength: 1.3, radius: 0.55, threshold: 0.05 };
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), b.strength, b.radius, b.threshold);
  if (o.bloomFactors) (bloom as unknown as { compositeMaterial: THREE.ShaderMaterial }).compositeMaterial.uniforms.bloomFactors.value = o.bloomFactors;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  if (o.grade?.vignette !== undefined) grade.uniforms.uVignette.value = o.grade.vignette;
  if (o.grade?.grain !== undefined) grade.uniforms.uGrain.value = o.grade.grain;
  if (o.grade?.aberration !== undefined) grade.uniforms.uAberration.value = o.grade.aberration;
  if (o.grade?.lift) grade.uniforms.uLift.value.set(...o.grade.lift);
  composer.addPass(grade);

  let W = 1, H = 1;
  const resize = (w: number, h: number) => {
    W = Math.max(1, w);
    H = Math.max(1, h);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(pr);
    composer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    grade.uniforms.uRes.value.set(W * pr, H * pr);
  };

  return {
    renderer, scene, camera, composer, bloom, grade, resize,
    render: (time: number) => {
      grade.uniforms.uTime.value = time;
      composer.render();
    },
    setPixelRatio: (r: number) => {
      pr = r;
      renderer.setPixelRatio(r);
      resize(W, H);
    },
    dispose: () => {
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      composer.dispose();
      target.dispose();
      renderer.dispose();
    },
  };
}

/** Frame-time watchdog: calls onSlow once if the average frame takes longer than budget. */
export function perfGuard(budgetMs: number, onSlow: () => void) {
  let n = 0, sum = 0, fired = false, last = 0;
  return (now: number) => {
    if (fired) return;
    if (last) {
      const dt = now - last;
      if (dt < 200) { sum += dt; n++; }
    }
    last = now;
    if (n >= 90) {
      if (sum / n > budgetMs) { fired = true; onSlow(); }
      n = 0; sum = 0;
    }
  };
}

/* -------------------------------------------------------------------------------- glow ribbons */

/**
 * A polyline as camera-facing-in-plane quads with a soft core profile. `uProgress` draws it in along
 * its length with a hot leading edge, which is what makes traces look like current flowing.
 */
export function ribbonGeometry(pts: THREE.Vector2[], width: number): THREE.BufferGeometry {
  const pos: number[] = [], side: number[] = [], along: number[] = [], idx: number[] = [];
  let total = 0;
  const lens = [0];
  for (let i = 1; i < pts.length; i++) {
    total += pts[i].distanceTo(pts[i - 1]);
    lens.push(total);
  }
  const ext = width * 0.5;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = new THREE.Vector2().subVectors(b, a).normalize();
    const n = new THREE.Vector2(-d.y, d.x).multiplyScalar(width * 0.5);
    const a2 = a.clone().addScaledVector(d, -ext), b2 = b.clone().addScaledVector(d, ext);
    const la = (lens[i - 1] - ext) / total, lb = (lens[i] + ext) / total;
    const base = pos.length / 3;
    pos.push(a2.x + n.x, a2.y + n.y, 0, a2.x - n.x, a2.y - n.y, 0, b2.x + n.x, b2.y + n.y, 0, b2.x - n.x, b2.y - n.y, 0);
    side.push(1, -1, 1, -1);
    along.push(la, la, lb, lb);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("side", new THREE.Float32BufferAttribute(side, 1));
  g.setAttribute("along", new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  return g;
}

export function ribbonMaterial(core: THREE.ColorRepresentation, edge: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uProgress: { value: 1 },
      uOpacity: { value: 1 },
      uCore: { value: new THREE.Color(core) },
      uEdge: { value: new THREE.Color(edge) },
      uHead: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float side; attribute float along;
      varying float vSide; varying float vAlong;
      void main() { vSide = side; vAlong = along; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform float uProgress, uOpacity, uHead; uniform vec3 uCore, uEdge;
      varying float vSide; varying float vAlong;
      void main() {
        if (vAlong > uProgress) discard;
        float x = 1.0 - abs(vSide);
        float core = smoothstep(0.55, 1.0, x);
        float body = smoothstep(0.0, 0.6, x);
        vec3 col = uEdge * body * 0.55 + uCore * core * 1.5;
        float head = exp(-(uProgress - vAlong) * 30.0) * uHead * step(uProgress, 0.999);
        col += uCore * head * 2.5 * x;
        gl_FragColor = vec4(col * uOpacity, 1.0);
      }
    `,
  });
}

/** Soft radial sprite texture (for halos and flares), generated once. */
let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.15, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.45, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Thin arc as a flat ring segment. */
export function arcMesh(r: number, w: number, a0: number, len: number, mat: THREE.Material, seg = 96): THREE.Mesh {
  return new THREE.Mesh(new THREE.RingGeometry(r - w / 2, r + w / 2, Math.max(8, Math.round(seg * (len / (Math.PI * 2)))), 1, a0, len), mat);
}

export function additive(color: THREE.ColorRepresentation, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

/**
 * N short radial blocks around a circle as one InstancedMesh (ticks, segment meters).
 * Per-instance colour lets a meter light segment by segment.
 */
export function radialBlocks(
  n: number, r: number, len: number, w: number, color: THREE.ColorRepresentation, opts: { skip?: (i: number) => boolean; arc?: number; start?: number } = {},
): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(w, len);
  geo.translate(0, len / 2, 0);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const col = new THREE.Color(color);
  const arc = opts.arc ?? Math.PI * 2, start = opts.start ?? 0;
  for (let i = 0; i < n; i++) {
    const a = start + (arc * i) / (arc >= Math.PI * 2 ? n : Math.max(1, n - 1));
    p.set(Math.cos(a) * r, Math.sin(a) * r, 0);
    q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a - Math.PI / 2);
    s.set(1, opts.skip?.(i) ? 0 : 1, 1);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * One shader for every circular HUD element: solid arcs, dashed rings, tick rings and segmented
 * meters. `uSweep` (0..1) draws it on around the circle, `uDash`/`uDuty` cut it into segments.
 */
export function ringMaterial(color: THREE.ColorRepresentation, o: { dash?: number; duty?: number; opacity?: number; start?: number; arc?: number } = {}) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: o.opacity ?? 1 },
      uSweep: { value: 1 },
      uStart: { value: o.start ?? 0 },
      uArc: { value: o.arc ?? 1 },
      uDash: { value: o.dash ?? 0 },
      uDuty: { value: o.duty ?? 0.5 },
      uInner: { value: 0 },
      uOuter: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity, uSweep, uStart, uArc, uDash, uDuty, uInner, uOuter;
      varying vec2 vP;
      void main() {
        float a = fract(atan(vP.y, vP.x) / 6.2831853 - uStart);
        if (a > uArc * uSweep) discard;
        if (uDash > 0.0 && fract(a / uArc * uDash) > uDuty) discard;
        float r = length(vP);
        float edge = 1.0 - abs((r - uInner) / max(uOuter - uInner, 1e-4) * 2.0 - 1.0);
        float soft = smoothstep(0.0, 0.35, edge);
        float head = exp(-(uArc * uSweep - a) * 40.0) * step(uSweep, 0.999);
        gl_FragColor = vec4(uColor * uOpacity * (0.75 + 0.25 * soft + head * 2.0), 1.0);
      }
    `,
  });
}

export function ringMesh(r: number, w: number, mat: THREE.ShaderMaterial, seg = 128): THREE.Mesh {
  mat.uniforms.uInner.value = r - w / 2;
  mat.uniforms.uOuter.value = r + w / 2;
  return new THREE.Mesh(new THREE.RingGeometry(r - w / 2, r + w / 2, seg, 1), mat);
}
