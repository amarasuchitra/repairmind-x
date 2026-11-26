// Precise builds: numbered wires with colours, multimeter readings, a buying list and one build pack.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/build/engine.ts";
import { firmware } from "../src/build/firmware.ts";
import { editProject } from "../src/workspace/tools.ts";
import { buildPack, buyCsv, buyList, colourFor, readings, wireList } from "../src/workspace/precision.ts";

const call = (tool, args = {}) => ({ tool, why: "", args: Object.entries(args).map(([key, value]) => ({ key, value: String(value) })) });
const build = (...ids) => ids.reduce((p, id) => editProject(p, call("add_part", { id })).project, null);

test("every connection becomes one numbered wire with the usual colours", () => {
  const p = build("nano", "usb", "led", "light");
  const r = analyze(p);
  const wires = wireList(r);
  assert.equal(wires.length, r.conns.length);
  assert.deepEqual(wires.map((w) => w.n), wires.map((_, i) => i + 1));
  for (const w of wires) {
    if (w.kind === "gnd") assert.equal(w.colour, "black");
    if (w.kind === "5v") assert.equal(w.colour, "red");
    assert.match(w.text, /→/);
  }
  // signals get different colours from each other and from power
  const sig = wires.filter((w) => w.kind === "signal").map((w) => w.colour);
  assert.equal(new Set(sig).size, sig.length);
  assert.ok(!sig.includes("red") && !sig.includes("black"));
  assert.equal(colourFor("3v3", 0), "orange");
});

test("readings start with the power-off short check and follow the supply", () => {
  const usb = readings(analyze(build("nano", "usb", "led")));
  assert.equal(usb[0].when, "power off");
  assert.match(usb[0].expect, /100 Ω/);
  assert.ok(usb.some((x) => x.expect === "4.75–5.25 V"));
  const aa = readings(analyze(build("esp32", "aa3", "boost5", "led")));
  assert.ok(aa.some((x) => /booster/.test(x.what) && x.expect === "4.9–5.2 V"));
  assert.ok(aa.some((x) => x.what === "3.3 V pin"));
  const current = aa.find((x) => x.what === "Current from the supply");
  assert.ok(current && /mA/.test(current.expect));
});

test("the buying list matches the checker's parts and total, with shop links", () => {
  const r = analyze(build("nano", "usb", "led", "buzzer"));
  const { lines, total } = buyList(r);
  assert.equal(total, r.totalInr);
  assert.equal(lines.length, r.bom.length);
  for (const l of lines) {
    assert.equal(l.shops.length, 3);
    for (const s of l.shops) assert.match(s.url, /^https:\/\//);
  }
  const csv = buyCsv(r).split("\n");
  assert.equal(csv[0], "Part,Qty,Each (INR),Total (INR),Robu,Amazon.in");
  assert.equal(csv.at(-1), `Total,,,${total},,`);
});

test("the build pack carries wires, readings, steps and the code", () => {
  const p = { ...build("nano", "usb", "led", "light"), name: "Night light" };
  const r = analyze(p);
  const md = buildPack(p, r, firmware(p, r));
  assert.match(md, /^# Night light/);
  assert.match(md, /- \[ \] \*\*1\.\*\*/);
  assert.match(md, /multimeter/);
  assert.match(md, /```cpp/);
  assert.equal((md.match(/^### \d+\./gm) ?? []).length, r.steps.length);
});
