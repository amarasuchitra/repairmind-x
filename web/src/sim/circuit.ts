/**
 * A small circuit solver: modified nodal analysis with Newton–Raphson for the non-linear parts and backward
 * Euler for capacitors. It is the same method SPICE uses, cut down to the elements a hobby project needs:
 * resistors, batteries and adapters (a voltage with an internal resistance), LEDs and diodes (Shockley
 * equation), capacitors, the loads of modules that regulate their own current, linear regulators and
 * boost converters. Plain functions over plain data, so it runs the same in the page and in the tests.
 *
 * Node "gnd" is 0 V. Every other node is a string the netlist makes up.
 */

export type El =
  /** a resistor */
  | { k: "R"; id: string; a: string; b: string; ohm: number }
  /** a source: V(p) − V(n) = v with no current; r is its internal resistance (battery, adapter, cable) */
  | { k: "V"; id: string; p: string; n: string; v: number; r: number }
  /** a diode or LED from anode a to cathode c: I = Is·(e^(V/(n·Vt)) − 1), plus a series resistance */
  | { k: "D"; id: string; a: string; c: string; is: number; n: number; rs: number }
  /** a capacitor (open in the DC solution) */
  | { k: "C"; id: string; a: string; b: string; f: number }
  /** a module that regulates its own draw: i amps from a to b when it has at least vmin across it, less below */
  | { k: "load"; id: string; a: string; b: string; i: number; vmin: number }
  /** a linear regulator from in to out (AMS1117 and the like): out = min(vset, in − dropout), plus quiescent current */
  | { k: "ldo"; id: string; in: string; out: string; vset: number; vdo: number; iq: number }
  /** a boost converter: out = vset once in ≥ vstart; it draws the output power ÷ efficiency from in */
  | { k: "boost"; id: string; in: string; out: string; vset: number; vstart: number; eff: number };

export interface Solution {
  ok: boolean;
  /** node voltages */
  v: Record<string, number>;
  /** current through each element, in its own direction (a→b, p→n through the source's + terminal out, anode→cathode, in→out) */
  i: Record<string, number>;
  /** power each element turns into heat, in W (for a source: the heat in its internal resistance) */
  p: Record<string, number>;
  iterations: number;
}

const VT = 0.025852;
const GMIN = 1e-9;

/** Shockley parameters for an LED with a forward voltage vf at 20 mA. */
export function ledModel(vf: number): { is: number; n: number; rs: number } {
  const n = 2, rs = 15;
  const vj = vf - 0.02 * rs;
  return { is: 0.02 / Math.exp(vj / (n * VT)), n, rs };
}

/** A silicon signal diode (1N4148-ish), and the protection diodes inside a chip's input pin. */
export const SI_DIODE = { is: 2.5e-9, n: 1.75, rs: 0.6 };

interface State {
  /** capacitor voltages from the last time step */
  cap: Record<string, number>;
}

export function newState(): State {
  return { cap: {} };
}

/**
 * Solves the circuit. With dt, capacitors act as their backward-Euler companion (a conductance and a current)
 * and st carries their voltages between steps; without it, the DC operating point.
 */
export function solve(els: El[], opts: { dt?: number; state?: State; guess?: Record<string, number> } = {}): Solution {
  const dt = opts.dt;
  const st = opts.state ?? newState();
  // diodes get an internal node for their series resistance
  const nodes = new Map<string, number>();
  const idx = (n: string) => {
    if (n === "gnd") return -1;
    let k = nodes.get(n);
    if (k === undefined) { k = nodes.size; nodes.set(n, k); }
    return k;
  };
  const inner = (e: { id: string }) => `${e.id}#j`;
  for (const e of els) {
    switch (e.k) {
      case "R": case "C": case "load": idx(e.a); idx(e.b); break;
      case "V": idx(e.p); idx(e.n); break;
      case "D": idx(e.a); idx(e.c); if (e.rs > 0) idx(inner(e)); break;
      case "ldo": case "boost": idx(e.in); idx(e.out); break;
    }
  }
  const N = nodes.size;
  const x = new Float64Array(N);
  // start from the sources' own voltages: Newton converges from there without wandering through 0 V
  for (const e of els) if (e.k === "V" && e.n === "gnd") x[idx(e.p)] = e.v;
  if (opts.guess) for (const [n, k] of nodes) if (Number.isFinite(opts.guess[n])) x[k] = opts.guess[n];
  const V = (n: string) => { const k = nodes.get(n); return k === undefined ? 0 : x[k]; };

  // fixed-point quantities for the regulators, updated each iteration
  const ldoDrop: Record<string, number> = {};
  const boostIn: Record<string, number> = {};
  const boostOn: Record<string, boolean> = {};
  for (const e of els) {
    if (e.k === "ldo") ldoDrop[e.id] = e.vdo;
    if (e.k === "boost") { boostIn[e.id] = 0; boostOn[e.id] = true; }
  }

  let iterations = 0;
  let ok = false;
  const G = Array.from({ length: N }, () => new Float64Array(N));
  const I = new Float64Array(N);
  for (; iterations < 200; iterations++) {
    for (let r = 0; r < N; r++) { G[r].fill(0); I[r] = 0; G[r][r] = GMIN; }
    const stamp = (a: number, b: number, g: number) => {
      if (a >= 0) G[a][a] += g;
      if (b >= 0) G[b][b] += g;
      if (a >= 0 && b >= 0) { G[a][b] -= g; G[b][a] -= g; }
    };
    /** a current j flowing out of node a and into node b */
    const inject = (a: number, b: number, j: number) => {
      if (a >= 0) I[a] -= j;
      if (b >= 0) I[b] += j;
    };
    /** a Thevenin source: V(p) − V(n) = v behind r */
    const thevenin = (p: number, n: number, v: number, r: number) => {
      const g = 1 / Math.max(r, 1e-4);
      stamp(p, n, g);
      inject(n, p, v * g);
    };
    for (const e of els) {
      switch (e.k) {
        case "R": stamp(idx(e.a), idx(e.b), 1 / Math.max(e.ohm, 1e-4)); break;
        case "V": thevenin(idx(e.p), idx(e.n), e.v, e.r); break;
        case "C": {
          if (!dt) break;
          const g = e.f / dt;
          stamp(idx(e.a), idx(e.b), g);
          inject(idx(e.b), idx(e.a), g * (st.cap[e.id] ?? 0));
          break;
        }
        case "D": {
          const a = idx(e.a), j = e.rs > 0 ? idx(inner(e)) : idx(e.c), c = idx(e.c);
          if (e.rs > 0) stamp(j, c, 1 / e.rs);
          const nvt = e.n * VT;
          const vd = Math.min((a >= 0 ? x[a] : 0) - (j >= 0 ? x[j] : 0), 60 * nvt);
          const ex = Math.exp(vd / nvt);
          const id = e.is * (ex - 1);
          const gd = (e.is * ex) / nvt + GMIN;
          stamp(a, j, gd);
          inject(a, j, id - gd * vd);
          break;
        }
        case "load": {
          const a = idx(e.a), b = idx(e.b);
          const vab = V(e.a) - V(e.b);
          const vmin = Math.max(e.vmin, 0.05);
          if (vab >= vmin) inject(a, b, e.i);
          else if (vab > 0) { const g = e.i / vmin; stamp(a, b, g); }
          else stamp(a, b, e.i / vmin);
          break;
        }
        case "ldo": {
          thevenin(idx(e.in), idx(e.out), ldoDrop[e.id], 0.05);
          inject(idx(e.in), -1, e.iq);
          break;
        }
        case "boost": {
          const o = idx(e.out);
          if (boostOn[e.id]) thevenin(o, -1, e.vset, 0.08);
          else stamp(o, -1, 1e-6);
          inject(idx(e.in), -1, boostIn[e.id]);
          break;
        }
      }
    }
    const nx = gauss(G, I);
    if (!nx) break;
    // limit how far a step can move, so diodes don't jump to huge currents between iterations
    let dmax = 0;
    for (let k = 0; k < N; k++) {
      let d = nx[k] - x[k];
      if (Math.abs(d) > 0.5) d = Math.sign(d) * 0.5;
      x[k] += d;
      dmax = Math.max(dmax, Math.abs(d));
    }
    // update the regulators from the new voltages
    let fp = 0;
    for (const e of els) {
      if (e.k === "ldo") {
        const drop = Math.max(e.vdo, V(e.in) - e.vset);
        const vin = V(e.in);
        const want = vin <= e.vdo ? Math.max(vin, 0) : drop;
        fp = Math.max(fp, Math.abs(want - ldoDrop[e.id]));
        ldoDrop[e.id] += 0.7 * (want - ldoDrop[e.id]);
      }
      if (e.k === "boost") {
        const vin = V(e.in);
        const on = boostOn[e.id] ? vin >= e.vstart * 0.95 : vin >= e.vstart;
        if (on !== boostOn[e.id]) { boostOn[e.id] = on; fp = Math.max(fp, 1); }
        const iout = on ? (e.vset - V(e.out)) / 0.08 : 0;
        // the switch inside limits the input current (about 4 A for an MT3608)
        const want = on && vin > 0.3 ? Math.min(4, Math.max(0, (V(e.out) * iout) / (e.eff * vin))) : 0;
        fp = Math.max(fp, Math.abs(want - boostIn[e.id]) * 0.1);
        boostIn[e.id] += 0.6 * (want - boostIn[e.id]);
      }
    }
    if (dmax < 1e-7 && fp < 1e-6) { ok = true; break; }
  }

  const v: Record<string, number> = { gnd: 0 };
  for (const [n, k] of nodes) v[n] = x[k];
  const i: Record<string, number> = {};
  const p: Record<string, number> = {};
  for (const e of els) {
    switch (e.k) {
      case "R": i[e.id] = (V(e.a) - V(e.b)) / Math.max(e.ohm, 1e-4); p[e.id] = i[e.id] ** 2 * Math.max(e.ohm, 1e-4); break;
      case "V": i[e.id] = (e.v - (V(e.p) - V(e.n))) / Math.max(e.r, 1e-4); p[e.id] = i[e.id] ** 2 * Math.max(e.r, 1e-4); break;
      case "C": {
        const vc = V(e.a) - V(e.b);
        i[e.id] = dt ? (e.f / dt) * (vc - (st.cap[e.id] ?? 0)) : 0;
        p[e.id] = 0;
        break;
      }
      case "D": {
        const j = e.rs > 0 ? inner(e) : e.c;
        const vd = Math.min(V(e.a) - V(j), 60 * e.n * VT);
        i[e.id] = e.is * (Math.exp(vd / (e.n * VT)) - 1);
        p[e.id] = Math.max(0, i[e.id] * (V(e.a) - V(e.c)));
        break;
      }
      case "load": {
        const vab = V(e.a) - V(e.b);
        const vmin = Math.max(e.vmin, 0.05);
        i[e.id] = vab >= vmin ? e.i : (e.i / vmin) * vab;
        p[e.id] = Math.max(0, i[e.id] * vab);
        break;
      }
      case "ldo": {
        const io = (V(e.in) - V(e.out) - ldoDrop[e.id]) / 0.05;
        i[e.id] = io;
        p[e.id] = Math.max(0, io * (V(e.in) - V(e.out)) + e.iq * V(e.in));
        break;
      }
      case "boost": {
        const io = boostOn[e.id] ? (e.vset - V(e.out)) / 0.08 : 0;
        i[e.id] = io;
        p[e.id] = Math.max(0, boostIn[e.id] * V(e.in) - io * V(e.out));
        break;
      }
    }
  }
  if (dt) for (const e of els) if (e.k === "C") st.cap[e.id] = V(e.a) - V(e.b);
  return { ok, v, i, p, iterations };
}

/** Gaussian elimination with partial pivoting; null if the matrix is singular. */
function gauss(G: Float64Array[], I: Float64Array): Float64Array | null {
  const n = I.length;
  const A = G.map((r) => Float64Array.from(r));
  const b = Float64Array.from(I);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-18) return null;
    if (piv !== c) { [A[piv], A[c]] = [A[c], A[piv]]; [b[piv], b[c]] = [b[c], b[piv]]; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const out = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * out[k];
    out[r] = s / A[r][r];
  }
  return out;
}
