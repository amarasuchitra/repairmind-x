import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * A desk fan modelled in code: weighted base, stem, motor housing, three pitched blades, a blade cap
 * (the part the demo repair unscrews) and domed wire guards. Every surface material shares one set of
 * "scan" uniforms so the whole model can be swept by the identification scan or turned into an x-ray.
 */

export interface FxUniforms {
  uScanY: { value: number };
  uScanAmt: { value: number };
  uXray: { value: number };
  uFxColor: { value: THREE.Color };
  uTime: { value: number };
}

export function makeFxUniforms(): FxUniforms {
  return {
    uScanY: { value: -10 },
    uScanAmt: { value: 0 },
    uXray: { value: 0 },
    uFxColor: { value: new THREE.Color(0x46e2ff) },
    uTime: { value: 0 },
  };
}

/** Physical material with the scan band and x-ray look injected into the shader. */
function fxMaterial(params: THREE.MeshPhysicalMaterialParameters, fx: FxUniforms) {
  const m = new THREE.MeshPhysicalMaterial(params);
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, fx);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFxW;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFxW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vFxW;\nuniform float uScanY, uScanAmt, uXray, uTime;\nuniform vec3 uFxColor;",
      )
      .replace(
        "#include <dithering_fragment>",
        /* glsl */ `#include <dithering_fragment>
        vec3 fxN = normalize(normal);
        float fxF = pow(1.0 - abs(dot(fxN, normalize(vViewPosition))), 2.2);
        // x-ray: surfaces become a dark glass with a bright rim, plus fine horizontal survey lines
        float lines = smoothstep(0.92, 1.0, abs(fract(vFxW.y * 18.0) * 2.0 - 1.0)) * 0.35;
        vec3 xray = uFxColor * (0.035 + fxF * 1.15 + lines * (0.2 + fxF));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, xray, uXray);
        // scan band: a bright sheet with a soft trailing wash below it
        float d = vFxW.y - uScanY;
        float band = exp(-d * d * 1600.0) * 1.3 + exp(-max(-d, 0.0) * 7.0) * step(d, 0.0) * 0.18;
        gl_FragColor.rgb += uFxColor * band * uScanAmt;`,
      );
  };
  return m;
}

export interface FanModel {
  root: THREE.Group;
  head: THREE.Group;
  bladeSpin: THREE.Group;
  parts: {
    frontGuard: THREE.Group;
    cap: THREE.Group;
    blades: THREE.Group;
    rearGuard: THREE.Group;
    motor: THREE.Group;
  };
  /** named points for screen labels */
  anchors: Record<string, THREE.Object3D>;
  capMaterial: THREE.MeshPhysicalMaterial;
  bladeMaterial: THREE.MeshPhysicalMaterial;
  accents: THREE.MeshBasicMaterial[];
}

const anchor = (parent: THREE.Object3D, name: string, x: number, y: number, z: number, out: Record<string, THREE.Object3D>) => {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  out[name] = o;
  return o;
};

/** A curved wire as a tube; merged later so a whole guard is one draw call. */
function wire(points: THREE.Vector3[], r: number, seg = 24) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, seg, r, 5, false);
}

function guard(radius: number, depth: number, rings: number[], spokes: number, wireR: number, front: boolean) {
  const geos: THREE.BufferGeometry[] = [];
  const dir = front ? 1 : -1;
  // dome profile: z grows toward the centre
  const zAt = (r: number) => dir * depth * (1 - Math.pow(r / radius, 2));
  for (const rr of rings) {
    const t = new THREE.TorusGeometry(rr, wireR, 5, 96);
    t.translate(0, 0, zAt(rr));
    geos.push(t);
  }
  const hubR = front ? 0.24 : 0.46;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 8; k++) {
      const r = hubR + (radius - hubR) * (k / 8);
      // the front guard's wires sweep slightly, which reads as a real moulded grille
      const twist = front ? (k / 8) * 0.22 : 0;
      pts.push(new THREE.Vector3(Math.cos(a + twist) * r, Math.sin(a + twist) * r, zAt(r)));
    }
    geos.push(wire(pts, wireR, 16));
  }
  return mergeGeometries(geos)!;
}

function bladeShape() {
  const s = new THREE.Shape();
  s.moveTo(0.16, -0.1);
  s.bezierCurveTo(0.42, -0.34, 0.98, -0.42, 1.1, -0.12);
  s.bezierCurveTo(1.16, 0.08, 0.92, 0.3, 0.6, 0.3);
  s.bezierCurveTo(0.36, 0.3, 0.2, 0.18, 0.16, 0.1);
  s.closePath();
  return s;
}

export function buildFan(fx: FxUniforms): FanModel {
  const anchors: Record<string, THREE.Object3D> = {};
  const root = new THREE.Group();

  const graphite = fxMaterial({ color: 0x1a2130, metalness: 0.6, roughness: 0.34, clearcoat: 0.7, clearcoatRoughness: 0.18, side: THREE.DoubleSide }, fx);
  const satin = fxMaterial({ color: 0x0d1119, metalness: 0.35, roughness: 0.52, clearcoat: 0.4, clearcoatRoughness: 0.4, side: THREE.DoubleSide }, fx);
  const chrome = fxMaterial({ color: 0xb9c6d8, metalness: 1, roughness: 0.22 }, fx);
  const wireMat = fxMaterial({ color: 0x8e9bb0, metalness: 0.95, roughness: 0.3 }, fx);
  const bladeMaterial = fxMaterial({ color: 0x223049, metalness: 0.25, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, side: THREE.DoubleSide }, fx);
  const capMaterial = fxMaterial({ color: 0x1d2536, metalness: 0.7, roughness: 0.28, clearcoat: 1, emissive: new THREE.Color(0x46e2ff), emissiveIntensity: 0, side: THREE.DoubleSide }, fx);
  const accent = new THREE.MeshBasicMaterial({ color: 0x46e2ff, toneMapped: false });
  const accentSoft = new THREE.MeshBasicMaterial({ color: 0x46e2ff, toneMapped: false, transparent: true, opacity: 0.55 });

  /* base */
  const baseProfile = [
    [0, 0], [1.12, 0], [1.19, 0.02], [1.21, 0.07], [1.18, 0.15], [1.04, 0.21], [0.42, 0.25], [0, 0.26],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const baseMat = fxMaterial({ color: 0x141a26, metalness: 0.5, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.45, side: THREE.DoubleSide }, fx);
  const base = new THREE.Mesh(new THREE.LatheGeometry(baseProfile, 96), baseMat);
  root.add(base);
  const baseTrim = new THREE.Mesh(new THREE.TorusGeometry(1.205, 0.006, 6, 160), accentSoft);
  baseTrim.rotation.x = Math.PI / 2;
  baseTrim.position.y = 0.075;
  root.add(baseTrim);
  // speed buttons on the front slope
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.075, 0.05, 32), satin);
    const a = -0.32 + i * 0.32;
    b.position.set(Math.sin(a) * 0.78, 0.235, Math.cos(a) * 0.78);
    b.rotation.x = 0.12;
    root.add(b);
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.016, 16), i === 1 ? accent : accentSoft);
    led.position.set(Math.sin(a) * 0.9, 0.205, Math.cos(a) * 0.9);
    led.rotation.x = -Math.PI / 2 + 0.35;
    root.add(led);
  }
  anchor(root, "base", 0, 0.2, 0.9, anchors);

  /* stem */
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 1.72, 40), chrome);
  stem.position.y = 0.26 + 0.86;
  root.add(stem);
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 40), graphite);
  collar.position.y = 1.32;
  root.add(collar);
  const collarRing = new THREE.Mesh(new THREE.TorusGeometry(0.131, 0.006, 6, 64), accent);
  collarRing.rotation.x = Math.PI / 2;
  collarRing.position.y = 1.36;
  root.add(collarRing);

  /* head */
  const head = new THREE.Group();
  head.position.set(0, 2.3, 0);
  head.rotation.x = -0.1;
  root.add(head);
  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.28, 8, 24), graphite);
  neck.position.set(0, -0.3, -0.5);
  head.add(neck);

  const motor = new THREE.Group();
  head.add(motor);
  const motorProfile = [
    [0, -0.98], [0.2, -0.97], [0.34, -0.92], [0.42, -0.8], [0.45, -0.6], [0.44, -0.4], [0.38, -0.26], [0.22, -0.2], [0, -0.2],
  ].map(([r, z]) => new THREE.Vector2(r, z));
  const motorGeo = new THREE.LatheGeometry(motorProfile, 96);
  motorGeo.rotateX(Math.PI / 2);
  const motorMesh = new THREE.Mesh(motorGeo, graphite);
  motor.add(motorMesh);
  // vent ribs around the motor
  for (let i = 0; i < 4; i++) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.452 - i * 0.004, 0.008, 6, 96), satin);
    rib.position.z = -0.48 - i * 0.07;
    motor.add(rib);
  }
  const motorLight = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 6, 96), accent);
  motorLight.position.z = -0.975;
  motor.add(motorLight);
  anchor(motor, "motor", 0, 0.46, -0.62, anchors);

  /* rear guard */
  const rearGuard = new THREE.Group();
  head.add(rearGuard);
  const rg = new THREE.Mesh(guard(1.28, 0.26, [0.55, 0.78, 1.0, 1.18], 28, 0.007, false), wireMat);
  rg.position.z = -0.16;
  rearGuard.add(rg);
  const rearRim = new THREE.Mesh(new THREE.TorusGeometry(1.28, 0.028, 10, 160), graphite);
  rearRim.position.z = -0.16;
  rearGuard.add(rearRim);

  /* blades and cap spin together */
  const bladeSpin = new THREE.Group();
  head.add(bladeSpin);
  const blades = new THREE.Group();
  bladeSpin.add(blades);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.24, 0.2, 48), satin);
  hub.rotation.x = Math.PI / 2;
  blades.add(hub);
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape(), { depth: 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.008, bevelSegments: 2, curveSegments: 32 });
  bladeGeo.rotateX(0.42); // pitch
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(bladeGeo, bladeMaterial);
    b.rotation.z = (i / 3) * Math.PI * 2;
    blades.add(b);
  }
  anchor(blades, "blade", 0.78, 0.22, 0.02, anchors);

  const cap = new THREE.Group();
  cap.position.z = 0.1;
  bladeSpin.add(cap);
  const capProfile = [[0, 0.17], [0.09, 0.16], [0.15, 0.12], [0.175, 0.05], [0.18, 0], [0, 0]].map(([r, z]) => new THREE.Vector2(r, z));
  const capGeo = new THREE.LatheGeometry(capProfile, 64);
  capGeo.rotateX(Math.PI / 2);
  cap.add(new THREE.Mesh(capGeo, capMaterial));
  // knurled grip
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.178, 0.012, 6, 48), chrome);
  grip.position.z = 0.03;
  cap.add(grip);
  const capDot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), accent);
  capDot.position.z = 0.172;
  cap.add(capDot);
  anchor(cap, "cap", 0, 0, 0.1, anchors);

  /* front guard */
  const frontGuard = new THREE.Group();
  frontGuard.position.z = 0.16;
  head.add(frontGuard);
  frontGuard.add(new THREE.Mesh(guard(1.28, 0.34, [0.42, 0.68, 0.92, 1.12], 40, 0.0065, true), wireMat));
  frontGuard.add(new THREE.Mesh(new THREE.TorusGeometry(1.28, 0.032, 10, 160), graphite));
  const frontTrim = new THREE.Mesh(new THREE.TorusGeometry(1.282, 0.005, 6, 200), accentSoft);
  frontTrim.position.z = 0.03;
  frontGuard.add(frontTrim);
  const badge = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.035, 64), graphite);
  badge.rotation.x = Math.PI / 2;
  badge.position.z = 0.34;
  frontGuard.add(badge);
  const badgeRing = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.185, 96), accent);
  badgeRing.position.z = 0.359;
  frontGuard.add(badgeRing);
  // guard clips
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.11), satin);
    clip.position.set(Math.cos(a) * 1.29, Math.sin(a) * 1.29, -0.02);
    clip.rotation.z = a;
    frontGuard.add(clip);
  }
  anchor(frontGuard, "clip", Math.cos(Math.PI / 4) * 1.3, Math.sin(Math.PI / 4) * 1.3, 0, anchors);
  anchor(frontGuard, "guard", -0.9, 0.9, 0.1, anchors);
  anchor(head, "model", 0, 1.32, 0, anchors);

  return {
    root, head, bladeSpin,
    parts: { frontGuard, cap, blades, rearGuard, motor },
    anchors, capMaterial, bladeMaterial,
    accents: [accent, accentSoft],
  };
}
