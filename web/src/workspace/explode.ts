/**
 * The exploded view in the middle of the workspace: where each piece of the product sits when it is pulled apart,
 * and where its label goes. Plain maths over the project and its body, so the page and the tests agree.
 *
 * Units are millimetres in the shell's own frame: the outline lies in x (width) and y (height), depth is z. The
 * view turns the whole thing so z points up, which stacks the pieces like a parts diagram: the top half of the
 * shell, then the electronics on their own levels, then the bottom half.
 */

import { BY_ID } from "../build/parts.ts";
import { short } from "../build/engine.ts";
import type { Project } from "../build/project.ts";
import { PRESETS, bbox, buildShell, fit, pack, type Box3, type ShellSpec } from "../sim/shell.ts";

export type PieceKind = "shellTop" | "shellBottom" | "board" | "speaker" | "ring" | "led" | "battery" | "motor" | "module";

export interface Piece {
  key: string;
  /** what the label says */
  label: string;
  kind: PieceKind;
  /** the catalogue id, for parts */
  id?: string;
  /** where it sits when the product is put together */
  home: [number, number, number];
  /** where it sits when pulled fully apart */
  apart: [number, number, number];
  size: [number, number, number];
  /** which side its label goes: -1 left, 1 right */
  side: -1 | 1;
}

const KIND: Record<string, PieceKind> = {
  esp32: "board", nano: "board", player: "board", amp: "board", mic: "board", touch: "board", oled: "board",
  temp: "board", motion6: "board", relay: "board", boost5: "board", soundsensor: "board",
  speaker: "speaker", buzzer: "speaker",
  ring: "ring", led: "led", strip: "led",
  aa3: "battery", aa4nimh: "battery", lipo: "battery",
  servo: "motor", vibe: "motor", pump: "motor",
};

export const kindOf = (id: string): PieceKind => KIND[id] ?? "module";

/** How the pieces sit, together and apart, for this project in this body. */
export function explode(project: Project, spec: ShellSpec, shapeName = ""): { pieces: Piece[]; span: number; radius: number; top: number; bottom: number } {
  const shell = buildShell(spec, 72);
  const ids = project.parts.map((p) => p.id).filter((id) => BY_ID[id] && id !== "switch");
  const boxes: Box3[] = ids.map((id) => ({ name: id, size: BY_ID[id].size }));
  const f = fit(shell, boxes);
  const placed = f.ok ? f.placed : pack(boxes, Math.max(40, (bbox(shell.innerProfile).x1 - bbox(shell.innerProfile).x0) * 0.9)).placed;
  // pack() names each placed box after the input, but reorders by size: match them back by name, one each
  const left = [...placed];
  const take = (id: string) => { const i = left.findIndex((p) => p.name === id); return i < 0 ? null : left.splice(i, 1)[0]; };

  const radius = Math.max(spec.width, spec.height) / 2;
  const d = spec.depth;
  const n = ids.length;
  const gap = Math.max(14, d * 0.55);
  // the electronics stack up from just above the bottom half, one level each, biggest at the bottom
  const order = ids.map((id, i) => ({ id, i, area: BY_ID[id].size[0] * BY_ID[id].size[1] })).sort((a, b) => b.area - a.area);
  const level = new Map(order.map((o, k) => [o.i, k]));
  const bottomZ = -d * 0.9 - gap * 0.4;
  const firstZ = bottomZ + d * 0.5 + gap * 0.6;
  const topZ = firstZ + Math.max(0, n - 1) * gap + d * 0.5 + gap * 0.9;
  const shape = shapeName || "Shell";

  const pieces: Piece[] = [
    { key: "top", label: `${shape} top`, kind: "shellTop", home: [0, 0, 0], apart: [0, 0, topZ], size: [spec.width, spec.height, d / 2], side: -1 },
  ];
  ids.forEach((id, i) => {
    const p = take(id);
    const part = BY_ID[id];
    const s = [...part.size].sort((a, b) => b - a) as [number, number, number];
    const k = level.get(i) ?? i;
    const hx = p ? p.x : 0, hy = p ? p.y : 0;
    // pulled apart, every part also moves a little toward the middle so the stack reads as one column
    pieces.push({
      key: `p${i}`, label: short(part), kind: kindOf(id), id,
      home: [hx, hy, 0], apart: [hx * 0.35, hy * 0.35, firstZ + k * gap],
      size: p ? [p.w, p.h, p.d] : s,
      side: k % 2 === 0 ? 1 : -1,
    });
  });
  pieces.push({ key: "bottom", label: `${shape} bottom`, kind: "shellBottom", home: [0, 0, 0], apart: [0, 0, bottomZ], size: [spec.width, spec.height, d / 2], side: 1 });
  return { pieces, span: Math.max(spec.width, spec.height, topZ - bottomZ), radius, top: topZ, bottom: bottomZ };
}

/** Somewhere between together (0) and apart (1). */
export function at(p: Piece, k: number): [number, number, number] {
  const e = Math.min(1, Math.max(0, k));
  return [0, 1, 2].map((j) => p.home[j] + (p.apart[j] - p.home[j]) * e) as [number, number, number];
}

/** The body's shape, as words for the labels. */
export function shapeLabel(source: string): string {
  const p = PRESETS.find((x) => x.id === source);
  if (!p) return source === "photo" ? "Body" : "Shell";
  return p.id === "box" ? "Case" : p.name.split(" ")[0];
}

/**
 * Shown before anyone has a project of their own, marked as an example: a star that glows and plays a lullaby
 * when touched. Real parts from the catalogue, so the checks and the build steps are the real ones.
 */
export const SAMPLE: Project = {
  v: 1,
  name: "Glowing star toy",
  mode: "new",
  goal: "A star night light that glows and plays a lullaby when a child touches it",
  product: { what: "a star night light toy", does: "", forKids: true, power: "battery", inner: null },
  parts: ["nano", "ring", "speaker", "player", "touch", "usb"].map((id, i) => ({ uid: `sample${i}`, id, x: 0.15 + (i % 3) * 0.3, y: i < 3 ? 0.3 : 0.7 })),
  rules: [
    { id: "s1", when: "touch", then: "light", color: "#ffc94a" },
    { id: "s2", when: "touch", then: "say", text: "lullaby" },
  ],
};

export const SAMPLE_BODY: { spec: ShellSpec; source: string; keep: boolean; squeeze: number } = {
  spec: { outline: PRESETS.find((p) => p.id === "star")!.make(), width: 140, height: 136, depth: 50, round: 12, wall: 2.4, material: "petg" },
  source: "star", keep: true, squeeze: 100,
};
