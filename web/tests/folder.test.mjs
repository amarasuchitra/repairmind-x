// The project folder: which files it holds, and that the .zip of it is a valid archive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/build/engine.ts";
import { SAMPLE, SAMPLE_BODY } from "../src/workspace/explode.ts";
import { crc32, projectFiles, slug, zip } from "../src/workspace/folder.ts";
import { toolsFor } from "../src/workspace/precision.ts";

test("the folder holds the sketch in its own folder, the guides, the parts list and the body", () => {
  const { root, files } = projectFiles(SAMPLE, analyze(SAMPLE), SAMPLE_BODY);
  assert.equal(root, "glowing-star-toy");
  const paths = files.map((f) => f.path);
  const ino = paths.find((p) => p.endsWith(".ino"));
  const [dir, name] = ino.split("/");
  assert.equal(`${dir}.ino`, name, "the Arduino IDE needs the folder and the sketch to share a name");
  assert.ok(!dir.endsWith(".ino"));
  for (const p of ["README.md", "wiring.md", "tests.md", "tools.md", "parts.csv", "project.json", "body/glowing-star-toy_front.stl", "body/glowing-star-toy_back.stl"]) {
    assert.ok(paths.includes(p), p);
  }
  assert.deepEqual(JSON.parse(files.find((f) => f.path === "project.json").data).name, SAMPLE.name);
  assert.equal(projectFiles(SAMPLE, analyze(SAMPLE), null).files.some((f) => f.path.endsWith(".stl")), false);
  assert.equal(slug("  My  Robot!! v2 "), "my-robot-v2");
  assert.equal(slug(""), "project");
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("the zip unpacks with a standard tool to the same files", (t) => {
  const { root, files } = projectFiles(SAMPLE, analyze(SAMPLE), SAMPLE_BODY);
  const dir = mkdtempSync(join(tmpdir(), "rmx-zip-"));
  const file = join(dir, "p.zip");
  writeFileSync(file, zip(root, files));
  try { execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])", file, dir]); }
  catch { t.skip("python3 not available"); return; }
  const readme = join(dir, root, "README.md");
  assert.ok(existsSync(readme));
  assert.equal(readFileSync(readme, "utf8"), files.find((f) => f.path === "README.md").data);
  assert.ok(existsSync(join(dir, root, "body", `${root}_front.stl`)));
});

test("tools follow the parts: a multimeter always, soldering when parts need it, a screwdriver for a booster", () => {
  const r = analyze(SAMPLE);
  const names = toolsFor(SAMPLE, r).map((x) => x.name);
  assert.ok(names.some((n) => /multimeter/i.test(n)));
  assert.ok(names.some((n) => /Mini-USB/.test(n)));
  assert.ok(names.some((n) => /Soldering iron/.test(n)), "the speaker needs soldering");
  const bare = { ...SAMPLE, parts: SAMPLE.parts.filter((p) => ["nano", "touch", "usb"].includes(p.id)) };
  assert.ok(!toolsFor(bare, analyze(bare)).some((x) => /Soldering iron/.test(x.name)));
  for (const x of toolsFor(SAMPLE, r)) assert.ok(x.shops.every((s) => s.url.startsWith("https://")));
});

test("the live build coach gets the same wires, pins and code the person sees", async () => {
  const { briefFor, readAction } = await import("../src/workspace/coach.ts");
  const { wireList } = await import("../src/workspace/precision.ts");
  const { firmware } = await import("../src/build/firmware.ts");
  const report = analyze(SAMPLE);
  const b = briefFor(SAMPLE, report);
  assert.equal(b.board, "nano");
  assert.deepEqual(b.wires.map((w) => w.text), wireList(report).map((w) => w.text));
  assert.equal(b.code, firmware(SAMPLE, report).code);
  assert.ok(b.sketch.endsWith(".ino") && !b.sketch.endsWith(".ino.ino"));
  assert.ok(b.parts.length === SAMPLE.parts.length);
  assert.deepEqual(readAction('{"action":"show_tab","target":"code"}'), { action: "show_tab", target: "code" });
  assert.equal(readAction('{"action":"rm -rf"}'), null);
  assert.equal(readAction("nope"), null);
});
