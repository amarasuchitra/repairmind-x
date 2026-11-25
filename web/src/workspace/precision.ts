/**
 * What makes a build precise enough to do on a real desk. These are the things the best hardware tools are good
 * at, put together and tied to the checker so they can't drift from the design:
 *
 * - A numbered wire-by-wire list with wire colours (Fritzing and Cirkit Designer show a picture; a list you tick
 *   off is what you actually build from, and each wire has a number the assistant and the photo check can name).
 * - Readings to expect with a multimeter, before and after power goes on (simulators like Wokwi and Tinkercad stop
 *   at the simulation; nothing tells you what your real circuit should read).
 * - A parts list with quantities, prices and shop links (Flux and Cirkit do this for PCBs; here for modules and
 *   breadboards, in rupees, with Indian shops).
 * - One build pack to download: wires, code, parts, steps and tests, as plain files that open anywhere.
 *
 * Pure functions over the checker's report, so the tests run them in Node.
 */
import type { Conn, Report } from "../build/engine.ts";
import type { Project } from "../build/project.ts";

export interface Wire {
  n: number;
  from: string;
  to: string;
  colour: string;
  kind: Conn["kind"];
  via?: string;
  /** one line, as it goes in the checklist and to the photo check */
  text: string;
}

const SIGNAL = ["yellow", "green", "blue", "white", "purple", "orange", "grey", "brown"];

/** The colour convention: red for + supply, black for ground, orange for 3.3 V, a different colour per signal. */
export function colourFor(kind: Conn["kind"], i: number): string {
  if (kind === "5v" || kind === "batt") return "red";
  if (kind === "3v3") return "orange";
  if (kind === "gnd") return "black";
  if (kind === "audio") return i % 2 ? "black" : "white";
  return SIGNAL[i % SIGNAL.length];
}

export function wireList(report: Report): Wire[] {
  let sig = 0;
  let aud = 0;
  return report.conns.map((c, i) => {
    const colour = c.kind === "signal" ? colourFor("signal", sig++) : c.kind === "audio" ? colourFor("audio", aud++) : colourFor(c.kind, 0);
    const from = `${c.from} ${c.fromPin}`.trim();
    const to = `${c.to} ${c.toPin}`.trim();
    return {
      n: i + 1, from, to, colour, kind: c.kind, via: c.via,
      text: `${from} → ${to} (${colour} wire${c.via ? `, through ${c.via}` : ""})`,
    };
  });
}

export interface Reading {
  when: "power off" | "power on";
  what: string;
  /** where to put the red and black probes */
  probes: string;
  expect: string;
  /** what it means if it's outside the range */
  ifNot: string;
}

const v = (x: number) => `${x.toFixed(2).replace(/\.?0+$/, "")} V`;

/** The readings a correct build gives. Ranges come from the parts' own data, not from the model. */
export function readings(report: Report): Reading[] {
  const out: Reading[] = [];
  const src = report.source;
  const board = report.board;
  out.push({
    when: "power off", what: "No short between supply and ground", probes: "Ohms setting: red on the board's 5V (or VIN), black on GND",
    expect: "more than 100 Ω (often several kΩ, rising as capacitors charge)",
    ifNot: "Near 0 Ω means a short: find the wire or part bridging + and ground before connecting power.",
  });
  if (src) {
    const [nom, low, high] = src.v;
    out.push({
      when: "power on", what: `${src.name.replace(/\s*\(.*\)/, "")} output`, probes: "DC volts: red on its + wire, black on its − wire",
      expect: src.kind === "usb" ? "4.75–5.25 V" : `${v(low)}–${v(high)} (about ${v(nom)} most of the time)`,
      ifNot: src.kind === "usb" ? "Below 4.75 V: try another cable or charger." : `Below ${v(low)}: the cells are flat or a contact is loose.`,
    });
  }
  if (report.boost) {
    out.push({
      when: "power on", what: "5 V booster output", probes: "DC volts: red on OUT+, black on OUT−", expect: "4.9–5.2 V",
      ifNot: "Above 5.3 V: turn the booster's trimmer back before connecting the board; it can destroy it. Below 4.8 V: check IN+ and IN−.",
    });
  }
  if (board) {
    out.push({
      when: "power on", what: `${board.name.replace(/\s*\(.*\)/, "")} supply pin`, probes: `DC volts: red on ${board.id === "esp32" ? "VIN" : "5V"}, black on GND`,
      expect: `${v(Math.max(board.minIn, 4.5))}–5.25 V`,
      ifNot: `Below ${v(board.minIn)} the board resets over and over (brownout): check the supply and the power wires.`,
    });
    if (report.conns.some((c) => c.kind === "3v3") || board.logic === 3.3) {
      out.push({
        when: "power on", what: "3.3 V pin", probes: "DC volts: red on 3V3, black on GND", expect: "3.2–3.4 V",
        ifNot: "Low: too much load on the board's 3.3 V regulator, or a short on the 3.3 V wires.",
      });
    }
  }
  if (report.draw.mA > 0) {
    const lo = Math.max(1, Math.round(report.draw.mA * 0.6));
    const hi = Math.round(report.draw.peakmA * 1.2);
    out.push({
      when: "power on", what: "Current from the supply", probes: "DC mA: meter in series in the + wire (move the red lead to the mA socket)",
      expect: `${lo}–${hi} mA (about ${Math.round(report.draw.mA)} mA idle, up to ${Math.round(report.draw.peakmA)} mA when everything runs)`,
      ifNot: `Far above ${hi} mA: something is shorted or a part is wired backwards; switch off at once.`,
    });
  }
  return out;
}

export interface BuyLine {
  name: string;
  qty: number;
  each: number;
  total: number;
  /** shop search links: no fixed product pages, which go stale */
  shops: { name: string; url: string }[];
}

const enc = (s: string) => encodeURIComponent(s.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim());

export function buyList(report: Report): { lines: BuyLine[]; total: number } {
  const lines = report.bom.map((b) => ({
    name: b.name, qty: b.qty, each: b.each, total: b.total,
    shops: [
      { name: "Robu", url: `https://robu.in/?s=${enc(b.name)}&post_type=product` },
      { name: "Amazon.in", url: `https://www.amazon.in/s?k=${enc(b.name)}` },
      { name: "Robocraze", url: `https://robocraze.com/search?q=${enc(b.name)}` },
    ],
  }));
  return { lines, total: report.totalInr };
}

const csvCell = (s: string | number) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

export function buyCsv(report: Report): string {
  const { lines, total } = buyList(report);
  return [
    "Part,Qty,Each (INR),Total (INR),Robu,Amazon.in",
    ...lines.map((l) => [l.name, l.qty, l.each, l.total, l.shops[0].url, l.shops[1].url].map(csvCell).join(",")),
    `Total,,,${total},,`,
  ].join("\n");
}

/** One Markdown file with everything needed to build it, readable on a phone at the workbench. */
export function buildPack(project: Project, report: Report, code: { name: string; code: string }): string {
  const name = project.name || "My project";
  const wires = wireList(report);
  const tests = readings(report);
  const { lines, total } = buyList(report);
  return [
    `# ${name}`,
    project.goal ? `\n${project.goal}` : "",
    `\nMade with RepairMind X on ${new Date().toISOString().slice(0, 10)}. Checks: ${report.ready ? "all passing" : "some still open, see the app"}.`,
    "\n## Parts to buy\n",
    "| Part | Qty | Each | Total |\n|---|---|---|---|",
    ...lines.map((l) => `| ${l.name} | ${l.qty} | ₹${l.each} | ₹${l.total} |`),
    `| **Total** | | | **₹${total}** |`,
    "\n## Wiring (tick each one off)\n",
    ...wires.map((w) => `- [ ] **${w.n}.** ${w.text}`),
    report.pinMap.length ? "\n## Board pins\n\n" + report.pinMap.map((p) => `- ${p.pin}: ${p.use}`).join("\n") : "",
    "\n## Before and after power: what your multimeter should read\n",
    ...tests.map((t) => `- **${t.what}** (${t.when}). ${t.probes}. Expect **${t.expect}**. ${t.ifNot}`),
    "\n## Build steps\n",
    ...report.steps.map((s, i) => `### ${i + 1}. ${s.title}\n\n${s.detail.map((d) => `- ${d}`).join("\n")}${s.safety?.length ? `\n\n> Safety: ${s.safety.join(" ")}` : ""}\n`),
    report.libs.length ? `\n## Arduino libraries\n\n${report.libs.map((l) => `- ${l}`).join("\n")}` : "",
    `\n## Code (${code.name}.ino)\n\nCompile it in the Arduino IDE before flashing.\n\n\`\`\`cpp\n${code.code}\n\`\`\``,
  ].filter(Boolean).join("\n");
}

/** Plain text for the assistant's next turn. */
export function wiresText(report: Report): string {
  return wireList(report).map((w) => `${w.n}. ${w.text}`).join("\n");
}
export function readingsText(report: Report): string {
  return readings(report).map((t) => `${t.what} (${t.when}): ${t.probes}; expect ${t.expect}.`).join("\n");
}
export function buyText(report: Report): string {
  const { lines, total } = buyList(report);
  return lines.map((l) => `${l.qty} × ${l.name} ₹${l.total}`).join("\n") + `\nTotal ₹${total}. Shop links shown on screen (Robu, Amazon.in, Robocraze).`;
}
