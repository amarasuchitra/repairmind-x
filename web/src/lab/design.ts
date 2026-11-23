/**
 * The engineering breakdown of an idea, the shape the design agent returns (agent/repairmind/lab/schema.py
 * is the same schema on the server). Numbers here are inputs and claims; the page recomputes every
 * equation itself (analysis.ts) and never shows the model's own arithmetic as a result.
 */

export type ReqKind = "functional" | "performance" | "safety" | "environmental" | "interface" | "cost";
export type Verification = "analysis" | "test" | "inspection" | "demonstration";

export interface Requirement {
  id: string;
  text: string;
  kind: ReqKind;
  verification: Verification;
  rationale: string;
}

export interface Component {
  name: string;
  function: string;
  material: string;
  mass_kg: number;
  notes: string;
}

export interface Variable {
  symbol: string;
  name: string;
  value: number;
  unit: string;
  /** where the number comes from: a datasheet, a handbook value, a requirement, or an assumption */
  source: string;
}

export interface Check {
  kind: "none" | "max" | "min";
  limit: number;
  limit_unit: string;
  factor_of_safety: number;
  label: string;
}

export interface Equation {
  id: string;
  name: string;
  /** the symbol this equation defines; later equations may use it */
  symbol: string;
  expression: string;
  /** the unit the result is reported in; it must match the expression's dimensions */
  unit: string;
  explanation: string;
  assumptions: string;
  requirement_id: string;
  check: Check;
}

export interface TradeStudy {
  question: string;
  criteria: { name: string; weight: number }[];
  options: { name: string; description: string; scores: number[] }[];
  recommendation: string;
}

export interface Risk {
  id: string;
  failure_mode: string;
  cause: string;
  effect: string;
  /** 1-10 each, as in an FMEA */
  severity: number;
  occurrence: number;
  detection: number;
  mitigation: string;
}

export type Shape = "box" | "sphere" | "cylinder";

export interface SimBody {
  id: string;
  label: string;
  shape: Shape;
  /** box: full x,y,z extents. sphere: [radius]. cylinder: [radius, height] (axis along y). Metres. */
  size: number[];
  position: number[];
  rotation_deg: number[];
  fixed: boolean;
  mass_kg: number;
  /** optional: take the mass from this variable so editing it changes the simulation */
  mass_symbol: string;
  friction: number;
  restitution: number;
  initial_velocity: number[];
  color: string;
}

export interface SimJoint {
  kind: "fixed" | "revolute" | "spring" | "prismatic";
  a: string;
  b: string;
  anchor_a: number[];
  anchor_b: number[];
  axis: number[];
  /** revolute: motor target speed (rad/s) and the most torque it may use (N·m); 0 = no motor */
  motor_speed: number;
  motor_max_torque: number;
  /** spring: N/m, N·s/m, m */
  stiffness: number;
  damping: number;
  rest_length: number;
  stiffness_symbol: string;
}

export type ProbeQty = "x" | "y" | "z" | "vx" | "vy" | "vz" | "speed" | "angular_speed" | "tilt_deg";

export interface SimProbe {
  id: string;
  label: string;
  body: string;
  quantity: ProbeQty;
  /** which sample to compare: the value at the end, or the extreme over the run */
  compare: "final" | "max" | "min";
  /** an equation whose result the simulation should reproduce; empty for a plain readout */
  predicted_by: string;
  tolerance_pct: number;
}

export interface Simulation {
  title: string;
  description: string;
  gravity: number;
  duration_s: number;
  ground: boolean;
  bodies: SimBody[];
  joints: SimJoint[];
  probes: SimProbe[];
}

export interface ResearchNote {
  topic: string;
  explanation: string;
  key_equations: string[];
  further_reading: string[];
}

export interface Revision {
  round: number;
  critique: string;
  changes: string[];
  lessons: string[];
}

export interface Design {
  title: string;
  idea: string;
  summary: string;
  objective: string;
  operating_context: string;
  constraints: string[];
  requirements: Requirement[];
  assumptions: string[];
  components: Component[];
  variables: Variable[];
  equations: Equation[];
  trade_study: TradeStudy;
  risks: Risk[];
  simulation: Simulation;
  research: ResearchNote[];
  open_questions: string[];
  trl: number;
  next_steps: string[];
  revisions: Revision[];
}
