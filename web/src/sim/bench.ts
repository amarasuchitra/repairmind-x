/**
 * The virtual bench: a project's parts, wired the way the builder wires them, powered and running. Each step
 * it lets the code run, moves the servo arm, solves the circuit (circuit.ts), warms and cools what carries
 * current, and checks every part against its ratings. Anything pushed past a limit fails the way the real
 * part would: an LED burns open, a pin driver dies, a regulator shuts itself off when hot, the board
 * restarts when its supply dips, a servo stalls or strips its gears. Each failure says what happened, the
 * numbers that caused it, and how to fix it.
 *
 * The numbers are typical datasheet values for the hobby modules in parts.ts; they show what would happen,
 * not what a particular part from a particular shop will do.
 */
import { analyze, railFor, short, type Report } from "../build/engine.ts";
import { BY_ID, isBoard, isPower, type Board, type Part, type Power } from "../build/parts.ts";
import type { Project } from "../build/project.ts";
import { SI_DIODE, ledModel, newState, solve, type El, type Solution } from "./circuit.ts";
import { RulesProgram, quietOuts, type Outs, type Readings } from "./program.ts";

/** What the person can change on the bench: values, wiring choices, and mistakes to try safely. */
export interface Mods {
  /** resistor in series with the single LED, Ω (0 = left out) */
  ledOhm: number;
  ledColor: "red" | "green" | "blue" | "white";
  /** the 1k/2k divider on the distance sensor's ECHO line (3.3 V boards) */
  echoDivider: boolean;
  /** the 470 µF capacitor across 5 V near the servo and LEDs */
  bulkCap: boolean;
  /** the 5 V booster is in the circuit (if the project has one) */
  booster: boolean;
  /** what the booster's trimmer is set to, V */
  boostV: number;
  /** battery charge, 0–1 */
  charge: number;
  /** a weight on the servo arm, grams, and how far out it sits, cm */
  servoLoadG: number;
  servoArmCm: number;
  /** LED ring/strip brightness cap, 0–1 (the code uses 0.4) */
  ringBright: number;
  /** the diode across the pump motor (inside the switch board) */
  flyback: boolean;
  /** long thin jumper wires instead of short thick ones */
  thinWires: boolean;
  /** a loose wire touching 5 V and GND */
  short: boolean;
  /** room temperature, °C */
  ambientC: number;
  /** which supply each part is wired to, when it isn't the usual one */
  rails: Record<string, "5v" | "3v3">;
}

export const defaultMods = (report: Report): Mods => ({
  ledOhm: 220, ledColor: "red", echoDivider: true, bulkCap: true, booster: report.boost, boostV: 5, charge: 1,
  servoLoadG: 0, servoArmCm: 3, ringBright: 0.4, flyback: true, thinWires: false, short: false, ambientC: 25, rails: {},
});

/** The world around the project, set with the bench's controls. */
export interface Env {
  touch: boolean;
  button: boolean;
  motion: boolean;
  door: boolean;
  /** a clap or a word, as loud as this for a moment (0 = quiet room) */
  clap: boolean;
  lux: number;
  soilPct: number;
  distanceCm: number;
  shakeG: number;
  tempC: number;
}

export const defaultEnv = (): Env => ({ touch: false, button: false, motion: false, door: false, clap: false, lux: 300, soilPct: 60, distanceCm: 150, shakeG: 0, tempC: 25 });

export type Severity = "broken" | "stopped" | "warning";

export interface Event {
  id: string;
  t: number;
  severity: Severity;
  /** the part it happened to, by uid ("board", "source" for those) */
  where: string;
  title: string;
  why: string;
  fix: string;
  /** a change to the bench that undoes the cause */
  undo?: Partial<Mods>;
}

export interface PartState {
  uid: string;
  id: string;
  name: string;
  /** supply voltage across it */
  v: number;
  mA: number;
  tempC: number | null;
  status: "off" | "ok" | "low" | "stressed" | "broken";
  /** what to draw: brightness, angle, colours, text */
  show: { lit?: number; color?: string; deg?: number; ring?: string[]; text?: string; tone?: number; running?: boolean; reading?: string };
}

export interface Frame {
  t: number;
  on: boolean;
  /** board state */
  board: { status: "off" | "booting" | "running" | "reset" | "dead"; resets: number; v: number; logicV: number; tempC: number | null };
  source: { v: number; mA: number; tripped: boolean };
  rails: { v5: number; v33: number };
  parts: PartState[];
  events: Event[];
  serial: string[];
}

// --- part models ---------------------------------------------------------------------------------------------

const LED_VF: Record<Mods["ledColor"], number> = { red: 2.0, green: 2.2, blue: 3.0, white: 3.0 };
const LED_RGB: Record<Mods["ledColor"], string> = { red: "#ff4040", green: "#40ff70", blue: "#4080ff", white: "#ffffff" };

/** SG90: 1.8 kgf·cm stall at 4.8 V, 0.1 s/60° no-load, about 7.4 Ω winding. */
const SERVO = { stallNm: 0.1766, at: 4.8, w0: 10.47, rWinding: 7.4, idle: 0.008, stripNm: 0.44, rth: 22, tau: 25, maxC: 120, J0: 2e-5 };
/** a 5 mm LED: 30 mA continuous, 100 mA peak, ~350 K/W junction to air */
const LED_LIM = { cont: 0.03, abs: 0.1, rth: 350, tau: 0.4, maxC: 150 };
/** source internal resistance in Ω, before ageing with discharge */
const R_INT: Record<string, number> = { aa3: 0.45, aa4nimh: 0.12, lipo: 0.15, usb: 0.25 };

function sourceV(p: Power, charge: number): number {
  if (p.kind === "usb") return p.v[2];
  const c = Math.min(1, Math.max(0, charge));
  // most chemistries sit near their nominal voltage for most of the discharge, then fall away
  const shape = c > 0.15 ? p.v[0] + (p.v[2] - p.v[0]) * ((c - 0.15) / 0.85) ** 1.6 : p.v[1] + (p.v[0] - p.v[1]) * (c / 0.15);
  return shape;
}

interface Item { uid: string; part: Part }

/** The bench for one project. Create a new one when the parts or the wiring change. */
export class Bench {
  readonly report: Report;
  readonly board: Board | null;
  readonly source: Power | null;
  readonly items: Item[];
  readonly program: RulesProgram | null;
  /** an external code runner (the emulated Nano) that replaces the rules */
  external: { boot: () => void; tick: (ms: number, x: Readings) => void; out: Outs; serial: string[] } | null = null;
  on = false;
  t = 0;
  events: Event[] = [];

  private st = newState();
  private sol: Solution | null = null;
  private guess: Record<string, number> = {};
  private broken = new Set<string>();
  private boardState: Frame["board"]["status"] = "off";
  private bootLeft = 0;
  private resets = 0;
  private temp: Record<string, number> = {};
  private timers: Record<string, number> = {};
  private servo = { deg: 0, w: 0, I: 0, stallT: 0 };
  private prevPump = false;
  private tripped = 0;
  private lastLoadOn: string[] = [];

  readonly project: Project;
  mods: Mods;

  constructor(project: Project, mods?: Mods) {
    this.project = project;
    this.report = analyze(project);
    this.mods = mods ?? defaultMods(this.report);
    this.board = this.report.board;
    this.source = this.report.source;
    this.items = project.parts.map((p) => ({ uid: p.uid, part: BY_ID[p.id] })).filter((x) => !!x.part);
    const lights = this.has("ring") ? 12 : this.has("strip") ? 30 : 0;
    this.program = this.board
      ? new RulesProgram(project, { esp: this.board.id === "esp32", leds: lights, bright: this.mods.ringBright, has: (id) => this.has(id) })
      : null;
    this.reset(false);
  }

  has(id: string) { return this.items.some((x) => x.part.id === id); }
  private first(id: string) { return this.items.find((x) => x.part.id === id); }
  private get code() { return this.external ?? this.program; }
  private get esp() { return this.board?.id === "esp32"; }

  /** Turn the power switch. Broken parts stay broken until "replace parts". */
  setPower(on: boolean) {
    if (on === this.on) return;
    this.on = on;
    if (on && this.board && !this.broken.has("board")) { this.boardState = "booting"; this.bootLeft = 0.5; }
    if (!on) { this.boardState = "off"; }
  }

  /** Start over with new parts in every socket. */
  reset(keepPower = true) {
    this.broken.clear();
    this.events = [];
    this.temp = {};
    this.timers = {};
    this.resets = 0;
    this.t = 0;
    this.tripped = 0;
    this.st = newState();
    this.servo = { deg: 0, w: 0, I: 0, stallT: 0 };
    if (!keepPower) this.on = false;
    this.boardState = this.on ? "booting" : "off";
    this.bootLeft = 0.5;
    if (this.code) Object.assign(this.code.out, quietOuts());
  }

  private emit(e: Omit<Event, "t">) {
    if (this.events.some((x) => x.id === e.id)) return;
    this.events.push({ ...e, t: this.t });
  }

  private kill(uid: string, e: Omit<Event, "t" | "severity">) {
    if (this.broken.has(uid)) return;
    this.broken.add(uid);
    this.emit({ ...e, severity: "broken" });
  }

  /** time a condition has held, in s; resets when it stops */
  private hold(key: string, cond: boolean, dt: number): number {
    this.timers[key] = cond ? (this.timers[key] ?? 0) + dt : 0;
    return this.timers[key];
  }

  private warm(key: string, watts: number, rth: number, tau: number, dt: number): number {
    const amb = this.mods.ambientC;
    const T = this.temp[key] ?? amb;
    const target = amb + watts * rth;
    this.temp[key] = T + (target - T) * (1 - Math.exp(-dt / tau));
    return this.temp[key];
  }

  /** The supply a part is wired to. */
  rail(it: Item): "5v" | "3v3" | "none" {
    return this.mods.rails[it.uid] ?? railFor(it.part, this.board);
  }

  // --- the circuit ---------------------------------------------------------------------------------------------

  private netlist(o: Outs): El[] {
    const els: El[] = [];
    const src = this.source;
    const m = this.mods;
    if (!this.on || !src) return els;
    const chargeR = src.kind === "battery" ? (R_INT[src.id] ?? 0.3) * (1 + 1.5 * (1 - m.charge)) : R_INT[src.id] ?? 0.25;
    const trip = this.tripped > 0;
    els.push({ k: "V", id: "source", p: "bat", n: "gnd", v: trip ? 0 : sourceV(src, m.charge), r: chargeR });
    const wire = m.thinWires ? 0.35 : 0.05;
    const boost = m.booster && this.report.boost;
    if (boost) {
      els.push({ k: "boost", id: "boost", in: "bat", out: "vb", vset: m.boostV, vstart: 2.0, eff: 0.85 });
      els.push({ k: "R", id: "wire", a: "vb", b: "5v", ohm: wire });
    } else {
      els.push({ k: "R", id: "wire", a: "bat", b: "5v", ohm: wire });
    }
    if (m.bulkCap && (this.has("servo") || this.has("ring") || this.has("strip"))) els.push({ k: "C", id: "bulk", a: "5v", b: "gnd", f: 470e-6 });
    if (m.short) els.push({ k: "R", id: "short", a: "5v", b: "gnd", ohm: 0.03 });

    const b = this.board;
    if (b && !this.broken.has("board")) {
      const running = this.boardState === "running" || this.boardState === "booting";
      if (b.id === "esp32") {
        const shutdown = (this.temp.ldo ?? 0) > 150 || this.timers.ldoOff > 0;
        els.push({ k: "ldo", id: "ldo", in: "5v", out: "3v3", vset: shutdown ? 0 : 3.3, vdo: 1.1, iq: 0.005 });
        els.push({ k: "load", id: "mcu", a: "3v3", b: "gnd", i: running ? 0.07 : 0.03, vmin: 2.3 });
      } else {
        els.push({ k: "load", id: "mcu", a: "5v", b: "gnd", i: running ? 0.02 : 0.015, vmin: 1.8 });
        els.push({ k: "ldo", id: "ldo", in: "5v", out: "3v3", vset: 3.3, vdo: 0.3, iq: 0 });
      }
    }
    const logic = this.esp ? "3v3" : "5v";
    const pinOhm = this.esp ? 35 : 25;
    const pinHigh = (id: string, node: string, high: boolean) => {
      els.push({ k: "R", id: `pin:${id}`, a: high ? logic : "gnd", b: node, ohm: pinOhm });
    };
    const running = this.boardState === "running";

    for (const it of this.items) {
      const p = it.part;
      if (isBoard(p) || isPower(p)) continue;
      const r = this.rail(it);
      const dead = this.broken.has(it.uid);
      const node = r === "none" ? "gnd" : r;
      const id = it.uid;
      switch (p.id) {
        case "led": {
          if (this.broken.has(`pin:${id}`)) break;
          pinHigh(id, `${id}:p`, running && o.led);
          if (m.ledOhm > 0) els.push({ k: "R", id: `${id}:r`, a: `${id}:p`, b: `${id}:a`, ohm: m.ledOhm });
          else els.push({ k: "R", id: `${id}:r`, a: `${id}:p`, b: `${id}:a`, ohm: 0.05 });
          if (!dead) els.push({ k: "D", id, a: `${id}:a`, c: "gnd", ...ledModel(LED_VF[m.ledColor]) });
          break;
        }
        case "ring": case "strip": {
          const n = p.id === "ring" ? 12 : 30;
          const ring = running ? o.ring : null;
          let sum = 0;
          for (const c of ring ?? []) sum += c[0] + c[1] + c[2];
          // WS2812B: about 1 mA each when dark, 20 mA per colour channel at full
          const i = dead ? 0 : n * 0.001 + (sum / 255) * 0.02;
          els.push({ k: "load", id, a: node, b: "gnd", i, vmin: 3.5 });
          break;
        }
        case "servo": {
          els.push({ k: "load", id, a: node, b: "gnd", i: dead ? 0.005 : this.servo.I, vmin: 3 });
          break;
        }
        case "pump": els.push({ k: "load", id, a: node, b: "gnd", i: !dead && running && o.pump ? 0.18 : 0.001, vmin: 2.5 }); break;
        case "vibe": els.push({ k: "load", id, a: node, b: "gnd", i: !dead && running && o.vibe ? 0.07 : 0.001, vmin: 2.5 }); break;
        case "relay": els.push({ k: "load", id, a: node, b: "gnd", i: !dead && running && o.relay ? 0.072 : 0.002, vmin: 3.5 }); break;
        case "player": els.push({ k: "load", id, a: node, b: "gnd", i: dead ? 0 : running && o.speaking ? 0.16 : 0.02, vmin: 3.2 }); break;
        case "amp": els.push({ k: "load", id, a: node, b: "gnd", i: dead ? 0 : running && o.speaking ? 0.3 : 0.003, vmin: 2.5 }); break;
        case "buzzer": {
          if (running && o.tone > 0) els.push({ k: "R", id: `pin:${id}`, a: logic, b: `${id}:p`, ohm: pinOhm }, { k: "R", id, a: `${id}:p`, b: "gnd", ohm: 600 });
          break;
        }
        case "distance": {
          els.push({ k: "load", id, a: node, b: "gnd", i: dead ? 0 : 0.015, vmin: 4.0 });
          // the ECHO pin drives the supply voltage back into the board's pin
          if (!dead && node !== "gnd") {
            els.push({ k: "V", id: `${id}:echo`, p: `${id}:e`, n: "gnd", v: 0, r: 120 });
            const into = this.esp && m.echoDivider ? `${id}:div` : `${id}:pin`;
            if (this.esp && m.echoDivider) {
              els.push({ k: "R", id: `${id}:r1`, a: `${id}:e`, b: into, ohm: 1000 }, { k: "R", id: `${id}:r2`, a: into, b: "gnd", ohm: 2000 });
            } else {
              els.push({ k: "R", id: `${id}:w`, a: `${id}:e`, b: into, ohm: 0.05 });
            }
            if (b && !this.broken.has(`pin:${id}`)) {
              els.push({ k: "R", id: `${id}:in`, a: into, b: "gnd", ohm: 1e6 });
              els.push({ k: "D", id: `clamp:${id}`, a: into, c: logic, ...SI_DIODE });
            }
          }
          break;
        }
        default: {
          if (node === "gnd" || p.mA <= 0) break;
          els.push({ k: "load", id, a: node, b: "gnd", i: dead ? 0 : p.mA / 1000, vmin: Math.max(1, (p.volts?.[0] ?? 2.5) * 0.8) });
        }
      }
    }
    return els;
  }

  /** the echo pin goes high to the sensor's supply voltage while a pulse comes back */
  private patchEcho(els: El[], v5: number) {
    for (const e of els) if (e.k === "V" && e.id.endsWith(":echo")) e.v = v5;
  }

  // --- a step ---------------------------------------------------------------------------------------------------

  readings(env: Env): Readings {
    const ok = (id: string) => {
      const it = this.first(id);
      if (!it || this.broken.has(it.uid)) return false;
      const r = this.rail(it);
      if (r === "none") return true;
      const v = this.sol?.v[r] ?? 0;
      return v >= (it.part.volts?.[0] ?? 2) * 0.95;
    };
    const esp = this.esp;
    const vref = esp ? 3.3 : 5;
    const adcMax = esp ? 4095 : 1023;
    // an LDR over a 10 kΩ resistor: about 10 kΩ at 10 lux, falling as the light rises
    const ldr = 10_000 * Math.pow(Math.max(env.lux, 0.05) / 10, -0.75);
    const lightRail = this.first("light") ? this.rail(this.first("light")!) : "3v3";
    const lv = (this.sol?.v[lightRail] ?? 0) * (10_000 / (10_000 + ldr));
    const quiet = this.has("mic") && esp ? 220 : esp ? 60 : 15;
    const loud = this.has("mic") && esp ? 4200 : esp ? 1400 : 350;
    const echoDead = (() => { const it = this.first("distance"); return !!it && this.broken.has(`pin:${it.uid}`); })();
    return {
      touch: ok("touch") && env.touch,
      button: !!this.first("button") && env.button,
      motion: ok("pir") && env.motion,
      door: !!this.first("reed") && env.door,
      sound: ok("mic") || ok("soundsensor") ? (env.clap ? loud : quiet) : 0,
      light: ok("light") ? Math.min(adcMax, Math.round((lv / vref) * adcMax)) : 0,
      soilPct: ok("soil") ? env.soilPct : 0,
      distanceCm: ok("distance") && !echoDead ? Math.min(400, Math.max(2, env.distanceCm)) : -1,
      shakeG: ok("motion6") ? env.shakeG : 0,
      tempC: ok("temp") ? env.tempC : NaN,
      humidity: ok("temp") ? 55 : NaN,
    };
  }

  /** Advance by dt seconds (keep it at 5 ms or less: the servo and capacitors need small steps). */
  step(dt: number, env: Env) {
    this.t += dt;
    const code = this.code;
    const outs = code?.out ?? quietOuts();
    const m = this.mods;
    if (this.program) this.program.s.bright = m.ringBright;

    // the board: booting, running the code, or held in reset
    if (this.on && this.board && !this.broken.has("board")) {
      if (this.boardState === "booting" || this.boardState === "reset") {
        this.bootLeft -= dt;
        if (this.bootLeft <= 0) { this.boardState = "running"; code?.boot(); }
      } else if (this.boardState === "running" && code) {
        code.tick(dt * 1000, this.readings(env));
      }
    } else if (this.broken.has("board")) this.boardState = "dead";

    // the servo arm: torque-limited position control against gravity on the load
    const sv = this.first("servo");
    if (sv) {
      const vS = this.sol?.v[this.rail(sv)] ?? 0;
      const dead = this.broken.has(sv.uid);
      const L = m.servoArmCm / 100, mass = m.servoLoadG / 1000;
      const th = (this.servo.deg * Math.PI) / 180;
      // gravity on the load, about the shaft (0° is the arm level): positive lifts toward 90°
      const tauG = -mass * 9.81 * L * Math.cos(th);
      const vr = Math.max(0, vS) / SERVO.at;
      const tauMax = this.on && vS > 3 && !dead ? SERVO.stallNm * Math.min(vr, 1.3) : 0;
      const target = this.boardState === "running" ? outs.servo : null;
      const w0 = SERVO.w0 * Math.min(vr, 1.3);
      const fric = 0.004;
      let tauM = 0;
      // the motor's own speed settles in ~15 ms; the gears and the load follow it
      let wWant = 0;
      let driving = false;
      if (target !== null && tauMax > 0) {
        const err = target - this.servo.deg;
        const dir = Math.sign(err);
        if (Math.abs(err) < 1) {
          // holding still: the motor only pushes back against the load
          tauM = Math.min(tauMax, Math.abs(tauG));
        } else {
          driving = true;
          const need = -tauG * dir + fric;
          if (need >= tauMax) {
            tauM = tauMax;
            // too heavy: it can't lift it, and if gravity wins outright the arm is pushed back down
            wWant = need - fric > tauMax ? -dir * w0 * Math.min(1, (need - fric - tauMax) / tauMax) * 0.3 : 0;
          } else {
            // the control loop drives flat out until close, then eases in (on a DC motor's torque–speed line)
            const k = Math.min(1, Math.abs(err) / 3);
            wWant = dir * w0 * k * (1 - need / tauMax);
            tauM = need;
          }
        }
      } else if (Math.abs(tauG) > 0.02 || (dead && this.broken.has(`${sv.uid}:gears`))) {
        // unpowered (or stripped): the load drags the arm down through the gears
        wWant = Math.sign(tauG) * Math.min(6, Math.abs(tauG) * 60);
      }
      const w = this.servo.w + (wWant - this.servo.w) * (1 - Math.exp(-dt / 0.015));
      const err0 = target === null ? 0 : target - this.servo.deg;
      let stepDeg = (w * dt * 180) / Math.PI;
      if (target !== null && Math.sign(stepDeg) === Math.sign(err0) && Math.abs(stepDeg) > Math.abs(err0)) stepDeg = err0;
      this.servo.w = w;
      this.servo.deg = Math.max(-10, Math.min(190, this.servo.deg + stepDeg));
      // winding current: (V − back-EMF) ÷ R while driving, so it peaks when starting and when stalled
      const stallI = Math.max(0, vS) / SERVO.rWinding;
      const dirNow = Math.sign(err0) || 1;
      this.servo.I = tauMax <= 0 ? SERVO.idle
        : driving ? SERVO.idle + stallI * Math.max(Math.abs(tauM) / tauMax, Math.min(1, Math.max(0, 1 - (w * dirNow) / Math.max(w0, 1e-6))))
        : SERVO.idle + stallI * Math.min(1, Math.abs(tauM) / tauMax);

      const needNm = Math.abs(mass * 9.81 * L);
      const kgcm = (nm: number) => (nm / 0.0981).toFixed(2);
      if (!dead && needNm > SERVO.stripNm) {
        this.kill(sv.uid, {
          id: "servo-gears", where: sv.uid, title: "The servo's gears stripped",
          why: `${m.servoLoadG} g at ${m.servoArmCm} cm pulls with ${kgcm(needNm)} kg·cm. The SG90's plastic gears give way at about ${kgcm(SERVO.stripNm)} kg·cm, so the teeth sheared and the arm drops.`,
          fix: "Lighten the load, move it closer to the shaft, or use a metal-gear servo (MG90S holds about 2.2 kg·cm, MG996R about 10).",
          undo: { servoLoadG: Math.floor(((SERVO.stallNm * 0.6) / (9.81 * L)) * 1000) },
        });
        this.broken.add(`${sv.uid}:gears`);
      }
      const err = target === null ? 0 : Math.abs(target - this.servo.deg);
      const stalled = this.hold("servoStall", !dead && tauMax > 0 && err > 6 && Math.abs(this.servo.w) < 0.25 && Math.abs(tauM) > tauMax * 0.85, dt);
      if (stalled > 0.6) {
        this.emit({
          id: "servo-stall", where: sv.uid, severity: "warning", title: "The servo is stalled",
          why: `It is trying to reach ${target?.toFixed(0)}° but is stuck at ${this.servo.deg.toFixed(0)}°. The load needs ${kgcm(needNm)} kg·cm; at ${vS.toFixed(2)} V the SG90 gives at most ${kgcm(tauMax)} kg·cm. Stalled, it draws ${(this.servo.I * 1000).toFixed(0)} mA and the motor heats up.`,
          fix: "Shorten the arm, lighten the load, give it a full 5 V, or use a stronger servo.",
          undo: { servoLoadG: Math.floor(((tauMax * 0.6) / (9.81 * Math.max(L, 0.005))) * 1000) },
        });
      }
      const wt = this.warm("servo", this.servo.I ** 2 * SERVO.rWinding, SERVO.rth, SERVO.tau, dt);
      if (!dead && wt > SERVO.maxC) {
        this.kill(sv.uid, {
          id: "servo-burn", where: sv.uid, title: "The servo motor burnt out",
          why: `Held against a load it drew ${(this.servo.I * 1000).toFixed(0)} mA for a long time. ${(this.servo.I ** 2 * SERVO.rWinding).toFixed(2)} W in a motor this small heats the windings past ${SERVO.maxC} °C, and the insulation fails.`,
          fix: "Don't let a servo push against something that won't move. Lighten the load or detach() the servo when it is holding still.",
        });
      }
    }

    // the circuit
    const els = this.netlist(outs);
    const v5guess = this.sol?.v["5v"] ?? 5;
    this.patchEcho(els, this.boardState === "running" && env.distanceCm < 400 ? v5guess : 0);
    if (els.length) {
      this.sol = solve(els, { dt, state: this.st, guess: this.guess });
      this.guess = this.sol.v;
    } else {
      this.sol = { ok: true, v: { gnd: 0 }, i: {}, p: {}, iterations: 0 };
      this.st = newState();
    }

    this.checkSource(dt);
    this.checkParts(dt, outs);
    this.checkBoard(dt);
    if (this.tripped > 0) this.tripped -= dt;
  }

  private checkSource(dt: number) {
    const S = this.sol!;
    const src = this.source;
    if (!src || !this.on) return;
    const amps = S.i.source ?? 0;
    // the short
    const big = this.hold("short", amps > 2.5, dt);
    if (big > 0.05) {
      if (src.kind === "usb") {
        this.tripped = 1.0;
        this.emit({ id: "short-usb", where: "source", severity: "stopped", title: "Short circuit: the charger cut out",
          why: `About ${amps.toFixed(1)} A tried to flow straight from 5 V to GND. The charger's protection switched it off. It will keep trying again every second while the short is there.`,
          fix: "Find the bare wire or solder blob touching both 5 V and GND. Unplug before you touch anything.", undo: { short: false } });
      } else if (src.id === "lipo" && amps > 3) {
        this.tripped = 2.0;
        this.emit({ id: "short-lipo", where: "source", severity: "stopped", title: "Short circuit: the battery's protection board tripped",
          why: `${amps.toFixed(1)} A flowed. The DW01 protection chip cut the cell off at about 3 A. Without that board, a lithium cell would keep pushing current until the wires or the cell overheated: this is how battery fires start.`,
          fix: "Remove the short. Always use a cell with a protection board.", undo: { short: false } });
      } else {
        const wireC = this.warm("shortWire", amps * amps * 0.03, 60, 3, dt);
        this.emit({ id: "short-batt", where: "source", severity: "warning", title: "Short circuit",
          why: `${amps.toFixed(1)} A is flowing straight from the batteries to GND. Nothing limits it except the batteries' own resistance. The wire and the cells are heating up${wireC > 60 ? ` (the wire is at ${wireC.toFixed(0)} °C)` : ""}.`,
          fix: "Switch off now and remove the short. A fuse or polyfuse (500 mA) in the battery lead would have stopped it.", undo: { short: false } });
        if (wireC > 120) this.kill("source", { id: "short-melt", where: "source", title: "The wire's insulation melted",
          why: `${amps.toFixed(1)} A for several seconds heated the shorting wire to ${wireC.toFixed(0)} °C. PVC insulation softens around 100 °C, and the cells are now hot and may leak.`,
          fix: "Replace the wire and the cells. Add a fuse in the battery lead.", undo: { short: false } });
      }
    }
    // a charger asked for more than it can give
    if (src.kind === "usb" && this.hold("usbOver", amps > src.maxmA / 1000 * 1.1 && amps <= 2.5, dt) > 0.3) {
      this.tripped = 0.8;
      this.emit({ id: "usb-over", where: "source", severity: "stopped", title: "The charger is overloaded",
        why: `The project draws ${(amps * 1000).toFixed(0)} mA but the charger gives ${src.maxmA} mA, so it keeps cutting out.`,
        fix: "Use a 2 A or 3 A charger, or reduce the load (lower LED brightness, smaller motors)." });
    }
    if (this.mods.booster && this.report.boost && (S.i.boost ?? 0) > 1.0 && this.hold("boostOver", true, dt) > 0.2) {
      this.emit({ id: "boost-over", where: "source", severity: "warning", title: "The 5 V booster is working past its limit",
        why: `It is delivering ${((S.i.boost ?? 0) * 1000).toFixed(0)} mA, more than the ~1 A it is good for, and pulling ${(amps * 1000).toFixed(0)} mA from the batteries. It will get hot and its output will sag.`,
        fix: "Use a bigger booster (2 A+), power the LEDs or motors straight from a 5 V supply, or lower their load." });
    } else if (!((S.i.boost ?? 0) > 1.0)) this.timers.boostOver = 0;
  }

  private checkBoard(dt: number) {
    const b = this.board;
    if (!b || !this.on || this.broken.has("board")) return;
    const S = this.sol!;
    const v5 = S.v["5v"] ?? 0, v33 = S.v["3v3"] ?? 0;
    // too much voltage on the board's 5 V pin
    const vmax = b.id === "nano" ? 6.0 : 15;
    if (this.hold("boardOver", v5 > vmax, dt) > 0.05) {
      this.kill("board", { id: "board-over", where: "board", title: `The ${short(b)} was destroyed by over-voltage`,
        why: `Its 5 V pin got ${v5.toFixed(1)} V. ${b.id === "nano" ? "The ATmega328P's absolute maximum is 6 V; above that its insides break down." : "The regulator's maximum input is 15 V."}`,
        fix: this.report.boost ? "Set the booster's trimmer to 5.0 V with a meter before connecting anything." : "Feed the 5 V pin 5 V only. Higher voltages go to VIN (7–12 V on a Nano).",
        undo: { boostV: 5 } });
      this.boardState = "dead";
      return;
    }
    if (b.id === "esp32") {
      const pd = S.p.ldo ?? 0;
      const tj = this.warm("ldo", pd, 90, 4, dt);
      if (tj > 150 && !(this.timers.ldoOff > 0)) {
        this.timers.ldoOff = 1;
        this.emit({ id: "ldo-hot", where: "board", severity: "stopped", title: "The board's 3.3 V regulator overheated and shut off",
          why: `It drops ${(v5 - 3.3).toFixed(1)} V at ${((S.i.ldo ?? 0) * 1000).toFixed(0)} mA, turning ${pd.toFixed(2)} W into heat. The small AMS1117 reaches ${tj.toFixed(0)} °C and its thermal protection switches it off until it cools.`,
          fix: "Feed the board 5 V, not more, and power hungry 3.3 V parts from their own regulator.", undo: { boostV: 5 } });
      }
      if (this.timers.ldoOff > 0 && tj < 130) this.timers.ldoOff = 0;
      if (v33 > 3.6 && this.hold("espOver", true, dt) > 0.05) {
        this.kill("board", { id: "esp-over", where: "board", title: "The ESP32 chip was damaged", why: `Its 3.3 V supply reached ${v33.toFixed(2)} V; the chip's maximum is 3.6 V.`, fix: "Never connect 5 V to the 3V3 pin." });
        return;
      }
    }
    // brownout: the supply dipped low enough that the chip restarts
    const low = b.id === "esp32" ? v33 < 2.8 : v5 < 3.6;
    const vNow = b.id === "esp32" ? v33 : v5;
    if (low && (this.boardState === "running" || this.boardState === "booting")) {
      if (this.boardState === "running") this.resets++;
      const culprit = this.lastLoadOn.length ? this.lastLoadOn.join(" and ") : "the load";
      if (this.boardState === "running" && !this.mods.short) {
        this.emit({ id: "brownout", where: "board", severity: "warning", title: "The board keeps restarting (brownout)",
          why: `Its ${b.id === "esp32" ? "3.3 V" : "5 V"} supply dipped to ${vNow.toFixed(2)} V when ${culprit} drew current. ${b.id === "esp32" ? "Below about 2.8 V the ESP32's brownout detector resets it" : "Below about 3.6 V a 16 MHz ATmega can't run reliably and resets"}. The batteries' internal resistance and the wires drop the voltage under load: the source is at ${(this.sol!.v.bat ?? 0).toFixed(2)} V while giving ${((this.sol!.i.source ?? 0) * 1000).toFixed(0)} mA.`,
          fix: `${this.mods.charge < 0.5 ? "Fresh batteries first. " : ""}${!this.mods.booster && this.report.boost ? "Put the 5 V booster back. " : ""}${!this.mods.bulkCap ? "Add the 470 µF capacitor across 5 V and GND near the motor. " : ""}${this.mods.thinWires ? "Use short, thick power wires. " : ""}Give motors and LED strips their own supply if it still happens.`,
          undo: { charge: 1, bulkCap: true, booster: this.report.boost, thinWires: false } });
      }
      this.boardState = "reset";
      this.bootLeft = b.id === "esp32" ? 0.4 : 0.8;
      if (this.code) Object.assign(this.code.out, quietOuts());
    }
  }

  private checkParts(dt: number, o: Outs) {
    const S = this.sol!;
    const m = this.mods;
    const on: string[] = [];
    for (const it of this.items) {
      const p = it.part;
      if (isBoard(p) || isPower(p)) continue;
      const r = this.rail(it);
      const v = r === "none" ? 0 : S.v[r] ?? 0;
      // over-voltage on the part's supply
      const vmax = p.volts?.[1];
      if (this.on && vmax && v > vmax * 1.1 && this.hold(`over:${it.uid}`, true, dt) > 0.2) {
        this.kill(it.uid, { id: `over:${it.uid}`, where: it.uid, title: `The ${short(p)} was damaged by too much voltage`,
          why: `It is rated for ${p.volts![0]}–${vmax} V and got ${v.toFixed(2)} V on its ${r === "5v" ? "5 V" : "3.3 V"} supply. Thin insulating layers inside its chip break down above the rating.`,
          fix: r === "5v" && (p.rail === "3v3" || p.rail === "either") ? "Wire it to 3.3 V." : this.report.boost ? "Set the booster to 5.0 V before connecting parts." : "Give it a supply inside its rating.",
          undo: m.rails[it.uid] ? { rails: Object.fromEntries(Object.entries(m.rails).filter(([k]) => k !== it.uid)) } : { boostV: 5 } });
      }
      if ((p.id === "servo" && this.servo.I > 0.2) || (p.id === "pump" && o.pump) || ((p.id === "ring" || p.id === "strip") && (S.i[it.uid] ?? 0) > 0.15) || (p.id === "player" && o.speaking) || (p.id === "amp" && o.speaking)) on.push(short(p).toLowerCase());

      if (p.id === "led") {
        const ia = S.i[it.uid] ?? 0;
        const pinI = Math.abs(S.i[`pin:${it.uid}`] ?? 0);
        const tj = this.warm(`led:${it.uid}`, Math.max(0, S.p[it.uid] ?? 0), LED_LIM.rth, LED_LIM.tau, dt);
        // damage adds up: every moment over the rating counts, even across blinks
        const k = `ledDose:${it.uid}`;
        if (ia > LED_LIM.cont * 1.2) this.timers[k] = (this.timers[k] ?? 0) + dt * (ia / LED_LIM.cont - 1);
        const over = this.timers[k] ?? 0;
        if (!this.broken.has(it.uid) && (this.hold(`ledAbs:${it.uid}`, ia > LED_LIM.abs, dt) > 0.05 || tj > LED_LIM.maxC || over > 2)) {
          const rNeed = Math.ceil(((this.esp ? 3.3 : 5) - LED_VF[m.ledColor]) / 0.012 / 10) * 10;
          this.kill(it.uid, { id: `led:${it.uid}`, where: it.uid, title: "The LED burnt out",
            why: `${(ia * 1000).toFixed(0)} mA went through it. A 5 mm LED is rated for ${LED_LIM.cont * 1000} mA. ${m.ledOhm > 0 ? `With only ${m.ledOhm} Ω in series` : "With no resistor"}, nothing but the pin's own ~${this.esp ? 35 : 25} Ω limits the current, so the tiny chip overheats (${tj.toFixed(0)} °C) and its bond wire or junction fails. It goes dark for good.`,
            fix: `Put a resistor in series: (${this.esp ? "3.3" : "5"} V − ${LED_VF[m.ledColor]} V) ÷ 12 mA ≈ ${rNeed} Ω; ${rNeed <= 220 ? "220" : "330"} Ω is the usual choice.`,
            undo: { ledOhm: 220 } });
        }
        if (pinI > 0.04 && !this.broken.has(`pin:${it.uid}`) && this.hold(`pinOver:${it.uid}`, true, dt) > 1.0) {
          this.kill(`pin:${it.uid}`, { id: `pin:${it.uid}`, where: it.uid, title: "The board's pin was damaged",
            why: `The pin drove ${(pinI * 1000).toFixed(0)} mA. ${this.esp ? "An ESP32 pin should stay under 20 mA (40 mA absolute maximum)" : "An ATmega328P pin's absolute maximum is 40 mA (20 mA recommended)"}. The tiny transistors inside burnt; that pin no longer drives anything.`,
            fix: "Always limit current from a pin with a resistor, and use a transistor or MOSFET board for anything over 20 mA.", undo: { ledOhm: 220 } });
        } else if (pinI <= 0.04) this.timers[`pinOver:${it.uid}`] = 0;
        if (pinI > 0.02 && pinI <= 0.04 && this.hold(`pinWarm:${it.uid}`, true, dt) > 0.5) {
          this.emit({ id: `pinwarn:${it.uid}`, where: it.uid, severity: "warning", title: "The pin is working harder than it should",
            why: `${(pinI * 1000).toFixed(0)} mA from one pin: above the 20 mA it is meant to carry continuously, though under the 40 mA that breaks it.`, fix: "Use a bigger resistor (220–330 Ω)." });
        }
      }
      if (p.id === "distance" && this.esp) {
        const clamp = S.i[`clamp:${it.uid}`] ?? 0;
        if (clamp > 0.001 && !this.broken.has(`pin:${it.uid}`)) {
          const tt = this.hold(`clamp:${it.uid}`, true, dt);
          this.emit({ id: `echo5v:${it.uid}`, where: it.uid, severity: "warning", title: "5 V is going into a 3.3 V pin",
            why: `The sensor's ECHO pin puts out ${(S.v[`${it.uid}:e`] ?? 0).toFixed(1)} V. ESP32 pins are 3.3 V parts: the excess forces ${(clamp * 1000).toFixed(1)} mA through the pin's protection diode into the 3.3 V supply. It may work for a while, but it wears the pin out.`,
            fix: "Put a 1 kΩ / 2 kΩ divider on ECHO (gives 3.3 V), or use a 3.3 V sensor such as the RCWL-1601.", undo: { echoDivider: true } });
          if (tt > 20) this.kill(`pin:${it.uid}`, { id: `echodead:${it.uid}`, where: it.uid, title: "The ECHO pin on the board died",
            why: "After running with 5 V on it, the input stopped responding. In this simulation it happens after 20 seconds so you can see it; in real life it might take minutes or months, and there is no safe amount.",
            fix: "Use another pin and add the 1 kΩ / 2 kΩ divider.", undo: { echoDivider: true } });
        }
      }
      if (p.id === "pump") {
        if (this.prevPump && !o.pump && this.boardState === "running" && !m.flyback && !this.broken.has(it.uid)) {
          // the motor's inductance keeps the current flowing for a moment: V = L·di/dt
          const spike = (1e-3 * 0.18) / 2e-6;
          const n = (this.timers.pumpKicks = (this.timers.pumpKicks ?? 0) + 1);
          this.emit({ id: `kick:${it.uid}`, where: it.uid, severity: "warning", title: "Voltage spike when the pump switches off",
            why: `The motor's coil (about 1 mH, 180 mA) keeps current flowing when the switch opens. With nowhere to go, it makes about ${spike.toFixed(0)} V for a moment (V = L·di/dt), more than the MOSFET's 55 V rating.`,
            fix: "Put a diode (1N4007 or 1N5819) across the motor, stripe to +.", undo: { flyback: true } });
          if (n >= 3) this.kill(it.uid, { id: `kickdead:${it.uid}`, where: it.uid, title: "The pump's switch board failed",
            why: `After ${n} spikes of about ${spike.toFixed(0)} V, the MOSFET's junction broke down and now stays shorted or open.`,
            fix: "Replace the switch board and fit the flyback diode.", undo: { flyback: true } });
        }
        this.prevPump = o.pump && this.boardState === "running";
      }
    }
    this.lastLoadOn = on;
  }

  // --- what to draw -----------------------------------------------------------------------------------------

  frame(): Frame {
    const S = this.sol ?? { v: {}, i: {}, p: {} } as unknown as Solution;
    const o = this.code?.out ?? quietOuts();
    const running = this.boardState === "running";
    const parts: PartState[] = this.items.map((it) => {
      const p = it.part;
      const r = isBoard(p) ? "5v" : isPower(p) ? "none" : this.rail(it);
      const v = r === "none" ? (isPower(p) ? S.v.bat ?? 0 : 0) : S.v[r] ?? 0;
      let mA = Math.abs(S.i[it.uid] ?? 0) * 1000;
      if (p.id === "led") mA = Math.abs(S.i[it.uid] ?? 0) * 1000;
      if (p.id === "buzzer") mA = Math.abs(S.i[it.uid] ?? 0) * 1000;
      if (isBoard(p)) mA = Math.abs((S.i.mcu ?? 0) + (this.esp ? 0 : 0)) * 1000;
      if (isPower(p)) mA = Math.abs(S.i[p.kind === "boost" ? "boost" : "source"] ?? 0) * 1000;
      const broken = isBoard(p) ? this.broken.has("board") : this.broken.has(it.uid) || this.broken.has(`pin:${it.uid}`) && p.id === "led";
      const min = p.volts?.[0] ?? 0;
      let status: PartState["status"] = !this.on ? "off" : broken ? "broken" : r !== "none" && min && v < min * 0.95 ? "low" : "ok";
      if (status === "ok" && this.events.some((e) => e.where === it.uid && e.severity === "warning" && this.t - e.t < 3)) status = "stressed";
      const show: PartState["show"] = {};
      switch (p.id) {
        case "led": {
          const ia = S.i[it.uid] ?? 0;
          show.lit = broken ? 0 : Math.min(1, ia / 0.015);
          show.color = LED_RGB[this.mods.ledColor];
          break;
        }
        case "ring": case "strip":
          show.ring = running && !broken && v > 3.5 ? (o.ring ?? []).map((c) => `rgb(${Math.min(255, c[0] / Math.max(this.mods.ringBright, 0.05) * 0.9 + 20)},${Math.min(255, c[1] / Math.max(this.mods.ringBright, 0.05) * 0.9 + 20)},${Math.min(255, c[2] / Math.max(this.mods.ringBright, 0.05) * 0.9 + 20)})`) : [];
          break;
        case "servo": show.deg = this.servo.deg; break;
        case "buzzer": show.tone = running ? o.tone : 0; break;
        case "pump": show.running = running && o.pump && !broken; break;
        case "vibe": show.running = running && o.vibe && !broken; break;
        case "relay": show.running = running && o.relay && !broken; break;
        case "player": case "amp": show.running = running && o.speaking && !broken; break;
        case "oled": show.text = running && !broken && v > 2.5 ? o.screen || (this.project.name || "My project").slice(0, 21) : ""; break;
      }
      const tempKey = p.id === "led" ? `led:${it.uid}` : p.id === "servo" ? "servo" : isBoard(p) && this.esp ? "ldo" : "";
      return { uid: it.uid, id: p.id, name: short(p), v, mA, tempC: tempKey && this.temp[tempKey] !== undefined ? this.temp[tempKey] : null, status, show };
    });
    return {
      t: this.t,
      on: this.on,
      board: { status: this.boardState, resets: this.resets, v: S.v["5v"] ?? 0, logicV: S.v[this.esp ? "3v3" : "5v"] ?? 0, tempC: this.temp.ldo ?? null },
      source: { v: S.v.bat ?? 0, mA: Math.abs(S.i.source ?? 0) * 1000, tripped: this.tripped > 0 },
      rails: { v5: S.v["5v"] ?? 0, v33: S.v["3v3"] ?? 0 },
      parts,
      events: this.events,
      serial: this.code?.serial ?? [],
    };
  }

  /** Run for a while with fixed inputs (tests and the "what if" checks). */
  run(seconds: number, env: Env = defaultEnv(), dt = 0.005) {
    const n = Math.round(seconds / dt);
    for (let i = 0; i < n; i++) this.step(dt, env);
    return this.frame();
  }
}
