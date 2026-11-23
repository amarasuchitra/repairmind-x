/**
 * Units with dimensional analysis. Every quantity is stored in SI with a dimension vector over the seven
 * SI base units, so an equation that adds metres to seconds, or claims newtons where it computes joules,
 * is caught instead of silently producing a number.
 */

/** Exponents of [m, kg, s, A, K, mol, cd]. Fractional exponents are allowed (sqrt). */
export type Dim = readonly number[];

export const DIMLESS: Dim = [0, 0, 0, 0, 0, 0, 0];
const BASE_NAMES = ["m", "kg", "s", "A", "K", "mol", "cd"];

export interface Unit {
  /** multiply a value in this unit by `scale` to get SI */
  scale: number;
  dim: Dim;
}

const d = (m = 0, kg = 0, s = 0, A = 0, K = 0, mol = 0, cd = 0): Dim => [m, kg, s, A, K, mol, cd];

const UNITS: Record<string, Unit> = {
  "1": { scale: 1, dim: DIMLESS },
  "": { scale: 1, dim: DIMLESS },
  "%": { scale: 0.01, dim: DIMLESS },
  rad: { scale: 1, dim: DIMLESS },
  deg: { scale: Math.PI / 180, dim: DIMLESS },
  "°": { scale: Math.PI / 180, dim: DIMLESS },
  rev: { scale: 2 * Math.PI, dim: DIMLESS },
  sr: { scale: 1, dim: DIMLESS },
  // base
  m: { scale: 1, dim: d(1) },
  g: { scale: 1e-3, dim: d(0, 1) },
  s: { scale: 1, dim: d(0, 0, 1) },
  A: { scale: 1, dim: d(0, 0, 0, 1) },
  K: { scale: 1, dim: d(0, 0, 0, 0, 1) },
  mol: { scale: 1, dim: d(0, 0, 0, 0, 0, 1) },
  cd: { scale: 1, dim: d(0, 0, 0, 0, 0, 0, 1) },
  // derived SI
  Hz: { scale: 1, dim: d(0, 0, -1) },
  N: { scale: 1, dim: d(1, 1, -2) },
  Pa: { scale: 1, dim: d(-1, 1, -2) },
  J: { scale: 1, dim: d(2, 1, -2) },
  W: { scale: 1, dim: d(2, 1, -3) },
  C: { scale: 1, dim: d(0, 0, 1, 1) },
  V: { scale: 1, dim: d(2, 1, -3, -1) },
  Ohm: { scale: 1, dim: d(2, 1, -3, -2) },
  "Ω": { scale: 1, dim: d(2, 1, -3, -2) },
  F: { scale: 1, dim: d(-2, -1, 4, 2) },
  H: { scale: 1, dim: d(2, 1, -2, -2) },
  T: { scale: 1, dim: d(0, 1, -2, -1) },
  Wb: { scale: 1, dim: d(2, 1, -2, -1) },
  L: { scale: 1e-3, dim: d(3) },
  // non-SI in common engineering use
  min: { scale: 60, dim: d(0, 0, 1) },
  h: { scale: 3600, dim: d(0, 0, 1) },
  day: { scale: 86400, dim: d(0, 0, 1) },
  rpm: { scale: (2 * Math.PI) / 60, dim: d(0, 0, -1) },
  bar: { scale: 1e5, dim: d(-1, 1, -2) },
  atm: { scale: 101325, dim: d(-1, 1, -2) },
  psi: { scale: 6894.757293168, dim: d(-1, 1, -2) },
  ksi: { scale: 6894757.293168, dim: d(-1, 1, -2) },
  lbf: { scale: 4.4482216152605, dim: d(1, 1, -2) },
  lb: { scale: 0.45359237, dim: d(0, 1) },
  in: { scale: 0.0254, dim: d(1) },
  ft: { scale: 0.3048, dim: d(1) },
  mi: { scale: 1609.344, dim: d(1) },
  nmi: { scale: 1852, dim: d(1) },
  mph: { scale: 0.44704, dim: d(1, 0, -1) },
  kn: { scale: 1852 / 3600, dim: d(1, 0, -1) },
  t: { scale: 1000, dim: d(0, 1) },
  Wh: { scale: 3600, dim: d(2, 1, -2) },
  Ah: { scale: 3600, dim: d(0, 0, 1, 1) },
  eV: { scale: 1.602176634e-19, dim: d(2, 1, -2) },
  cal: { scale: 4.184, dim: d(2, 1, -2) },
  hp: { scale: 745.69987158227, dim: d(2, 1, -3) },
  gee: { scale: 9.80665, dim: d(1, 0, -2) },
};

/** Spellings people and models commonly use. */
const ALIASES: Record<string, string> = {
  ohm: "Ohm", ohms: "Ohm", sec: "s", secs: "s", hr: "h", hrs: "h", degree: "deg", degrees: "deg",
  Nm: "N*m", kmh: "km/h", kph: "km/h", "km/hr": "km/h", mAh: "mA*h", kWh: "kW*h", lbs: "lb", inch: "in",
  rads: "rad", "rad/sec": "rad/s", RPM: "rpm", percent: "%", "-": "1", none: "1", dimensionless: "1",
  G: "gee", "g0": "gee", "m/s2": "m/s^2", "m/s²": "m/s^2", "m²": "m^2", "m³": "m^3", "mm²": "mm^2",
  "kg·m²": "kg*m^2", "kg m^2": "kg*m^2",
};

const PREFIX: Record<string, number> = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1,
  d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};
/** Prefixes only make sense on these. Stops "min" parsing as milli-inch, etc. */
const PREFIXABLE = new Set(["m", "g", "s", "A", "K", "mol", "N", "Pa", "J", "W", "C", "V", "Ohm", "Ω", "F", "H", "T",
  "Hz", "L", "Wh", "Ah", "eV", "bar", "rad", "t", "Wb"]);

export function dimMul(a: Dim, b: Dim, k = 1): Dim {
  return a.map((x, i) => x + k * b[i]);
}
export function dimPow(a: Dim, p: number): Dim {
  return a.map((x) => x * p);
}
export function dimEq(a: Dim, b: Dim): boolean {
  return a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
}
export function dimIsNone(a: Dim): boolean {
  return dimEq(a, DIMLESS);
}

/** Human-readable dimension, e.g. "kg·m/s^2". */
export function dimLabel(a: Dim): string {
  const fmt = (n: string, e: number) => (Math.abs(e - 1) < 1e-9 ? n : `${n}^${+e.toFixed(3)}`);
  const num = a.map((e, i) => (e > 1e-9 ? fmt(BASE_NAMES[i], e) : "")).filter(Boolean);
  const den = a.map((e, i) => (e < -1e-9 ? fmt(BASE_NAMES[i], -e) : "")).filter(Boolean);
  if (!num.length && !den.length) return "dimensionless";
  return (num.join("·") || "1") + (den.length ? "/" + (den.length > 1 ? `(${den.join("·")})` : den[0]) : "");
}

function atom(name: string): Unit {
  if (name in UNITS) return UNITS[name];
  for (const p of Object.keys(PREFIX).sort((a, b) => b.length - a.length)) {
    if (name.startsWith(p)) {
      const rest = name.slice(p.length);
      if (PREFIXABLE.has(rest)) return { scale: PREFIX[p] * UNITS[rest].scale, dim: UNITS[rest].dim };
    }
  }
  throw new Error(`unknown unit "${name}"`);
}

const cache = new Map<string, Unit>();

/**
 * Parse a unit expression: "kg", "m/s^2", "N*m", "N·m", "W/(m*K)", "kg m^-3", "mm^4", "1/s".
 * A "/" divides by the single factor after it (or a parenthesised group), as engineers write them.
 */
export function parseUnit(text: string): Unit {
  const key = text.trim();
  const hit = cache.get(key);
  if (hit) return hit;
  const src = ALIASES[key] ?? key;
  let i = 0;
  const peek = () => src[i];
  const skipWs = () => { while (src[i] === " ") i++; };

  function factor(): Unit {
    skipWs();
    let u: Unit;
    if (peek() === "(") {
      i++;
      u = product();
      skipWs();
      if (peek() !== ")") throw new Error(`missing ")" in unit "${text}"`);
      i++;
    } else {
      const m = /^(?:[A-Za-zµμΩ°%]+|1)/.exec(src.slice(i));
      if (!m) throw new Error(`can't read unit "${text}"`);
      i += m[0].length;
      const name = ALIASES[m[0]] && !ALIASES[m[0]].includes("/") && !ALIASES[m[0]].includes("*") ? ALIASES[m[0]] : m[0];
      u = atom(name);
    }
    skipWs();
    let exp = 1;
    if (peek() === "^" || peek() === "²" || peek() === "³") {
      if (peek() === "²") { exp = 2; i++; } else if (peek() === "³") { exp = 3; i++; } else {
        i++;
        const m = /^\(?\s*(-?\d+(?:\.\d+)?(?:\/\d+)?)\s*\)?/.exec(src.slice(i));
        if (!m) throw new Error(`bad exponent in unit "${text}"`);
        i += m[0].length;
        const [a, b] = m[1].split("/");
        exp = Number(a) / (b ? Number(b) : 1);
      }
    } else {
      const m = /^-?\d+/.exec(src.slice(i));
      if (m && i > 0 && /[A-Za-z]/.test(src[i - 1])) { exp = Number(m[0]); i += m[0].length; }
    }
    return { scale: u.scale ** exp, dim: dimPow(u.dim, exp) };
  }

  function product(): Unit {
    let u = factor();
    for (;;) {
      skipWs();
      const c = peek();
      if (c === "*" || c === "·" || c === ".") { i++; const f = factor(); u = { scale: u.scale * f.scale, dim: dimMul(u.dim, f.dim) }; }
      else if (c === "/") { i++; const f = factor(); u = { scale: u.scale / f.scale, dim: dimMul(u.dim, f.dim, -1) }; }
      else if (c !== undefined && c !== ")" ) { const f = factor(); u = { scale: u.scale * f.scale, dim: dimMul(u.dim, f.dim) }; }
      else return u;
    }
  }

  const out = product();
  if (i < src.length) throw new Error(`can't read unit "${text}"`);
  cache.set(key, out);
  return out;
}

/** Try to parse; null instead of throwing. */
export function tryUnit(text: string): Unit | null {
  try {
    return parseUnit(text);
  } catch {
    return null;
  }
}

export function toSI(value: number, unit: string): number {
  return value * parseUnit(unit).scale;
}
export function fromSI(value: number, unit: string): number {
  return value / parseUnit(unit).scale;
}

/** Engineering-friendly number formatting: 4 significant figures, exponent outside 1e-3..1e6. */
export function fmt(v: number, sig = 4): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? "NaN" : v > 0 ? "∞" : "−∞";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(sig - 1).replace("e+", "e");
  return String(Number(v.toPrecision(sig)));
}
