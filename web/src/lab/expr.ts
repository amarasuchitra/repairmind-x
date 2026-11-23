/**
 * A small, safe expression language for engineering equations, evaluated with units.
 *
 *   sigma = M * c / I        F = m * a        v = sqrt(2 * g * h)
 *
 * Numbers, symbols, + - * / ^, parentheses and a fixed list of functions. No property access, no calls
 * to anything not on the list, so expressions written by a model can be evaluated in the page safely.
 */

import { DIMLESS, dimEq, dimIsNone, dimLabel, dimMul, dimPow, type Dim } from "./units.ts";

export interface Q {
  v: number;
  dim: Dim;
}

type Node =
  | { k: "num"; v: number }
  | { k: "sym"; name: string }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { k: "call"; fn: string; args: Node[] };

export class ExprError extends Error {}

/** Physical constants available in every expression (SI). */
export const CONSTANTS: Record<string, Q> = {
  pi: { v: Math.PI, dim: DIMLESS },
  e: { v: Math.E, dim: DIMLESS },
  g0: { v: 9.80665, dim: [1, 0, -2, 0, 0, 0, 0] },
  G_grav: { v: 6.6743e-11, dim: [3, -1, -2, 0, 0, 0, 0] },
  sigma_sb: { v: 5.670374419e-8, dim: [0, 1, -3, 0, -4, 0, 0] },
  R_gas: { v: 8.314462618, dim: [2, 1, -2, 0, -1, -1, 0] },
  c_light: { v: 299792458, dim: [1, 0, -1, 0, 0, 0, 0] },
  k_B: { v: 1.380649e-23, dim: [2, 1, -2, 0, -1, 0, 0] },
  mu0: { v: 1.25663706212e-6, dim: [1, 1, -2, -2, 0, 0, 0] },
  eps0: { v: 8.8541878128e-12, dim: [-3, -1, 4, 2, 0, 0, 0] },
};

const FUNCS = new Set(["sqrt", "cbrt", "abs", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "exp", "ln", "log",
  "log10", "min", "max", "pow", "sinh", "cosh", "tanh", "floor", "ceil", "round"]);

function tokenize(src: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\*\*|[-+*/^(),]))/y;
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new ExprError(`unexpected "${src[i]}"`);
    out.push(m[1] ?? m[2] ?? (m[3] === "**" ? "^" : m[3]));
    i = re.lastIndex;
  }
  return out;
}

export function parseExpr(src: string): Node {
  if (src.length > 500) throw new ExprError("expression too long");
  const t = tokenize(src.replace(/[×·]/g, "*").replace(/−/g, "-"));
  let i = 0;
  const peek = () => t[i];
  const eat = (s?: string) => {
    const x = t[i++];
    if (s !== undefined && x !== s) throw new ExprError(`expected "${s}"`);
    return x;
  };
  // precedence: + - < * / < unary - < ^ (right assoc)
  function sum(): Node {
    let a = prod();
    while (peek() === "+" || peek() === "-") { const op = eat() as "+" | "-"; a = { k: "bin", op, a, b: prod() }; }
    return a;
  }
  function prod(): Node {
    let a = unary();
    while (peek() === "*" || peek() === "/") { const op = eat() as "*" | "/"; a = { k: "bin", op, a, b: unary() }; }
    return a;
  }
  function unary(): Node {
    if (peek() === "-") { eat(); return { k: "neg", a: unary() }; }
    if (peek() === "+") { eat(); return unary(); }
    return power();
  }
  function power(): Node {
    const a = atom();
    if (peek() === "^") { eat(); return { k: "bin", op: "^", a, b: unary() }; }
    return a;
  }
  function atom(): Node {
    const x = eat();
    if (x === undefined) throw new ExprError("unexpected end");
    if (x === "(") { const a = sum(); eat(")"); return a; }
    if (/^[\d.]/.test(x)) return { k: "num", v: Number(x) };
    if (/^[A-Za-z_]/.test(x)) {
      if (peek() === "(") {
        if (!FUNCS.has(x)) throw new ExprError(`unknown function "${x}"`);
        eat("(");
        const args: Node[] = [];
        if (peek() !== ")") { args.push(sum()); while (peek() === ",") { eat(); args.push(sum()); } }
        eat(")");
        return { k: "call", fn: x, args };
      }
      return { k: "sym", name: x };
    }
    throw new ExprError(`unexpected "${x}"`);
  }
  const node = sum();
  if (i < t.length) throw new ExprError(`unexpected "${t[i]}"`);
  return node;
}

/** Every symbol an expression reads (not constants, not functions). */
export function symbolsOf(node: Node, out = new Set<string>()): Set<string> {
  switch (node.k) {
    case "sym": if (!(node.name in CONSTANTS)) out.add(node.name); break;
    case "neg": symbolsOf(node.a, out); break;
    case "bin": symbolsOf(node.a, out); symbolsOf(node.b, out); break;
    case "call": node.args.forEach((a) => symbolsOf(a, out)); break;
  }
  return out;
}

function needNone(q: Q, what: string) {
  if (!dimIsNone(q.dim)) throw new ExprError(`${what} needs a dimensionless argument, got ${dimLabel(q.dim)}`);
}

export function evaluate(node: Node, env: Record<string, Q>): Q {
  switch (node.k) {
    case "num": return { v: node.v, dim: DIMLESS };
    case "sym": {
      const q = env[node.name] ?? CONSTANTS[node.name];
      if (!q) throw new ExprError(`"${node.name}" is not defined`);
      return q;
    }
    case "neg": { const a = evaluate(node.a, env); return { v: -a.v, dim: a.dim }; }
    case "bin": {
      const a = evaluate(node.a, env);
      const b = evaluate(node.b, env);
      switch (node.op) {
        case "+": case "-":
          if (!dimEq(a.dim, b.dim)) {
            throw new ExprError(`can't ${node.op === "+" ? "add" : "subtract"} ${dimLabel(a.dim)} and ${dimLabel(b.dim)}`);
          }
          return { v: node.op === "+" ? a.v + b.v : a.v - b.v, dim: a.dim };
        case "*": return { v: a.v * b.v, dim: dimMul(a.dim, b.dim) };
        case "/": return { v: a.v / b.v, dim: dimMul(a.dim, b.dim, -1) };
        case "^":
          needNone(b, "an exponent");
          return { v: a.v ** b.v, dim: dimPow(a.dim, b.v) };
      }
    }
    // falls through never
    case "call": {
      const args = node.args.map((x) => evaluate(x, env));
      const n = (c: number) => { if (args.length !== c) throw new ExprError(`${node.fn} takes ${c} argument(s)`); };
      const one = (f: (x: number) => number): Q => { n(1); needNone(args[0], node.fn); return { v: f(args[0].v), dim: DIMLESS }; };
      switch (node.fn) {
        case "sqrt": n(1); return { v: Math.sqrt(args[0].v), dim: dimPow(args[0].dim, 0.5) };
        case "cbrt": n(1); return { v: Math.cbrt(args[0].v), dim: dimPow(args[0].dim, 1 / 3) };
        case "abs": n(1); return { v: Math.abs(args[0].v), dim: args[0].dim };
        case "floor": n(1); return { v: Math.floor(args[0].v), dim: args[0].dim };
        case "ceil": n(1); return { v: Math.ceil(args[0].v), dim: args[0].dim };
        case "round": n(1); return { v: Math.round(args[0].v), dim: args[0].dim };
        case "pow": n(2); needNone(args[1], "pow's exponent"); return { v: args[0].v ** args[1].v, dim: dimPow(args[0].dim, args[1].v) };
        case "min": case "max": {
          if (!args.length) throw new ExprError(`${node.fn} needs arguments`);
          if (!args.every((x) => dimEq(x.dim, args[0].dim))) throw new ExprError(`${node.fn} mixes different units`);
          return { v: (node.fn === "min" ? Math.min : Math.max)(...args.map((x) => x.v)), dim: args[0].dim };
        }
        case "atan2":
          n(2);
          if (!dimEq(args[0].dim, args[1].dim)) throw new ExprError("atan2 needs both arguments in the same unit");
          return { v: Math.atan2(args[0].v, args[1].v), dim: DIMLESS };
        case "sin": return one(Math.sin);
        case "cos": return one(Math.cos);
        case "tan": return one(Math.tan);
        case "asin": return one(Math.asin);
        case "acos": return one(Math.acos);
        case "atan": return one(Math.atan);
        case "sinh": return one(Math.sinh);
        case "cosh": return one(Math.cosh);
        case "tanh": return one(Math.tanh);
        case "exp": return one(Math.exp);
        case "ln": case "log": return one(Math.log);
        case "log10": return one(Math.log10);
      }
      throw new ExprError(`unknown function "${node.fn}"`);
    }
  }
}
