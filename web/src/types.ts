export type RiskLevel = "green" | "amber" | "red";

export interface StepView {
  id: string;
  text: string;
  status: "pending" | "awaiting_confirmation" | "active" | "done" | "failed" | "blocked";
  risk: RiskLevel;
  irreversible: string[];
  source: string;
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
}

export interface Alert {
  kind: string;
  message: string;
}

export const TOPIC_STATE = "rmx.state";
export const TOPIC_MARKER = "rmx.marker";
export const TOPIC_ALERT = "rmx.alert";
export const TOPIC_ESCALATION = "rmx.escalation";
