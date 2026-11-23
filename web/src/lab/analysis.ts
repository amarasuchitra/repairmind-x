/**
 * Recomputes a design: every equation in dependency order with units checked, margins of safety,
 * FMEA risk priority numbers and the weighted trade study. It also produces "findings", the list of
 * things that are wrong or unproven, which the design agent gets back when it is asked to rethink.
 */

import type { Design, Equation } from "./design.ts";
import { ExprError, evaluate, parseExpr, symbolsOf, type Q } from "./expr.ts";
import { dimEq, dimLabel, fmt, tryUnit } from "./units.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  where: string;
  text: string;
}

export interface EqResult {
  eq: Equation;
  /** in the equation's declared unit */
  value: number | null;
  si: Q | null;
  error: string;
  /** margin of safety, when the equation has a check */
  margin: number | null;
  pass: boolean | null;
  deps: string[];
}

export interface RiskRow {
  id: string;
  rpn: number;
  level: "high" | "medium" | "low";
}

export interface TradeRow {
  name: string;
  total: number;
  rank: number;
}

export interface Analysis {
  env: Record<string, Q>;
  equations: EqResult[];
  risks: RiskRow[];
  trade: TradeRow[];
  findings: Finding[];
  totalMassKg: number;
}

/** Margin of safety (NASA-STD-5001 style): MS = allowable / (applied × FS) − 1, pass when ≥ 0. */
export function marginOfSafety(kind: "max" | "min", applied: number, limit: number, fs: number): number {
  const f = fs > 0 ? fs : 1;
  return kind === "max" ? limit / (applied * f) - 1 : applied / (limit * f) - 1;
}

export function rpnLevel(rpn: number, severity: number): RiskRow["level"] {
  if (rpn >= 200 || severity >= 9) return "high";
  if (rpn >= 80 || severity >= 7) return "medium";
  return "low";
}

/** " kg" for a unit, nothing for dimensionless */
const u = (unit: string) => (!unit || unit === "1" ? "" : ` ${unit}`);
const clamp10 = (n: number) => Math.min(10, Math.max(1, Math.round(Number(n) || 1)));

/**
 * @param overrides variable values the user has edited, in each variable's own unit
 */
export function analyze(design: Design, overrides: Record<string, number> = {}): Analysis {
  const findings: Finding[] = [];
  const env: Record<string, Q> = {};

  for (const v of design.variables) {
    const u = tryUnit(v.unit);
    if (!u) {
      findings.push({ severity: "error", where: `variable ${v.symbol}`, text: `unknown unit "${v.unit}"` });
      continue;
    }
    if (env[v.symbol]) findings.push({ severity: "warning", where: `variable ${v.symbol}`, text: "defined twice" });
    const value = overrides[v.symbol] ?? v.value;
    if (!Number.isFinite(value)) findings.push({ severity: "error", where: `variable ${v.symbol}`, text: "has no numeric value" });
    env[v.symbol] = { v: value * u.scale, dim: u.dim };
    if (!v.source.trim()) findings.push({ severity: "info", where: `variable ${v.symbol}`, text: "no source given for this value" });
  }

  // parse, then evaluate in dependency order (an equation can use symbols defined by others)
  const parsed = design.equations.map((eq) => {
    try {
      const node = parseExpr(eq.expression);
      return { eq, node, deps: [...symbolsOf(node)], error: "" };
    } catch (e) {
      return { eq, node: null, deps: [] as string[], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const bySymbol = new Map(parsed.map((p) => [p.eq.symbol, p]));
  const results = new Map<string, EqResult>();
  const visiting = new Set<string>();

  function run(p: (typeof parsed)[number]): EqResult {
    const done = results.get(p.eq.id);
    if (done) return done;
    const r: EqResult = { eq: p.eq, value: null, si: null, error: p.error, margin: null, pass: null, deps: p.deps };
    if (p.node && !p.error) {
      if (visiting.has(p.eq.id)) {
        r.error = "circular: this equation depends on itself";
      } else {
        visiting.add(p.eq.id);
        for (const s of p.deps) {
          const dep = bySymbol.get(s);
          if (dep && !(s in env) && dep !== p) run(dep);
        }
        visiting.delete(p.eq.id);
        try {
          const q = evaluate(p.node, env);
          const u = tryUnit(p.eq.unit);
          if (!u) throw new ExprError(`unknown unit "${p.eq.unit}"`);
          if (!dimEq(q.dim, u.dim)) {
            throw new ExprError(`units don't match: the expression gives ${dimLabel(q.dim)} but the result is declared in ${p.eq.unit} (${dimLabel(u.dim)})`);
          }
          if (!Number.isFinite(q.v)) throw new ExprError("result is not a finite number (check for division by zero or a negative square root)");
          r.si = q;
          r.value = q.v / u.scale;
          env[p.eq.symbol] = q;
        } catch (e) {
          r.error = e instanceof Error ? e.message : String(e);
        }
      }
    }
    const c = p.eq.check;
    if (r.si && c && c.kind !== "none") {
      const lu = tryUnit(c.limit_unit || p.eq.unit);
      if (!lu || !dimEq(lu.dim, r.si.dim)) {
        findings.push({ severity: "error", where: `${p.eq.id} check`, text: `limit unit "${c.limit_unit}" doesn't match the result's unit` });
      } else {
        r.margin = marginOfSafety(c.kind, r.si.v, c.limit * lu.scale, c.factor_of_safety);
        r.pass = r.margin >= 0;
        if (!r.pass) {
          findings.push({
            severity: "error", where: `${p.eq.id} ${p.eq.name}`,
            text: `fails its check "${c.label}": ${p.eq.symbol} = ${fmt(r.value!)}${u(p.eq.unit)} against a ${c.kind === "max" ? "maximum" : "minimum"} of ${fmt(c.limit)}${u(c.limit_unit || p.eq.unit)} with factor of safety ${c.factor_of_safety}; margin of safety ${(r.margin * 100).toFixed(1)}%`,
          });
        } else if (r.margin > 4) {
          findings.push({ severity: "info", where: `${p.eq.id} ${p.eq.name}`, text: `margin of safety is ${(r.margin * 100).toFixed(0)}%: likely over-designed (mass and cost to save)` });
        }
      }
    }
    if (r.error) findings.push({ severity: "error", where: `${p.eq.id} ${p.eq.name}`, text: r.error });
    results.set(p.eq.id, r);
    return r;
  }
  parsed.forEach(run);

  // requirements that nothing verifies
  const reqIds = new Set(design.requirements.map((r) => r.id));
  for (const eq of design.equations) {
    if (eq.requirement_id && !reqIds.has(eq.requirement_id)) {
      findings.push({ severity: "warning", where: eq.id, text: `refers to requirement ${eq.requirement_id}, which doesn't exist` });
    }
  }
  for (const r of design.requirements) {
    if (r.verification === "analysis" && !design.equations.some((e) => e.requirement_id === r.id)) {
      findings.push({ severity: "warning", where: `requirement ${r.id}`, text: "is to be verified by analysis, but no equation checks it" });
    }
  }

  const risks: RiskRow[] = design.risks.map((k) => {
    const s = clamp10(k.severity);
    const rpn = s * clamp10(k.occurrence) * clamp10(k.detection);
    const level = rpnLevel(rpn, s);
    if (level === "high" && !k.mitigation.trim()) {
      findings.push({ severity: "error", where: `risk ${k.id}`, text: `high risk (RPN ${rpn}) with no mitigation` });
    } else if (level === "high") {
      findings.push({ severity: "warning", where: `risk ${k.id}`, text: `RPN ${rpn} is still high; show how the mitigation lowers occurrence or improves detection` });
    }
    return { id: k.id, rpn, level };
  });

  const ts = design.trade_study;
  const wsum = ts.criteria.reduce((a, c) => a + Math.max(0, c.weight), 0) || 1;
  const trade = ts.options
    .map((o) => ({ name: o.name, total: ts.criteria.reduce((a, c, i) => a + (Math.max(0, c.weight) / wsum) * (o.scores[i] ?? 0), 0), rank: 0 }))
    .sort((a, b) => b.total - a.total)
    .map((t, i) => ({ ...t, rank: i + 1 }));
  if (trade.length && ts.recommendation && !ts.recommendation.toLowerCase().includes(trade[0].name.toLowerCase())) {
    findings.push({ severity: "warning", where: "trade study", text: `the recommendation doesn't name the top-scoring option (${trade[0].name})` });
  }

  const totalMassKg = design.components.reduce((a, c) => a + (Number(c.mass_kg) || 0), 0);
  return { env, equations: parsed.map((p) => results.get(p.eq.id)!), risks, trade, findings, totalMassKg };
}

/** Findings as plain text for the design agent's next round. */
export function findingsText(f: Finding[]): string {
  return f.filter((x) => x.severity !== "info").map((x) => `- [${x.severity}] ${x.where}: ${x.text}`).join("\n");
}
