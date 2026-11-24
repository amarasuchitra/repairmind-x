/**
 * Checks a hardware project and works out everything needed to build it: which pin each part uses, the
 * wiring, the power budget and battery life, whether it fits, the parts list with prices, and the build steps.
 * Pure functions over plain data, so the same checks run in the browser and in the tests.
 */
import { BOARDS, BOXES, BY_ID, POWER, isBoard, isPower, type Board, type Part, type Power } from "./parts.ts";
import { ACTIONS, TRIGGERS, type Placed, type Project } from "./project.ts";

export type Level = "block" | "fix" | "warn" | "tip";

export interface Issue {
  level: Level;
  text: string;
  /** a one-tap change that solves it */
  fix?: { label: string; add?: string[]; remove?: string[]; replace?: [string, string] };
}

export interface Conn {
  /** the part (or "power") end of the wire */
  from: string;
  fromPin: string;
  /** the other end: a board pin like "GPIO 18", a rail like "5V", or another part */
  to: string;
  toPin: string;
  kind: "5v" | "3v3" | "gnd" | "batt" | "signal" | "audio";
  /** something that goes in the wire, like a resistor */
  via?: string;
}

export interface Pin { pin: string; use: string }

export interface BudgetRow { name: string; rail: string; mA: number; peakmA: number }

export interface BomLine { id: string; name: string; qty: number; each: number; total: number; note?: string }

export interface Step { title: string; detail: string[]; safety?: string[] }

export interface Report {
  board: Board | null;
  source: Power | null;
  boost: boolean;
  issues: Issue[];
  /** no block or fix issues left */
  ready: boolean;
  conns: Conn[];
  /** part uid → its board pins, by the part's own pin name */
  pinsOf: Record<string, Record<string, string>>;
  pinMap: Pin[];
  budget: BudgetRow[];
  rail5: [number, number, number] | null;
  /** totals at the battery or USB socket */
  draw: { mA: number; peakmA: number };
  /** hours on a full battery at the typical draw, or null on USB */
  hours: number | null;
  fit: { state: "ok" | "tight" | "no" | "unknown"; partsVolume: number; innerVolume: number | null; box?: (typeof BOXES)[number]; tooBig: string[] };
  bom: BomLine[];
  totalInr: number;
  steps: Step[];
  libs: string[];
}

const GND = "GND";

/** How a board names a pin for people. */
export const pinLabel = (board: Board | null, pin: string) => (board?.id === "esp32" ? `GPIO ${pin}` : pin);

export function partsOf(p: Project): { placed: Placed; part: Part }[] {
  return p.parts.map((placed) => ({ placed, part: BY_ID[placed.id] })).filter((x) => !!x.part);
}

export function analyze(project: Project): Report {
  const items = partsOf(project);
  const issues: Issue[] = [];
  const has = (id: string) => items.some((x) => x.part.id === id);
  const count = (id: string) => items.filter((x) => x.part.id === id).length;
  const boards = items.filter((x) => isBoard(x.part));
  const board = (boards[0]?.part as Board | undefined) ?? null;
  const sources = items.filter((x) => isPower(x.part) && ((x.part as Power).kind === "battery" || (x.part as Power).kind === "usb"));
  const source = (sources[0]?.part as Power | undefined) ?? null;
  const boost = has("boost5");
  const kids = project.product.forKids;
  const active = items.filter((x) => !isBoard(x.part) && !isPower(x.part));

  // --- the basics: one brain, one power source -----------------------------------------------------------
  if (!board && active.some((x) => x.part.signal)) {
    issues.push({ level: "fix", text: "It needs a brain to run the parts.", fix: { label: "Add the ESP32 board", add: ["esp32"] } });
  }
  if (boards.length > 1) {
    issues.push({ level: "fix", text: "Use one brain. Two boards would need to talk to each other, which this builder doesn't wire.", fix: { label: `Remove the extra ${boards[1].part.name}`, remove: [boards[1].placed.uid] } });
  }
  if (!source && items.length) {
    const portable = kids || project.product.power === "battery";
    issues.push({
      level: "fix", text: "It needs power.",
      fix: portable ? { label: "Add AA batteries with a 5 V booster", add: ["aa3", "boost5", "switch"] } : { label: "Add USB power", add: ["usb"] },
    });
  }
  if (sources.length > 1) {
    issues.push({ level: "fix", text: "Use one power source. Two connected together can fight each other.", fix: { label: `Remove ${sources[1].part.name}`, remove: [sources[1].placed.uid] } });
  }
  if (project.product.power === "wall" && project.mode === "upgrade") {
    issues.push({
      level: has("relay") ? "block" : "warn",
      text: has("relay")
        ? "This item plugs into the wall. Switching its mains power with a relay isn't something this app will guide: it needs an electrician."
        : "This item plugs into the wall. Keep the new electronics on their own batteries or USB, never connected to anything inside the mains part. If you'd have to open the mains section to fit them, stop.",
    });
  }

  // --- power rails ----------------------------------------------------------------------------------------
  let rail5: [number, number, number] | null = null;
  if (source) {
    if (boost && source.kind === "usb") {
      issues.push({ level: "tip", text: "USB is already 5 V, so the booster isn't needed.", fix: { label: "Remove the booster", remove: items.filter((x) => x.part.id === "boost5").map((x) => x.placed.uid) } });
      rail5 = [...source.v];
    } else if (boost && source.v[2] <= 5) {
      rail5 = [5, 5, 5];
    } else {
      rail5 = [...source.v];
      if (boost) issues.push({ level: "warn", text: `The ${source.name} is already above 5 V when fresh; a booster can't bring it down.` });
    }
  }

  if (board && rail5 && rail5[1] < board.minIn) {
    const canBoost = !!source && source.kind === "battery" && source.v[2] <= 5;
    issues.push({
      level: canBoost ? "fix" : "warn",
      text: `As the batteries run down they drop to ${fmt(rail5[1])} V, below the ${fmt(board.minIn)} V the ${short(board)} needs, so it will keep restarting.`,
      fix: canBoost ? { label: "Add a 5 V booster", add: ["boost5"] } : undefined,
    });
  }

  // --- pins -----------------------------------------------------------------------------------------------
  const pinsOf: Record<string, Record<string, string>> = {};
  const pinMap: Pin[] = [];
  const used = new Set<string>();
  const conns: Conn[] = [];
  const take = (pool: string[] | undefined, use: string) => {
    const pin = (pool ?? []).find((x) => !used.has(x));
    if (pin) { used.add(pin); pinMap.push({ pin, use }); }
    return pin;
  };
  const libs = new Set<string>();

  if (board) {
    const order = (sig?: string) => ["i2s_mic", "i2s_amp", "i2c", "uart", "led_data", "analog", "trig_echo", "in", "out", "pwm"].indexOf(sig ?? "");
    const withSig = active.filter((x) => x.part.signal).sort((a, b) => order(a.part.signal) - order(b.part.signal));
    // buses claim their fixed pins before the general pool hands pins out
    let i2c = false, uart = false, mic = false, amp = false;
    const addrs = new Map<number, string>();
    for (const { placed, part } of withSig) {
      const pins: Record<string, string> = {};
      const sig = part.signal!;
      if (sig === "i2s_mic" || sig === "i2s_amp") {
        const pool = board.pinPools[sig];
        if (!board.canI2S || !pool) {
          issues.push({ level: "fix", text: `The ${part.name} needs the ESP32; the ${short(board)} can't drive it.`, fix: { label: "Swap to the ESP32", replace: [board.id, "esp32"] } });
          continue;
        }
        if (sig === "i2s_mic" ? mic : amp) {
          issues.push({ level: "fix", text: `Use one ${part.name}.`, fix: { label: "Remove the extra one", remove: [placed.uid] } });
          continue;
        }
        if (sig === "i2s_mic") mic = true; else amp = true;
        part.pins!.forEach((n, i) => { pins[n] = pool[i]; used.add(pool[i]); pinMap.push({ pin: pool[i], use: `${short(part)} ${n}` }); });
      } else if (sig === "i2c") {
        const [sda, scl] = board.pinPools.i2c!;
        if (!i2c) { used.add(sda); used.add(scl); pinMap.push({ pin: sda, use: "I2C SDA (shared)" }, { pin: scl, use: "I2C SCL (shared)" }); i2c = true; }
        pins.SDA = sda; pins.SCL = scl;
        if (part.i2c !== undefined) {
          const other = addrs.get(part.i2c);
          if (other) issues.push({ level: "fix", text: `Two parts answer to the same I2C address (${other} and ${part.name}). Use one of them.`, fix: { label: "Remove the second one", remove: [placed.uid] } });
          addrs.set(part.i2c, part.name);
        }
      } else if (sig === "uart") {
        if (uart) { issues.push({ level: "fix", text: `Use one ${part.name}.`, fix: { label: "Remove the extra one", remove: [placed.uid] } }); continue; }
        const [rx, tx] = board.pinPools.uart!;
        used.add(rx); used.add(tx); uart = true;
        pinMap.push({ pin: rx, use: `${short(part)} TX → board RX` }, { pin: tx, use: `board TX → ${short(part)} RX` });
        pins.RX = tx; pins.TX = rx; // the part's RX listens to the board's TX
      } else if (sig === "led_data") {
        const pin = take(board.pinPools.led_data, short(part)) ?? take(board.pinPools.general, short(part));
        if (pin) pins.DIN = pin;
      } else if (sig === "analog") {
        const pin = take(board.pinPools.analog, short(part));
        if (pin) pins[part.pins![0]] = pin;
      } else if (sig === "trig_echo") {
        const t = take(board.pinPools.general, `${short(part)} TRIG`);
        const e = take(board.pinPools.general, `${short(part)} ECHO`);
        if (t && e) { pins.TRIG = t; pins.ECHO = e; }
      } else {
        const pin = take(board.pinPools.general, short(part));
        if (pin) pins[part.pins![0]] = pin;
      }
      if (part.pins && part.pins.some((n) => !pins[n])) {
        issues.push({ level: "fix", text: `The ${short(board)} has run out of free pins for the ${part.name}.`, fix: { label: `Remove the ${short(part)}`, remove: [placed.uid] } });
        continue;
      }
      pinsOf[placed.uid] = pins;
    }
  }

  // --- what needs what ------------------------------------------------------------------------------------
  for (const { part } of active) {
    if (part.needsOneOf && !part.needsOneOf.some(has)) {
      const add = part.needsOneOf[0] === "player" && board?.canI2S && !kids ? "amp" : part.needsOneOf[0];
      issues.push({ level: "fix", text: `The ${short(part)} needs a ${short(BY_ID[add])} to work.`, fix: { label: `Add the ${short(BY_ID[add])}`, add: [add] } });
    }
  }
  if (count("speaker") > 1) issues.push({ level: "warn", text: "Each voice part drives one speaker; extra speakers aren't wired." });
  if (has("player") && has("amp")) issues.push({ level: "tip", text: "You have two ways to talk (MP3 player and robot voice). The code uses the MP3 player; the amplifier isn't needed.", fix: { label: "Remove the amplifier", remove: items.filter((x) => x.part.id === "amp").map((x) => x.placed.uid) } });
  if (has("amp") && has("mic") && board?.id === "esp32") issues.push({ level: "tip", text: "Robot voice plus microphone: build with ESP32 board package 2.0.17 so both use the same sound driver (noted at the top of the code)." });

  // behaviours need their parts
  for (const r of project.rules) {
    const t = TRIGGERS.find((x) => x.id === r.when)!;
    const a = ACTIONS.find((x) => x.id === r.then)!;
    for (const need of [t, a]) {
      if (need.needs.length && !need.needs.some(has)) {
        issues.push({ level: "fix", text: `"${need.label}" needs a ${short(BY_ID[need.needs[0]])}.`, fix: { label: `Add the ${short(BY_ID[need.needs[0]])}`, add: [need.needs[0]] } });
      }
    }
  }
  const usedByRules = new Set(project.rules.flatMap((r) => [...TRIGGERS.find((x) => x.id === r.when)!.needs, ...ACTIONS.find((x) => x.id === r.then)!.needs]));
  for (const { part } of active) {
    if (part.signal && !usedByRules.has(part.id) && part.id !== "oled") {
      issues.push({ level: "tip", text: `The ${short(part)} isn't used by anything it does yet. Add a "When… then…" for it.` });
    }
  }
  if (!project.rules.length && active.length) issues.push({ level: "tip", text: "Tell it what to do: add a \"When… then…\" below." });

  // --- wiring ---------------------------------------------------------------------------------------------
  const b = board ? short(board) : "board";
  const pin5 = board?.id === "esp32" ? "VIN (5V)" : "5V";
  if (board && source) {
    const sw = has("switch");
    if (source.kind === "usb") {
      conns.push({ from: short(source), fromPin: "5V", to: b, toPin: board.id === "esp32" ? "VIN (5V)" : "5V", kind: "5v", via: sw ? "on/off switch" : undefined });
      conns.push({ from: short(source), fromPin: "GND", to: b, toPin: GND, kind: "gnd" });
    } else if (boost && rail5 && rail5[0] === 5) {
      const cell = source.id === "lipo" ? "charger board OUT+" : "+";
      conns.push({ from: short(source), fromPin: cell, to: "5 V booster", toPin: "IN+", kind: "batt", via: sw ? "on/off switch" : undefined });
      conns.push({ from: short(source), fromPin: source.id === "lipo" ? "charger board OUT−" : "−", to: "5 V booster", toPin: "IN−", kind: "gnd" });
      conns.push({ from: "5 V booster", fromPin: "OUT+", to: b, toPin: pin5, kind: "5v" });
      conns.push({ from: "5 V booster", fromPin: "OUT−", to: b, toPin: GND, kind: "gnd" });
    } else {
      conns.push({ from: short(source), fromPin: "+", to: b, toPin: pin5, kind: "batt", via: sw ? "on/off switch" : undefined });
      conns.push({ from: short(source), fromPin: "−", to: b, toPin: GND, kind: "gnd" });
    }
  }
  const speakerTo = has("player") ? "player" : has("amp") ? "amp" : null;
  for (const { placed, part } of active) {
    const name = short(part);
    const pins = pinsOf[placed.uid] ?? {};
    const supply = railFor(part, board);
    if (supply === "5v") {
      conns.push({ from: name, fromPin: part.id === "amp" ? "VIN" : "VCC", to: b, toPin: pin5, kind: "5v" });
      conns.push({ from: name, fromPin: GND, to: b, toPin: GND, kind: "gnd" });
    } else if (supply === "3v3") {
      conns.push({ from: name, fromPin: part.id === "mic" ? "VDD" : "VCC", to: b, toPin: "3V3", kind: "3v3" });
      conns.push({ from: name, fromPin: GND, to: b, toPin: GND, kind: "gnd" });
    }
    if (part.id === "speaker" && speakerTo) {
      const via = speakerTo === "player" ? ["SPK_1", "SPK_2"] : ["+", "−"];
      conns.push({ from: name, fromPin: "+", to: short(BY_ID[speakerTo]), toPin: via[0], kind: "audio" });
      conns.push({ from: name, fromPin: "−", to: short(BY_ID[speakerTo]), toPin: via[1], kind: "audio" });
      continue;
    }
    if (!part.pins || !board) continue;
    for (const pn of part.pins) {
      const bp = pins[pn];
      if (!bp) continue;
      let via: string | undefined;
      if (part.signal === "led_data") via = "330 Ω resistor";
      if (part.id === "led") via = "220 Ω resistor";
      if (part.id === "player" && pn === "RX") via = "1 kΩ resistor";
      if (part.id === "distance" && pn === "ECHO" && board.logic === 3.3) via = "divider: 1 kΩ from ECHO, 2 kΩ to GND";
      if (part.id === "light" && pn === "AO") via = "10 kΩ resistor from the pin to GND (LDR from the pin to 3V3/5V)";
      conns.push({ from: name, fromPin: pn, to: b, toPin: pinLabel(board, bp), kind: "signal", via });
    }
    if (part.id === "led" || part.id === "buzzer" || part.id === "button" || part.id === "reed") {
      conns.push({ from: name, fromPin: part.id === "led" || part.id === "buzzer" ? "−" : "2", to: b, toPin: GND, kind: "gnd" });
    }
    if (part.id === "mic") conns.push({ from: name, fromPin: "L/R", to: b, toPin: GND, kind: "gnd" });
    if (part.id === "light") conns.push({ from: name, fromPin: "leg 2", to: b, toPin: board.logic === 3.3 ? "3V3" : "5V", kind: board.logic === 3.3 ? "3v3" : "5v" });
  }

  // --- voltages and the current budget --------------------------------------------------------------------
  const budget: BudgetRow[] = [];
  let i5 = 0, p5 = 0, i3 = 0, p3 = 0;
  if (board) { budget.push({ name: board.name, rail: "5 V", mA: board.mA, peakmA: board.peakmA }); i5 += board.mA; p5 += board.peakmA; }
  for (const { part } of active) {
    if (!part.mA && !part.peakmA) continue;
    const rail = railFor(part, board);
    const label = rail === "3v3" ? "3.3 V" : rail === "5v" ? "5 V" : "pin";
    budget.push({ name: part.name, rail: label, mA: part.mA, peakmA: part.peakmA });
    if (rail === "3v3") { i3 += part.mA; p3 += part.peakmA; }
    else { i5 += part.mA; p5 += part.peakmA; }
    if (rail === "5v" && rail5 && part.volts) {
      if (rail5[2] > part.volts[1] + 0.01) issues.push({ level: "warn", text: `Fresh batteries give ${fmt(rail5[2])} V, above the ${fmt(part.volts[1])} V the ${short(part)} is rated for. Let freshly charged cells settle, or use USB.` });
      else if (rail5[1] < part.volts[0] - 0.01) issues.push({ level: "warn", text: `The ${short(part)} needs at least ${fmt(part.volts[0])} V; it may act up as the batteries run down.` });
    }
    if (part.rail === "3v3" && board && board.logic === 5) {
      issues.push({ level: "fix", text: `The ${short(part)} runs on 3.3 V signals and the ${short(board)} uses 5 V.`, fix: { label: "Swap to the ESP32", replace: [board.id, "esp32"] } });
    }
  }
  i5 += i3; p5 += p3; // the 3.3 V regulator draws its current from the 5 V side
  if (board && p3 > board.max3v3mA) {
    issues.push({ level: "warn", text: `The 3.3 V parts can draw ${Math.round(p3)} mA, more than the ${short(board)}'s regulator gives (${board.max3v3mA} mA).` });
  }
  let draw = { mA: Math.round(i5), peakmA: Math.round(p5) };
  if (source && boost && rail5?.[0] === 5 && source.kind === "battery") {
    const k = 5 / (source.v[0] * 0.85);
    draw = { mA: Math.round(i5 * k), peakmA: Math.round(p5 * k) };
    const boostMax = (POWER.find((x) => x.id === "boost5") as Power).maxmA;
    if (p5 > boostMax) issues.push({ level: "warn", text: `Everything at once can pull ${Math.round(p5)} mA from the booster, over its ${boostMax} mA. The code staggers things, but avoid running lights, voice and motors flat out together.` });
  }
  if (source && draw.peakmA > source.maxmA) {
    issues.push({ level: "warn", text: `Short bursts can reach ${draw.peakmA} mA, more than the ${short(source)} comfortably gives (${source.maxmA} mA). The brain may restart if everything runs at full power at once.` });
  }
  if (source?.kind === "usb" && draw.mA < 80 && items.length) {
    issues.push({ level: "tip", text: "It draws very little. Some power banks switch themselves off below about 80 mA; a wall charger avoids that." });
  }
  if ((has("servo") || has("pump") || has("strip")) && board) {
    issues.push({ level: "tip", text: "Put a 470 µF capacitor across 5 V and GND near the motor or LEDs so the brain doesn't restart when they start up." });
  }
  const hours = source && source.kind === "battery" && draw.mA > 0 ? (source.mAh * 0.8) / draw.mA : null;

  // --- kids ------------------------------------------------------------------------------------------------
  if (kids) {
    if (has("lipo")) issues.push({ level: "warn", text: (BY_ID.lipo as Part).kids!, fix: { label: "Use AA batteries instead", replace: ["lipo", "aa3"] } });
    if (has("pump") || has("relay")) issues.push({ level: "warn", text: "Water pumps and relays aren't suitable inside a children's toy." });
  }

  // --- fit -------------------------------------------------------------------------------------------------
  const physical = items.filter((x) => x.part.size[0] > 0 && !(project.mode === "upgrade" && x.part.id === "usb"));
  const partsVolume = physical.reduce((s, x) => s + x.part.size[0] * x.part.size[1] * x.part.size[2], 0) / 1000;
  const SPACE = 2; // wires, air and mounting take about as much room again
  const fitsIn = (inner: [number, number, number]) => {
    const room = [...inner].sort((a, c) => c - a);
    return physical.filter((x) => {
      const d = [...x.part.size].sort((a, c) => c - a);
      return d.some((v, i) => v > room[i]);
    }).map((x) => x.part.name);
  };
  let fit: Report["fit"];
  const inner = project.product.inner;
  if (project.mode === "upgrade") {
    if (!inner) fit = { state: "unknown", partsVolume, innerVolume: null, tooBig: [] };
    else {
      const innerVolume = (inner[0] * inner[1] * inner[2]) / 1000;
      const tooBig = fitsIn(inner);
      const state = tooBig.length || partsVolume * 1.3 > innerVolume ? "no" : partsVolume * SPACE > innerVolume ? "tight" : "ok";
      fit = { state, partsVolume, innerVolume, tooBig };
      if (state === "no") issues.push({ level: "warn", text: tooBig.length ? `Too big for the space inside: ${tooBig.join(", ")}. Mount it outside, in a base or a backpack box.` : "The parts won't all fit inside. Put the batteries and board in a small box under or behind it." });
      else if (state === "tight") issues.push({ level: "tip", text: "It's a tight fit. Use short wires and stack the small boards." });
    }
  } else {
    const box = partsVolume ? BOXES.find((bx) => !fitsIn(bx.inner).length && (bx.inner[0] * bx.inner[1] * bx.inner[2]) / 1000 >= partsVolume * SPACE) : undefined;
    fit = { state: box || !partsVolume ? "ok" : "no", partsVolume, innerVolume: box ? (box.inner[0] * box.inner[1] * box.inner[2]) / 1000 : null, box, tooBig: [] };
    if (partsVolume && !box) issues.push({ level: "tip", text: "It's bigger than a standard project box; plan a custom case or a board on a base." });
  }

  // --- parts list ------------------------------------------------------------------------------------------
  const bom: BomLine[] = [];
  for (const { part } of items) {
    const line = bom.find((l) => l.id === part.id);
    if (line) { line.qty++; line.total += part.priceInr; } else bom.push({ id: part.id, name: part.name, qty: 1, each: part.priceInr, total: part.priceInr });
    part.libs?.forEach((l) => libs.add(l));
  }
  if (items.length) {
    const small = conns.filter((c) => c.via && /resistor|divider/.test(c.via)).length;
    const caps = has("servo") || has("pump") || has("strip") || has("ring");
    if (small || caps) bom.push({ id: "passives", name: "Resistors and capacitors", qty: 1, each: 40, total: 40, note: [small ? "220 Ω / 330 Ω / 1 kΩ / 2 kΩ / 10 kΩ as listed in the wiring" : "", caps ? "470 µF 10 V capacitor" : ""].filter(Boolean).join("; ") });
    bom.push({ id: "wires", name: "Jumper wires, small perfboard, heat-shrink", qty: 1, each: 90, total: 90 });
    if (fit.box) bom.push({ id: "box", name: fit.box.name, qty: 1, each: fit.box.priceInr, total: fit.box.priceInr });
  }
  const totalInr = bom.reduce((s, l) => s + l.total, 0);

  const steps = buildSteps(project, { board, source, boost, conns, items, libs: [...libs] });
  const order: Record<Level, number> = { block: 0, fix: 1, warn: 2, tip: 3 };
  const dedup = issues.filter((x, i) => issues.findIndex((y) => y.text === x.text) === i).sort((a, c) => order[a.level] - order[c.level]);
  return {
    board, source, boost, issues: dedup, ready: items.length > 0 && !dedup.some((x) => x.level === "block" || x.level === "fix"),
    conns, pinsOf, pinMap, budget, rail5, draw, hours, fit, bom, totalInr, steps, libs: [...libs],
  };
}

/** Which supply a part takes on this board. */
export function railFor(part: Part, board: Board | null): "5v" | "3v3" | "none" {
  if (part.rail === "none") return "none";
  if (part.rail === "either") return board?.logic === 5 ? "5v" : "3v3";
  return part.rail;
}

function buildSteps(project: Project, x: { board: Board | null; source: Power | null; boost: boolean; conns: Conn[]; items: { part: Part }[]; libs: string[] }): Step[] {
  const steps: Step[] = [];
  const has = (id: string) => x.items.some((i) => i.part.id === id);
  const kids = project.product.forKids;
  if (project.mode === "upgrade") {
    steps.push({
      title: `Open up the ${project.product.what || "item"}`,
      detail: [
        "Take out the batteries or unplug it first.",
        "Take a photo of the inside before you change anything, so you can put it back.",
        project.product.does ? `Leave what it already does (${project.product.does}) wired as it is. The new parts run alongside it.` : "Leave its existing circuit as it is. The new parts run alongside it.",
        "Measure the free space inside and enter it under the product details to check the fit.",
      ],
      safety: project.product.power === "wall" ? ["Don't open or touch anything connected to the wall plug. Mains voltage can kill."] : undefined,
    });
  }
  if (x.board) {
    steps.push({
      title: "Load the code first, on the desk",
      detail: [
        "Install the Arduino IDE (free) and plug the brain into your computer with a USB cable.",
        x.board.id === "esp32"
          ? "Add the ESP32 boards: File → Preferences → Additional boards URL: https://espressif.github.io/arduino-esp32/package_esp32_index.json, then Tools → Board → Boards Manager → install \"esp32\". Pick \"ESP32 Dev Module\"."
          : "Pick Tools → Board → Arduino Nano. On clone boards choose Processor → \"ATmega328P (Old Bootloader)\" if uploading fails.",
        x.libs.length ? `Install these libraries from Tools → Manage Libraries: ${x.libs.join(", ")}.` : "No extra libraries are needed.",
        "Open the code from the Code tab, press Upload, then open the Serial Monitor at 115200 baud to see what it's doing.",
      ],
    });
  }
  if (x.boost) {
    steps.push({
      title: "Set the booster to 5 V",
      detail: ["Connect only the batteries to the booster's IN pins.", "With a multimeter on OUT+ and OUT−, turn the little screw until it reads 5.0 V. Do this before anything else is connected: some come set to 12 V or more."],
      safety: ["Too high a voltage here will destroy the board and the parts in one go."],
    });
  }
  const byPart = new Map<string, Conn[]>();
  for (const c of x.conns) byPart.set(c.from, [...(byPart.get(c.from) ?? []), c]);
  const wiring: string[] = [];
  for (const [from, cs] of byPart) {
    wiring.push(`${from}: ${cs.map((c) => `${c.fromPin} → ${c.to === from ? "" : `${c.to} `}${c.toPin}${c.via ? ` (through ${c.via})` : ""}`).join("; ")}`);
  }
  if (wiring.length) {
    steps.push({
      title: "Wire it up on a breadboard",
      detail: ["Power off while you wire. Connect all GNDs together.", ...wiring, "Power on from USB first and check each part works before using batteries."],
      safety: ["Double-check + and − on the battery box before connecting: reversed polarity destroys boards."],
    });
  }
  if (has("player")) {
    const lines = project.rules.filter((r) => r.then === "say");
    steps.push({
      title: "Record what it says",
      detail: [
        "Format the microSD card as FAT32.",
        ...(lines.length ? lines.map((r, i) => `Save ${String(i + 1).padStart(4, "0")}.mp3: "${r.text || "Hello!"}"`) : ["Save your first voice line as 0001.mp3."]),
        "Record your own voice on a phone, or use any text-to-speech website, and save as MP3. Copy the files to the card in that order (the player goes by the order files were copied).",
      ],
    });
  }
  steps.push({
    title: project.mode === "upgrade" ? "Fit it inside" : "Put it in the box",
    detail: [
      ...(has("speaker") ? ["Drill a few 3 mm holes where the speaker sits and glue the speaker face against them."] : []),
      ...(has("ring") || has("strip") ? ["Put the lights behind a frosted or translucent part so they glow evenly."] : []),
      ...(has("touch") ? ["Stick the touch pad on the inside of a thin (under 3 mm) plastic wall: it senses through it."] : []),
      ...(has("mic") || has("soundsensor") ? ["Leave a small hole in front of the microphone."] : []),
      ...(has("pir") || has("distance") || has("light") ? ["Sensors need to see out: cut a window for them."] : []),
      "Fix boards with double-sided foam tape or small screws. Glue wires near joints so they can't bend and break.",
      "Cover every solder joint with heat-shrink.",
      ...(x.source?.kind === "battery" ? ["Keep the battery box reachable so the batteries can be changed."] : []),
    ],
    safety: kids ? [
      "Battery cover held by a screw.",
      "No loose small parts: everything glued or screwed so nothing can come out and be swallowed.",
      "No sharp edges or bare metal on the outside.",
      ...x.items.map((i) => i.part.kids).filter((k): k is string => !!k && !k.startsWith("Lithium") && !k.startsWith("Use a box")),
      "Toys sold in India must meet IS 9873 and carry BIS certification. These steps are for a personal build, not for selling.",
    ] : undefined,
  });
  steps.push({
    title: "Test everything",
    detail: [
      ...project.rules.map((r) => `${TRIGGERS.find((t) => t.id === r.when)!.label}: check that it does "${ACTIONS.find((a) => a.id === r.then)!.label.toLowerCase()}".`),
      "Run it for 10 minutes and touch the boards and batteries: nothing should be more than warm.",
    ],
    safety: ["If anything gets hot, smells or smokes, switch off and remove the batteries at once."],
  });
  return steps;
}

export const short = (p: Part) => p.name.replace(/\s*\(.*\)\s*/g, " ").replace(/\s*\+.*$/, "").trim();
const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/** Apply a one-tap fix. */
export function applyFix(project: Project, fix: NonNullable<Issue["fix"]>, newUid: () => string): Project {
  let parts = project.parts.filter((p) => !fix.remove?.includes(p.uid));
  if (fix.replace) {
    const [from, to] = fix.replace;
    parts = parts.map((p) => (p.id === from ? { ...p, id: to } : p));
  }
  for (const id of fix.add ?? []) {
    if (BOARDS.some((b) => b.id === id) && parts.some((p) => BY_ID[p.id]?.category === "brain")) continue;
    parts.push({ uid: newUid(), id, ...freeSpot(parts) });
  }
  return { ...project, parts };
}

/** A free spot on the canvas: the middle first (the brain goes there), then a ring around it, then the gaps. */
export function freeSpot(parts: Placed[]): { x: number; y: number } {
  const spots: { x: number; y: number }[] = [{ x: 0.5, y: 0.5 }];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 10;
    spots.push({ x: 0.5 + 0.37 * Math.cos(a), y: 0.5 + 0.36 * Math.sin(a) });
  }
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + Math.PI / 8 + (i * 2 * Math.PI) / 8;
    spots.push({ x: 0.5 + 0.2 * Math.cos(a), y: 0.5 + 0.2 * Math.sin(a) });
  }
  const free = spots.find((s) => !parts.some((p) => Math.abs(p.x - s.x) < 0.09 && Math.abs(p.y - s.y) < 0.09));
  if (free) return { x: round(free.x), y: round(free.y) };
  return { x: round(0.15 + Math.random() * 0.7), y: round(0.15 + Math.random() * 0.7) };
}
const round = (n: number) => Math.round(n * 1000) / 1000;
