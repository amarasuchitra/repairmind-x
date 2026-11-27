/**
 * What the live build coach is told about the project when the call starts: the same wires, pins, steps and code
 * the person sees on screen, so the coach can only ever guide what the build really has.
 */
import type { Report } from "../build/engine.ts";
import { firmware } from "../build/firmware.ts";
import { BY_ID } from "../build/parts.ts";
import type { Project } from "../build/project.ts";
import { wireList } from "./precision.ts";

export const TOPIC_BUILD = "rmx.build";
export const TOPIC_BRIEF = "rmx.build.brief";
export const TOPIC_APP = "rmx.app";

export interface Brief {
  name: string;
  board: "esp32" | "nano" | "";
  parts: string[];
  wires: { n: number; text: string; from: string; to: string; colour: string; via: string }[];
  pins: { pin: string; use: string }[];
  steps: { title: string; detail: string[]; safety: string[] }[];
  sketch: string;
  code: string;
  libs: string[];
}

/** Progress the coach sends back. */
export interface BuildView {
  name: string;
  current: number;
  step: number;
  done: number[];
  checked: number[];
  total: number;
  uploaded: boolean;
  serial: string;
  busy?: "" | "upload" | "serial";
  log?: string;
}

export interface AppAction { action: "show_tab" | "save_folder" | "download_pack" | "go_to_step"; target: string }

export function briefFor(project: Project, report: Report): Brief {
  const id = report.board?.id;
  const code = report.board ? firmware(project, report) : null;
  return {
    name: project.name || "My project",
    board: id === "esp32" || id === "nano" ? id : "",
    parts: project.parts.map((p) => BY_ID[p.id]?.name).filter((x): x is string => !!x),
    wires: wireList(report).map((w) => ({ n: w.n, text: w.text, from: w.from, to: w.to, colour: w.colour, via: w.via ?? "" })),
    pins: report.pinMap.map((p) => ({ pin: p.pin, use: p.use })),
    steps: report.steps.map((s) => ({ title: s.title, detail: s.detail, safety: s.safety ?? [] })),
    sketch: code?.name ?? "sketch.ino",
    code: code?.code ?? "",
    libs: report.libs,
  };
}

const ACTIONS = new Set(["show_tab", "save_folder", "download_pack", "go_to_step"]);

/** An action from the coach, or null if it isn't one the screen knows. */
export function readAction(text: string): AppAction | null {
  try {
    const a = JSON.parse(text);
    return a && ACTIONS.has(a.action) ? { action: a.action, target: String(a.target ?? "") } : null;
  } catch {
    return null;
  }
}
