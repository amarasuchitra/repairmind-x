/** Types and calls for the repair-to-design bridge (agent/repairmind/redesign). */

export type ValueSource = "measured" | "label" | "spec" | "user" | "estimated" | "";
export type Outcome = "pending" | "holding" | "failed_again";

export interface Measure {
  name: string;
  value: string;
  source: ValueSource;
}

export interface DesignBrief {
  id: string;
  room: string;
  device: string;
  brand: string;
  model: string;
  part: string;
  part_function: string;
  observations: string[];
  diagnosis: string;
  failure_mode: string;
  failure_mode_certainty: "seen" | "suspected" | "";
  material: string;
  material_source: ValueSource;
  dimensions: Measure[];
  operating: Measure[];
  constraints: string[];
  manufacturing: string;
  safety_factor: number;
  share_to_library: boolean;
}

export interface Check {
  ready: boolean;
  blocked: string;
  needs_signoff: boolean;
  signoff_reason: string;
  errors: string[];
  missing: string[];
  assumptions: string[];
  suggested_modes: { id: string; name: string; matches: number }[];
  required_analyses: { id: string; text: string }[];
}

export interface FailureMode {
  id: string;
  name: string;
  signs: string[];
  causes: string[];
  analyses: string[];
  design_fixes: string[];
  questions: string[];
}

export interface LibraryRecord {
  brief_id: string;
  added_at: number;
  device: string;
  brand: string;
  model: string;
  part: string;
  function: string;
  failure_mode: string;
  certainty: string;
  material: string;
  outcome: Outcome;
}

export interface LibraryStats {
  total: number;
  by_mode: { id: string; name: string; count: number }[];
  outcomes: Partial<Record<Outcome, number>>;
}

export const EMPTY_BRIEF: DesignBrief = {
  id: "", room: "", device: "", brand: "", model: "", part: "", part_function: "", observations: [], diagnosis: "",
  failure_mode: "unknown", failure_mode_certainty: "", material: "", material_source: "", dimensions: [], operating: [],
  constraints: [], manufacturing: "", safety_factor: 1.5, share_to_library: false,
};

/** The design lab reads {idea, context} from here once, then removes it (see web/src/lab/Lab.tsx BRIEF_KEY). */
export const LAB_BRIEF_KEY = "rmx.lab.brief";
export const BRIEF_ID_KEY = "rmx.redesign.briefId";
export const LAST_CALL_KEY = "rmx.lastCallRoom";

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    throw new Error(typeof detail === "string" ? detail : res.status >= 500 ? "Can't reach the RepairMind server." : `Error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the page still works, it just won't remember */
  }
}

export function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
