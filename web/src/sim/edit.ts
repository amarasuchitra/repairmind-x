/**
 * What a person changes in the design lab's sandbox: gravity, each body's mass, size, friction and bounce, and
 * each joint's motor, spring and strength. Applied to a copy of the design, so the engineer's version and its
 * hand calculations stay as they were and "back to the design" is one click.
 */
import type { Design, SimBody, SimJoint } from "../lab/design.ts";

export interface BodyEdit { mass_kg?: number; scale?: number; friction?: number; restitution?: number; fixed?: boolean }
export interface JointEdit { motor_speed?: number; motor_max_torque?: number; stiffness?: number; damping?: number }

export interface Edits {
  gravity?: number;
  duration_s?: number;
  bodies?: Record<string, BodyEdit>;
  /** by joint index */
  joints?: Record<number, JointEdit>;
  /** what each joint can carry before it breaks, N, by joint index (null = unbreakable) */
  breakN?: Record<number, number | null>;
}

export function applyEdits(design: Design, e: Edits): Design {
  const d: Design = structuredClone(design);
  const sim = d.simulation;
  if (e.gravity !== undefined && Number.isFinite(e.gravity)) sim.gravity = Math.max(0, Math.min(100, e.gravity));
  if (e.duration_s !== undefined && Number.isFinite(e.duration_s)) sim.duration_s = Math.max(0.5, Math.min(60, e.duration_s));
  sim.bodies = sim.bodies.map((b: SimBody) => {
    const x = e.bodies?.[b.id];
    if (!x) return b;
    const n = { ...b };
    if (x.mass_kg !== undefined && x.mass_kg > 0) { n.mass_kg = x.mass_kg; n.mass_symbol = ""; }
    if (x.scale !== undefined && x.scale > 0) n.size = b.size.map((s) => s * x.scale!);
    if (x.friction !== undefined) n.friction = Math.max(0, x.friction);
    if (x.restitution !== undefined) n.restitution = Math.min(1, Math.max(0, x.restitution));
    if (x.fixed !== undefined) n.fixed = x.fixed;
    return n;
  });
  sim.joints = sim.joints.map((j: SimJoint, i) => {
    const x = e.joints?.[i];
    if (!x) return j;
    const n = { ...j };
    if (x.motor_speed !== undefined) n.motor_speed = x.motor_speed;
    if (x.motor_max_torque !== undefined) n.motor_max_torque = Math.max(0, x.motor_max_torque);
    if (x.stiffness !== undefined) { n.stiffness = Math.max(0, x.stiffness); n.stiffness_symbol = ""; }
    if (x.damping !== undefined) n.damping = Math.max(0, x.damping);
    return n;
  });
  return d;
}

export const breakList = (design: Design, e: Edits): (number | null)[] => design.simulation.joints.map((_, i) => e.breakN?.[i] ?? null);

export const isEdited = (e: Edits) => Object.keys(e).some((k) => {
  const v = (e as Record<string, unknown>)[k];
  return v !== undefined && !(typeof v === "object" && v !== null && !Object.keys(v).length);
});

/** Typical strength of common joints, for the strength picker. Shear or pull-out, roughly, at room temperature. */
export const JOINT_STRENGTHS: { label: string; n: number | null; note: string }[] = [
  { label: "Unbreakable (ideal)", n: null, note: "How the engineer modelled it." },
  { label: "Hot glue dab", n: 40, note: "About 1 cm² of hot glue on plastic." },
  { label: "M3 nylon screw", n: 150, note: "Nylon shears around 30 MPa over the 5 mm² core." },
  { label: "Super glue, 1 cm² on ABS", n: 300, note: "Cyanoacrylate on smooth plastic." },
  { label: "5 mm 3D-printed PLA pin", n: 550, note: "About 28 MPa in shear over 20 mm²; layer lines make it weaker across them." },
  { label: "M3 steel screw (8.8)", n: 1500, note: "Shear about 0.6 × 800 MPa over 5 mm²; the plastic round it usually fails first." },
  { label: "M5 steel bolt (8.8)", n: 4500, note: "Shear over 14 mm² of thread core." },
];
