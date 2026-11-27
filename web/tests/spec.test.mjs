// The engineering spec sheet: every figure agrees with the engine and can be re-derived from its working.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze, BOOST_EFF, USABLE } from "../src/build/engine.ts";
import { hoursText, specMarkdown, specSheet } from "../src/build/spec.ts";
import { SAMPLE } from "../src/workspace/explode.ts";

const project = (ids, extra = {}) => ({
  v: 1, name: "Test", mode: "new", goal: "", rules: [],
  product: { what: "", does: "", forKids: false, power: "battery", inner: null },
  parts: ids.map((id, i) => ({ uid: `u${i}`, id, x: 0.1, y: 0.1 })), ...extra,
});
const row = (groups, key) => groups.flatMap((g) => g.rows).find((r) => r.key === key);
const num = (s) => Number(String(s).replace(/[^0-9.]/g, ""));

test("the sample's spec covers power, fit and cost, and the currents add up to the engine's", () => {
  const r = analyze(SAMPLE);
  const g = specSheet(r);
  assert.deepEqual(g.map((x) => x.id), ["power", "fit", "cost"]);
  assert.equal(num(row(g, "i_typ").value), r.draw.mA, "on USB the parts' current is the supply current");
  assert.equal(num(row(g, "i_peak").value), r.draw.peakmA);
  assert.equal(num(row(g, "cost").value), r.totalInr);
  for (const x of g.flatMap((y) => y.rows)) assert.ok(x.formula && x.working && x.note, x.key);
});

test("on batteries through a booster the battery current and the hours follow their formulas", () => {
  const r = analyze(project(["esp32", "ring", "aa3", "boost5", "switch"]));
  const g = specSheet(r);
  const i5 = r.budget.reduce((s, b) => s + b.mA, 0);
  assert.ok(Math.abs(r.draw.mA - (i5 * 5) / (r.source.v[0] * BOOST_EFF)) <= 1);
  assert.match(row(g, "i_batt").working, new RegExp(`× ${BOOST_EFF}\\)`));
  assert.ok(Math.abs(r.hours - (r.source.mAh * USABLE) / r.draw.mA) < 1e-9);
  assert.equal(row(g, "life").value, hoursText(r.hours));
  assert.ok(row(g, "life_min"), "the worst-case floor is shown too");
  assert.equal(row(g, "rail").verdict, "ok", "boosted to 5 V the ESP32 runs until the cells are flat");
});

test("loads past their limit are marked over", () => {
  const r = analyze(project(["nano", "oled", "usb"]));
  const reg = row(specSheet(r), "reg3");
  if (reg) assert.equal(reg.verdict, num(reg.value) > r.board.max3v3mA ? "over" : reg.verdict);
  const r2 = analyze(project(["esp32", "strip", "servo", "usb"], { product: { what: "", does: "", forKids: false, power: "usb", inner: null } }));
  const m = row(specSheet(r2), "src_margin");
  assert.equal(m.verdict, r2.draw.peakmA > r2.source.maxmA ? "over" : r2.draw.peakmA > r2.source.maxmA * 0.8 ? "tight" : "ok");
});

test("the spec as Markdown has a table per group and no empty cells in the value column", () => {
  const md = specMarkdown("Star", specSheet(analyze(SAMPLE)));
  assert.match(md, /^# Engineering spec: Star/);
  assert.equal((md.match(/\| Quantity \| Value/g) || []).length, 3);
  assert.doesNotMatch(md, /\| \*\*\*\* \|/);
});

test("hours read naturally", () => {
  assert.equal(hoursText(0.5), "about 30 minutes");
  assert.equal(hoursText(5.25), "about 5.3 hours");
  assert.equal(hoursText(72), "about 3.0 days");
});
