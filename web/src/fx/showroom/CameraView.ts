import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createStage, perfGuard, type Stage } from "../gl/core";
import { buildDeck, type DeckModel } from "./turntable";
import { makeFxUniforms } from "./fx";

/**
 * A stand-in for the phone camera on the #demo call screen: the same record player as the start page,
 * rendered as a real scene rather than a drawing. It sits on an oak desk under a warm lamp, mid-repair,
 * with the platter lifted off and set down beside it so the belt and motor pulley show. The camera is
 * handheld: it breathes and drifts a little, with a touch of sensor noise. The motor pulley's position on
 * screen is reported every frame so the AR marker can follow it.
 */

function woodTexture(base: string, dark: string, w = 1024, h = 1024, rings = 46) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  // long grain lines that wander a little, with darker latewood bands
  for (let i = 0; i < rings * 6; i++) {
    const y0 = (i / (rings * 6)) * h + (Math.random() - 0.5) * 6;
    const band = i % 6 === 0;
    g.strokeStyle = band ? dark : `rgba(0,0,0,${0.03 + Math.random() * 0.05})`;
    g.globalAlpha = band ? 0.22 + Math.random() * 0.18 : 1;
    g.lineWidth = band ? 2 + Math.random() * 3 : 1;
    g.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const y = y0 + Math.sin(x * 0.004 + i * 0.7) * 6 + Math.sin(x * 0.013 + i) * 2;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  // pores
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 4, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export class CameraView {
  private stage: Stage;
  private deck: DeckModel;
  private raf = 0;
  private t0 = performance.now();
  private v = new THREE.Vector3();
  private guard = perfGuard(22, () => this.stage.setPixelRatio(1));
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, private onPin?: (x: number, y: number) => void) {
    this.stage = createStage({
      canvas,
      fov: 46,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      bloom: { strength: 0.18, radius: 0.4, threshold: 0.92 },
      grade: { vignette: 0.35, grain: 0.045, aberration: 0.0004, lift: [0.004, 0.004, 0.006] },
    });
    const { renderer, scene } = this.stage;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x16130f, 1);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    // a warm desk lamp up and to the left, a cool window fill from the right, and a soft bounce
    const lamp = new THREE.SpotLight(0xffe2bf, 60, 30, 0.8, 0.7, 1.6);
    lamp.position.set(-4.5, 7, 3);
    lamp.target.position.set(0, 0, 0);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(2048, 2048);
    lamp.shadow.bias = -0.0004;
    lamp.shadow.radius = 4;
    const win = new THREE.DirectionalLight(0xbfd6ff, 0.6);
    win.position.set(8, 4, -2);
    scene.add(lamp, lamp.target, win, new THREE.HemisphereLight(0xfff1de, 0x2a1f14, 0.35));

    // oak desk and a plain wall behind it
    const oak = woodTexture("#7a5233", "#3a2210");
    oak.repeat.set(2, 1);
    const desk = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 18),
      new THREE.MeshPhysicalMaterial({ map: oak, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
    );
    desk.rotation.x = -Math.PI / 2;
    desk.receiveShadow = true;
    scene.add(desk);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 16), new THREE.MeshStandardMaterial({ color: 0x5b5650, roughness: 0.95 }));
    wall.position.set(0, 8, -6);
    scene.add(wall);

    // the record player, mid-repair: platter lifted off and set down on the desk beside it
    this.deck = buildDeck(makeFxUniforms());
    const walnut = woodTexture("#3b2414", "#170c05");
    this.deck.plinth.material = new THREE.MeshPhysicalMaterial({ map: walnut, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    this.deck.accents.forEach((m) => m.color.multiplyScalar(1.4));
    this.deck.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.deck.platter.position.set(3.4, 0.09, 1.9);
    this.deck.platter.rotation.set(0, 0.4, 0);
    this.deck.root.rotation.y = -0.12;
    scene.add(this.deck.root);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  private resize() {
    const w = this.canvas.clientWidth || 640, h = this.canvas.clientHeight || 480;
    this.stage.resize(w, h);
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    this.guard(now);
    const t = (now - this.t0) / 1000;
    const cam = this.stage.camera;
    // handheld: a slow drift plus a small, uneven breathing sway
    const sway = (a: number, b: number) => Math.sin(t * a) * 0.6 + Math.sin(t * b + 1.3) * 0.4;
    const portrait = this.canvas.clientHeight > this.canvas.clientWidth;
    const d = portrait ? 1.35 : 1;
    cam.position.set(-0.6 + sway(0.31, 0.83) * 0.06, 6.6 * d + sway(0.27, 0.71) * 0.05, 6.4 * d + sway(0.23, 0.61) * 0.05);
    cam.lookAt(0.5 + sway(0.4, 1.1) * 0.03, 0.3, 0.3 + sway(0.37, 0.9) * 0.03);
    cam.rotateZ(sway(0.2, 0.55) * 0.008);
    this.stage.render(t);

    if (this.onPin) {
      this.deck.anchors.pulley.getWorldPosition(this.v);
      this.v.project(cam);
      this.onPin(this.v.x * 0.5 + 0.5, -this.v.y * 0.5 + 0.5);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.stage.scene.environment?.dispose();
    this.stage.dispose();
  }
}
