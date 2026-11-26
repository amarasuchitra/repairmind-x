export type RiskLevel = "green" | "amber" | "red";

export interface StepView {
  id: string;
  text: string;
  status: "pending" | "awaiting_confirmation" | "active" | "done" | "failed" | "blocked";
  risk: RiskLevel;
  irreversible: string[];
  source: string;
  cross_checked?: boolean;
}

export interface SessionView {
  session_id: string;
  device: string;
  device_type: string;
  model_confirmed: boolean;
  risk_level: RiskLevel;
  risk_reasons: string[];
  precautions: { id: string; text: string; done: boolean }[];
  diagnosis: string;
  confidence: number;
  hypotheses: { cause: string; confidence: number }[];
  steps: StepView[];
  hazard: string;
  escalated: boolean;
}

export interface Marker {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  precise?: boolean;
  image?: string; // the exact frame the mechanic analysed, as a data URL
  id?: number; // new id = new target; the live AR overlay restarts tracking
  action?: "" | "press" | "pull" | "lift" | "turn_cw" | "turn_ccw" | "slide_left" | "slide_right";
  step_id?: string; // motion arrows belong to this step and disappear when it is no longer active
  clear?: boolean; // remove the overlay
}

export interface Alert {
  kind: string;
  message: string;
}

export const TOPIC_STATE = "rmx.state";
export const TOPIC_MARKER = "rmx.marker";
export const TOPIC_ALERT = "rmx.alert";
export const TOPIC_ESCALATION = "rmx.escalation";
export const TOPIC_AR = "rmx.ar"; // client -> agent: {event: "lost", id}

export const TOPIC_3D = "rmx.3d";
export const TOPIC_ASK = "rmx.ask"; // client -> agent: {kind: "circle", box, question, image} | {kind: "next"}
export const TOPIC_DIAGRAM = "rmx.diagram";
export const TOPIC_NOTES = "rmx.notes"; // agent -> app: {notes: [{at, text}]}
export const TOPIC_PARTS = "rmx.parts"; // agent -> app: {parts: PartSearch[]}

export interface PartSearch {
  part: string;
  number: string;
  query: string;
  links: { shop: string; url: string }[];
}

/** Teach mode: numbered parts on a still of the camera. Boxes are centre + size, fractions of the image. */
export interface Diagram {
  title: string;
  image: string;
  items: { n: number; label: string; x: number; y: number; w: number; h: number }[];
}

export interface Step3D {
  product_id: string;
  procedure_id: string;
  step_id: string;
  highlight: string[];
  move: Record<string, number[]>;
  hide: string[];
  caption: string;
  illustrative: boolean;
}

export interface Part3D {
  name: string;
  label: string;
  shape: "box" | "cylinder" | "sphere" | "torus";
  size: number[];
  position: number[];
  rotation: number[];
  color: string;
}

export interface Product3D {
  id: string;
  name: string;
  illustrative: boolean;
  model_url: string;
  parts: Part3D[];
}
