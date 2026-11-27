// Writes the code RepairMind X generates for many real builds into a folder of Arduino sketches, with a
// manifest of which board and libraries each needs, so CI can compile every one with the real toolchains.
//
//   node scripts/sketches.mjs <out-dir>
//
// It covers every template, the example star toy, and every catalogue part on each board it works with: only
// designs the checker calls ready to build are included, since those are the ones people build.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze } from "../src/build/engine.ts";
import { firmware } from "../src/build/firmware.ts";
import { PARTS } from "../src/build/parts.ts";
import { TEMPLATES, fromTemplate } from "../src/build/templates.ts";
import { SAMPLE } from "../src/workspace/explode.ts";
import { editProject } from "../src/workspace/tools.ts";

const out = process.argv[2] || "sketches";
mkdirSync(out, { recursive: true });

const call = (id) => ({ tool: "add_part", why: "", args: [{ key: "id", value: id }] });
const build = (ids) => ids.reduce((p, id) => editProject(p, call(id)).project, null);

const designs = [...TEMPLATES.map((t) => [t.id, fromTemplate(t)]), ["sample-star", SAMPLE]];
for (const board of ["nano", "esp32"]) {
  for (const part of PARTS) designs.push([`${board}-${part.id}`, build([board, "usb", part.id])]);
  // parts that only work as a pair
  designs.push([`${board}-player-speaker`, build([board, "usb", "player", "speaker"])]);
}
designs.push(["esp32-amp-speaker", build(["esp32", "usb", "amp", "speaker"])]);
designs.push(["esp32-everything", build(["esp32", "usb", "mic", "amp", "speaker", "ring", "touch", "pir", "oled", "temp", "servo"])]);

const FQBN = { nano: "arduino:avr:nano", esp32: "esp32:esp32:esp32" };
const manifest = [];
const skipped = [];
for (const [name, project] of designs) {
  if (!project) { skipped.push(`${name}: could not be built`); continue; }
  const report = analyze(project);
  if (!report.board) { skipped.push(`${name}: no board`); continue; }
  const blocking = report.issues.filter((i) => i.level === "fix");
  if (blocking.length) { skipped.push(`${name}: ${blocking[0].text}`); continue; }
  const code = firmware(project, report);
  const sketch = name.replace(/[^a-z0-9]+/gi, "_");
  mkdirSync(join(out, sketch), { recursive: true });
  writeFileSync(join(out, sketch, `${sketch}.ino`), code.code);
  const libs = [...report.libs];
  // libraries a listed one needs that the Arduino library manager doesn't always pull in
  if (libs.includes("DHT sensor library")) libs.push("Adafruit Unified Sensor");
  if (report.board.id === "nano" && project.parts.some((p) => p.id === "servo")) libs.push("Servo");
  manifest.push({ sketch, fqbn: FQBN[report.board.id], libs });
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${manifest.length} sketches written to ${out}`);
if (skipped.length) console.log(`Skipped (not ready to build):\n  ${skipped.join("\n  ")}`);
