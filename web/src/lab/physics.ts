/**
 * The physics sandbox: builds a Rapier world from a design's simulation spec and steps it. Kept free of
 * any rendering so it runs the same in the page and in tests.
 *
 * Conventions (they keep joint frames simple for a model to write): every body starts world-aligned;
 * `rotation_deg` turns the body's collider shape, not its frame. So a wheel is a cylinder turned 90° about
 * x, and its revolute axis is written in world terms, e.g. [0, 0, 1].
 */

import type RAPIER_NS from "@dimforge/rapier3d-compat";
import type { Design, SimBody, SimProbe, ProbeQty } from "./design.ts";
import type { Analysis } from "./analysis.ts";
import { fmt } from "./units.ts";

type R = typeof RAPIER_NS;

let rapier: Promise<R> | null = null;
/** Loads the physics engine once (WebAssembly, ~2 MB, only when the lab opens). */
export function loadRapier(): Promise<R> {
  rapier ??= import("@dimforge/rapier3d-compat").then(async (m) => {
    const lib = (m as unknown as { default?: R }).default ?? (m as unknown as R);
    await lib.init();
    return lib;
  });
  return rapier;
}

export const DT = 1 / 120;
const MAX_BODIES = 60;

export interface BodyState {
  id: string;
  p: [number, number, number];
  q: [number, number, number, number];
}

export interface ProbeResult {
  probe: SimProbe;
  series: number[];
  value: number;
  predicted: number | null;
  errorPct: number | null;
  pass: boolean | null;
  unit: string;
}

const UNIT: Record<ProbeQty, string> = {
  x: "m", y: "m", z: "m", vx: "m/s", vy: "m/s", vz: "m/s", speed: "m/s", angular_speed: "rad/s", tilt_deg: "deg",
};

function quatFromEulerDeg(e: number[]): { x: number; y: number; z: number; w: number } {
  const [x, y, z] = (e.length === 3 ? e : [0, 0, 0]).map((a) => (a * Math.PI) / 360);
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  // XYZ intrinsic order
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

function rotate(q: { x: number; y: number; z: number; w: number }, v: [number, number, number]): [number, number, number] {
  const [vx, vy, vz] = v;
  const tx = 2 * (q.y * vz - q.z * vy), ty = 2 * (q.z * vx - q.x * vz), tz = 2 * (q.x * vy - q.y * vx);
  return [vx + q.w * tx + (q.y * tz - q.z * ty), vy + q.w * ty + (q.z * tx - q.x * tz), vz + q.w * tz + (q.x * ty - q.y * tx)];
}

const vec3 = (a: number[] | undefined, fallback: [number, number, number] = [0, 0, 0]): [number, number, number] =>
  Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite) ? [a[0], a[1], a[2]] : fallback;
const pos = (n: number, min: number, max: number, dflt: number) => (Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : dflt);

/** Resolve a value that may be bound to a design variable, in SI. */
function bound(symbol: string, fallback: number, analysis: Analysis | null, dim?: number[]): number {
  const q = symbol && analysis?.env[symbol];
  if (q && (!dim || q.dim.every((x, i) => Math.abs(x - dim[i]) < 1e-9))) return q.v;
  return fallback;
}

interface Motor { index: number; a: RAPIER_NS.RigidBody; b: RAPIER_NS.RigidBody; axis: [number, number, number]; speed: number; maxTorque: number; stallT: number; torque: number }

/** Something that went wrong in a run: a motor that can't turn its load, a joint that broke, a body that fell. */
export interface SimEvent {
  t: number;
  kind: "stall" | "break" | "fell";
  where: string;
  title: string;
  why: string;
  fix: string;
}

/** What each joint can take before it breaks, in N, by joint index; null or missing is unbreakable. */
export interface Limits { breakN?: (number | null)[] }

/**
 * Rapier's contact-force events report 1.25× the force that holds a resting body up (rapier3d-compat 0.14,
 * checked in tests/lab.test.mjs); divide it out so joint loads come out right.
 */
const CONTACT_FORCE_SCALE = 1 / 1.25;

interface JointRec { index: number; a: string; b: string; kind: string; joint: RAPIER_NS.ImpulseJoint; breakN: number | null; broken: boolean; over: number; peak: number }

export class Sandbox {
  readonly world: RAPIER_NS.World;
  readonly bodies = new Map<string, RAPIER_NS.RigidBody>();
  readonly specs: SimBody[];
  readonly warnings: string[] = [];
  time = 0;
  /** set once the WebAssembly world is released; nothing may touch the bodies after that */
  freed = false;
  private motors: Motor[] = [];
  private samples = new Map<string, number[]>();
  readonly events: SimEvent[] = [];
  private joints: JointRec[] = [];
  private queue: RAPIER_NS.EventQueue;
  private colliderBody = new Map<number, string>();
  private contact = new Map<string, [number, number, number]>();
  private gravity: number;
  /** the largest load each joint has carried so far, N */
  get jointLoads() { return this.joints.map((j) => ({ index: j.index, peak: j.peak, broken: j.broken, breakN: j.breakN })); }

  private design: Design;
  private analysis: Analysis | null;

  constructor(R: R, design: Design, analysis: Analysis | null, limits: Limits = {}) {
    this.design = design;
    this.analysis = analysis;
    const sim = design.simulation;
    this.gravity = Number.isFinite(sim.gravity) ? sim.gravity : 9.80665;
    this.world = new R.World({ x: 0, y: -this.gravity, z: 0 });
    this.queue = new R.EventQueue(true);
    this.world.timestep = DT;
    this.specs = sim.bodies.slice(0, MAX_BODIES);
    if (sim.bodies.length > MAX_BODIES) this.warnings.push(`Only the first ${MAX_BODIES} bodies are simulated.`);

    if (sim.ground) {
      const g = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
      this.world.createCollider(R.ColliderDesc.cuboid(50, 0.1, 50).setFriction(0.8), g);
    }

    for (const b of this.specs) {
      const p = vec3(b.position);
      const desc = b.fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic();
      desc.setTranslation(...p).setCanSleep(false);
      const v = vec3(b.initial_velocity);
      if (!b.fixed) desc.setLinvel(...v);
      const rb = this.world.createRigidBody(desc);
      const s = b.size ?? [];
      let col: RAPIER_NS.ColliderDesc;
      if (b.shape === "sphere") col = R.ColliderDesc.ball(pos(s[0], 0.005, 20, 0.1));
      else if (b.shape === "cylinder") col = R.ColliderDesc.cylinder(pos(s[1], 0.005, 40, 0.1) / 2, pos(s[0], 0.005, 20, 0.1));
      else col = R.ColliderDesc.cuboid(pos(s[0], 0.005, 100, 0.2) / 2, pos(s[1], 0.005, 100, 0.2) / 2, pos(s[2], 0.005, 100, 0.2) / 2);
      col.setRotation(quatFromEulerDeg(b.rotation_deg ?? [0, 0, 0]));
      col.setFriction(Math.max(0, Number.isFinite(b.friction) ? b.friction : 0.7));
      col.setRestitution(Math.min(1, Math.max(0, Number.isFinite(b.restitution) ? b.restitution : 0)));
      const mass = bound(b.mass_symbol, b.mass_kg, analysis, [0, 1, 0, 0, 0, 0, 0]);
      if (!b.fixed) col.setMass(pos(mass, 1e-4, 1e6, 1));
      col.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0);
      const made = this.world.createCollider(col, rb);
      this.colliderBody.set(made.handle, b.id);
      if (this.bodies.has(b.id)) this.warnings.push(`Body id "${b.id}" is used twice.`);
      this.bodies.set(b.id, rb);
    }

    for (const [index, j] of sim.joints.entries()) {
      const a = this.bodies.get(j.a), b = this.bodies.get(j.b);
      if (!a || !b) { this.warnings.push(`Joint ${j.kind} ${j.a}–${j.b} refers to a body that doesn't exist.`); continue; }
      const aa = vec3(j.anchor_a), ab = vec3(j.anchor_b);
      const axisRaw = vec3(j.axis, [0, 0, 1]);
      const n = Math.hypot(...axisRaw) || 1;
      const axis: [number, number, number] = [axisRaw[0] / n, axisRaw[1] / n, axisRaw[2] / n];
      const V = (x: [number, number, number]) => ({ x: x[0], y: x[1], z: x[2] });
      let data: RAPIER_NS.JointData;
      if (j.kind === "fixed") {
        // keep the current relative placement if no anchors were given
        const pa = a.translation(), pb = b.translation();
        const rel: [number, number, number] = j.anchor_a.some((x) => x) || j.anchor_b.some((x) => x) ? aa : [pb.x - pa.x, pb.y - pa.y, pb.z - pa.z];
        data = R.JointData.fixed(V(rel), { x: 0, y: 0, z: 0, w: 1 }, V(ab), { x: 0, y: 0, z: 0, w: 1 });
      } else if (j.kind === "revolute") {
        data = R.JointData.revolute(V(aa), V(ab), V(axis));
        if (j.motor_speed && j.motor_max_torque > 0) this.motors.push({ index, a, b, axis, speed: j.motor_speed, maxTorque: j.motor_max_torque, stallT: 0, torque: 0 });
      } else if (j.kind === "prismatic") {
        data = R.JointData.prismatic(V(aa), V(ab), V(axis));
      } else {
        const k = bound(j.stiffness_symbol, j.stiffness, analysis, [0, 1, -2, 0, 0, 0, 0]);
        data = R.JointData.spring(Math.max(0, j.rest_length), Math.max(0, k), Math.max(0, j.damping), V(aa), V(ab));
      }
      const joint = this.world.createImpulseJoint(data, a, b, true);
      const bn = limits.breakN?.[index];
      this.joints.push({ index, a: j.a, b: j.b, kind: j.kind, joint, breakN: bn && bn > 0 ? bn : null, broken: false, over: 0, peak: 0 });
    }
    for (const p of sim.probes) {
      if (!this.bodies.has(p.body)) this.warnings.push(`Probe ${p.id} watches "${p.body}", which doesn't exist.`);
      this.samples.set(p.id, []);
    }
  }

  /** Torque-limited velocity motors: τ = clamp(gain·(ω_target − ω_rel), ±τ_max), equal and opposite. */
  private driveMotors() {
    for (const m of this.motors) {
      const qa = m.a.rotation();
      const ax = rotate(qa, m.axis);
      const wa = m.a.angvel(), wb = m.b.angvel();
      const rel = (wb.x - wa.x) * ax[0] + (wb.y - wa.y) * ax[1] + (wb.z - wa.z) * ax[2];
      const gain = m.maxTorque / 0.5;
      const tau = Math.max(-m.maxTorque, Math.min(m.maxTorque, gain * (m.speed - rel)));
      m.torque = tau;
      // stalled: pushing with all it has and barely turning
      m.stallT = Math.abs(tau) >= m.maxTorque * 0.98 && rel * Math.sign(m.speed) < Math.abs(m.speed) * 0.1 ? m.stallT + DT : 0;
      if (m.stallT > 0.5) this.stalled(m, rel);
      const imp = { x: ax[0] * tau * DT, y: ax[1] * tau * DT, z: ax[2] * tau * DT };
      m.b.applyTorqueImpulse(imp, true);
      m.a.applyTorqueImpulse({ x: -imp.x, y: -imp.y, z: -imp.z }, true);
    }
  }

  private read(id: string, q: ProbeQty): number {
    const b = this.bodies.get(id);
    if (!b) return NaN;
    const t = b.translation(), v = b.linvel(), w = b.angvel();
    switch (q) {
      case "x": return t.x;
      case "y": return t.y;
      case "z": return t.z;
      case "vx": return v.x;
      case "vy": return v.y;
      case "vz": return v.z;
      case "speed": return Math.hypot(v.x, v.y, v.z);
      case "angular_speed": return Math.hypot(w.x, w.y, w.z);
      case "tilt_deg": {
        const up = rotate(b.rotation(), [0, 1, 0]);
        return (Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180) / Math.PI;
      }
    }
  }

  private stalled(m: Motor, rel: number) {
    const j = this.design.simulation.joints[m.index];
    const where = `${j.a}–${j.b}`;
    if (this.events.some((e) => e.kind === "stall" && e.where === where)) return;
    this.events.push({
      t: this.time, kind: "stall", where,
      title: `The motor at ${where} stalled`,
      why: `It is set to ${fmt(m.speed)} rad/s but turns at ${fmt(rel * Math.sign(m.speed))} rad/s${rel * Math.sign(m.speed) < 0 ? " (the load is pushing it backwards)" : ""} while giving all of its ${fmt(m.maxTorque)} N·m. The load needs more torque than that. A real motor held like this draws its stall current and heats up fast.`,
      fix: "Give it more torque (a bigger motor or a gearbox: torque × ratio, speed ÷ ratio), make what it turns lighter, or use smaller wheels or a shorter arm.",
    });
  }

  /** Joint loads from Newton's second law on a body held by one joint: F = m·a − m·g − contact forces. */
  private checkJoints(vel: Map<string, { x: number; y: number; z: number }>) {
    if (!this.joints.some((j) => !j.broken)) return;
    const count = new Map<string, number>();
    for (const j of this.joints) if (!j.broken) for (const id of [j.a, j.b]) count.set(id, (count.get(id) ?? 0) + 1);
    const fixed = (id: string) => this.specs.find((s) => s.id === id)?.fixed ?? true;
    for (const j of this.joints) {
      if (j.broken) continue;
      // measure on the side that hangs off this joint alone
      const side = [j.b, j.a].find((id) => !fixed(id) && count.get(id) === 1);
      if (!side) continue;
      const rb = this.bodies.get(side)!;
      const v0 = vel.get(side), v1 = rb.linvel();
      if (!v0) continue;
      const m = rb.mass();
      const c = this.contact.get(side) ?? [0, 0, 0];
      const f = [m * (v1.x - v0.x) / DT - c[0], m * (v1.y - v0.y) / DT + m * this.gravity - c[1], m * (v1.z - v0.z) / DT - c[2]];
      const F = Math.hypot(f[0], f[1], f[2]);
      // a short moving average: one solver step can spike
      j.over = j.over * 0.8 + F * 0.2;
      j.peak = Math.max(j.peak, j.over);
      if (j.breakN !== null && j.over > j.breakN) {
        j.broken = true;
        this.world.removeImpulseJoint(j.joint, true);
        this.motors = this.motors.filter((mo) => mo.index !== j.index);
        const label = (id: string) => this.specs.find((s) => s.id === id)?.label || id;
        this.events.push({
          t: this.time, kind: "break", where: `${j.a}–${j.b}`,
          title: `The ${j.kind} joint between ${label(j.a)} and ${label(j.b)} broke`,
          why: `It was carrying ${fmt(j.over)} N, more than the ${fmt(j.breakN)} N it can take. (${label(side)} weighs ${fmt(m * this.gravity)} N; the rest is the force needed to accelerate or stop it.)`,
          fix: `Make the joint stronger (a larger or steel fastener, more glue area), lighten ${label(side)}, or slow the motion so the peak force drops. With a safety factor of 2 it should be rated for at least ${fmt(j.over * 2)} N.`,
        });
      }
    }
  }

  step(n = 1) {
    if (this.freed) return;
    for (let i = 0; i < n; i++) {
      this.driveMotors();
      const vel = new Map<string, { x: number; y: number; z: number }>();
      if (this.joints.length) for (const [id, b] of this.bodies) { const v = b.linvel(); vel.set(id, { x: v.x, y: v.y, z: v.z }); }
      this.world.step(this.queue);
      this.contact.clear();
      this.queue.drainContactForceEvents((e) => {
        const f = e.totalForce();
        const k = CONTACT_FORCE_SCALE;
        // the force acts on collider 2 as given, and on collider 1 the other way
        const add = (h: number, sign: number) => {
          const id = this.colliderBody.get(h);
          if (!id) return;
          const c = this.contact.get(id) ?? [0, 0, 0];
          this.contact.set(id, [c[0] + sign * f.x * k, c[1] + sign * f.y * k, c[2] + sign * f.z * k]);
        };
        add(e.collider2(), 1);
        add(e.collider1(), -1);
      });
      if (this.joints.length) this.checkJoints(vel);
      this.time += DT;
      for (const p of this.design.simulation.probes) this.samples.get(p.id)?.push(this.read(p.body, p.quantity));
    }
  }

  get duration() {
    const d = this.design.simulation.duration_s;
    return Number.isFinite(d) && d > 0 ? Math.min(d, 60) : 5;
  }

  get done() {
    return this.time >= this.duration - 1e-9;
  }

  states(): BodyState[] {
    return this.specs.map((s) => {
      const b = this.bodies.get(s.id)!;
      const t = b.translation(), r = b.rotation();
      return { id: s.id, p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
    });
  }

  /** Probe values so far, compared against the equations that predict them. */
  results(): ProbeResult[] {
    if (this.freed) return [];
    return this.design.simulation.probes.map((p) => {
      const series = this.samples.get(p.id) ?? [];
      const finite = series.filter(Number.isFinite);
      const value = !finite.length ? NaN : p.compare === "max" ? Math.max(...finite) : p.compare === "min" ? Math.min(...finite) : finite[finite.length - 1];
      const eq = p.predicted_by ? this.analysis?.equations.find((e) => e.eq.id === p.predicted_by) : undefined;
      let predicted: number | null = null;
      if (eq?.si) {
        // compare in the probe's SI unit; degrees for tilt
        predicted = p.quantity === "tilt_deg" ? (eq.si.v * 180) / Math.PI : eq.si.v;
      }
      const errorPct = predicted !== null && Number.isFinite(value) ? (Math.abs(value - predicted) / Math.max(Math.abs(predicted), 1e-9)) * 100 : null;
      const tol = Number.isFinite(p.tolerance_pct) && p.tolerance_pct > 0 ? p.tolerance_pct : 10;
      return { probe: p, series, value, predicted, errorPct, pass: errorPct === null ? null : errorPct <= tol, unit: UNIT[p.quantity] ?? "" };
    });
  }

  free() {
    if (this.freed) return;
    this.freed = true;
    this.queue.free();
    this.world.free();
  }
}

/** Plain-text findings from a finished run, for the design agent's next round. */
export function simFindings(results: ProbeResult[], warnings: string[], sb?: Sandbox): { severity: "error" | "warning"; where: string; text: string }[] {
  const out: { severity: "error" | "warning"; where: string; text: string }[] = warnings.map((w) => ({ severity: "warning" as const, where: "simulation", text: w }));
  for (const r of results) {
    if (r.pass === false) {
      out.push({
        severity: "error", where: `simulation probe ${r.probe.id} (${r.probe.label})`,
        text: `measured ${r.probe.compare} ${r.probe.quantity} = ${fmt(r.value)} ${r.unit}, but ${r.probe.predicted_by} predicts ${fmt(r.predicted!)} ${r.unit} (${r.errorPct!.toFixed(1)}% off, tolerance ${r.probe.tolerance_pct}%). Either the hand calculation or the assembly is wrong.`,
      });
    }
    if (r.probe.predicted_by && r.predicted === null) {
      out.push({ severity: "warning", where: `simulation probe ${r.probe.id}`, text: `refers to ${r.probe.predicted_by}, which has no computed result` });
    }
  }
  if (sb) {
    for (const s of sb.specs) {
      const b = sb.bodies.get(s.id);
      if (b && !s.fixed && b.translation().y < -2) out.push({ severity: "error", where: `simulation body ${s.id}`, text: "fell through or off the world; check positions and supports" });
    }
  }
  return out;
}
