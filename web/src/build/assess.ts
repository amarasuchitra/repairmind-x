/**
 * The idea assistant's answer: what the thing is, whether each wish can be built and why, and a staged plan.
 * Same shape as agent/repairmind/upgrade/schema.py. The server's AI analyst fills it; when no AI model is
 * configured, `offlineAssess` fills it from built-in product knowledge and the parts checker, so the flow
 * still works (with fewer insights).
 */
import { analyze } from "./engine.ts";
import { ALL } from "./parts.ts";
import { ACTIONS, TRIGGERS, emptyProject, uid, type Placed, type Project, type Rule } from "./project.ts";
import { autoRules, suggest } from "./templates.ts";
import { freeSpot } from "./engine.ts";

export type Verdict = "possible" | "possible_with_changes" | "not_possible";
export type Overall = "go" | "go_with_changes" | "not_recommended";
export type FactorKind = "physics" | "power" | "space" | "cost" | "safety" | "skill" | "legal";

export interface Assessment {
  product: {
    kind: "existing" | "new";
    name: string; category: string; how_it_works: string;
    power: "battery" | "usb" | "wall" | "none" | "unknown"; power_detail: string;
    inside: { name: string; purpose: string; confidence: "seen" | "likely" | "guess" }[];
    space: string; inner_mm: number[]; for_kids: boolean; hazards: string[]; can_open: string;
  };
  wishes: {
    wish: string; verdict: Verdict; why: string;
    factors: { kind: FactorKind; verdict: "ok" | "concern" | "blocker"; text: string }[];
    how: string; alternative: string; effort: "easy" | "moderate" | "hard"; cost_inr: number;
  }[];
  overall: Overall;
  overall_why: string;
  plan: {
    summary: string; reuse: string; steps: string[];
    parts: { id: string; why: string }[];
    rules: { when: string; then: string; text: string; color: string }[];
    other_parts: { name: string; why: string; price_inr: number }[];
    stages: { name: string; goal: string; tasks: string[]; weeks: number }[];
    warnings: string[];
  };
  restated: string;
  questions: { q: string; why: string; options: string[] }[];
  design_lab: boolean;
  /** three ranked product directions; the plan builds the first (missing from older or offline answers) */
  concepts?: Concept[];
}

export interface Concept {
  title: string; pitch: string; for_user: string; tech: string; new_because: string;
  parts: string[]; cost_inr: number; effort: "easy" | "moderate" | "hard"; risk: string;
}

export interface IdeaInput {
  idea: string;
  /** what they already have; empty for a new invention */
  product: string;
  forKids: boolean;
  answers: { q: string; a: string }[];
  attachment_ids: string[];
}

/** The parts, triggers and actions the analyst may use, sent with each request. */
export function catalogForServer() {
  return {
    catalog: ALL.map((p) => ({
      id: p.id, name: p.name, plain: p.plain, category: p.category,
      volts: p.volts ? `${p.volts[0]}–${p.volts[1]} V` : "", ma: p.mA ? `${p.mA}/${p.peakmA}` : "", price_inr: p.priceInr,
    })),
    triggers: TRIGGERS.map((x) => ({ id: x.id, label: x.label })),
    actions: ACTIONS.map((x) => ({ id: x.id, label: x.label })),
  };
}

/** Turn the plan into a project on the canvas: the parts it names, its reactions, and what we know of the product. */
export function toProject(a: Assessment, input: IdeaInput): Project {
  const p = emptyProject(a.product.kind === "existing" ? "upgrade" : "new");
  const parts: Placed[] = [];
  for (const x of a.plan.parts) if (ALL.some((c) => c.id === x.id)) parts.push({ uid: uid(), id: x.id, ...freeSpot(parts) });
  const rules: Rule[] = a.plan.rules
    .filter((r) => TRIGGERS.some((t) => t.id === r.when) && ACTIONS.some((x) => x.id === r.then))
    .map((r) => ({ id: uid("r"), when: r.when as Rule["when"], then: r.then as Rule["then"], text: r.text || undefined, color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : undefined }));
  const inner = a.product.inner_mm.length === 3 && a.product.inner_mm.every((n) => n > 0) ? (a.product.inner_mm.map(Math.round) as [number, number, number]) : null;
  const project: Project = {
    ...p, name: a.product.name.slice(0, 80), goal: input.idea.slice(0, 400), parts,
    product: { what: a.product.name.slice(0, 120), does: a.product.how_it_works.slice(0, 200), forKids: input.forKids || a.product.for_kids, power: a.product.power === "unknown" ? "none" : a.product.power, inner },
    rules,
  };
  return rules.length ? project : { ...project, rules: autoRules(project) };
}

// --- offline: built-in product knowledge ---------------------------------------------------------------

interface Known {
  re: RegExp; category: string; how: string; power: Assessment["product"]["power"]; powerDetail: string;
  inside: string[]; space: string; hazards: string[]; open: string; kids?: boolean;
  /** internal changes are off limits */ red?: string;
}

const KNOWN: Known[] = [
  { re: /\b(plush|soft toy|teddy|stuffed|doll)\b/, category: "soft toy", how: "A fabric shell with stuffing; light-up ones have a small battery pack and LEDs inside.", power: "battery", powerDetail: "usually 2–3 AA or AAA cells, 3–4.5 V", inside: ["battery box", "an LED or two with a resistor", "a push switch"], space: "A pocket or the stuffing around the battery pack; soft, so parts must be wrapped in a small box.", hazards: ["small parts if anything comes loose"], open: "Usually a Velcro pocket or a sewn seam", kids: true },
  { re: /\b(toy|robot toy|action figure|car toy|toy car)\b/, category: "plastic toy", how: "A plastic shell held by small screws, with a battery box and simple electronics.", power: "battery", powerDetail: "usually 2–4 AA cells", inside: ["battery box", "a small circuit board", "LEDs or a buzzer"], space: "Some room inside the shell; check around the battery box.", hazards: ["small parts"], open: "Small Phillips screws, sometimes under stickers", kids: true },
  { re: /\b(lamp|night ?light|light bulb|lantern)\b/, category: "lamp", how: "A light source and a switch, run from mains or from batteries/USB.", power: "unknown", powerDetail: "mains 230 V for plug-in lamps; batteries or USB for small ones", inside: ["LED or bulb", "switch", "a driver or adapter"], space: "The base usually has room.", hazards: ["mains voltage in plug-in lamps"], open: "Screws under the base" },
  { re: /\b(fan|cooler)\b/, category: "fan", how: "A motor spins blades; table fans run from mains.", power: "wall", powerDetail: "mains 230 V", inside: ["motor", "speed switch", "capacitor"], space: "The base has some room, but it shares it with mains wiring.", hazards: ["mains voltage", "moving blades"], open: "Screws on the base and the motor housing" },
  { re: /\b(speaker|radio)\b/, category: "speaker", how: "An amplifier drives a speaker from batteries, USB or mains.", power: "unknown", powerDetail: "varies", inside: ["amplifier board", "speaker", "battery or adapter"], space: "Little spare room; the box is tuned for sound.", hazards: [], open: "Screws or clips" },
  { re: /\b(bicycle|bike|cycle|scooter)\b/, category: "bicycle", how: "Pedal power; electronics mount on the frame or handlebar.", power: "none", powerDetail: "no power today", inside: ["frame", "handlebar", "seat post"], space: "Mount a small waterproof box on the frame or handlebar.", hazards: ["water", "vibration", "road safety"], open: "Nothing to open: mount outside" },
  { re: /\b(plant|pot|planter|garden)\b/, category: "plant pot", how: "Soil and water; no electronics today.", power: "none", powerDetail: "no power today", inside: [], space: "Electronics go in a small box beside or under the pot.", hazards: ["water near electronics"], open: "Nothing to open" },
  { re: /\b(box|drawer|cupboard|door|cabinet|jewel)\b/, category: "box or door", how: "A container with a lid or door.", power: "none", powerDetail: "no power today", inside: [], space: "Room inside the box or on the frame for a small module.", hazards: [], open: "Nothing to open" },
  { re: /\b(helmet|bag|backpack|jacket|glove|shoe|wearable)\b/, category: "wearable", how: "Worn on the body; electronics must be light, flat and comfortable.", power: "none", powerDetail: "no power today", inside: [], space: "Flat pockets or the outer shell.", hazards: ["heat against skin", "lithium cells worn on the body"], open: "Pockets, seams or padding" },
  { re: /\b(clock|watch|alarm clock)\b/, category: "clock", how: "A quartz movement on one AA cell, or a digital clock board.", power: "battery", powerDetail: "1 AA, 1.5 V", inside: ["quartz movement or clock board"], space: "Behind the face there is a little room.", hazards: [], open: "Back cover clips or screws" },
  { re: /\b(microwave|oven|heater|iron|kettle|geyser|induction|hair ?dryer|toaster)\b/, category: "heating appliance", how: "Mains-powered heating.", power: "wall", powerDetail: "mains 230 V, high power", inside: ["heating element or magnetron", "thermal cut-outs", "mains wiring"], space: "Not to be used.", hazards: ["mains voltage", "high heat", "stored charge (microwave)"], open: "Do not open", red: "It is a mains heating appliance: opening or modifying it can kill or start a fire." },
  { re: /\b(car|motorbike|motorcycle|vehicle)\b/, category: "vehicle", how: "A vehicle with its own 12 V electrical system.", power: "battery", powerDetail: "12 V vehicle battery", inside: ["vehicle wiring", "fuse box"], space: "Inside the cabin, as a separate gadget.", hazards: ["vehicle electrics", "road safety and the law"], open: "Don't modify vehicle wiring; use a USB socket", red: "Changes to a vehicle's wiring, brakes or lights affect road safety and may be illegal." },
];

const IMPOSSIBLE: { re: RegExp; why: string; alt: string }[] = [
  { re: /\b(fly|flying|hover|levitate|float in the air)\b/, why: "Flight needs strong motors, propellers and a very light frame; small add-on parts in an existing object can't lift it.", alt: "Make it look alive with lights, sound and a moving arm, or build a separate small drone kit." },
  { re: /\b(perpetual|never needs? (charging|power|batteries)|free energy|power itself forever)\b/, why: "Every gadget uses energy; nothing runs forever without a source.", alt: "Use a small solar panel with a rechargeable cell, or a USB supply." },
  { re: /\b(teleport|invisible|time travel|read (my )?mind)\b/, why: "That isn't possible with today's physics or electronics.", alt: "Tell me the effect you want people to feel, and I'll suggest something buildable." },
  { re: /\b(cool(s|ing)? (the )?(room|it down)|air ?condition|freeze|refrigerat)\w*/, why: "Real cooling needs a compressor or a large Peltier with big power; small batteries can't cool a room.", alt: "A small USB fan, or a temperature display that tells you when to cool it." },
  { re: /\b(lift (a )?(person|me|car)|carry (a )?person|exoskeleton|super strength)\b/, why: "Lifting people needs large motors, strong frames and serious safety engineering, far beyond hobby parts.", alt: "Start with a scale model, or a powered arm that lifts a light object, and take the full version to the design lab." },
];

const CONVERSATION = /\b(talk (back|with|to me)|conversation|chat|understand (me|what i say)|answer (my )?questions|like alexa|like siri|assistant)\b/;

function splitWishes(idea: string): string[] {
  return idea.split(/\s*(?:,|;|\n|\band also\b|\balso\b|\band\b(?= (?:make|let|it|have|when|add)))\s*/i).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 6);
}

/** A first pass without an AI model: product knowledge, keyword-matched wishes and the parts checker. */
export function offlineAssess(input: IdeaInput): Assessment {
  const text = `${input.product} ${input.idea}`.toLowerCase();
  const existing = input.product.trim().length > 0;
  const known = KNOWN.find((k) => k.re.test(input.product.toLowerCase())) ?? KNOWN.find((k) => k.re.test(text));
  const answer = (k: RegExp) => input.answers.find((x) => k.test(x.q.toLowerCase()))?.a.toLowerCase() ?? "";
  const forKids = input.forKids || /child/.test(answer(/who/)) || /\b(kids?|child|children|son|daughter|baby)\b/.test(text);
  const wantsUsb = /usb|plug/.test(answer(/power/));

  const s = suggest(`${input.idea} ${forKids ? "for my kid" : ""} ${wantsUsb ? "" : known?.power === "battery" || /portable|carry|wear/.test(text) ? "portable" : ""}`);
  let project = s.project;
  project = { ...project, mode: existing ? "upgrade" : "new", product: { ...project.product, forKids, power: known?.power === "unknown" ? "none" : known?.power ?? "none", what: input.product || project.name } };
  if (wantsUsb) project = { ...project, parts: project.parts.filter((p) => !["aa3", "boost5", "switch"].includes(p.id)) };
  if (wantsUsb && !project.parts.some((p) => p.id === "usb")) project.parts = [...project.parts, { uid: uid(), id: "usb", ...freeSpot(project.parts) }];
  const report = project.parts.length ? analyze(project) : null;

  const wishes: Assessment["wishes"] = splitWishes(input.idea).map((w) => {
    const lw = w.toLowerCase();
    const imp = IMPOSSIBLE.find((x) => x.re.test(lw));
    if (imp) return { wish: w, verdict: "not_possible", why: imp.why, factors: [{ kind: "physics", verdict: "blocker", text: imp.why }], how: "", alternative: imp.alt, effort: "hard", cost_inr: 0 };
    if (known?.red) return { wish: w, verdict: "not_possible", why: known.red, factors: [{ kind: "safety", verdict: "blocker", text: known.red }], how: "", alternative: "Build it as a separate battery- or USB-powered gadget that sits next to it and never connects to it.", effort: "hard", cost_inr: 0 };
    const one = suggest(w);
    if (!one.reasons.length) return { wish: w, verdict: "possible_with_changes", why: "I couldn't judge this one without the AI analyst. It may well be possible.", factors: [], how: "Connect an AI model (see the note above), or describe it with words like light, sound, talk, touch, move, motion, distance or temperature.", alternative: "", effort: "moderate", cost_inr: 0 };
    const conv = CONVERSATION.test(lw);
    const factors: Assessment["wishes"][number]["factors"] = [];
    if (report) {
      factors.push({ kind: "power", verdict: report.hours !== null && report.hours < 3 ? "concern" : "ok", text: report.hours !== null ? `About ${report.draw.mA} mA, so roughly ${report.hours.toFixed(1)} hours on a full battery.` : `About ${report.draw.mA} mA from USB.` });
      factors.push({ kind: "cost", verdict: "ok", text: `About ₹${report.totalInr.toLocaleString("en-IN")} for the whole build.` });
    }
    if (existing && known) factors.push({ kind: "space", verdict: "concern", text: `${known.space} Measure the free space to be sure.` });
    if (known?.hazards.length) factors.push({ kind: "safety", verdict: "concern", text: `Watch out for: ${known.hazards.join(", ")}.` });
    if (conv) factors.push({ kind: "physics", verdict: "concern", text: "Understanding words needs Wi-Fi and a speech service. Offline, it can react to your voice and answer with recorded lines." });
    const cost = one.project.parts.reduce((n, p) => n + (ALL.find((c) => c.id === p.id)?.priceInr ?? 0), 0);
    return {
      wish: w, verdict: conv ? "possible_with_changes" : "possible",
      why: conv ? "It can hear you and answer with recorded lines; a real conversation needs Wi-Fi and a speech service." : "Common, low-cost hobby parts do this reliably.",
      factors, how: `Add ${one.reasons.slice(1, 4).join(", ")}.`, alternative: "", effort: one.project.parts.length > 6 ? "moderate" : "easy", cost_inr: cost,
    };
  });

  const blocked = wishes.length > 0 && wishes.every((w) => w.verdict === "not_possible");
  const changes = wishes.some((w) => w.verdict !== "possible") || (report ? !report.ready : false);
  const questions: Assessment["questions"] = [
    ...(forKids ? [] : [{ q: "Who will use it?", why: "Changes the safety rules", options: ["A child", "Me or another adult", "Everyone at home"] }]),
    { q: "How should it be powered?", why: "Decides batteries, size and how long it runs", options: ["Batteries, so it's portable", "USB / plugged in"] },
    { q: "What's your budget?", why: "Decides which parts to use", options: ["Under ₹1,000", "₹1,000–3,000", "More is fine"] },
    ...(existing ? [{ q: "How much free space is inside, roughly?", why: "Decides what fits", options: ["Matchbox size", "Phone size", "Bigger", "Not sure"] }] : []),
  ].filter((q) => !input.answers.some((x) => x.q === q.q));

  return {
    product: {
      kind: existing ? "existing" : "new",
      name: existing ? input.product.slice(0, 80) : project.name || "Your idea",
      category: known?.category ?? (existing ? "product" : "new gadget"),
      how_it_works: known?.how ?? (existing ? "I don't know this kind of product yet; a photo or the AI analyst would help." : "A small brain reads sensors and drives lights, sound or motion."),
      power: known?.power ?? (existing ? "unknown" : wantsUsb ? "usb" : "battery"),
      power_detail: known?.powerDetail ?? "unknown",
      inside: (known?.inside ?? []).map((n) => ({ name: n, purpose: "", confidence: "likely" as const })),
      space: known?.space ?? "Unknown: measure it.", inner_mm: [], for_kids: forKids, hazards: known?.hazards ?? [], can_open: known?.open ?? "Unknown",
    },
    wishes,
    overall: blocked ? "not_recommended" : changes ? "go_with_changes" : "go",
    overall_why: blocked ? "None of the wishes can be done safely with small add-on electronics." : changes ? "Most of it can be built; some parts need changes or a closer look." : "All of it can be built with small, cheap parts.",
    plan: {
      summary: blocked ? "" : `Add ${s.reasons.join(", ")}.`,
      reuse: existing ? "Keep its case and what it already does; the new parts run alongside." : "",
      steps: blocked ? [] : ["Try it on the desk first, powered from USB", "Load the starter code", "Wire the parts one by one and test each", "Fit everything into the case", "Test every reaction"],
      parts: blocked ? [] : project.parts.map((p) => ({ id: p.id, why: "" })),
      rules: blocked ? [] : project.rules.map((r) => ({ when: r.when, then: r.then, text: r.text ?? "", color: r.color ?? "" })),
      other_parts: [],
      stages: blocked ? [] : [
        { name: "Desk prototype", goal: "Prove the idea works, wired loosely on a table", tasks: ["Buy the parts", "Upload the starter code", "Wire and test one part at a time"], weeks: 1 },
        { name: "Working model", goal: existing ? "Fit it inside and use it for a few days" : "Put it in a box and use it for a few days", tasks: ["Solder onto a small board", "Fit it in the case", "Tune the settings at the top of the code"], weeks: 1 },
        { name: "Finished product", goal: "Make it tidy, safe and reliable", tasks: ["Secure every part and wire", "Check the safety list", "Ask someone else to try it"], weeks: 1 },
      ],
      warnings: [...(known?.red ? [known.red] : []), ...(report?.issues.filter((i) => i.level === "warn").map((i) => i.text) ?? [])],
    },
    restated: existing ? `You have ${input.product.trim().replace(/^(a|an|my|the)\s+/i, "a ").replace(/[.!]+$/, "")}, and you want to: ${input.idea.trim().replace(/[.!]+$/, "")}.` : `You want to build: ${input.idea.trim().replace(/[.!]+$/, "")}.`,
    questions: questions.slice(0, 4),
    design_lab: /\b(arm|frame|wheel|lift|carry|structure|exoskeleton|drone|vehicle|cart|crane)\b/.test(text),
  };
}
