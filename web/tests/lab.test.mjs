// The design lab's math: units, expressions, margins, and the physics sandbox against hand calculations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnit, toSI, fromSI, dimLabel } from "../src/lab/units.ts";
import { parseExpr, evaluate } from "../src/lab/expr.ts";
import { analyze, marginOfSafety } from "../src/lab/analysis.ts";
import { EXAMPLES } from "../src/lab/examples.ts";
import { Sandbox, loadRapier, simFindings } from "../src/lab/physics.ts";

const close = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("units parse with prefixes, powers and division", () => {
  close(toSI(1, "kN"), 1000);
  close(toSI(250, "MPa"), 250e6);
  close(toSI(1, "mm^4"), 1e-12);
  close(toSI(1, "km/h"), 1 / 3.6);
  close(toSI(3000, "rpm"), 100 * Math.PI);
  close(toSI(1, "mAh"), 3.6);
  close(fromSI(1, "in"), 1 / 0.0254);
  assert.equal(dimLabel(parseUnit("N").dim), "m·kg/s^2");
  assert.equal(dimLabel(parseUnit("W/(m*K)").dim), dimLabel(parseUnit("kg*m/s^3/K").dim));
  assert.equal(dimLabel(parseUnit("kg m^-3").dim), "kg/m^3");
  assert.throws(() => parseUnit("furlongs"));
  // "min" is minutes, not milli-inches
  close(toSI(1, "min"), 60);
});

test("expressions are dimension checked", () => {
  const env = { m: { v: 2, dim: [0, 1, 0, 0, 0, 0, 0] }, a: { v: 3, dim: [1, 0, -2, 0, 0, 0, 0] }, t: { v: 1, dim: [0, 0, 1, 0, 0, 0, 0] } };
  const F = evaluate(parseExpr("m * a"), env);
  close(F.v, 6);
  assert.deepEqual(F.dim, parseUnit("N").dim);
  assert.throws(() => evaluate(parseExpr("m + a"), env), /can't add/);
  assert.throws(() => evaluate(parseExpr("sin(t)"), env), /dimensionless/);
  close(evaluate(parseExpr("sqrt(2 * g0 * 5)"), {}).v, Math.sqrt(2 * 9.80665 * 5));
  assert.throws(() => parseExpr("constructor.call(1)"));
  assert.throws(() => parseExpr("alert(1)"), /unknown function/);
});

test("margin of safety follows allowable / (applied × FS) − 1", () => {
  close(marginOfSafety("max", 100, 300, 1.5), 1);
  close(marginOfSafety("min", 3, 1, 2), 0.5);
});

test("worked examples compute, and the drop pod fails its shock check on purpose", () => {
  const [rover, pod, rig] = EXAMPLES.map((d) => analyze(d));
  assert.deepEqual(rover.findings.filter((f) => f.severity === "error"), []);
  const tau = rover.equations.find((e) => e.eq.id === "E2");
  close(tau.value, 10 * 9.80665 * (Math.sin(Math.PI / 18) + 0.05 * Math.cos(Math.PI / 18)) * 0.1 / 4);
  assert.equal(tau.pass, true);
  const g = pod.equations.find((e) => e.eq.id === "E3");
  assert.equal(g.pass, false);
  assert.ok(pod.findings.some((f) => f.severity === "error" && f.where.startsWith("risk")));
  close(rig.equations.find((e) => e.eq.id === "E1").value, 4 * 9.80665 / 2000 * 1000);
  // editing a variable recomputes everything downstream
  const stiffer = analyze(EXAMPLES[2], { k: 4000 });
  close(stiffer.equations.find((e) => e.eq.id === "E1").value, 4 * 9.80665 / 4000 * 1000);
});

test("an equation in the wrong unit is caught", () => {
  const d = structuredClone(EXAMPLES[2]);
  d.equations[0].unit = "N";
  const a = analyze(d);
  assert.ok(a.findings.some((f) => /units don't match/.test(f.text)));
});

async function run(design) {
  const R = await loadRapier();
  const analysis = analyze(design);
  const sb = new Sandbox(R, design, analysis);
  while (!sb.done) sb.step(10);
  const res = sb.results();
  const findings = simFindings(res, sb.warnings, sb);
  sb.free();
  return { res, findings };
}

for (const d of EXAMPLES) {
  test(`physics reproduces the hand calculation: ${d.title}`, async () => {
    const { res, findings } = await run(d);
    for (const r of res.filter((x) => x.probe.predicted_by)) {
      assert.equal(r.pass, true, `${r.probe.label}: sim ${r.value} vs predicted ${r.predicted} (${r.errorPct?.toFixed(1)}%)`);
    }
    assert.deepEqual(findings, []);
  });
}

test("the server's copy of the examples is up to date", async () => {
  const { readFileSync } = await import("node:fs");
  const copy = JSON.parse(readFileSync(new URL("../../agent/tests/data/lab_examples.json", import.meta.url), "utf8"));
  assert.deepEqual(copy, JSON.parse(JSON.stringify(EXAMPLES)), "re-export: node -e 'import(\"./web/src/lab/examples.ts\").then(...)'");
});
