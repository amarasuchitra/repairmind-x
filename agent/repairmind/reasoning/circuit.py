"""A small DC circuit simulator for checking diagnosis against real meter readings.

The mechanic writes down the part of the circuit it is reasoning about (from the board, the label or the
manual), the person measures a few voltages, and this module:

1. solves the healthy circuit (modified nodal analysis),
2. breaks each part in turn (open, shorted, blown, drifted) and solves again,
3. ranks the faults by how well they explain the readings, and
4. names the next point to probe: the one where the likely faults disagree most.

It is deliberately limited to extra-low voltage (60 V DC or less). Mains and high-voltage circuits are refused,
because the advice that follows a simulation would have someone probing live high-voltage parts.

Parts: R (resistor, ohms), V (voltage source, volts, a = +), I (current source, amps, from a to b), D (diode,
a = anode, vf volts, default 0.7), LED (diode with vf default 2.0), F (fuse), S (switch, closed true/false),
W (wire or solder joint). Ground is node "0" (also "gnd").
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

MAX_VOLTS = 60.0
MAX_PARTS = 80
R_ON = 0.5  # a conducting diode's series resistance
G_OFF = 1e-12  # an off diode or an open part
G_MIN = 1e-7  # a 10 MΩ meter on every node: a node a fault cut off reads about 0 V, as on a real meter
SHORT = 1e-3
GROUND = {"0", "gnd", "ground", "-"}


class Refused(ValueError):
    """The circuit is outside what this simulator will advise on."""


@dataclass
class Part:
    id: str
    type: str
    a: str
    b: str
    value: float = 0.0
    vf: float = 0.0
    closed: bool = True


@dataclass
class Fault:
    part: str
    kind: str  # open, short, high, blown, stuck_open, stuck_closed, dead, low
    label: str


@dataclass
class Solution:
    volts: dict[str, float]
    ok: bool = True


@dataclass
class Ranked:
    fault: Fault | None  # None = the healthy circuit
    probability: float
    error: float  # worst reading's miss, in tolerances
    predicted: dict[str, float] = field(default_factory=dict)


def _node(n: str) -> str:
    n = str(n).strip()
    return "0" if n.lower() in GROUND else n


def parse(netlist: list[dict]) -> list[Part]:
    if not isinstance(netlist, list) or not netlist:
        raise ValueError("the netlist is empty")
    if len(netlist) > MAX_PARTS:
        raise ValueError(f"too many parts ({len(netlist)}); simulate one section of at most {MAX_PARTS}")
    parts: list[Part] = []
    seen: set[str] = set()
    for i, raw in enumerate(netlist):
        t = str(raw.get("type", "")).upper()
        pid = str(raw.get("id") or f"{t}{i + 1}")
        if pid in seen:
            raise ValueError(f"two parts are called {pid}")
        seen.add(pid)
        a, b = _node(raw.get("a", "")), _node(raw.get("b", ""))
        if not a or not b:
            raise ValueError(f"{pid} needs both ends (a and b)")
        val = float(raw.get("value", 0) or 0)
        if t == "R":
            if val <= 0:
                raise ValueError(f"{pid} needs a resistance above 0 ohms")
        elif t in {"V", "I"}:
            if t == "V" and abs(val) > MAX_VOLTS:
                raise Refused(f"{pid} is {val:g} V. Above {MAX_VOLTS:g} V is mains or high voltage: RepairMind won't "
                              "guide live measurements there. A qualified technician should test it.")
        elif t in {"D", "LED"}:
            raw_vf = raw.get("vf")
            val = float(raw_vf) if raw_vf not in (None, "") else (2.0 if t == "LED" else 0.7)
        elif t not in {"F", "S", "W"}:
            raise ValueError(f"{pid}: unknown part type {t!r} (use R, V, I, D, LED, F, S or W)")
        parts.append(Part(pid, t, a, b, value=val, vf=val if t in {"D", "LED"} else 0.0,
                          closed=bool(raw.get("closed", True))))
    if not any(p.type == "V" for p in parts) and not any(p.type == "I" for p in parts):
        raise ValueError("the circuit has no supply (add a V part)")
    if not any("0" in (p.a, p.b) for p in parts):
        raise ValueError("nothing connects to ground (node 0)")
    return parts


def _conductance(p: Part, fault: Fault | None) -> float | None:
    """The part as a conductance, or None for sources and diodes (stamped separately)."""
    broken = fault is not None and fault.part == p.id
    kind = fault.kind if broken else ""
    if p.type == "R":
        if kind == "open":
            return G_OFF
        if kind == "short":
            return 1 / SHORT
        return 1 / (p.value * (10 if kind == "high" else 1))
    if p.type == "F":
        return G_OFF if kind == "blown" else 1 / 0.05
    if p.type == "W":
        return G_OFF if kind == "open" else 1 / SHORT
    if p.type == "S":
        closed = (p.closed and kind != "stuck_open") or kind == "stuck_closed"
        return 1 / SHORT if closed else G_OFF
    return None


def solve(parts: list[Part], fault: Fault | None = None) -> Solution:
    nodes = sorted({n for p in parts for n in (p.a, p.b) if n != "0"})
    idx = {n: i for i, n in enumerate(nodes)}
    vsrc = [p for p in parts if p.type == "V"]
    n, m = len(nodes), len(vsrc)
    diodes = [p for p in parts if p.type in {"D", "LED"}]
    on = {d.id: False for d in diodes}

    def stamp_g(G: np.ndarray, a: str, b: str, g: float) -> None:
        ia, ib = idx.get(a), idx.get(b)
        if ia is not None:
            G[ia, ia] += g
        if ib is not None:
            G[ib, ib] += g
        if ia is not None and ib is not None:
            G[ia, ib] -= g
            G[ib, ia] -= g

    def inject(rhs: np.ndarray, node: str, amps: float) -> None:
        if node in idx:
            rhs[idx[node]] += amps

    x = np.zeros(n + m)
    for _ in range(40):
        A = np.zeros((n + m, n + m))
        rhs = np.zeros(n + m)
        for i in range(n):
            A[i, i] += G_MIN
        for p in parts:
            g = _conductance(p, fault)
            if g is not None:
                stamp_g(A, p.a, p.b, g)
            elif p.type == "I":
                inject(rhs, p.a, -p.value)
                inject(rhs, p.b, p.value)
        for d in diodes:
            broken = fault.kind if fault and fault.part == d.id else ""
            if broken == "open":
                stamp_g(A, d.a, d.b, G_OFF)
            elif broken == "short":
                stamp_g(A, d.a, d.b, 1 / SHORT)
            elif on[d.id]:  # I = (Va - Vb - vf) / R_ON
                g = 1 / R_ON
                stamp_g(A, d.a, d.b, g)
                inject(rhs, d.a, g * d.vf)
                inject(rhs, d.b, -g * d.vf)
            else:
                stamp_g(A, d.a, d.b, G_OFF)
        for k, s in enumerate(vsrc):
            row = n + k
            volts = s.value
            if fault and fault.part == s.id:
                volts = 0.0 if fault.kind == "dead" else s.value / 2
            for node, sign in ((s.a, 1.0), (s.b, -1.0)):
                if node in idx:
                    A[idx[node], row] += sign
                    A[row, idx[node]] += sign
            rhs[row] = volts
        try:
            x = np.linalg.solve(A, rhs)
        except np.linalg.LinAlgError:
            x = np.linalg.lstsq(A, rhs, rcond=None)[0]
        v = lambda node: 0.0 if node == "0" else float(x[idx[node]])
        flipped = False
        for d in diodes:
            want = v(d.a) - v(d.b) > d.vf
            if want != on[d.id]:
                on[d.id] = want
                flipped = True
        if not flipped:
            break
    volts = {"0": 0.0, **{nd: float(x[i]) for nd, i in idx.items()}}
    return Solution(volts=volts, ok=all(math.isfinite(val) for val in volts.values()))


def faults(parts: list[Part]) -> list[Fault]:
    out: list[Fault] = []
    for p in parts:
        if p.type == "R":
            out += [Fault(p.id, "open", f"{p.id} open (burnt or cracked)"), Fault(p.id, "short", f"{p.id} shorted"),
                    Fault(p.id, "high", f"{p.id} drifted high")]
        elif p.type in {"D", "LED"}:
            out += [Fault(p.id, "open", f"{p.id} open (dead {'LED' if p.type == 'LED' else 'diode'})"),
                    Fault(p.id, "short", f"{p.id} shorted")]
        elif p.type == "F":
            out.append(Fault(p.id, "blown", f"{p.id} blown"))
        elif p.type == "W":
            out.append(Fault(p.id, "open", f"{p.id} broken (wire or cracked solder joint)"))
        elif p.type == "S":
            out.append(Fault(p.id, "stuck_open", f"{p.id} not making contact") if p.closed
                       else Fault(p.id, "stuck_closed", f"{p.id} stuck closed"))
        elif p.type == "V":
            out += [Fault(p.id, "dead", f"{p.id} supply dead (0 V)"), Fault(p.id, "low", f"{p.id} supply sagging (half)")]
    return out


def reading(sol: Solution, m: dict) -> float:
    if "node" in m:
        return sol.volts.get(_node(m["node"]), float("nan"))
    return sol.volts.get(_node(m.get("from", "")), float("nan")) - sol.volts.get(_node(m.get("to", "0")), float("nan"))


def where(m: dict) -> str:
    return _node(m["node"]) if "node" in m else f"{_node(m.get('from', ''))}-{_node(m.get('to', '0'))}"


def tolerance(volts: float) -> float:
    """A cheap meter and a shaky probe: 0.15 V or 5%, whichever is bigger."""
    return max(0.15, 0.05 * abs(volts))


def diagnose(parts: list[Part], measurements: list[dict]) -> list[Ranked]:
    """The healthy circuit and every single fault, ranked by how well each explains the readings."""
    for m in measurements:
        if "volts" not in m or ("node" not in m and "from" not in m):
            raise ValueError("each reading needs volts and a node (or from/to)")
    scenarios: list[Fault | None] = [None, *faults(parts)]
    out: list[Ranked] = []
    for f in scenarios:
        sol = solve(parts, f)
        if not sol.ok:
            continue
        misses, pred = [], {}
        for m in measurements:
            got = reading(sol, m)
            pred[where(m)] = got
            misses.append(abs(got - float(m["volts"])) / tolerance(float(m["volts"])))
        worst = max(misses) if misses else 0.0
        out.append(Ranked(f, math.exp(-0.5 * sum(x * x for x in misses)), worst, pred))
    total = sum(r.probability for r in out) or 1.0
    for r in out:
        r.probability /= total
    return sorted(out, key=lambda r: r.probability, reverse=True)


def next_probe(parts: list[Part], ranked: list[Ranked], measured: set[str], top: int = 4) -> tuple[str, dict[str, float]] | None:
    """The unmeasured node where the likely explanations disagree most, with what each would read there."""
    likely = [r for r in ranked[:top] if r.probability > 0.02]
    if len(likely) < 2:
        return None
    sols = [(r, solve(parts, r.fault)) for r in likely]
    best, spread = None, 0.0
    for nd in sorted({n for p in parts for n in (p.a, p.b) if n != "0"} - measured):
        vals = [(r.probability, s.volts[nd]) for r, s in sols]
        w = sum(p for p, _ in vals)
        mean = sum(p * v for p, v in vals) / w
        var = sum(p * (v - mean) ** 2 for p, v in vals) / w
        if var > spread:
            best, spread = nd, var
    if best is None or math.sqrt(spread) < 0.15:
        return None
    return best, {(r.fault.label if r.fault else "working circuit"): round(s.volts[best], 2) for r, s in sols}


def report(netlist: list[dict], measurements: list[dict]) -> dict:
    """Everything the mechanic needs: healthy voltages, ranked faults and the next probe point."""
    parts = parse(netlist)
    healthy = solve(parts)
    ranked = diagnose(parts, measurements) if measurements else []
    probe = next_probe(parts, ranked, {where(m) for m in measurements}) if ranked else None
    return {
        "healthy": {k: round(v, 2) for k, v in healthy.volts.items() if k != "0"},
        "ranked": [{"fault": r.fault.label if r.fault else "working circuit (no single fault)",
                    "part": r.fault.part if r.fault else "", "probability": round(r.probability, 3),
                    "fits": r.error <= 2.0, "predicted": {k: round(v, 2) for k, v in r.predicted.items()}}
                   for r in ranked[:5]],
        "probe": {"node": probe[0], "expect": probe[1]} if probe else None,
    }


def for_model(rep: dict) -> str:
    lines = ["Healthy circuit, volts to ground: " + ", ".join(f"{k} {v:g} V" for k, v in rep["healthy"].items()) + "."]
    if rep["ranked"]:
        lines.append("Faults ranked against the readings (simulated, single fault each):")
        for r in rep["ranked"]:
            fit = "fits the readings" if r["fits"] else "does NOT fit well"
            lines.append(f"- {r['fault']}: {round(r['probability'] * 100)}% ({fit}); it would read "
                         + ", ".join(f"{k} {v:g} V" for k, v in r["predicted"].items()))
        if not any(r["fits"] for r in rep["ranked"]):
            lines.append("No single fault explains the readings. Check the netlist against the board, re-measure, or "
                         "consider two faults or a part not drawn here.")
    if rep["probe"]:
        lines.append(f"Next probe: node {rep['probe']['node']}. Expected: "
                     + "; ".join(f"{k} -> {v:g} V" for k, v in rep["probe"]["expect"].items())
                     + ". Pass this to plan_tests as a candidate test.")
    lines.append("This is a simulation of the circuit you described: use it to choose tests and as evidence, never as "
                 "proof on its own. Add the leading faults as causes with update_hypotheses.")
    return "\n".join(lines)
