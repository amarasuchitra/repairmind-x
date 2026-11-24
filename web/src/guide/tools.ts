/**
 * The build guide's hands. The guide (a model on the server) picks tools; these run them here, on the same
 * checker, circuit simulator and shell maths the rest of the app uses, and describe what happened in plain
 * text for the guide's next turn. Nothing here calls the network or touches the page, so tests run it in Node.
 */
import { analyze, applyFix, short, type Report } from "../build/engine.ts";
import { ALL, BY_ID, isBoard, type Part } from "../build/parts.ts";
import { ACTIONS, TRIGGERS, emptyProject, uid, type Action, type Project, type Trigger } from "../build/project.ts";
import { autoRules, suggest } from "../build/templates.ts";
import type { Assessment } from "../build/assess.ts";
import { Bench, defaultEnv, defaultMods, type Env, type Mods } from "../sim/bench.ts";
import { MATERIALS, PRESETS, buildShell, engineering, fit, scaleToFit, type Box3, type ShellSpec } from "../sim/shell.ts";

export type Tool =
  | "understand_idea" | "answer_questions" | "correct_understanding" | "start_build" | "suggest_parts" | "add_part"
  | "remove_part" | "apply_fix" | "add_rule" | "rename" | "check" | "show" | "test_on_bench" | "shape_body"
  | "design_mechanism" | "rethink_design" | "open_full_lab" | "show_step" | "step_done";

export interface KV { key: string; value: string }
export interface ToolCall { tool: Tool; args: KV[]; why: string }
export interface Checkpoint { step: number; question: string; options: string[] }
export type Stage = "idea" | "understand" | "plan" | "design" | "simulate" | "body" | "build" | "done";
export interface GuideTurn {
  say: string; actions: ToolCall[]; checkpoint: Checkpoint; chips: string[]; stage: Stage; remember: string[]; then_continue: boolean;
}

/** What can sit beside the conversation. "none" keeps the screen to just the guide. */
export type View = "none" | "plan" | "parts" | "wiring" | "try" | "body" | "code" | "steps" | "design";
export const VIEWS: View[] = ["none", "plan", "parts", "wiring", "try", "body", "code", "steps", "design"];

// --- arguments ---------------------------------------------------------------------------------------------------

export function argMap(args: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args ?? []) if (a && typeof a.key === "string") out[a.key.trim()] = String(a.value ?? "").trim();
  return out;
}
const num = (s: string | undefined): number | null => {
  if (s === undefined || s === "") return null;
  const n = Number(String(s).replace(/[^\d.+-eE]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const bool = (s: string | undefined): boolean | null =>
  s === undefined || s === "" ? null : /^(true|yes|on|1|y)$/i.test(s) ? true : /^(false|no|off|0|n)$/i.test(s) ? false : null;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Find a catalogue part from an id or a name the model gave. */
export function findPart(s: string): Part | null {
  const q = s.trim().toLowerCase();
  if (!q) return null;
  return BY_ID[q] ?? ALL.find((p) => p.name.toLowerCase() === q) ?? ALL.find((p) => `${p.name} ${p.plain}`.toLowerCase().includes(q)) ?? null;
}

// --- what the guide is told about the world ----------------------------------------------------------------------

/** The catalogue in short lines: the guide may only use these ids. */
export function catalogText(): string {
  return [
    "PARTS (id: name, price):",
    ...ALL.map((p) => `${p.id}: ${short(p)} (₹${p.priceInr})`),
    "TRIGGERS (when): " + TRIGGERS.map((x) => `${x.id} = ${x.label}`).join("; "),
    "ACTIONS (then): " + ACTIONS.map((x) => `${x.id} = ${x.label}`).join("; "),
    "BODY SHAPES: " + PRESETS.map((p) => `${p.id} (${p.name})`).join(", "),
    "BODY MATERIALS: " + MATERIALS.map((m) => `${m.id} (${m.name})`).join(", "),
    "VIEWS: " + VIEWS.join(", "),
  ].join("\n");
}

export function reportText(project: Project, report: Report): string {
  if (!project.parts.length) return "No parts yet.";
  const parts = project.parts.map((x) => BY_ID[x.id]).filter(Boolean).map((p) => `${p.id} (${short(p)})`);
  const issues = report.issues.filter((i) => i.level !== "tip");
  const lines = [
    `Parts: ${parts.join(", ")}.`,
    project.rules.length ? `Behaviour: ${project.rules.map((r) => `when ${r.when} then ${r.then}${r.text ? ` "${r.text}"` : ""}`).join("; ")}.` : "Behaviour: none yet.",
    report.ready ? "Checks: all pass, ready to build." : `Checks: ${issues.filter((i) => i.level === "block" || i.level === "fix").length} to fix.`,
    ...issues.map((i, n) => `  ${n + 1}. [${i.level}] ${i.text}${i.fix ? ` (fix available: ${i.fix.label})` : ""}`),
    `Cost about ₹${report.totalInr}. Draw ${report.draw.mA} mA typical, ${report.draw.peakmA} mA peak.` +
      (report.hours !== null ? ` About ${report.hours.toFixed(1)} h on a full battery.` : report.source?.kind === "usb" ? " USB powered." : ""),
  ];
  return lines.join("\n");
}

export function assessmentText(a: Assessment): string {
  return [
    `Verdict: ${a.overall} (${a.overall_why})`,
    `Understood: ${a.restated}`,
    ...a.wishes.map((w) => `Wish "${w.wish}": ${w.verdict}. ${w.why}${w.alternative ? ` Instead: ${w.alternative}` : ""}`),
    a.plan.summary ? `Plan: ${a.plan.summary}` : "",
    a.plan.parts.length ? `Planned parts: ${a.plan.parts.map((p) => p.id).join(", ")}` : "",
    a.plan.warnings.length ? `Warnings: ${a.plan.warnings.join("; ")}` : "",
    a.questions.length ? `Open questions: ${a.questions.map((q) => `${q.q} [${q.options.join(" / ")}]`).join(" | ")}` : "",
    a.design_lab ? "The analyst suggests the design lab for the mechanics." : "",
  ].filter(Boolean).join("\n");
}

// --- changing the project ----------------------------------------------------------------------------------------

export interface Change { project: Project; text: string }

function addPart(project: Project, id: string): Change {
  const part = findPart(id);
  if (!part) return { project, text: `No part "${id}" in the catalogue.` };
  if (isBoard(part) && project.parts.some((x) => isBoard(BY_ID[x.id]))) {
    const next = { ...project, parts: project.parts.map((x) => (isBoard(BY_ID[x.id]) ? { ...x, id: part.id } : x)) };
    return { project: next, text: `Swapped the board for ${short(part)}.` };
  }
  const parts = [...project.parts, { uid: uid(), id: part.id, x: 0.2 + Math.random() * 0.6, y: 0.2 + Math.random() * 0.6 }];
  const next = { ...project, parts };
  return { project: { ...next, rules: autoRules(next) }, text: `Added ${short(part)}.` };
}

function pruneRules(p: Project): Project {
  const ids = new Set(p.parts.map((x) => x.id));
  const ok = (needs: string[]) => !needs.length || needs.some((n) => ids.has(n));
  return { ...p, rules: p.rules.filter((r) => ok(TRIGGERS.find((t) => t.id === r.when)!.needs) && ok(ACTIONS.find((a) => a.id === r.then)!.needs)) };
}

/** Tools that only change the project. Returns null for tools that aren't project edits. */
export function editProject(project: Project | null, call: ToolCall): Change | null {
  const a = argMap(call.args);
  const p = project ?? emptyProject("new");
  switch (call.tool) {
    case "suggest_parts": {
      const s = suggest(a.goal || a.text || "", p);
      if (!s.reasons.length) return { project: p, text: `No catalogue parts matched "${a.goal}".` };
      return { project: s.project, text: `Added parts for: ${s.reasons.join(", ")}.` };
    }
    case "add_part": return addPart(p, a.id || a.part || "");
    case "remove_part": {
      const part = findPart(a.id || a.part || "");
      const hit = part && p.parts.find((x) => x.id === part.id);
      if (!hit) return { project: p, text: `There's no ${a.id} in the project.` };
      return { project: pruneRules({ ...p, parts: p.parts.filter((x) => x.uid !== hit.uid) }), text: `Removed ${short(part!)}.` };
    }
    case "apply_fix": {
      const issues = analyze(p).issues.filter((i) => i.level !== "tip");
      const which = (a.n ?? "all").toLowerCase();
      const pick = which === "all" ? issues.filter((i) => i.fix) : [issues[(num(which) ?? 0) - 1]].filter((i) => i && i.fix);
      if (!pick.length) return { project: p, text: "No fix to apply there." };
      let next = p;
      const done: string[] = [];
      for (const i of pick) {
        // re-find the issue each time: earlier fixes change the project
        const cur = analyze(next).issues.find((x) => x.text === i.text && x.fix);
        if (!cur) continue;
        next = pruneRules(applyFix(next, cur.fix!, uid));
        next = { ...next, rules: autoRules(next) };
        done.push(cur.fix!.label);
      }
      return { project: next, text: done.length ? `Applied: ${done.join("; ")}.` : "Those issues were already fixed." };
    }
    case "add_rule": {
      const when = a.when as Trigger, then = a.then as Action;
      if (!TRIGGERS.some((t) => t.id === when) || !ACTIONS.some((x) => x.id === then)) return { project: p, text: `Unknown trigger or action (${a.when} → ${a.then}).` };
      const rule = { id: uid("r"), when, then, text: a.text ? a.text.slice(0, 120) : undefined, color: /^#[0-9a-f]{6}$/i.test(a.color ?? "") ? a.color : undefined };
      return { project: { ...p, rules: [...p.rules, rule] }, text: `Added: when ${when}, ${then}.` };
    }
    case "rename": return { project: { ...p, name: (a.name ?? "").slice(0, 80) }, text: `Named it "${a.name}".` };
    default: return null;
  }
}

// --- the bench ---------------------------------------------------------------------------------------------------

const ENV_NUM: (keyof Env)[] = ["lux", "soilPct", "distanceCm", "shakeG", "tempC"];
const ENV_BOOL: (keyof Env)[] = ["touch", "button", "motion", "door", "clap"];
const MOD_NUM: (keyof Mods)[] = ["ledOhm", "boostV", "charge", "servoLoadG", "servoArmCm", "ringBright", "ambientC"];
const MOD_BOOL: (keyof Mods)[] = ["echoDivider", "bulkCap", "booster", "flyback", "thinWires", "short"];

export interface BenchSetup { env: Env; mods: Mods; power: boolean; seconds: number }

export function benchSetup(report: Report, args: KV[]): BenchSetup {
  const a = argMap(args);
  const env = defaultEnv();
  const mods = defaultMods(report);
  for (const k of ENV_NUM) { const v = num(a[k]); if (v !== null) (env as unknown as Record<string, number>)[k] = v; }
  for (const k of ENV_BOOL) { const v = bool(a[k]); if (v !== null) (env as unknown as Record<string, boolean>)[k] = v; }
  for (const k of MOD_NUM) { const v = num(a[k]); if (v !== null) (mods as unknown as Record<string, number>)[k] = v; }
  for (const k of MOD_BOOL) { const v = bool(a[k]); if (v !== null) (mods as unknown as Record<string, boolean>)[k] = v; }
  if (mods.charge > 1) mods.charge = mods.charge / 100;
  mods.charge = clamp(mods.charge, 0, 1);
  if (a.ledColor && ["red", "green", "blue", "white"].includes(a.ledColor)) mods.ledColor = a.ledColor as Mods["ledColor"];
  return { env, mods, power: bool(a.power) ?? true, seconds: clamp(num(a.seconds) ?? 4, 0.5, 30) };
}

/**
 * Run the project on the virtual bench without drawing it. A momentary input (a clap, a touch, a button) is held
 * for a moment after the board has booted, the way a person would press it, so its effect shows in the result.
 */
export function benchRun(project: Project, s: BenchSetup): string {
  const b = new Bench(project, s.mods);
  if (!b.board) return "The bench needs a board (the brain) first.";
  if (!b.report.source) return "The bench needs a power source first.";
  const quiet: Env = { ...s.env, clap: false, touch: false, button: false };
  const pulse = s.env.clap || s.env.touch || s.env.button;
  b.setPower(s.power);
  const dt = 0.005;
  let t = 0;
  const lit = new Map<string, number>();
  while (t < s.seconds) {
    const press = pulse && t > 1 && t < 1.3;
    b.step(dt, press ? s.env : quiet);
    t += dt;
    // remember the brightest each light got, so a short flash isn't missed
    if (t > 0.6) for (const p of b.frame().parts) if (p.show.lit !== undefined) lit.set(p.uid, Math.max(lit.get(p.uid) ?? 0, p.show.lit));
  }
  const f = b.frame();
  const world = Object.entries(s.env).filter(([k, v]) => (typeof v === "boolean" ? v : v !== (defaultEnv() as unknown as Record<string, unknown>)[k]))
    .map(([k, v]) => `${k}=${v}`);
  const lines = [
    `Bench, ${s.seconds} s${world.length ? `, world: ${world.join(", ")}` : ", normal room"}. Board: ${f.board.status}${f.board.resets ? `, ${f.board.resets} resets (brownout)` : ""}. Supply ${f.source.v.toFixed(2)} V, ${f.source.mA.toFixed(0)} mA${f.source.tripped ? ", protection tripped" : ""}. 5 V rail ${f.rails.v5.toFixed(2)} V.`,
    ...f.parts.map((p) => {
      const sh = p.show;
      const did = [
        lit.has(p.uid) ? (lit.get(p.uid)! > 0.05 ? `lit (up to ${Math.round(lit.get(p.uid)! * 100)}%)` : "stayed dark") : "",
        sh.deg !== undefined ? `arm at ${Math.round(sh.deg)}°` : "",
        sh.tone ? `beeping ${Math.round(sh.tone)} Hz` : "",
        sh.running !== undefined ? (sh.running ? "running" : "stopped") : "",
        sh.text ? `shows "${sh.text}"` : "",
        sh.reading ? `reads ${sh.reading}` : "",
      ].filter(Boolean).join(", ");
      return `- ${p.name}: ${p.status}, ${p.mA.toFixed(1)} mA${p.tempC !== null && p.tempC > 35 ? `, ${p.tempC.toFixed(0)} °C` : ""}${did ? `; ${did}` : ""}`;
    }),
  ];
  if (f.events.length) {
    lines.push("Events:");
    for (const e of f.events.slice(-8)) lines.push(`- [${e.severity}] ${e.title}. Why: ${e.why} Fix: ${e.fix}`);
  } else lines.push("No failures.");
  return lines.join("\n");
}

// --- the body ----------------------------------------------------------------------------------------------------

export interface BodySaved { spec: ShellSpec; source: string; keep: boolean; squeeze: number }

export const freshBody = (): BodySaved => ({ spec: { outline: PRESETS[0].make(), width: 100, height: 70, depth: 45, round: 8, wall: 2.4, material: "petg" }, source: "box", keep: true, squeeze: 100 });

export const bodyParts = (project: Project): Box3[] =>
  project.parts.map((p) => BY_ID[p.id]).filter(Boolean).filter((p) => p.id !== "switch").map((p) => ({ name: short(p), size: p.size }));

const SHAPE_ALIAS: Record<string, string> = { rounded: "box", rect: "box", box: "box", round: "round", circle: "round", egg: "oval", oval: "oval", star: "star", heart: "heart" };

export function shapeBody(project: Project, prev: BodySaved, args: KV[]): { body: BodySaved; text: string } {
  const a = argMap(args);
  const s: BodySaved = { ...prev, spec: { ...prev.spec } };
  const shape = SHAPE_ALIAS[(a.shape ?? "").toLowerCase()];
  const preset = PRESETS.find((p) => p.id === shape);
  if (preset) { s.spec.outline = preset.make(); s.source = preset.id; }
  for (const k of ["width", "height", "depth", "wall", "round"] as const) {
    const v = num(a[k]);
    if (v !== null) s.spec[k] = k === "wall" ? clamp(v, 0.8, 8) : k === "round" ? clamp(v, 0, 200) : clamp(v, k === "depth" ? 6 : 10, 600);
  }
  // one of width or height given (or a new shape): keep the outline's own proportions, as the body view does
  const xs = s.spec.outline.map((q) => q[0]), ys = s.spec.outline.map((q) => q[1]);
  const aspect = (Math.max(...ys) - Math.min(...ys)) / Math.max(1e-9, Math.max(...xs) - Math.min(...xs));
  const w = num(a.width), h = num(a.height);
  if (w !== null && h === null) s.spec.height = clamp(Math.round(s.spec.width * aspect), 10, 600);
  else if (h !== null && w === null) s.spec.width = clamp(Math.round(s.spec.height / aspect), 10, 600);
  else if (w === null && h === null && preset) s.spec.height = clamp(Math.round(s.spec.width * aspect), 10, 600);
  s.spec.round = Math.min(s.spec.round, s.spec.depth / 2);
  const mat = MATERIALS.find((m) => m.id === (a.material ?? "").toLowerCase());
  if (mat) s.spec.material = mat.id;
  const parts = bodyParts(project);
  let grew = "";
  if (bool(a.fit)) {
    const k = scaleToFit(s.spec, parts);
    if (k === null) grew = "Couldn't find a size that holds the parts in this shape. ";
    else if (Math.abs(k - 1) > 0.01) {
      s.spec.width = Math.ceil(s.spec.width * k); s.spec.height = Math.ceil(s.spec.height * k); s.spec.depth = Math.ceil(s.spec.depth * k);
      grew = `Scaled ×${k.toFixed(2)} to just hold the parts. `;
    }
  }
  return { body: s, text: grew + bodyText(project, s) };
}

export function bodyText(project: Project, s: BodySaved): string {
  const sh = buildShell(s.spec);
  const f = fit(sh, bodyParts(project));
  const e = engineering(s.spec, sh, s.squeeze);
  const m = MATERIALS.find((x) => x.id === s.spec.material) ?? MATERIALS[0];
  return `Body: ${s.source}, ${s.spec.width} × ${s.spec.height} × ${s.spec.depth} mm, wall ${s.spec.wall} mm, ${m.name}. ` +
    `${f.ok ? `Electronics fit with ${f.marginMm.toFixed(1)} mm to spare.` : `Electronics don't fit: ${f.reason}.`} ` +
    `Mass about ${e.massG.toFixed(0)} g, print about ${e.printH.toFixed(1)} h, about ₹${Math.round(e.costInr)}. ` +
    `Squeeze test (${e.squeezeN} N): safety factor ${e.safety.toFixed(1)}${e.safety < 2 ? `, below 2; a ${e.wallFor2.toFixed(1)} mm wall would reach 2` : ""}.`;
}

// --- memory ------------------------------------------------------------------------------------------------------

export interface Said {
  role: "user" | "guide" | "tool"; text: string; at: number;
  /** for tool results: the short lines the page shows instead of the full results */
  brief?: string;
  /** names of files sent with this message */
  files?: string[];
}

export interface Memory {
  v: 1;
  messages: Said[];
  stage: Stage;
  notes: string[];
  view: View;
  /** build steps the person confirmed on their real build (1-based) */
  done: number[];
  step: number;
  checkpoint: Checkpoint | null;
  chips: string[];
}

export const freshMemory = (): Memory => ({ v: 1, messages: [], stage: "idea", notes: [], view: "none", done: [], step: 0, checkpoint: null, chips: [] });

export function parseMemory(raw: string | null): Memory {
  try {
    const m = raw ? JSON.parse(raw) : null;
    if (!m || m.v !== 1 || !Array.isArray(m.messages)) return freshMemory();
    return {
      ...freshMemory(), ...m,
      messages: m.messages.filter((x: Said) => x && typeof x.text === "string" && ["user", "guide", "tool"].includes(x.role)).slice(-120),
      notes: Array.isArray(m.notes) ? m.notes.filter((x: unknown) => typeof x === "string").slice(-30) : [],
      done: Array.isArray(m.done) ? m.done.filter((x: unknown) => typeof x === "number") : [],
      view: VIEWS.includes(m.view) ? m.view : "none",
    };
  } catch {
    return freshMemory();
  }
}

/** Keep what the guide learned, without repeats. */
export function remember(m: Memory, facts: string[]): string[] {
  const out = [...m.notes];
  for (const f of facts) if (f && !out.some((x) => x.toLowerCase() === f.toLowerCase())) out.push(f);
  return out.slice(-30);
}

/** Everything the guide needs to know about the project right now, as plain text. */
export function stateText(x: {
  memory: Memory; project: Project | null; report: Report | null; assessment: Assessment | null; idea: string;
  bench: string; body: string; design: string; language: string;
}): string {
  const m = x.memory;
  const steps = x.report?.steps ?? [];
  return [
    `Stage: ${m.stage}. On screen: ${m.view}.`,
    x.idea ? `Idea in their words: ${x.idea}` : "",
    m.notes.length ? `Remembered: ${m.notes.join("; ")}` : "",
    x.assessment ? `ANALYST:\n${assessmentText(x.assessment)}` : "",
    x.project && x.report ? `PROJECT "${x.project.name || "unnamed"}" (${x.project.mode}):\n${reportText(x.project, x.report)}` : "No project laid out yet.",
    steps.length ? `BUILD STEPS (done: ${m.done.length ? m.done.join(", ") : "none"}; current: ${m.step || "not started"}):\n` +
      steps.map((s, i) => `  ${i + 1}. ${s.title}${m.done.includes(i + 1) ? " ✓" : ""}`).join("\n") : "",
    m.step && steps[m.step - 1] ? `CURRENT STEP ${m.step} DETAIL: ${steps[m.step - 1].detail.join(" ")}${steps[m.step - 1].safety?.length ? ` SAFETY: ${steps[m.step - 1].safety!.join(" ")}` : ""}` : "",
    m.checkpoint ? `Waiting on checkpoint: ${m.checkpoint.question}` : "",
    x.bench ? `LAST BENCH RUN:\n${x.bench}` : "",
    x.body ? `BODY:\n${x.body}` : "",
    x.design ? `DESIGN LAB:\n${x.design}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 15000);
}

/** The last messages, sized for one request. Tool results are kept short; the latest ones matter most. */
export function forRequest(messages: Said[]): { role: Said["role"]; text: string }[] {
  return messages.slice(-30).map((m) => ({ role: m.role, text: m.text.slice(0, m.role === "tool" ? 3000 : 2000) }));
}
