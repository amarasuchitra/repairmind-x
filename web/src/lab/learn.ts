/**
 * The learning path: predict, then see. Each step names an equation of the design and a variable it depends on. The
 * page itself multiplies that variable and recomputes the equation with units (analysis.ts), so the answer the learner
 * sees is never the model's claim. The scaling law (direct, square, inverse...) is read off the numbers.
 */
import { analyze } from "./analysis.ts";
import type { Design, LearnStep } from "./design.ts";

export type Level = "beginner" | "student" | "engineer";
export const LEVELS: Level[] = ["beginner", "student", "engineer"];
const LEVEL_KEY = "rmx.learn.level";

export function readLevel(): Level {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    return LEVELS.includes(v as Level) ? (v as Level) : "beginner";
  } catch {
    return "beginner";
  }
}
export function storeLevel(l: Level) {
  try { localStorage.setItem(LEVEL_KEY, l); } catch { /* kept for this visit */ }
}

export interface Step extends LearnStep {
  /** true when built by the page from the equations because the design came without a learning path */
  generated: boolean;
}

/** Variables an equation depends on, directly or through earlier equations. */
function variablesBehind(design: Design, eqId: string): string[] {
  const vars = new Set(design.variables.map((v) => v.symbol));
  const bySymbol = new Map(design.equations.map((e) => [e.symbol, e]));
  const a = analyze(design);
  const deps = new Map(a.equations.map((r) => [r.eq.symbol, r.deps]));
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (sym: string) => {
    for (const d of deps.get(sym) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (vars.has(d)) out.push(d);
      else if (bySymbol.has(d)) walk(d);
    }
  };
  const eq = design.equations.find((e) => e.id === eqId);
  if (eq) walk(eq.symbol);
  return out;
}

/** The design's own learning path, keeping only steps the page can actually run; else one built from the equations. */
export function learnSteps(design: Design): Step[] {
  const good = (design.learn ?? []).filter((s) => {
    if (!(s.try_factor > 0) || s.try_factor === 1) return false;
    return variablesBehind(design, s.equation_id).includes(s.try_variable);
  });
  if (good.length) return good.map((s) => ({ ...s, generated: false }));
  const vars = new Map(design.variables.map((v) => [v.symbol, v]));
  const checked = [...design.equations].sort((a, b) => Number(b.check.kind !== "none") - Number(a.check.kind !== "none"));
  const out: Step[] = [];
  for (const eq of checked) {
    const v = variablesBehind(design, eq.id).find((s) => (vars.get(s)?.value ?? 0) !== 0);
    if (!v) continue;
    const req = design.requirements.find((r) => r.id === eq.requirement_id);
    out.push({
      concept: eq.name, intuition: eq.explanation, why_here: req ? req.text : eq.assumptions,
      equation_id: eq.id, walkthrough: [`${eq.symbol} = ${eq.expression}`], try_variable: v, try_factor: 2,
      question: "", explain_after: eq.assumptions, generated: true,
    });
    if (out.length >= 4) break;
  }
  return out;
}

export type Direction = "up" | "same" | "down";

export interface Outcome {
  before: number; after: number; unit: string;
  varBefore: number; varAfter: number; varUnit: string; varName: string; eqName: string;
  ratio: number; direction: Direction;
  /** how the result scales with the variable, when it follows a simple law */
  law: "direct" | "square" | "cube" | "sqrt" | "inverse" | "inverse_square" | "none" | "other";
  passBefore: boolean | null; passAfter: boolean | null; marginAfter: number | null;
}

/** Run a step's experiment: multiply the variable, recompute everything, compare the equation before and after. */
export function experiment(design: Design, overrides: Record<string, number>, step: LearnStep): Outcome | null {
  const v = design.variables.find((x) => x.symbol === step.try_variable);
  const eq = design.equations.find((e) => e.id === step.equation_id);
  if (!v || !eq) return null;
  const base = overrides[v.symbol] ?? v.value;
  const a = analyze(design, overrides).equations.find((r) => r.eq.id === eq.id);
  const b = analyze(design, { ...overrides, [v.symbol]: base * step.try_factor }).equations.find((r) => r.eq.id === eq.id);
  if (!a || !b || a.value === null || b.value === null) return null;
  const ratio = a.value === 0 ? (b.value === 0 ? 1 : Infinity) : b.value / a.value;
  const close = (x: number, y: number) => Math.abs(x - y) <= 0.02 * Math.max(Math.abs(y), 1e-12);
  const f = step.try_factor;
  const law: Outcome["law"] = close(ratio, 1) ? "none"
    : close(ratio, f) ? "direct" : close(ratio, f * f) ? "square" : close(ratio, f ** 3) ? "cube"
    : close(ratio, Math.sqrt(f)) ? "sqrt" : close(ratio, 1 / f) ? "inverse" : close(ratio, 1 / (f * f)) ? "inverse_square" : "other";
  const direction: Direction = close(ratio, 1) ? "same" : b.value > a.value ? "up" : "down";
  return {
    before: a.value, after: b.value, unit: eq.unit, varBefore: base, varAfter: base * f, varUnit: v.unit, varName: v.name,
    eqName: eq.name, ratio, direction, law, passBefore: a.pass, passAfter: b.pass, marginAfter: b.margin,
  };
}
