// The design lab's sandbox as a place to break things: joint loads, joints that break, motors that stall, and
// the edits a person makes (sim/edit.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Sandbox, loadRapier } from "../src/lab/physics.ts";
import { applyEdits } from "../src/sim/edit.ts";
import { EXAMPLES } from "../src/lab/examples.ts";

const body = (id, o = {}) => ({ id, label: id, shape: "box", size: [0.1, 0.1, 0.1], position: [0, 0, 0], rotation_deg: [0, 0, 0], fixed: false, mass_kg: 1, mass_symbol: "", friction: 0.7, restitution: 0, initial_velocity: [0, 0, 0], color: "", ...o });
const joint = (o) => ({ kind: "fixed", a: "", b: "", anchor_a: [0, 0, 0], anchor_b: [0, 0, 0], axis: [0, 0, 1], motor_speed: 0, motor_max_torque: 0, stiffness: 0, damping: 0, rest_length: 0, stiffness_symbol: "", ...o });
const design = (sim) => ({ title: "t", simulation: { title: "", description: "", gravity: 9.81, duration_s: 2, ground: true, probes: [], ...sim } });

async function run(d, limits, seconds = 2) {
  const R = await loadRapier();
  const sb = new Sandbox(R, d, null, limits);
  while (sb.time < seconds) sb.step(10);
  const out = { events: [...sb.events], loads: sb.jointLoads };
  sb.free();
  return out;
}

// a 2 kg weight hanging under a fixed bracket by one joint
const hanging = design({
  ground: false,
  bodies: [body("bracket", { fixed: true, position: [0, 1, 0] }), body("weight", { position: [0, 0.8, 0], mass_kg: 2 })],
  joints: [joint({ kind: "fixed", a: "bracket", b: "weight" })],
});

test("a joint carries the weight hanging from it", async () => {
  const { loads, events } = await run(hanging, {});
  assert.deepEqual(events, []);
  const peak = loads[0].peak;
  assert.ok(Math.abs(peak - 2 * 9.81) < 2, `peak load ${peak} N, expected about 19.6 N`);
});

test("a joint weaker than its load breaks and says why; a strong one holds", async () => {
  const weak = await run(hanging, { breakN: [10] });
  assert.equal(weak.events.length, 1);
  assert.equal(weak.events[0].kind, "break");
  assert.match(weak.events[0].why, /more than the 10 N/);
  assert.ok(weak.loads[0].broken);
  const strong = await run(hanging, { breakN: [60] });
  assert.deepEqual(strong.events, []);
});

test("contact forces are taken off, so a block resting on the ground and tied to a post loads its joint lightly", async () => {
  const resting = design({
    bodies: [body("post", { fixed: true, position: [0.3, 0.05, 0] }), body("block", { position: [0, 0.05, 0], mass_kg: 3 })],
    joints: [joint({ kind: "spring", a: "post", b: "block", stiffness: 0, damping: 0, rest_length: 0.3 })],
  });
  const { loads } = await run(resting, {}, 1.5);
  assert.ok(loads[0].peak < 5, `the ground holds the block up, not the joint: ${loads[0].peak} N`);
});

test("a motor too weak for its arm stalls", async () => {
  // a 1 kg weight on a 0.5 m arm needs about 2.9 N·m to hold level; the motor gives 1 N·m
  const arm = design({
    ground: false,
    bodies: [body("base", { fixed: true, position: [0, 1, 0], size: [0.04, 0.04, 0.04] }), body("arm", { position: [0.3, 1, 0], size: [0.5, 0.04, 0.04], mass_kg: 1 })],
    joints: [joint({ kind: "revolute", a: "base", b: "arm", anchor_a: [0, 0, 0], anchor_b: [-0.3, 0, 0], axis: [0, 0, 1], motor_speed: 1, motor_max_torque: 1 })],
  });
  const weak = await run(arm, {});
  assert.ok(weak.events.some((e) => e.kind === "stall"), JSON.stringify(weak.events));
  const strong = await run(applyEdits(arm, { joints: { 0: { motor_max_torque: 20 } } }), {});
  assert.ok(!strong.events.some((e) => e.kind === "stall"), JSON.stringify(strong.events));
});

test("edits change a copy, never the design itself", () => {
  const d = structuredClone(EXAMPLES[0]);
  const before = JSON.stringify(d);
  const id = d.simulation.bodies.find((b) => !b.fixed).id;
  const e = applyEdits(d, { gravity: 1.62, bodies: { [id]: { mass_kg: 99, scale: 2 } } });
  assert.equal(JSON.stringify(d), before);
  assert.equal(e.simulation.gravity, 1.62);
  const b = e.simulation.bodies.find((x) => x.id === id);
  assert.equal(b.mass_kg, 99);
  assert.equal(b.mass_symbol, "", "an edited mass no longer follows the design variable");
  assert.equal(b.size[0], d.simulation.bodies.find((x) => x.id === id).size[0] * 2);
});

test("the worked examples still reproduce their hand calculations with joint checks switched on", async () => {
  for (const d of EXAMPLES) {
    const { events } = await run(d, { breakN: d.simulation.joints.map(() => 1e9) }, d.simulation.duration_s);
    assert.ok(!events.some((e) => e.kind === "break"), `${d.title}: ${JSON.stringify(events)}`);
  }
});
