// The exploded 3D view in the workspace: where each piece sits together and apart, and the example project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyze } from "../src/build/engine.ts";
import { SAMPLE, SAMPLE_BODY, at, explode, kindOf, shapeLabel } from "../src/workspace/explode.ts";

test("the shell halves bracket every part, and pieces come apart in order", () => {
  const { pieces, top, bottom } = explode(SAMPLE, SAMPLE_BODY.spec, "Star");
  assert.equal(pieces.length, SAMPLE.parts.length + 2);
  assert.equal(pieces[0].kind, "shellTop");
  assert.equal(pieces.at(-1).kind, "shellBottom");
  assert.equal(pieces[0].apart[2], top);
  assert.equal(pieces.at(-1).apart[2], bottom);
  const inner = pieces.slice(1, -1);
  for (const p of inner) assert.ok(p.apart[2] > bottom && p.apart[2] < top, `${p.label} sits between the halves`);
  // every part has its own level
  assert.equal(new Set(inner.map((p) => p.apart[2])).size, inner.length);
  // labels alternate sides so neighbours don't collide
  assert.ok(inner.some((p) => p.side === 1) && inner.some((p) => p.side === -1));
});

test("together means at home, apart means at the stack position", () => {
  const { pieces } = explode(SAMPLE, SAMPLE_BODY.spec);
  const near = (a, b) => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${a} != ${b}`));
  for (const p of pieces) {
    near(at(p, 0), p.home);
    near(at(p, 1), p.apart);
    near(at(p, 7), p.apart);
  }
});

test("the switch is left out, unknown parts still show, and kinds are sensible", () => {
  const p = { ...SAMPLE, parts: [...SAMPLE.parts, { uid: "x", id: "switch", x: 0, y: 0 }, { uid: "y", id: "nope", x: 0, y: 0 }] };
  assert.equal(explode(p, SAMPLE_BODY.spec).pieces.length, SAMPLE.parts.length + 2);
  assert.equal(kindOf("nano"), "board");
  assert.equal(kindOf("speaker"), "speaker");
  assert.equal(kindOf("ring"), "ring");
  assert.equal(kindOf("something-new"), "module");
  assert.equal(shapeLabel("star"), "Star");
  assert.equal(shapeLabel("box"), "Case");
  assert.equal(shapeLabel("photo"), "Body");
});

test("the example project is a clean build, so its steps are honest", () => {
  const r = analyze(SAMPLE);
  assert.deepEqual(r.issues.filter((i) => i.level === "fix").map((i) => i.text), []);
  assert.ok(r.steps.length >= 3);
});
