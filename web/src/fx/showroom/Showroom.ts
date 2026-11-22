import * as THREE from "three";
import gsap from "gsap";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createStage, glowTexture, perfGuard, ringMaterial, ringMesh, type Stage } from "../gl/core";
import { buildDeck, DECK, type DeckModel } from "./turntable";
import { makeFxUniforms } from "./fx";

/**
 * The landing page's one 3D scene: a belt-drive record player on a lit platform in a dark studio, a slow network of
 * connections far behind it, and a camera that moves between composed "shots" when the visitor picks a
 * chapter. Screen labels are plain DOM elements that this class pins to named points on the model.
 */

function shadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,0.95)");
  grd.addColorStop(0.45, "rgba(0,0,0,0.6)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export interface Shot {
  az: number; // camera angle around the model, degrees (0 = straight on)
  el: number; // camera elevation, degrees
  dist: number;
  tx: number; ty: number; tz: number;
  explode: number;
  xray: number;
  scan: number;
  spin: number; // platter speed, rad/s (33⅓ rpm is about 3.5)
  arm: number; // tonearm: 0 on its rest, 1 over the record
  glow: number; // highlight on the part being worked on (the belt)
  sx: number; // horizontal framing: positive moves the model right, as a fraction of the width
}

export const SHOTS: Shot[] = [
  { az: 28, el: 24, dist: 15, tx: 0, ty: 0.3, tz: 0, explode: 0, xray: 0, scan: 0, spin: 3.5, arm: 1, glow: 0, sx: 0.2 },
  { az: -30, el: 26, dist: 14.5, tx: 0, ty: 0.3, tz: 0, explode: 0, xray: 1, scan: 1, spin: 0.4, arm: 1, glow: 0, sx: -0.2 },
  { az: 16, el: 34, dist: 12, tx: -0.25, ty: 0.4, tz: 0.1, explode: 0, xray: 0, scan: 0, spin: 2.2, arm: 1, glow: 0, sx: 0.2 },
  { az: -24, el: 17, dist: 13, tx: -0.5, ty: 1.05, tz: -0.2, explode: 1, xray: 0, scan: 0, spin: 0, arm: 0, glow: 1, sx: -0.13 },
  { az: 6, el: 22, dist: 17, tx: 0, ty: 0.3, tz: 0, explode: 0, xray: 0, scan: 0, spin: 2, arm: 0, glow: 0, sx: 0.2 },
];

export interface ShowroomOptions {
  canvas: HTMLCanvasElement;
  labels: HTMLElement;
  reduced: boolean;
}

export class Showroom {
  private stage: Stage;
  private deck: DeckModel;
  private fx = makeFxUniforms();
  private cur: Shot = { ...SHOTS[0] };
  private reveal = { v: 0 };
  private raf = 0;
  private t0 = performance.now();
  private last = 0;
  private spinAngle = 0;
  private scanPhase = 0;
  private yaw = 0;
  private yawVel = 0;
  private pitch = 0;
  private dragging = false;
  private lastInput = 0;
  private parallax = new THREE.Vector2();
  private parallaxT = new THREE.Vector2();
  private plexus: THREE.Group;
  private scanRing: THREE.Mesh;
  private platform: THREE.Mesh[] = [];
  private frameY = 0;
  private frameX = 0;
  private fit = 1;
  private W = 1;
  private H = 1;
  private dirty = true;
  private pT = 0;
  private p = 0;
  private guard = perfGuard(22, () => this.stage.setPixelRatio(1));
  private disposers: (() => void)[] = [];
  private v = new THREE.Vector3();
  private v2 = new THREE.Vector3();

  constructor(private o: ShowroomOptions) {
    const mobile = window.matchMedia("(max-width: 820px)").matches;
    this.stage = createStage({
      canvas: o.canvas,
      fov: 30,
      pixelRatio: Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2),
      bloom: { strength: 0.6, radius: 0.35, threshold: 0.85 },
      grade: { vignette: 0.55, grain: 0.025, aberration: 0, lift: [0.002, 0.006, 0.018] },
    });
    const { renderer, scene } = this.stage;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x02060f, 1);
    scene.fog = new THREE.FogExp2(0x02060f, 0.034);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
    pmrem.dispose();

    // lighting: a soft key, a cool cyan rim from behind and a blue fill, like a product shoot
    const key = new THREE.DirectionalLight(0xf2f6ff, 1.6);
    key.position.set(4, 6.5, 5);
    const rim = new THREE.DirectionalLight(0x46e2ff, 2.2);
    rim.position.set(-4.5, 3.5, -5);
    const rim2 = new THREE.DirectionalLight(0x9fc4ff, 1.6);
    rim2.position.set(5, 2.5, -4);
    const fill = new THREE.DirectionalLight(0x2f6bff, 0.9);
    fill.position.set(-5, 1, 3);
    scene.add(key, rim, rim2, fill, new THREE.AmbientLight(0x0b1830, 0.6));

    this.deck = buildDeck(this.fx);
    // accents read as light sources, so they bloom
    this.deck.accents.forEach((m) => m.color.multiplyScalar(2.4));
    scene.add(this.deck.root);

    this.buildFloor();
    this.scanRing = this.buildScanRing();
    this.plexus = this.buildPlexus();

    this.bindInput();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(o.canvas);
    this.disposers.push(() => ro.disconnect());
    this.resize();
    this.apply(0);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    const onVis = () => {
      if (document.hidden) cancelAnimationFrame(this.raf);
      else { this.last = 0; this.raf = requestAnimationFrame(this.loop); }
    };
    document.addEventListener("visibilitychange", onVis);
    this.disposers.push(() => document.removeEventListener("visibilitychange", onVis));
  }

  /* ------------------------------------------------------------------ scene pieces */

  private buildFloor() {
    const { scene } = this.stage;
    // studio floor: a dark disc with fine survey rings that fade into the dark
    const floorMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: this.fx.uTime },
      vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vP; uniform float uTime;
        void main(){
          float r = length(vP);
          float fade = smoothstep(9.0, 1.5, r);
          float rings = smoothstep(0.012, 0.0, abs(fract(r * 1.25) - 0.5) - 0.488);
          float a = atan(vP.y, vP.x);
          float ticks = step(0.985, fract(a / 6.2831853 * 120.0)) * smoothstep(3.3, 3.35, r) * smoothstep(3.7, 3.65, r);
          float glow = exp(-r * r * 0.35) * 0.55;
          float shadow = smoothstep(0.0, 2.6, r);
          vec3 col = vec3(0.02, 0.05, 0.1) * glow + vec3(0.16, 0.6, 0.9) * (rings * 0.07 + ticks * 0.5) * fade;
          float alpha = max(fade * 0.9, 0.0);
          gl_FragColor = vec4(col * shadow, alpha);
        }`,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(10, 128), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.002;
    scene.add(floor);

    // contact shadow under the base
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(DECK.w * 1.45, DECK.d * 1.5),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.95, depthWrite: false }),
    );
    sh.rotation.x = -Math.PI / 2;
    sh.position.y = 0.002;
    scene.add(sh);

    // platform rings: a solid hairline, a slow dashed ring and a short bright arc
    const mk = (r: number, w: number, color: number, o: Parameters<typeof ringMaterial>[1]) => {
      const m = ringMesh(r, w, ringMaterial(new THREE.Color(color).multiplyScalar(1.6), o), 192);
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.004;
      scene.add(m);
      this.platform.push(m);
      return m;
    };
    mk(2.95, 0.014, 0x46e2ff, { opacity: 0.5 });
    mk(3.12, 0.035, 0x46e2ff, { dash: 140, duty: 0.35, opacity: 0.3 });
    mk(3.3, 0.012, 0x2f86ff, { opacity: 0.25 });
    mk(3.48, 0.024, 0x9fe9ff, { arc: 0.12, start: 0.1, opacity: 0.9 });
    mk(3.48, 0.024, 0x9fe9ff, { arc: 0.05, start: 0.6, opacity: 0.6 });
  }

  private buildScanRing() {
    // a hoop standing across the deck that sweeps from left to right
    const m = ringMesh(1.95, 0.02, ringMaterial(new THREE.Color(0x46e2ff).multiplyScalar(2.2), { opacity: 1 }), 160);
    m.rotation.y = Math.PI / 2;
    m.scale.set(1, 0.5, 1);
    m.position.y = 0.36;
    this.stage.scene.add(m);
    return m;
  }

  private buildPlexus() {
    const g = new THREE.Group();
    const n = 170;
    const pts: THREE.Vector3[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) pts.push(new THREE.Vector3((rnd() - 0.5) * 56, rnd() * 22 - 3, -12 - rnd() * 22));
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const d = pts[i].distanceTo(pts[j]);
      if (d < 5.2) {
        const k = 1 - d / 5.2;
        c.setRGB(0.18 * k, 0.5 * k, 1.0 * k);
        pos.push(pts[i].x, pts[i].y, pts[i].z, pts[j].x, pts[j].y, pts[j].z);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
    const pg = new THREE.BufferGeometry().setFromPoints(pts);
    g.add(new THREE.Points(pg, new THREE.PointsMaterial({ map: glowTexture(), color: 0x6fc8ff, size: 0.5, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
    // a soft blue nebula behind the model gives the dark some depth
    const neb = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x123a8a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    neb.scale.set(30, 18, 1);
    neb.position.set(0, 4, -20);
    g.add(neb);
    this.stage.scene.add(g);
    return g;
  }

  /* ------------------------------------------------------------------ interaction */

  private bindInput() {
    const el = this.o.canvas;
    let lx = 0, ly = 0;
    const down = (e: PointerEvent) => {
      this.dragging = true;
      lx = e.clientX; ly = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add("grabbing");
    };
    const move = (e: PointerEvent) => {
      this.parallaxT.set(e.clientX / this.W - 0.5, e.clientY / this.H - 0.5);
      if (!this.dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      this.yawVel = dx * 0.006;
      this.yaw += this.yawVel;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.003, -0.25, 0.35);
      this.lastInput = performance.now();
      this.dirty = true;
    };
    const up = () => {
      this.dragging = false;
      this.lastInput = performance.now();
      el.classList.remove("grabbing");
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    this.disposers.push(() => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    });
  }

  private resize() {
    const c = this.o.canvas;
    this.W = c.clientWidth || window.innerWidth;
    this.H = c.clientHeight || window.innerHeight;
    this.stage.resize(this.W, this.H);
    const aspect = this.W / this.H;
    // phones: pull back so the model fits the narrow frame, and lift it into the top half
    this.fit = aspect < 1 ? Math.pow(1 / aspect, 0.75) * 1.12 : 1;
    this.frameY = aspect < 1 ? 0.22 : 0;
    // desktop: nudge the model right of centre, away from the headline column
    this.frameX = aspect >= 1 ? 1 : 0;
    this.dirty = true;
  }

  /* ------------------------------------------------------------------ shots */

  /**
   * Scroll position in chapters: 0 is the first shot, 1.5 is halfway between the second and the third.
   * The camera follows with a little inertia and holds still around each whole number, so every chapter
   * has a resting composition and the moves happen between them.
   */
  setProgress(p: number) {
    this.pT = THREE.MathUtils.clamp(p, 0, SHOTS.length - 1);
    if (this.o.reduced) this.p = Math.round(this.pT);
    this.dirty = true;
  }

  private blend() {
    const n = SHOTS.length;
    const i = Math.min(Math.floor(this.p), n - 2);
    const k = THREE.MathUtils.smoothstep(this.p - i, 0.12, 0.88);
    const a = SHOTS[i], b = SHOTS[i + 1];
    for (const key of Object.keys(a) as (keyof Shot)[]) this.cur[key] = a[key] + (b[key] - a[key]) * k;
    if (this.o.reduced) this.cur.spin = 0;
  }

  /** Entrance: the camera settles in from further back while the scene fades up. */
  enter() {
    if (this.o.reduced) { this.reveal.v = 1; this.dirty = true; return; }
    gsap.fromTo(this.reveal, { v: 0 }, { v: 1, duration: 2.6, ease: "expo.out" });
  }

  /* ------------------------------------------------------------------ frame */

  private apply(dt: number) {
    this.blend();
    const s = this.cur, f = this.deck, now = performance.now();
    const reduced = this.o.reduced;

    // camera on an orbit around the target
    const rv = this.reveal.v;
    const az = THREE.MathUtils.degToRad(s.az + this.parallax.x * 3);
    const el = THREE.MathUtils.degToRad(s.el - this.parallax.y * 2);
    const dist = s.dist * this.fit * (1 + (1 - rv) * 0.45);
    const cam = this.stage.camera;
    cam.position.set(s.tx + Math.sin(az) * Math.cos(el) * dist, s.ty + Math.sin(el) * dist, s.tz + Math.cos(az) * Math.cos(el) * dist);
    cam.lookAt(s.tx, s.ty, s.tz);
    if (this.frameY || this.frameX) cam.setViewOffset(this.W, this.H, -this.frameX * s.sx * this.W, this.frameY * this.H, this.W, this.H);
    else cam.clearViewOffset();
    this.stage.renderer.toneMappingExposure = 1.05 * rv;

    // drag to turn; it eases back to the composed angle a few seconds after you let go
    if (!this.dragging) {
      this.yaw += this.yawVel;
      this.yawVel *= 0.92;
      if (now - this.lastInput > 2600) {
        this.yaw *= 0.96;
        this.pitch *= 0.96;
      }
    }
    f.root.rotation.y = this.yaw;
    f.root.rotation.x = this.pitch * 0.4;

    // the record turns; the tonearm swings between its rest and the record
    const t = (now - this.t0) / 1000;
    if (!reduced) this.spinAngle -= s.spin * dt;
    f.spin.rotation.y = this.spinAngle;
    f.arm.rotation.y = -0.54 * s.arm;
    f.arm.rotation.x = -0.05 * Math.sin(Math.PI * s.arm); // cued up while it travels

    // repair view: the platter lifts off to show the belt and the motor pulley underneath
    const e = s.explode;
    f.platter.position.set(DECK.platter.x + 0.2 * e, DECK.h + 0.16 + 1.35 * e, DECK.platter.z + 0.1 * e);
    f.platter.rotation.x = 0.1 * e;
    f.platter.rotation.z = -0.06 * e;
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    f.highlight.emissiveIntensity = s.glow * (0.6 + 1.2 * pulse);

    // identification scan
    this.fx.uXray.value = s.xray;
    this.fx.uScanAmt.value = s.scan;
    if (s.scan > 0.001) {
      if (!reduced) this.scanPhase = (this.scanPhase + dt / 2.8) % 1;
      else this.scanPhase = 0.62;
      const x = -2.5 + this.scanPhase * 5;
      this.fx.uScanY.value = x;
      this.scanRing.position.x = x;
      this.scanRing.visible = true;
      const m = this.scanRing.material as THREE.ShaderMaterial;
      m.uniforms.uOpacity.value = s.scan * Math.sin(this.scanPhase * Math.PI);
    } else this.scanRing.visible = false;

    // platform rings drift
    if (!reduced) {
      this.platform[1].rotation.z = t * 0.06;
      this.platform[3].rotation.z = -t * 0.18;
      this.platform[4].rotation.z = -t * 0.18;
      this.plexus.rotation.y = Math.sin(t * 0.03) * 0.08;
      this.plexus.position.x = Math.sin(t * 0.05) * 1.5;
    }
    this.fx.uTime.value = t;
  }

  private projectLabels() {
    const cam = this.stage.camera;
    const els = this.o.labels.querySelectorAll<HTMLElement>("[data-anchor]");
    cam.updateMatrixWorld();
    const right = this.v2.setFromMatrixColumn(cam.matrixWorld, 0);
    els.forEach((el) => {
      const a = this.deck.anchors[el.dataset.anchor!];
      if (!a) return;
      a.getWorldPosition(this.v);
      const r = Number(el.dataset.r || 0);
      let px = 0;
      if (r) {
        const p2 = this.v.clone().addScaledVector(right, r).project(cam);
        const p1 = this.v.clone().project(cam);
        px = Math.abs(p2.x - p1.x) * 0.5 * this.W;
      }
      this.v.project(cam);
      const x = (this.v.x * 0.5 + 0.5) * this.W;
      const y = (-this.v.y * 0.5 + 0.5) * this.H;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      if (r) el.style.setProperty("--r", `${px.toFixed(1)}px`);
    });
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop);
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.last = now;
    this.parallax.lerp(this.parallaxT, this.o.reduced ? 1 : 0.04);
    if (!this.o.reduced && Math.abs(this.pT - this.p) > 1e-4) this.p += (this.pT - this.p) * (1 - Math.exp(-dt * 6));
    // under reduced motion only draw when something actually changed
    if (this.o.reduced && !this.dirty && !this.dragging && Math.abs(this.yaw) < 1e-3) return;
    this.dirty = false;
    this.guard(now);
    this.apply(dt);
    this.stage.render(now / 1000);
    this.projectLabels();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    gsap.killTweensOf(this.reveal);
    this.disposers.forEach((d) => d());
    this.stage.scene.environment?.dispose();
    this.stage.dispose();
  }
}
