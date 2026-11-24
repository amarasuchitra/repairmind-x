/**
 * Runs a project's "When… then…" list the way the generated sketch does (firmware.ts): the same thresholds,
 * the same 3-second cooldown, reacting once when a trigger starts, and actions that block the loop for as
 * long as their delay() calls would. It is the sketch's logic in TypeScript, not the compiled binary: for
 * that, load a .hex into the emulated Nano (avr.ts).
 */
import type { Project, Rule, Trigger } from "../build/project.ts";

export type RGB = [number, number, number];

/** What the board is driving right now. */
export interface Outs {
  led: boolean;
  /** servo target angle, or null when no pulses are sent */
  servo: number | null;
  /** buzzer frequency in Hz, 0 when quiet */
  tone: number;
  /** each LED's colour after the brightness cap, 0–255 per channel */
  ring: RGB[] | null;
  pump: boolean;
  vibe: boolean;
  relay: boolean;
  screen: string;
  speaking: boolean;
}

/** Sensor readings the code sees, already through the wiring (a sensor without power reads nothing). */
export interface Readings {
  touch: boolean;
  button: boolean;
  motion: boolean;
  door: boolean;
  sound: number;
  light: number;
  soilPct: number;
  distanceCm: number;
  shakeG: number;
  tempC: number;
  humidity: number;
}

export const quietOuts = (): Outs => ({ led: false, servo: null, tone: 0, ring: null, pump: false, vibe: false, relay: false, screen: "", speaking: false });

interface Seg { ms: number; set: (o: Outs, k: number) => void }

const hex = (c: string | undefined, d: RGB): RGB => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c ?? "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : d;
};

export interface Settings {
  esp: boolean;
  /** LEDs on the ring or strip, 0 if none */
  leds: number;
  /** brightness cap, 0–1 (the sketch uses 40%) */
  bright: number;
  has: (id: string) => boolean;
}

export class RulesProgram {
  readonly out: Outs = quietOuts();
  serial: string[] = [];
  private now = 0;
  private queue: Seg[] = [];
  private segLeft = 0;
  private segK = 0;
  private segMs = 0;
  private cur: Seg | null = null;
  private was: boolean[] = [];
  private lastRun: number[] = [];
  private lastTimer = 0;
  private quietUntil = 0;
  private screenUntil = 0;
  private speakUntil = 0;
  private lastLog = 0;
  private glowBase: RGB;
  private rules: Rule[];

  s: Settings;

  constructor(project: Project, s: Settings) {
    this.s = s;
    this.rules = project.rules;
    this.glowBase = hex(project.rules.find((r) => r.then === "light")?.color, [255, 140, 40]);
    this.boot();
  }

  /** Power on or reset: setup() runs again, including the "when switched on" rules. */
  boot() {
    Object.assign(this.out, quietOuts());
    if (this.s.has("servo")) this.out.servo = 0;
    this.queue = [];
    this.segLeft = 0;
    this.was = this.rules.map(() => false);
    this.lastRun = this.rules.map(() => -1e9);
    this.lastTimer = this.now;
    this.quietUntil = this.screenUntil = this.speakUntil = 0;
    this.say("Ready.");
    this.rules.forEach((r) => { if (r.when === "start") this.queue.push(...this.action(r)); });
  }

  private say(line: string) { this.serial.push(line); if (this.serial.length > 200) this.serial.splice(0, this.serial.length - 200); }

  private fill(c: RGB, k = 1) {
    if (!this.s.leds) return;
    const b = this.s.bright;
    this.out.ring = Array.from({ length: this.s.leds }, () => [c[0] * k * b, c[1] * k * b, c[2] * k * b] as RGB);
  }

  /** The timeline an action plays, as the generated code's delays would. */
  private action(r: Rule): Seg[] {
    const has = this.s.has;
    switch (r.then) {
      case "say":
        if (has("player")) return [{ ms: 0, set: () => { this.speakUntil = this.now + 2500; this.quietUntil = this.now + 4000; } }];
        if (has("amp") && this.s.esp) {
          const ms = Math.max(400, 75 * (r.text || "Hello").length);
          return [{ ms, set: (o) => { o.speaking = true; } }, { ms: 0, set: (o) => { o.speaking = false; this.quietUntil = this.now + 800; } }];
        }
        return [];
      case "light": {
        const c = hex(r.color, [80, 200, 255]);
        if (this.s.leds) {
          const n = this.s.leds;
          const segs: Seg[] = [];
          for (let pass = 0; pass < 2; pass++) {
            segs.push({ ms: 25 * n, set: (o, k) => {
              const lit = Math.ceil(k * n);
              const b = this.s.bright;
              o.ring = Array.from({ length: n }, (_, i) => (i < lit ? [c[0] * b, c[1] * b, c[2] * b] : (o.ring?.[i] ?? [0, 0, 0])) as RGB);
            } });
            segs.push({ ms: 150, set: () => {} });
          }
          segs.push({ ms: 280, set: (_, k) => this.fill(c, 1 - 0.65 * k) });
          return segs;
        }
        if (has("led")) {
          const segs: Seg[] = [];
          for (let i = 0; i < 3; i++) segs.push({ ms: 150, set: (o) => { o.led = true; } }, { ms: 150, set: (o) => { o.led = false; } });
          return segs;
        }
        return [];
      }
      case "beep":
        if (!has("buzzer")) return [];
        return [
          { ms: 160, set: (o) => { o.tone = 1760; } },
          { ms: 200, set: (o) => { o.tone = 2093; } },
          { ms: 0, set: (o) => { o.tone = 0; this.quietUntil = this.now + 600; } },
        ];
      case "move":
        if (!has("servo")) return [];
        return [
          { ms: 372, set: (o, k) => { o.servo = Math.min(90, Math.floor((k * 372) / 12) * 3); } },
          { ms: 300, set: (o) => { o.servo = 90; } },
          { ms: 372, set: (o, k) => { o.servo = Math.max(0, 90 - Math.floor((k * 372) / 12) * 3); } },
        ];
      case "pump": return has("pump") ? [{ ms: 3000, set: (o) => { o.pump = true; } }, { ms: 0, set: (o) => { o.pump = false; } }] : [];
      case "vibrate": return has("vibe") ? [{ ms: 400, set: (o) => { o.vibe = true; } }, { ms: 0, set: (o) => { o.vibe = false; } }] : [];
      case "show": return has("oled") ? [{ ms: 0, set: (o) => { o.screen = (r.text || "Hello!").slice(0, 20); this.screenUntil = this.now + 4000; } }] : [];
      case "switch": return has("relay") ? [{ ms: 5000, set: (o) => { o.relay = true; } }, { ms: 0, set: (o) => { o.relay = false; } }] : [];
    }
  }

  private thresholds() {
    const esp = this.s.esp;
    return {
      sound: this.s.has("mic") && esp ? 1500 : esp ? 400 : 100,
      dark: esp ? 800 : 200,
    };
  }

  private cond(w: Trigger, x: Readings): boolean {
    const th = this.thresholds();
    switch (w) {
      case "start": return false;
      case "timer": return this.now - this.lastTimer >= 5 * 60_000;
      case "touch": return x.touch;
      case "button": return x.button;
      case "sound": return this.now > this.quietUntil && x.sound > th.sound;
      case "motion": return x.motion;
      case "dark": return x.light < th.dark;
      case "dry": return x.soilPct < 30;
      case "near": return x.distanceCm > 0 && x.distanceCm < 20;
      case "shake": return x.shakeG > 0.6;
      case "open": return x.door;
      case "hot": return Number.isFinite(x.tempC) && x.tempC > 32;
    }
  }

  /** Advance the board by ms milliseconds of running code. */
  tick(ms: number, x: Readings) {
    let left = ms;
    while (left > 0) {
      // an action is playing: the loop is stuck in its delay()
      if (this.segLeft > 0 || this.queue.length) {
        if (this.segLeft <= 0) {
          const seg = this.queue.shift()!;
          this.segMs = seg.ms;
          this.segLeft = seg.ms;
          this.segK = 0;
          this.cur = seg;
          if (seg.ms === 0) { seg.set(this.out, 1); continue; }
        }
        const step = Math.min(left, this.segLeft);
        this.segLeft -= step;
        this.now += step;
        left -= step;
        this.segK = 1 - this.segLeft / this.segMs;
        this.cur!.set(this.out, this.segK);
        continue;
      }
      // one pass of loop(), which ends in delay(10)
      this.loopOnce(x);
      const step = Math.min(left, 10);
      this.now += step;
      left -= step;
    }
    if (this.s.has("player")) this.out.speaking = this.now < this.speakUntil;
    if (this.now >= this.screenUntil) this.out.screen = "";
  }

  private loopOnce(x: Readings) {
    const on = new Map<Trigger, boolean>();
    for (const r of this.rules) if (r.when !== "start" && !on.has(r.when)) on.set(r.when, this.cond(r.when, x));
    if (on.get("timer")) this.lastTimer = this.now;
    this.rules.forEach((r, i) => {
      if (r.when === "start") return;
      const c = on.get(r.when)!;
      let fire = false;
      if (r.when === "timer") fire = c;
      else if (r.when === "dry" || r.when === "hot") {
        fire = c && (this.lastRun[i] < 0 || this.now - this.lastRun[i] > 10 * 60_000);
      } else {
        fire = c && !this.was[i] && this.now - this.lastRun[i] > 3000;
        this.was[i] = c;
      }
      if (fire) { this.lastRun[i] = this.now; this.queue.push(...this.action(r)); }
    });
    if (!this.queue.length && this.s.leds) {
      const k = 0.35 + 0.25 * Math.sin(this.now / 900);
      this.fill(this.glowBase, k);
    }
    if (this.now - this.lastLog > 1000) {
      this.lastLog = this.now;
      const parts: string[] = [];
      if (this.s.has("mic") || this.s.has("soundsensor")) parts.push(`sound ${Math.round(x.sound)}`);
      if (this.s.has("light")) parts.push(`light ${Math.round(x.light)}`);
      if (this.s.has("soil")) parts.push(`soil% ${Math.round(x.soilPct)}`);
      if (this.s.has("distance")) parts.push(`cm ${x.distanceCm.toFixed(2)}`);
      if (this.s.has("motion6")) parts.push(`shake ${x.shakeG.toFixed(2)}`);
      if (this.s.has("temp")) parts.push(`C ${Number.isFinite(x.tempC) ? x.tempC.toFixed(2) : "nan"}`);
      if (parts.length) this.say(parts.join(" "));
    }
  }

  get millis() { return this.now; }
}
