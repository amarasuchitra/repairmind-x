/**
 * Runs real compiled Arduino Nano code: the machine instructions in a .hex file, executed by avr8js (Wokwi's
 * open-source ATmega328P emulator, MIT licence) at 16 MHz, cycle by cycle. The bench's sensors drive the
 * chip's input pins and ADC; its output pins drive the bench's parts. Pulse timing is measured on the pins,
 * so the Servo library's pulses turn the arm, tone() sounds the buzzer, NeoPixel data lights the ring, and
 * Serial.print appears in the serial monitor.
 *
 * Not emulated yet: I2C parts (screen, shake sensor), the DHT22's one-wire protocol and the MP3 player's serial
 * commands. The code still runs; those parts just don't answer.
 */
import { AVRADC, AVRClock, AVRIOPort, AVRTimer, AVRUSART, CPU, adcConfig, avrInstruction, clockConfig, portBConfig, portCConfig, portDConfig, timer0Config, timer1Config, timer2Config, usart0Config } from "avr8js";
import type { Report } from "../build/engine.ts";
import type { Project } from "../build/project.ts";
import { quietOuts, type Outs, type Readings, type RGB } from "./program.ts";

const HZ = 16_000_000;

/** Intel HEX → program memory (32 KB flash on the ATmega328P). Throws on a malformed file. */
export function parseHex(text: string): Uint16Array {
  const bytes = new Uint8Array(0x8000);
  let base = 0, any = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ":") throw new Error("This isn't an Intel HEX file (each line should start with ':').");
    const b = line.slice(1).match(/../g)?.map((h) => parseInt(h, 16)) ?? [];
    if (b.some((x) => Number.isNaN(x)) || b.length < 5) throw new Error("This HEX file is damaged.");
    const n = b[0], addr = (b[1] << 8) | b[2], type = b[3];
    if (b.reduce((s, x) => (s + x) & 0xff, 0) !== 0) throw new Error("This HEX file is damaged (a checksum doesn't match).");
    if (type === 0) {
      for (let i = 0; i < n; i++) {
        const a = base + addr + i;
        if (a >= bytes.length) throw new Error("This program is bigger than a Nano's 32 KB of flash. Was it built for another board?");
        bytes[a] = b[4 + i];
        any = true;
      }
    } else if (type === 1) break;
    else if (type === 2) base = ((b[4] << 8) | b[5]) * 16;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
  }
  if (!any) throw new Error("This HEX file has no program in it.");
  return new Uint16Array(bytes.buffer);
}

/** Nano pin name → port and bit. */
export function nanoPin(pin: string): { port: "B" | "C" | "D"; bit: number } | null {
  const d = /^D(\d+)$/.exec(pin);
  if (d) {
    const n = Number(d[1]);
    if (n <= 7) return { port: "D", bit: n };
    if (n <= 13) return { port: "B", bit: n - 8 };
    return null;
  }
  const a = /^A([0-5])$/.exec(pin);
  return a ? { port: "C", bit: Number(a[1]) } : null;
}

export class AvrRunner {
  readonly out: Outs = quietOuts();
  serial: string[] = [];
  readonly cpu: CPU;
  private ports: Record<"B" | "C" | "D", AVRIOPort>;
  private adc: AVRADC;
  private pins: Record<string, Record<string, string>> = {};
  private line = "";
  private watch: { key: keyof Outs | "servoPulse" | "toneEdge" | "ledData"; pin: { port: "B" | "C" | "D"; bit: number } }[] = [];
  private high = new Map<string, number>();
  private toneEdges: number[] = [];
  private ledBits: number[] = [];
  private lastEdge = 0;
  private leds: number;
  private echoArmed = false;
  private x: Readings | null = null;
  private program: Uint16Array;
  private project: Project;
  private report: Report;

  constructor(hex: string | Uint16Array, project: Project, report: Report) {
    this.project = project;
    this.report = report;
    this.program = typeof hex === "string" ? parseHex(hex) : hex;
    this.cpu = new CPU(this.program);
    this.leds = project.parts.some((p) => p.id === "ring") ? 12 : project.parts.some((p) => p.id === "strip") ? 30 : 0;
    this.ports = { B: new AVRIOPort(this.cpu, portBConfig), C: new AVRIOPort(this.cpu, portCConfig), D: new AVRIOPort(this.cpu, portDConfig) };
    this.adc = new AVRADC(this.cpu, adcConfig);
    this.setup();
  }

  private setup() {
    const cpu = this.cpu;
    new AVRTimer(cpu, timer0Config);
    new AVRTimer(cpu, timer1Config);
    new AVRTimer(cpu, timer2Config);
    new AVRClock(cpu, HZ, clockConfig);
    const usart = new AVRUSART(cpu, usart0Config, HZ);
    usart.onByteTransmit = (b) => {
      const c = String.fromCharCode(b);
      if (c === "\n") { this.serial.push(this.line.replace(/\r$/, "")); this.line = ""; if (this.serial.length > 200) this.serial.splice(0, this.serial.length - 200); }
      else if (this.line.length < 200) this.line += c;
    };
    // which part sits on which pin, from the builder's pin plan
    for (const placed of this.project.parts) this.pins[placed.id] ??= this.report.pinsOf[placed.uid] ?? {};
    const at = (id: string, name: string) => { const p = this.pins[id]?.[name]; return p ? nanoPin(p) : null; };
    const add = (key: (typeof this.watch)[number]["key"], pin: ReturnType<typeof nanoPin>) => { if (pin) this.watch.push({ key, pin }); };
    add("led", at("led", "+"));
    add("pump", at("pump", "SIG"));
    add("vibe", at("vibe", "IN"));
    add("relay", at("relay", "IN"));
    add("servoPulse", at("servo", "SIG"));
    add("toneEdge", at("buzzer", "+"));
    add("ledData", at(this.leds === 12 ? "ring" : "strip", "DIN"));
    if (this.project.parts.some((p) => p.id === "servo")) this.out.servo = null;

    for (const port of ["B", "C", "D"] as const) {
      this.ports[port].addListener(() => this.onPins(port));
    }
    // the distance sensor answers a 10 µs TRIG pulse with an ECHO pulse 58 µs long per cm
    const trig = at("distance", "TRIG"), echo = at("distance", "ECHO");
    if (trig && echo) {
      this.ports[trig.port].addListener(() => {
        const hi = this.ports[trig.port].pinState(trig.bit) === 1;
        if (hi) this.echoArmed = true;
        else if (this.echoArmed) {
          this.echoArmed = false;
          const cm = this.x?.distanceCm ?? -1;
          if (cm <= 0) return;
          const port = this.ports[echo.port];
          this.cpu.addClockEvent(() => {
            port.setPin(echo.bit, true);
            this.cpu.addClockEvent(() => port.setPin(echo.bit, false), Math.round(cm * 58 * 16));
          }, 16 * 250);
        }
      });
    }
  }

  private onPins(port: "B" | "C" | "D") {
    const now = this.cpu.cycles;
    for (const w of this.watch) {
      if (w.pin.port !== port) continue;
      const k = `${w.pin.port}${w.pin.bit}`;
      const hi = this.ports[port].pinState(w.pin.bit) === 1;
      const was = this.high.has(k);
      if (hi === was) continue;
      if (hi) this.high.set(k, now);
      else {
        const start = this.high.get(k)!;
        this.high.delete(k);
        const width = now - start;
        if (w.key === "servoPulse") {
          const us = width / 16;
          // Arduino's Servo library: 544 µs is 0°, 2400 µs is 180°
          if (us > 400 && us < 2600) this.out.servo = Math.max(0, Math.min(180, ((us - 544) / (2400 - 544)) * 180));
        } else if (w.key === "ledData") {
          if (start - this.lastEdge > 16 * 50) this.latch();
          // WS2812: a long high (~0.8 µs) is a 1, a short one (~0.4 µs) a 0
          this.ledBits.push(width > 9.6 ? 1 : 0);
          this.lastEdge = now;
        }
      }
      if (w.key === "toneEdge") this.toneEdges.push(now);
    }
  }

  private latch() {
    if (this.ledBits.length >= 24) {
      const n = Math.min(this.leds, Math.floor(this.ledBits.length / 24));
      const ring: RGB[] = [];
      for (let i = 0; i < n; i++) {
        const byte = (o: number) => this.ledBits.slice(i * 24 + o, i * 24 + o + 8).reduce((s, b) => (s << 1) | b, 0);
        ring.push([byte(8), byte(0), byte(16)]); // the wire order is green, red, blue
      }
      this.out.ring = ring;
    }
    this.ledBits = [];
  }

  /** Power on: the chip starts from address 0 with its RAM cleared, like after a reset. */
  boot() {
    this.cpu.reset();
    this.serial.push("— reset —");
    Object.assign(this.out, quietOuts());
    this.high.clear();
    this.ledBits = [];
    this.toneEdges = [];
  }

  private inputs(x: Readings) {
    const set = (id: string, name: string, v: boolean) => { const p = this.pins[id]?.[name]; const n = p && nanoPin(p); if (n) this.ports[n.port].setPin(n.bit, v); };
    // a button and a reed switch pull the pin to GND (the code turns on the pull-up)
    set("button", "1", !x.button);
    set("reed", "1", x.door);
    set("touch", "SIG", x.touch);
    set("pir", "OUT", x.motion);
    const vcc = 5;
    const analog = (id: string, name: string, v: number) => { const p = this.pins[id]?.[name]; const a = p && /^A(\d)$/.exec(p); if (a) this.adc.channelValues[Number(a[1])] = v; };
    analog("light", "AO", (x.light / 1023) * vcc);
    analog("soil", "AO", ((600 - (x.soilPct / 100) * 300) / 1023) * vcc);
    // the clap sensor's output swings around mid-rail; louder is a bigger swing
    const swing = (x.sound / 1023) * vcc;
    analog("soundsensor", "AO", vcc / 2 + (Math.random() - 0.5) * swing);
  }

  /** Run ms milliseconds of the chip's time. */
  tick(ms: number, x: Readings) {
    this.x = x;
    const end = this.cpu.cycles + Math.round((ms / 1000) * HZ);
    this.inputs(x);
    const cpu = this.cpu;
    let n = 0;
    while (cpu.cycles < end) {
      avrInstruction(cpu);
      cpu.tick();
      if ((++n & 0x3ff) === 0 && this.pins.soundsensor) this.inputs(x);
    }
    // outputs that are a level, read straight from the pins
    for (const w of this.watch) {
      if (w.key === "led" || w.key === "pump" || w.key === "vibe" || w.key === "relay") {
        (this.out as unknown as Record<string, boolean>)[w.key] = this.ports[w.pin.port].pinState(w.pin.bit) === 1;
      }
    }
    if (this.ledBits.length && cpu.cycles - this.lastEdge > 16 * 50) this.latch();
    // tone(): count the pin's edges over the last 50 ms
    const win = 0.05 * HZ;
    this.toneEdges = this.toneEdges.filter((c) => cpu.cycles - c < win);
    this.out.tone = this.toneEdges.length > 4 ? Math.round(this.toneEdges.length / 2 / 0.05) : 0;
  }
}
