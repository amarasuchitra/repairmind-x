// The virtual bench: the circuit solver, the rules running like the generated code, real compiled code on the
// emulated Nano, and the ways parts fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ledModel, solve } from "../src/sim/circuit.ts";
import { Bench, defaultEnv } from "../src/sim/bench.ts";
import { AvrRunner, nanoPin, parseHex } from "../src/sim/avr.ts";
import { emptyProject } from "../src/build/project.ts";
import { TEMPLATES, fromTemplate } from "../src/build/templates.ts";

const make = (ids, rules = []) => {
  const p = emptyProject("new");
  p.parts = ids.map((id, i) => ({ uid: `u${i}${id}`, id, x: 0.5, y: 0.5 }));
  p.rules = rules.map((r, i) => ({ id: `r${i}`, ...r }));
  return p;
};
const titles = (b) => b.frame().events.map((e) => `${e.severity}: ${e.title}`);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ± ${tol}`);

test("circuit: Ohm's law, an LED with its resistor, and the same LED straight on a pin", () => {
  const r = solve([{ k: "V", id: "s", p: "a", n: "gnd", v: 5, r: 0.001 }, { k: "R", id: "r1", a: "a", b: "m", ohm: 1000 }, { k: "R", id: "r2", a: "m", b: "gnd", ohm: 2000 }]);
  assert.ok(r.ok);
  near(r.v.m, 10 / 3, 1e-3, "divider");
  near(r.i.r1, 5 / 3000, 1e-6, "current");
  const red = ledModel(2.0);
  const led = solve([{ k: "V", id: "s", p: "a", n: "gnd", v: 5, r: 0.1 }, { k: "R", id: "r", a: "a", b: "x", ohm: 220 }, { k: "D", id: "d", a: "x", c: "gnd", ...red }]);
  assert.ok(led.ok);
  near(led.i.d * 1000, (5 - 2.0) / 220 * 1000, 2, "LED mA with 220 Ω");
  const raw = solve([{ k: "V", id: "s", p: "a", n: "gnd", v: 5, r: 0.1 }, { k: "R", id: "r", a: "a", b: "x", ohm: 25 }, { k: "D", id: "d", a: "x", c: "gnd", ...red }]);
  assert.ok(raw.i.d > 0.06, `no resistor: ${raw.i.d}`);
});

test("circuit: a regulator drops out and a booster pulls more from a weak battery", () => {
  const ldo = solve([{ k: "V", id: "s", p: "in", n: "gnd", v: 4.0, r: 0.01 }, { k: "ldo", id: "l", in: "in", out: "o", vset: 3.3, vdo: 1.1, iq: 0 }, { k: "load", id: "x", a: "o", b: "gnd", i: 0.1, vmin: 2 }]);
  near(ldo.v.o, 2.9, 0.02, "dropout");
  const fresh = solve([{ k: "V", id: "s", p: "b", n: "gnd", v: 4.5, r: 0.45 }, { k: "boost", id: "bo", in: "b", out: "o", vset: 5, vstart: 2, eff: 0.85 }, { k: "load", id: "x", a: "o", b: "gnd", i: 0.5, vmin: 3 }]);
  assert.ok(fresh.ok);
  near(fresh.v.o, 5, 0.05, "boost output");
  // power in = power out ÷ efficiency
  near(fresh.i.s * fresh.v.b, (fresh.v.o * 0.5) / 0.85, 0.05, "boost power balance");
});

test("every template runs on the bench without anything failing", () => {
  for (const t of TEMPLATES) {
    const b = new Bench(fromTemplate(t));
    b.setPower(true);
    const f = b.run(3);
    assert.equal(f.board.status, "running", t.id);
    assert.deepEqual(titles(b), [], t.id);
    assert.ok(f.rails.v5 > 4.6, `${t.id} 5 V rail ${f.rails.v5}`);
  }
});

test("the rules run like the generated code: a press makes the servo wave and come back", () => {
  const b = new Bench(make(["esp32", "usb", "servo", "button"], [{ when: "button", then: "move" }]));
  b.setPower(true);
  const env = defaultEnv();
  b.run(1, env);
  env.button = true;
  b.run(0.55, env);
  const up = b.frame().parts.find((p) => p.id === "servo").show.deg;
  assert.ok(up > 80, `arm up: ${up}`);
  b.run(1.5, env);
  near(b.frame().parts.find((p) => p.id === "servo").show.deg, 0, 2, "arm back");
  // holding the button doesn't repeat it: it reacts once each time it starts
  b.run(4, env);
  near(b.frame().parts.find((p) => p.id === "servo").show.deg, 0, 2, "no repeat");
});

test("brownout: a servo on run-down AA cells without a booster restarts the ESP32", () => {
  const b = new Bench(make(["esp32", "aa3", "servo", "soundsensor", "switch"], [{ when: "sound", then: "move" }]));
  b.mods.charge = 0.3;
  b.mods.servoLoadG = 20;
  b.setPower(true);
  const env = defaultEnv();
  b.run(1, env);
  env.clap = true; b.run(0.2, env); env.clap = false; b.run(2, env);
  const f = b.frame();
  assert.ok(f.board.resets >= 1, "it should restart");
  const e = f.events.find((x) => x.id === "brownout");
  assert.ok(e && /servo|motor arm/i.test(e.why), e?.why);
  assert.ok(e.undo?.charge === 1);
});

test("too heavy for the servo: it stalls, and far too heavy strips its gears", () => {
  const b = new Bench(make(["esp32", "usb", "servo", "button"], [{ when: "button", then: "move" }]));
  b.mods.servoLoadG = 500;
  b.mods.servoArmCm = 4;
  b.setPower(true);
  const env = defaultEnv();
  b.run(1, env);
  env.button = true;
  b.run(0.8, env);
  assert.ok(titles(b).includes("warning: The servo is stalled"), titles(b).join(" | "));
  b.mods.servoLoadG = 1000;
  b.mods.servoArmCm = 6;
  b.run(0.1, env);
  assert.ok(titles(b).includes("broken: The servo's gears stripped"));
});

test("a short across the batteries melts the wire; on USB the charger cuts out", () => {
  let b = new Bench(make(["nano", "aa4nimh", "led"]));
  b.setPower(true); b.run(0.5);
  b.mods.short = true; b.run(4);
  assert.ok(titles(b).includes("warning: Short circuit"));
  assert.ok(titles(b).includes("broken: The wire's insulation melted"));
  assert.ok(!titles(b).some((x) => /brownout|restarting/i.test(x)), "the short explains it, not a brownout");
  b = new Bench(make(["nano", "usb", "led"]));
  b.setPower(true); b.run(0.5);
  b.mods.short = true; b.run(1);
  assert.ok(titles(b).includes("stopped: Short circuit: the charger cut out"));
  assert.ok(b.frame().source.tripped);
});

test("over-voltage: a booster trimmed to 9 V kills a Nano and the LED ring; a 3.3 V mic on 5 V dies", () => {
  let b = new Bench(make(["nano", "aa3", "boost5", "ring"]));
  b.mods.boostV = 9; b.setPower(true); b.run(1);
  assert.ok(titles(b).includes("broken: The Arduino Nano was destroyed by over-voltage"));
  assert.equal(b.frame().board.status, "dead");
  const ring = b.frame().events.find((e) => e.where.includes("ring"));
  assert.ok(ring && /4–5\.3 V/.test(ring.why), ring?.why);
  b = new Bench(make(["esp32", "usb", "mic"]));
  b.mods.rails = { u2mic: "5v" }; b.setPower(true); b.run(1);
  assert.ok(b.frame().events.some((e) => e.where === "u2mic" && e.severity === "broken"));
});

test("5 V into a 3.3 V pin: the ECHO line without its divider wears out the ESP32 pin", () => {
  const b = new Bench(make(["esp32", "usb", "distance"], [{ when: "near", then: "light" }]));
  b.mods.echoDivider = false;
  b.setPower(true); b.run(1);
  const w = b.frame().events.find((e) => e.title === "5 V is going into a 3.3 V pin");
  assert.ok(w, titles(b).join(" | "));
  assert.deepEqual(w.undo, { echoDivider: true });
  b.run(21);
  assert.ok(titles(b).includes("broken: The ECHO pin on the board died"));
  // with the divider, nothing happens
  const ok = new Bench(make(["esp32", "usb", "distance"]));
  ok.setPower(true); ok.run(3);
  assert.deepEqual(titles(ok), []);
});

test("no flyback diode: the pump's switch fails after a few spikes", () => {
  const b = new Bench(make(["esp32", "usb", "pump", "button"], [{ when: "button", then: "pump" }]));
  b.mods.flyback = false;
  b.setPower(true);
  const env = defaultEnv();
  b.run(1, env);
  for (let i = 0; i < 3; i++) { env.button = true; b.run(0.2, env); env.button = false; b.run(4, env); }
  assert.ok(titles(b).includes("broken: The pump's switch board failed"), titles(b).join(" | "));
});

test("Intel HEX parsing and Nano pin mapping", () => {
  assert.deepEqual(nanoPin("D13"), { port: "B", bit: 5 });
  assert.deepEqual(nanoPin("D2"), { port: "D", bit: 2 });
  assert.deepEqual(nanoPin("A3"), { port: "C", bit: 3 });
  assert.throws(() => parseHex("hello"), /Intel HEX/);
  assert.throws(() => parseHex(":0100000000FE\n"), /checksum/);
  const mem = parseHex(":020000000C94"+"5E"+"\n:00000001FF\n");
  assert.equal(mem[0], 0x940c);
});

test("real compiled code: the emulated Nano runs a .hex, reads the button and light sensor, drives the LED and servo", () => {
  // tests/fixtures/nano_bench.c, built with avr-gcc; pins follow the builder's plan for these parts
  const p = make(["nano", "usb", "button", "led", "servo", "light"]);
  const b = new Bench(p);
  b.external = new AvrRunner(readFileSync(new URL("./fixtures/nano_bench.hex", import.meta.url), "utf8"), p, b.report);
  b.setPower(true);
  const env = defaultEnv();
  b.run(1, env);
  let f = b.frame();
  assert.equal(f.serial[1], "Ready.");
  assert.ok(/^light \d+$/.test(f.serial.at(-1)), f.serial.at(-1));
  assert.equal(f.parts.find((x) => x.id === "led").show.lit, 0);
  near(f.parts.find((x) => x.id === "servo").show.deg, ((1000 - 544) / (2400 - 544)) * 180, 1.5, "1000 µs pulse");
  env.button = true;
  env.lux = 2;
  b.run(1, env);
  f = b.frame();
  const led = f.parts.find((x) => x.id === "led");
  assert.ok(led.show.lit > 0.5 && led.mA > 10 && led.mA < 16, `LED ${led.mA} mA`);
  near(f.parts.find((x) => x.id === "servo").show.deg, ((1950 - 544) / (2400 - 544)) * 180, 1.5, "1950 µs pulse");
  const dark = Number(f.serial.at(-1).split(" ")[1]);
  assert.ok(dark < 400, `dark reading ${dark}`);
  // the same code with the LED's resistor left out burns the pin
  b.mods.ledOhm = 0;
  b.run(2, env);
  assert.ok(titles(b).includes("broken: The board's pin was damaged"), titles(b).join(" | "));
});
