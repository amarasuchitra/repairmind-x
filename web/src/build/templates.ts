/**
 * Starting points (templates across everyday categories) and the assistant's first guess at the parts for a
 * goal written in plain words ("make my toy talk"). Both produce an ordinary project the person then changes.
 */
import { freeSpot } from "./engine.ts";
import { ACTIONS, TRIGGERS, emptyProject, uid, type Action, type Placed, type Project, type Rule, type Trigger } from "./project.ts";

export interface Template {
  id: string;
  category: "Toys" | "Home" | "Garden" | "Pets" | "Safety" | "Vehicles";
  name: string;
  blurb: string;
  mode: Project["mode"];
  forKids?: boolean;
  what?: string;
  does?: string;
  power?: Project["product"]["power"];
  parts: string[];
  rules: Omit<Rule, "id">[];
}

export const TEMPLATES: Template[] = [
  {
    id: "talking-toy", category: "Toys", name: "Talking toy", mode: "upgrade", forKids: true,
    blurb: "A toy that only glows becomes one that answers when touched and when it hears you.",
    what: "Glowing soft toy", does: "glows when switched on", power: "battery",
    parts: ["esp32", "mic", "player", "speaker", "ring", "touch", "aa3", "boost5", "switch"],
    rules: [
      { when: "start", then: "say", text: "Hello! I'm awake." },
      { when: "touch", then: "say", text: "Hee hee, that tickles! Want to hear a story?" },
      { when: "touch", then: "light", color: "#ff7ad9" },
      { when: "sound", then: "say", text: "I heard you! Let's sing a song." },
      { when: "sound", then: "light", color: "#46e2ff" },
    ],
  },
  {
    id: "robot-buddy", category: "Toys", name: "Robot buddy that waves", mode: "new", forKids: true,
    blurb: "Waves its arm and speaks in a robot voice when you clap.",
    parts: ["esp32", "amp", "speaker", "servo", "soundsensor", "ring", "usb"],
    rules: [
      { when: "sound", then: "move" },
      { when: "sound", then: "say", text: "Hello human. I am your robot friend." },
      { when: "start", then: "light", color: "#46e2ff" },
    ],
  },
  {
    id: "night-light", category: "Home", name: "Motion night light", mode: "new",
    blurb: "Glows softly when someone walks past in the dark.",
    parts: ["nano", "pir", "light", "ring", "usb"],
    rules: [{ when: "motion", then: "light", color: "#ffb35c" }, { when: "dark", then: "light", color: "#ff9a3c" }],
  },
  {
    id: "doorbell", category: "Home", name: "Talking doorbell", mode: "new",
    blurb: "Press the button and it announces a visitor in your own recorded voice.",
    parts: ["esp32", "button", "player", "speaker", "ring", "usb"],
    rules: [{ when: "button", then: "say", text: "Someone is at the door!" }, { when: "button", then: "light", color: "#3ee8a0" }],
  },
  {
    id: "weather", category: "Home", name: "Room weather station", mode: "new",
    blurb: "Shows temperature and humidity, and beeps if the room gets too hot.",
    parts: ["esp32", "temp", "oled", "buzzer", "usb"],
    rules: [{ when: "hot", then: "show", text: "Too hot!" }, { when: "hot", then: "beep" }],
  },
  {
    id: "plant", category: "Garden", name: "Self-watering plant", mode: "new",
    blurb: "Checks the soil and waters the plant for a few seconds when it's dry.",
    parts: ["esp32", "soil", "pump", "oled", "usb"],
    rules: [{ when: "dry", then: "pump" }, { when: "dry", then: "show", text: "Watering" }],
  },
  {
    id: "feeder", category: "Pets", name: "Pet treat dispenser", mode: "new",
    blurb: "Press a button and a flap opens to drop a treat.",
    parts: ["esp32", "button", "servo", "buzzer", "usb"],
    rules: [{ when: "button", then: "beep" }, { when: "button", then: "move" }],
  },
  {
    id: "drawer-alarm", category: "Safety", name: "Drawer or door alarm", mode: "new",
    blurb: "Beeps when a drawer, cupboard or door is opened.",
    parts: ["nano", "reed", "buzzer", "aa3", "boost5", "switch"],
    rules: [{ when: "open", then: "beep" }],
  },
  {
    id: "parking", category: "Vehicles", name: "Parking distance helper", mode: "new",
    blurb: "Lights turn red and it beeps when the car is close to the wall.",
    parts: ["nano", "distance", "strip", "buzzer", "usb"],
    rules: [{ when: "near", then: "light", color: "#ff4d4d" }, { when: "near", then: "beep" }],
  },
  {
    id: "bike-alarm", category: "Vehicles", name: "Bike shake alarm", mode: "new",
    blurb: "Flashes and beeps if someone moves your parked bike.",
    parts: ["esp32", "motion6", "buzzer", "ring", "lipo", "boost5", "switch"],
    rules: [{ when: "shake", then: "beep" }, { when: "shake", then: "light", color: "#ff4d4d" }],
  },
];

export function fromTemplate(t: Template): Project {
  const p = emptyProject(t.mode);
  const parts: Placed[] = [];
  for (const id of t.parts) parts.push({ uid: uid(), id, ...freeSpot(parts) });
  return {
    ...p, name: t.name, template: t.id, parts,
    rules: t.rules.map((r) => ({ ...r, id: uid("r") })),
    product: { ...p.product, forKids: !!t.forKids, what: t.what ?? "", does: t.does ?? "", power: t.power ?? p.product.power },
  };
}

// --- the assistant's suggestion from a goal ---------------------------------------------------------------

interface Want { re: RegExp; parts: string[]; why: string }

/** English keywords for now: other languages fall back to templates and the parts list. */
const WANTS: Want[] = [
  { re: /\b(talk|talks|talking|speak|speaks|say|says|voice|sing|sings|story|stories|answer|chat|conversation|tell)\b/, parts: ["player", "speaker"], why: "MP3 voice player and speaker, so it can talk in a real recorded voice" },
  { re: /\b(listen\w*|hear|hears|hearing|voice command|respond|reply|replies|clap|claps|noise|sound)\b/, parts: ["mic"], why: "a microphone, so it notices when you speak or clap" },
  { re: /\b(glow\w*|light|lights|lighting|lit|colou?r\w*|led|leds|shine\w*|rainbow|lamp)\b/, parts: ["ring"], why: "colour lights that can glow and animate" },
  { re: /\b(touch|touched|pat|hug|hugged|tap|tapped|stroke|tickle)\b/, parts: ["touch"], why: "a touch pad hidden under the surface" },
  { re: /\b(button|press|pressed|push)\b/, parts: ["button"], why: "a button to press" },
  { re: /\b(motion|someone (walks|comes|enters)|presence|visitor|walk past|movement|intruder)\b/, parts: ["pir"], why: "a motion sensor that notices people nearby" },
  { re: /\b(dark|night|bedtime|sunset)\b/, parts: ["light"], why: "a light sensor that knows when it's dark" },
  { re: /\b(plant|plants|soil|garden|water(ing)?|pot)\b/, parts: ["soil", "pump"], why: "a soil sensor and a small pump to water it" },
  { re: /\b(distance|park|parking|close|near|obstacle|how far|wall)\b/, parts: ["distance"], why: "a distance sensor" },
  { re: /\b(shake|shaken|tilt|fall|falls|dropped|bike|cycle|knock)\b/, parts: ["motion6"], why: "a shake and tilt sensor" },
  { re: /\b(door|drawer|lid|cupboard|box opens|window)\b/, parts: ["reed"], why: "a magnet switch that notices it opening" },
  { re: /\b(temperature|temp|hot|cold|weather|humid|humidity)\b/, parts: ["temp"], why: "a temperature and humidity sensor" },
  { re: /\b(screen|display|show|shows|readout|text)\b/, parts: ["oled"], why: "a small screen" },
  { re: /\b(wave|waves|arm|nod|flap|feeder|feed|treat|dispense|move|moves|moving|dance)\b/, parts: ["servo"], why: "a small motor arm that can wave or open a flap" },
  { re: /\b(vibrate|vibrates|vibration|rumble)\b/, parts: ["vibe"], why: "a vibration motor" },
  { re: /\b(beep|beeps|alarm|alert|buzz|buzzer|warn)\b/, parts: ["buzzer"], why: "a buzzer for beeps and alarms" },
];

const TRIGGER_FOR: Record<string, Trigger> = { touch: "touch", button: "button", mic: "sound", soundsensor: "sound", pir: "motion", light: "dark", soil: "dry", distance: "near", motion6: "shake", reed: "open", temp: "hot" };
const ACTION_FOR: Record<string, Action> = { player: "say", amp: "say", ring: "light", strip: "light", led: "light", buzzer: "beep", servo: "move", pump: "pump", vibe: "vibrate", oled: "show", relay: "switch" };

export interface Suggestion { project: Project; reasons: string[]; template?: Template }

export function suggest(goal: string, base?: Project): Suggestion {
  const g = ` ${goal.toLowerCase()} `;
  const kids = /\b(toy|toys|kid|kids|child|children|baby|son|daughter|plush|teddy|doll)\b/.test(g) || !!base?.product.forKids;
  const upgrade = /\b(my|existing|already|i have|old|turn (my|the|this|it)|make (my|it|this|the))\b/.test(g) || base?.mode === "upgrade";
  const portable = kids || /\b(battery|portable|carry|wear|bike|cycle|outdoor)\b/.test(g);

  const ids: string[] = [];
  const reasons: string[] = [];
  for (const w of WANTS) {
    if (w.re.test(g)) {
      const fresh = w.parts.filter((p) => !ids.includes(p));
      if (fresh.length) { ids.push(...fresh); reasons.push(w.why); }
    }
  }
  // nothing recognised: say so rather than guess at a pile of parts
  if (!ids.length) return { project: base ?? emptyProject(upgrade ? "upgrade" : "new"), reasons: [] };

  // something has to react to: if it only acts, give it a trigger
  const triggers = ids.filter((id) => TRIGGER_FOR[id]);
  const actions = ids.filter((id) => ACTION_FOR[id]);
  if (!triggers.length) { ids.push(kids ? "touch" : "button"); reasons.push(kids ? "a touch pad to wake it up" : "a button to start it"); }
  if (!actions.length) { ids.push("ring"); reasons.push("lights, so you can see it react"); }

  ids.unshift("esp32");
  reasons.unshift("an ESP32 board as the brain");
  if (portable) { ids.push("aa3", "boost5", "switch"); reasons.push("AA batteries with a 5 V booster and a switch"); }
  else { ids.push("usb"); reasons.push("USB power"); }

  const project = base ? { ...base } : emptyProject(upgrade ? "upgrade" : "new");
  project.goal = goal.slice(0, 400);
  project.product = { ...project.product, forKids: kids };
  if (!project.name) project.name = goal.length <= 40 ? capital(goal) : "My project";
  const parts: Placed[] = [...project.parts];
  for (const id of ids) if (!parts.some((p) => p.id === id)) parts.push({ uid: uid(), id, ...freeSpot(parts) });
  project.parts = parts;
  project.rules = autoRules(project, goal);
  return { project, reasons };
}

/** Pair every sensor with something to do, and every output with something that sets it off. */
export function autoRules(project: Project, goal = ""): Rule[] {
  const rules = [...project.rules];
  const ids = project.parts.map((p) => p.id);
  const trig = [...new Set(ids.map((id) => TRIGGER_FOR[id]).filter(Boolean))];
  const acts = [...new Set(ids.map((id) => ACTION_FOR[id]).filter(Boolean))];
  const covered = (t?: Trigger, a?: Action) => rules.some((r) => (!t || r.when === t) && (!a || r.then === a));
  const phrase = (t: Trigger) =>
    t === "touch" ? "Hello! That tickles." : t === "sound" ? "I heard you!" : t === "button" ? "Hello!" :
    t === "motion" ? "Hi there!" : t === "open" ? "Who opened me?" : t === "dark" ? "Good night!" : "Hello!";
  const make = (when: Trigger, then: Action): Rule => ({
    id: uid("r"), when, then,
    text: then === "say" ? phrase(when) : then === "show" ? (when === "dry" ? "Watering" : when === "hot" ? "Too hot!" : "Hello!") : undefined,
    color: then === "light" ? (when === "near" || when === "shake" || when === "open" ? "#ff4d4d" : when === "sound" ? "#46e2ff" : "#ffb35c") : undefined,
  });
  const PREFER: Action[] = ["say", "light", "beep", "move", "show", "vibrate", "pump", "switch"];
  acts.sort((a, b) => PREFER.indexOf(a) - PREFER.indexOf(b));
  for (const t of trig) {
    if (covered(t)) continue;
    // each sensor gets up to two reactions; the pump only ever answers dry soil
    const fits = acts.filter((a) => (a === "pump") === (t === "dry") || (t === "dry" && a === "show"));
    for (const a of fits.slice(0, 2)) rules.push(make(t, a));
  }
  for (const a of acts) {
    if (covered(undefined, a)) continue;
    const t = trig.find((x) => !(a === "pump" && x !== "dry")) ?? (a === "light" || a === "say" ? "start" : undefined);
    if (t) rules.push(make(t, a));
  }
  void goal;
  return rules.slice(0, 12);
}

const capital = (s: string) => s.trim().replace(/^./, (c) => c.toUpperCase()).replace(/[.!?]+$/, "");
export const TRIGGER_OF = TRIGGER_FOR;
export const ACTION_OF = ACTION_FOR;
export { ACTIONS, TRIGGERS };
