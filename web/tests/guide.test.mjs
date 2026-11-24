// The build guide's hands: the tools the conversation drives, run on the same checker, bench and shell maths.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/build/engine.ts";
import {
  argMap, benchRun, benchSetup, bodyText, catalogText, editProject, forRequest, freshBody, freshMemory, parseMemory,
  remember, reportText, shapeBody, stateText,
} from "../src/guide/tools.ts";

const call = (tool, args = {}) => ({ tool, why: "", args: Object.entries(args).map(([key, value]) => ({ key, value: String(value) })) });
const build = (...ids) => ids.reduce((p, id) => editProject(p, call("add_part", { id })).project, null);

test("parts are added by id or by name, and behaviour follows the parts", () => {
  const p = build("nano", "usb", "led", "Light sensor");
  assert.deepEqual(p.parts.map((x) => x.id), ["nano", "usb", "led", "light"]);
  assert.ok(p.rules.some((r) => r.when === "dark" && r.then === "light"));
  assert.match(editProject(p, call("add_part", { id: "flux capacitor" })).text, /No part/);
  // a second board replaces the first
  const swapped = editProject(p, call("add_part", { id: "esp32" })).project;
  assert.equal(swapped.parts.filter((x) => x.id === "esp32" || x.id === "nano").length, 1);
  // removing the sensor drops the rule that needed it
  const less = editProject(p, call("remove_part", { id: "light" })).project;
  assert.ok(!less.rules.some((r) => r.when === "dark"));
});

test("the report the guide reads numbers each issue so it can apply fix n", () => {
  const p = build("nano", "servo", "aa3");
  const r = analyze(p);
  const text = reportText(p, r);
  assert.match(text, /Parts: nano/);
  if (!r.ready) {
    assert.match(text, /1\. \[/);
    const fixed = editProject(p, call("apply_fix", { n: "all" }));
    assert.match(fixed.text, /Applied|already/);
  }
  assert.equal(editProject(p, call("apply_fix", { n: "99" })).text, "No fix to apply there.");
});

test("rules can only use real triggers and actions", () => {
  const p = build("nano", "usb", "buzzer", "button");
  assert.match(editProject(p, call("add_rule", { when: "button", then: "beep" })).text, /Added/);
  assert.match(editProject(p, call("add_rule", { when: "telepathy", then: "beep" })).text, /Unknown/);
});

test("the bench run reports what each part did, with the changes the guide asked for", () => {
  const p = build("nano", "usb", "led", "light");
  const dark = benchRun(p, benchSetup(analyze(p), [{ key: "lux", value: "3" }]));
  assert.match(dark, /Board: running/);
  assert.match(dark, /Single LED: .*lit/);
  const setup = benchSetup(analyze(p), [{ key: "lux", value: "3" }, { key: "ledOhm", value: "0" }, { key: "seconds", value: "12" }]);
  assert.equal(setup.mods.ledOhm, 0);
  // values are clamped to what the bench can do
  assert.equal(benchSetup(analyze(p), [{ key: "seconds", value: "500" }, { key: "charge", value: "40" }]).seconds, 30);
  assert.equal(benchSetup(analyze(p), [{ key: "charge", value: "40" }]).mods.charge, 0.4);
  assert.match(benchRun(build("led"), benchSetup(analyze(build("led")), [])), /needs a board/);
});

test("a momentary input is pressed after boot, so its effect shows", () => {
  const p = build("nano", "usb", "buzzer", "button");
  const p2 = editProject(p, call("add_rule", { when: "button", then: "beep" })).project;
  const out = benchRun(p2, benchSetup(analyze(p2), [{ key: "button", value: "true" }, { key: "seconds", value: "1.2" }]));
  assert.match(out, /world: button=true/);
});

test("the body is shaped around the parts and keeps its proportions", () => {
  const p = build("nano", "usb", "led", "light");
  const r = shapeBody(p, freshBody(), [{ key: "shape", value: "round" }, { key: "width", value: "40" }, { key: "fit", value: "yes" }]);
  assert.equal(r.body.source, "round");
  assert.equal(r.body.spec.width, r.body.spec.height); // a round outline stays round
  assert.match(r.text, /Electronics fit/);
  assert.match(bodyText(p, r.body), /Mass about \d+ g/);
  const m = shapeBody(p, freshBody(), [{ key: "material", value: "PLA" }, { key: "wall", value: "50" }]);
  assert.equal(m.body.spec.material, "pla");
  assert.equal(m.body.spec.wall, 8);
});

test("memory survives a reload and refuses junk", () => {
  const m = { ...freshMemory(), stage: "build", step: 3, done: [1, 2], notes: ["has a soldering iron"], messages: [{ role: "user", text: "hi", at: 1 }, { role: "evil", text: "x", at: 2 }] };
  const back = parseMemory(JSON.stringify(m));
  assert.equal(back.stage, "build");
  assert.deepEqual(back.done, [1, 2]);
  assert.equal(back.messages.length, 1);
  assert.equal(parseMemory("{not json").messages.length, 0);
  assert.deepEqual(remember(back, ["Has a soldering iron", "owns a 3D printer"]), ["has a soldering iron", "owns a 3D printer"]);
});

test("the state the guide reads names where the person is in the build", () => {
  const p = build("nano", "usb", "led", "light");
  const memory = { ...freshMemory(), stage: "build", step: 2, done: [1], notes: ["beginner"] };
  const s = stateText({ memory, project: p, report: analyze(p), assessment: null, idea: "night light", bench: "", body: "", design: "", language: "en" });
  assert.match(s, /Stage: build/);
  assert.match(s, /BUILD STEPS \(done: 1; current: 2\)/);
  assert.match(s, /CURRENT STEP 2 DETAIL/);
  assert.match(s, /Remembered: beginner/);
  assert.ok(catalogText().includes("nano: "));
  assert.equal(argMap([{ key: " a ", value: " b " }]).a, "b");
  assert.equal(forRequest(Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `m${i}`, at: i }))).length, 30);
});
