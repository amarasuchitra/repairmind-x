// The hardware project builder: checks, pins, power, fit, parts list, templates, suggestions and code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, applyFix } from "../src/build/engine.ts";
import { firmware, cString } from "../src/build/firmware.ts";
import { TEMPLATES, fromTemplate, suggest } from "../src/build/templates.ts";
import { emptyProject, parseProject } from "../src/build/project.ts";
import { BY_ID } from "../src/build/parts.ts";

let n = 0;
const make = (ids, extra = {}) => {
  const p = emptyProject(extra.mode ?? "new");
  p.parts = ids.map((id, i) => ({ uid: `u${n++}`, id, x: 0.1 + (i % 5) * 0.18, y: 0.2 }));
  p.rules = (extra.rules ?? []).map((r, i) => ({ id: `r${i}`, ...r }));
  Object.assign(p.product, extra.product ?? {});
  return p;
};
const levels = (r) => r.issues.map((i) => `${i.level}: ${i.text}`);

test("every template is ready to build as it comes", () => {
  for (const t of TEMPLATES) {
    const r = analyze(fromTemplate(t));
    assert.ok(r.ready, `${t.id}: ${levels(r).join(" | ")}`);
    assert.ok(r.totalInr > 0);
    assert.ok(r.steps.length >= 3);
  }
});

test("the talking toy: pins don't clash, voice needs a speaker, AA cells need a booster", () => {
  const toy = fromTemplate(TEMPLATES.find((t) => t.id === "talking-toy"));
  const r = analyze(toy);
  const pins = r.pinMap.map((p) => p.pin);
  assert.equal(new Set(pins).size, pins.length, `duplicate pins: ${pins}`);
  assert.equal(r.rail5?.[0], 5);
  assert.ok(r.hours && r.hours > 3 && r.hours < 30, `hours ${r.hours}`);

  const noBoost = { ...toy, parts: toy.parts.filter((p) => p.id !== "boost5") };
  const r2 = analyze(noBoost);
  const fix = r2.issues.find((i) => i.fix?.add?.includes("boost5"));
  assert.ok(fix, levels(r2).join(" | "));
  assert.ok(analyze(applyFix(noBoost, fix.fix, () => "new1")).ready);

  const noSpeaker = { ...toy, parts: toy.parts.filter((p) => p.id !== "speaker") };
  assert.ok(analyze(noSpeaker).issues.some((i) => i.level === "fix" && i.fix?.add?.includes("speaker")));
});

test("a microphone on the Nano asks to swap to the ESP32", () => {
  const r = analyze(make(["nano", "mic", "usb"], { rules: [{ when: "sound", then: "light" }] }));
  const swap = r.issues.find((i) => i.fix?.replace?.[1] === "esp32");
  assert.ok(swap, levels(r).join(" | "));
  assert.ok(!r.ready);
});

test("missing brain and power are offered as one-tap fixes", () => {
  const r = analyze(make(["touch", "ring"], { product: { forKids: true } }));
  assert.ok(r.issues.some((i) => i.fix?.add?.includes("esp32")));
  assert.ok(r.issues.some((i) => i.fix?.add?.includes("aa3")));
});

test("the ultrasonic sensor's 5 V echo goes through a divider on the ESP32, not on the Nano", () => {
  const esp = analyze(make(["esp32", "distance", "buzzer", "usb"], { rules: [{ when: "near", then: "beep" }] }));
  assert.match(esp.conns.find((c) => c.fromPin === "ECHO").via ?? "", /divider/);
  const nano = analyze(make(["nano", "distance", "buzzer", "usb"], { rules: [{ when: "near", then: "beep" }] }));
  assert.equal(nano.conns.find((c) => c.fromPin === "ECHO").via, undefined);
});

test("two parts on the same I2C address are caught", () => {
  const r = analyze(make(["esp32", "oled", "oled", "usb"]));
  assert.ok(r.issues.some((i) => /same I2C address/.test(i.text)));
});

test("a wall-powered item with a relay is blocked; without one it warns", () => {
  const rules = [{ when: "button", then: "switch" }];
  const blocked = analyze(make(["esp32", "button", "relay", "usb"], { mode: "upgrade", rules, product: { power: "wall" } }));
  assert.ok(blocked.issues.some((i) => i.level === "block"));
  assert.ok(!blocked.ready);
  const warned = analyze(make(["esp32", "button", "ring", "usb"], { mode: "upgrade", rules: [{ when: "button", then: "light" }], product: { power: "wall" } }));
  assert.ok(warned.ready && warned.issues.some((i) => i.level === "warn" && /wall/.test(i.text)));
});

test("lithium cells in a children's toy are flagged with an AA swap", () => {
  const r = analyze(make(["esp32", "touch", "ring", "lipo", "boost5"], { rules: [{ when: "touch", then: "light" }], product: { forKids: true } }));
  assert.ok(r.issues.some((i) => i.fix?.replace?.[0] === "lipo"));
});

test("fit: measured space inside an existing item, or a suggested project box", () => {
  const ids = ["esp32", "touch", "ring", "aa3", "boost5"];
  const rules = [{ when: "touch", then: "light" }];
  assert.equal(analyze(make(ids, { mode: "upgrade", rules })).fit.state, "unknown");
  assert.equal(analyze(make(ids, { mode: "upgrade", rules, product: { inner: [120, 90, 60] } })).fit.state, "ok");
  const small = analyze(make(ids, { mode: "upgrade", rules, product: { inner: [40, 30, 20] } }));
  assert.equal(small.fit.state, "no");
  assert.ok(small.fit.tooBig.length > 0);
  const box = analyze(make(ids, { rules })).fit.box;
  assert.ok(box, "a project box is suggested");
  assert.ok(analyze(make(ids, { rules })).bom.some((l) => l.id === "box"));
});

test("power budget adds the 3.3 V parts to the 5 V side and scales through the booster", () => {
  const usb = analyze(make(["esp32", "mic", "ring", "usb"], { rules: [{ when: "sound", then: "light" }] }));
  assert.equal(usb.draw.mA, BY_ID.esp32.mA + BY_ID.mic.mA + BY_ID.ring.mA);
  const aa = analyze(make(["esp32", "mic", "ring", "aa3", "boost5"], { rules: [{ when: "sound", then: "light" }] }));
  assert.ok(aa.draw.mA > usb.draw.mA * 1.25, `${aa.draw.mA} vs ${usb.draw.mA}`);
});

test("the assistant suggests parts from plain words", () => {
  const s = suggest("make my glowing toy talk and listen to my kid");
  const ids = s.project.parts.map((p) => p.id);
  for (const id of ["esp32", "player", "speaker", "mic", "ring", "aa3", "boost5"]) assert.ok(ids.includes(id), `${id} missing from ${ids}`);
  assert.equal(s.project.mode, "upgrade");
  assert.ok(s.project.product.forKids);
  assert.ok(s.project.rules.some((r) => r.when === "sound" && r.then === "say"));
  assert.ok(analyze(s.project).ready, levels(analyze(s.project)).join(" | "));

  const plant = suggest("water my plants when the soil is dry");
  assert.ok(plant.project.rules.some((r) => r.when === "dry" && r.then === "pump"));
  assert.ok(!plant.project.rules.some((r) => r.then === "pump" && r.when !== "dry"));

  assert.equal(suggest("qwerty").reasons.length, 0);
});

test("generated code has every pin it uses and balanced braces", () => {
  for (const t of TEMPLATES) {
    const p = fromTemplate(t);
    const { code, name } = firmware(p);
    assert.match(name, /\.ino$/);
    const opens = (code.match(/\{/g) ?? []).length;
    const closes = (code.match(/\}/g) ?? []).length;
    assert.equal(opens, closes, `${t.id}: braces`);
    for (const m of code.matchAll(/\bPIN_[A-Z_]+\b/g)) assert.match(code, new RegExp(`const int ${m[0]} =`), `${t.id}: ${m[0]} undefined`);
    assert.match(code, /void setup\(\)/);
    assert.match(code, /void loop\(\)/);
  }
});

test("strings from people can't break out of the C code", () => {
  assert.equal(cString('say "hi"\\ now\n'), 'say \\"hi\\"\\\\ now ');
  assert.equal(cString("नमस्ते hello", true), " hello");
});

test("project files round-trip and junk is refused", () => {
  const p = fromTemplate(TEMPLATES[0]);
  const back = parseProject(JSON.stringify(p));
  assert.deepEqual(back.parts.map((x) => x.id), p.parts.map((x) => x.id));
  assert.equal(parseProject("{\"v\":2}"), null);
  assert.equal(parseProject("not json"), null);
});
