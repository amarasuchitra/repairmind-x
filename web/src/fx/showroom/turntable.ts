import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { FxUniforms } from "./fx";

/**
 * A belt-drive record player modelled in code: plinth on isolation feet, a brushed deck, the platter with
 * strobe dots, mat and record, the sub-platter, drive belt and motor pulley underneath, a tonearm with
 * counterweight, headshell and cartridge, an arm rest with cue lever, speed buttons and a pitch slider.
 * The demo repair lifts the platter off to replace a worn belt.
 */

export interface DeckModel {
  root: THREE.Group;
  spin: THREE.Group; // platter, mat and record turn together
  platter: THREE.Group; // lifts off in the repair view
  arm: THREE.Group; // swings between rest and the record
  anchors: Record<string, THREE.Object3D>;
  highlight: THREE.MeshPhysicalMaterial; // the drive belt: glows when it is the part being worked on
  plinth: THREE.Mesh; // the cabinet, so a scene can give it a different finish
  accents: THREE.MeshBasicMaterial[];
}

function fxMaterial(params: THREE.MeshPhysicalMaterialParameters, fx: FxUniforms) {
  const m = new THREE.MeshPhysicalMaterial(params);
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, fx);
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFxW;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvFxW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vFxW;\nuniform float uScanY, uScanAmt, uXray, uTime;\nuniform vec3 uFxColor;")
      .replace(
        "#include <dithering_fragment>",
        /* glsl */ `#include <dithering_fragment>
        vec3 fxN = normalize(normal);
        float fxF = pow(1.0 - abs(dot(fxN, normalize(vViewPosition))), 2.2);
        float lines = smoothstep(0.92, 1.0, abs(fract((vFxW.x + vFxW.z) * 9.0) * 2.0 - 1.0)) * 0.3;
        vec3 xray = uFxColor * (0.035 + fxF * 1.15 + lines * (0.2 + fxF));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, xray, uXray);
        float d = vFxW.x - uScanY;
        float band = exp(-d * d * 260.0) * 1.3 + exp(-max(-d, 0.0) * 3.0) * step(d, 0.0) * 0.14;
        gl_FragColor.rgb += uFxColor * band * uScanAmt;`,
      );
  };
  return m;
}

/** Concentric groove texture for the record, with a printed centre label. */
function recordTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const g = c.getContext("2d")!;
  g.fillStyle = "#07090d";
  g.fillRect(0, 0, 1024, 1024);
  for (let r = 175; r < 505; r += 1.6) {
    const a = 0.05 + 0.05 * Math.sin(r * 0.37) + (r % 61 < 3 ? 0.12 : 0);
    g.strokeStyle = `rgba(150,170,200,${a})`;
    g.lineWidth = 0.7;
    g.beginPath();
    g.arc(512, 512, r, 0, Math.PI * 2);
    g.stroke();
  }
  // run-out gaps between tracks
  for (const r of [260, 330, 410]) {
    g.strokeStyle = "rgba(0,0,0,0.9)";
    g.lineWidth = 5;
    g.beginPath();
    g.arc(512, 512, r, 0, Math.PI * 2);
    g.stroke();
  }
  const lab = g.createRadialGradient(512, 512, 10, 512, 512, 165);
  lab.addColorStop(0, "#0f3b66");
  lab.addColorStop(1, "#0a2240");
  g.fillStyle = lab;
  g.beginPath();
  g.arc(512, 512, 165, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(70,226,255,0.8)";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(512, 512, 150, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "rgba(200,235,255,0.85)";
  g.font = "600 30px sans-serif";
  g.textAlign = "center";
  g.fillText("SIDE A  ·  33⅓", 512, 450);
  g.fillRect(452, 580, 120, 3);
  g.fillRect(472, 600, 80, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Fine radial brushing for the aluminium deck. */
function brushedTexture() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#808080";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2600; i++) {
    const y = Math.random() * 512;
    g.strokeStyle = `rgba(${Math.random() < 0.5 ? "255,255,255" : "0,0,0"},${0.03 + Math.random() * 0.05})`;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(512, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const anchor = (parent: THREE.Object3D, name: string, x: number, y: number, z: number, out: Record<string, THREE.Object3D>) => {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  out[name] = o;
  return o;
};

export const DECK = { w: 4.4, d: 3.3, h: 0.46, platter: new THREE.Vector3(-0.55, 0, 0.05), pulley: new THREE.Vector3(-1.62, 0, -0.98) };

export function buildDeck(fx: FxUniforms): DeckModel {
  const anchors: Record<string, THREE.Object3D> = {};
  const root = new THREE.Group();
  const TOP = DECK.h;

  const plinthMat = fxMaterial({ color: 0x0e131c, metalness: 0.35, roughness: 0.42, clearcoat: 0.8, clearcoatRoughness: 0.2 }, fx);
  const deckMat = fxMaterial({ color: 0x3e4757, metalness: 0.85, roughness: 0.55, roughnessMap: brushedTexture() }, fx);
  const chrome = fxMaterial({ color: 0xd2dbe8, metalness: 1, roughness: 0.16 }, fx);
  const alu = fxMaterial({ color: 0x8994a6, metalness: 0.9, roughness: 0.42 }, fx);
  const black = fxMaterial({ color: 0x10141b, metalness: 0.3, roughness: 0.5 }, fx);
  const rubber = fxMaterial({ color: 0x0b0d11, metalness: 0, roughness: 0.92 }, fx);
  const vinyl = fxMaterial({ map: recordTexture(), metalness: 0.2, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 }, fx);
  const highlight = fxMaterial({ color: 0x1a1f28, metalness: 0.1, roughness: 0.6, emissive: new THREE.Color(0x46e2ff), emissiveIntensity: 0 }, fx);
  const accent = new THREE.MeshBasicMaterial({ color: 0x46e2ff, toneMapped: false });
  const accentSoft = new THREE.MeshBasicMaterial({ color: 0x46e2ff, toneMapped: false, transparent: true, opacity: 0.5 });
  const amber = new THREE.MeshBasicMaterial({ color: 0xffb648, toneMapped: false });

  /* plinth, deck plate, feet */
  const plinth = new THREE.Mesh(new RoundedBoxGeometry(DECK.w, DECK.h - 0.1, DECK.d, 6, 0.08), plinthMat);
  plinth.position.y = 0.1 + (DECK.h - 0.1) / 2;
  root.add(plinth);
  const deck = new THREE.Mesh(new RoundedBoxGeometry(DECK.w - 0.12, 0.03, DECK.d - 0.12, 4, 0.012), deckMat);
  deck.position.y = TOP + 0.0;
  root.add(deck);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(DECK.w - 0.3, 0.008, 0.008), accentSoft);
  trim.position.set(0, 0.33, DECK.d / 2 + 0.001);
  root.add(trim);
  for (const [x, z] of [[-1.9, -1.35], [1.9, -1.35], [-1.9, 1.35], [1.9, 1.35]]) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.1, 40), rubber);
    foot.position.set(x, 0.05, z);
    root.add(foot);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.03, 40), chrome);
    ring.position.set(x, 0.1, z);
    root.add(ring);
  }
  // dust-cover hinges at the back
  for (const x of [-1.3, 1.3]) {
    const h = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.14, 0.12, 2, 0.03), black);
    h.position.set(x, TOP + 0.05, -DECK.d / 2 + 0.02);
    root.add(h);
  }

  /* drive: sub-platter, belt, motor pulley (hidden under the platter until it lifts) */
  const P0 = DECK.platter, PU = DECK.pulley;
  const sub = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 0.14, 72), black);
  sub.position.set(P0.x, TOP + 0.08, P0.z);
  root.add(sub);
  const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 40), chrome);
  bearing.position.set(P0.x, TOP + 0.03, P0.z);
  root.add(bearing);
  const pulley = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.14, 32), chrome);
  pulley.position.set(PU.x, TOP + 0.08, PU.z);
  root.add(pulley);
  const pulleyCap = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.02, 32), black);
  pulleyCap.position.set(PU.x, TOP + 0.015, PU.z);
  root.add(pulleyCap);
  // belt: a closed loop hugging the sub-platter and the pulley
  const loop: THREE.Vector3[] = [];
  const toP = new THREE.Vector2(PU.x - P0.x, PU.z - P0.z);
  const ang = Math.atan2(toP.y, toP.x);
  const dist = toP.length();
  const tangent = Math.acos((0.585 - 0.08) / dist);
  for (let i = 0; i <= 40; i++) {
    const a = ang + tangent + (i / 40) * (Math.PI * 2 - tangent * 2);
    loop.push(new THREE.Vector3(P0.x + Math.cos(a) * 0.585, TOP + 0.09, P0.z + Math.sin(a) * 0.585));
  }
  for (let i = 0; i <= 16; i++) {
    const a = ang - tangent + (i / 16) * tangent * 2;
    loop.push(new THREE.Vector3(PU.x + Math.cos(a) * 0.08, TOP + 0.09, PU.z + Math.sin(a) * 0.08));
  }
  const belt = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(loop, true, "centripetal"), 220, 0.014, 8, true), highlight);
  belt.scale.set(1, 0.6, 1);
  belt.position.y = (TOP + 0.09) * 0.4;
  root.add(belt);
  anchor(root, "belt", P0.x + Math.cos(ang + Math.PI) * 0.585, TOP + 0.09, P0.z + Math.sin(ang + Math.PI) * 0.585, anchors);
  anchor(root, "pulley", PU.x, TOP + 0.16, PU.z, anchors);

  /* platter, mat and record: spin together, lift together */
  const platter = new THREE.Group();
  platter.position.set(P0.x, TOP + 0.16, P0.z);
  root.add(platter);
  const spin = new THREE.Group();
  platter.add(spin);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.48, 0.16, 128), alu);
  spin.add(disc);
  // strobe dots round the rim
  const dotGeo = new THREE.BoxGeometry(0.035, 0.05, 0.012);
  const dots = new THREE.InstancedMesh(dotGeo, black, 180);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 180; i++) {
    const a = (i / 180) * Math.PI * 2;
    m4.makeRotationY(-a).setPosition(Math.cos(a) * 1.502, 0, Math.sin(a) * 1.502);
    dots.setMatrixAt(i, m4);
  }
  spin.add(dots);
  const mat = new THREE.Mesh(new THREE.CylinderGeometry(1.44, 1.44, 0.025, 128), rubber);
  mat.position.y = 0.092;
  spin.add(mat);
  const record = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.014, 160), [black, vinyl, black]);
  record.position.y = 0.112;
  spin.add(record);
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.16, 16), chrome);
  spindle.position.y = 0.17;
  spin.add(spindle);
  anchor(platter, "platter", 1.35, 0.06, 0.55, anchors);
  anchor(platter, "record", -0.55, 0.13, 0.75, anchors);

  /* tonearm */
  const ARM = new THREE.Vector3(1.38, TOP, -0.92);
  const armBase = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.08, 64), black);
  armBase.position.set(ARM.x, TOP + 0.04, ARM.z);
  root.add(armBase);
  const armRing = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.006, 6, 96), accent);
  armRing.rotation.x = Math.PI / 2;
  armRing.position.set(ARM.x, TOP + 0.08, ARM.z);
  root.add(armRing);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.32, 40), chrome);
  pillar.position.set(ARM.x, TOP + 0.24, ARM.z);
  root.add(pillar);
  const arm = new THREE.Group();
  arm.position.set(ARM.x, TOP + 0.42, ARM.z);
  root.add(arm);
  const gimbal = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 32), black);
  gimbal.rotation.x = Math.PI / 2;
  arm.add(gimbal);
  // arm tube points along local -z, toward the record
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.05, 20), chrome);
  tube.rotation.x = Math.PI / 2;
  tube.position.z = 1.02;
  arm.add(tube);
  const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 20), chrome);
  stub.rotation.x = Math.PI / 2;
  stub.position.z = -0.25;
  arm.add(stub);
  const weight = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.2, 40), black);
  weight.rotation.x = Math.PI / 2;
  weight.position.z = -0.42;
  arm.add(weight);
  const weightRing = new THREE.Mesh(new THREE.TorusGeometry(0.131, 0.005, 6, 64), accentSoft);
  weightRing.position.z = -0.36;
  arm.add(weightRing);
  const head = new THREE.Group();
  head.position.set(0, -0.07, 2.08);
  head.rotation.y = 0.38;
  arm.add(head);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.14, 0.03, 0.3, 2, 0.01), black);
  head.add(shell);
  const cart = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.07, 0.16, 2, 0.01), alu);
  cart.position.set(0, -0.05, 0.03);
  head.add(cart);
  const lift = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.008, 0.02), chrome);
  lift.position.set(0.09, 0, 0.12);
  head.add(lift);
  anchor(head, "cartridge", 0, -0.04, 0.05, anchors);
  anchor(arm, "tonearm", 0, 0.04, 0.6, anchors);
  // arm rest and cue lever
  const rest = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.34, 16), chrome);
  rest.position.set(ARM.x + 0.08, TOP + 0.17, ARM.z + 1.55);
  root.add(rest);
  const restCup = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.05, 0.1, 2, 0.015), black);
  restCup.position.set(ARM.x + 0.08, TOP + 0.35, ARM.z + 1.55);
  root.add(restCup);
  const cue = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.1, 0.24, 2, 0.02), black);
  cue.position.set(ARM.x + 0.38, TOP + 0.05, ARM.z + 0.2);
  root.add(cue);

  /* controls: speed buttons, power, pitch slider, LED */
  const FRONT = DECK.d / 2 - 0.36;
  [-1.85, -1.5].forEach((x, i) => {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 40), alu);
    b.position.set(x, TOP + 0.04, FRONT);
    root.add(b);
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.018, 16), i === 0 ? accent : accentSoft);
    led.rotation.x = -Math.PI / 2;
    led.position.set(x, TOP + 0.02, FRONT - 0.18);
    root.add(led);
  });
  const power = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.17, 0.12, 48), alu);
  power.position.set(-1.9 + 0.02, TOP + 0.07, -1.25);
  root.add(power);
  const powerLed = new THREE.Mesh(new THREE.CircleGeometry(0.022, 16), amber);
  powerLed.rotation.x = -Math.PI / 2;
  powerLed.position.set(-1.6, TOP + 0.02, -1.25);
  root.add(powerLed);
  const slot = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.02, 0.8, 2, 0.01), black);
  slot.position.set(1.9, TOP + 0.015, 0.75);
  root.add(slot);
  const slider = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.08, 0.1, 2, 0.02), alu);
  slider.position.set(1.9, TOP + 0.05, 0.75);
  root.add(slider);
  anchor(root, "speed", -1.68, TOP + 0.06, FRONT, anchors);
  anchor(root, "model", 0.3, TOP + 0.55, -1.1, anchors);

  return { root, spin, platter, arm, anchors, highlight, plinth, accents: [accent, accentSoft, amber] };
}
