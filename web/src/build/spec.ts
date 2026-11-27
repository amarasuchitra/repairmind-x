/**
 * The engineering spec sheet: every number the build engine works out, with the formula and the inputs that give
 * it, so a person (or a reviewer) can check each one by hand. Nothing here is estimated separately: it reads the
 * engine's own report and constants, so the sheet and the checks can never disagree.
 */
import { BOOST_EFF, SPACE, USABLE, type Report } from "./engine.ts";

export type Verdict = "ok" | "tight" | "over" | "info";

export interface SpecRow {
  key: string;
  /** what is measured */
  label: string;
  /** the result, with its unit */
  value: string;
  /** the formula in symbols */
  formula: string;
  /** the formula with this project's numbers put in */
  working: string;
  verdict: Verdict;
  /** what it means, in one sentence */
  note: string;
}

export interface SpecGroup { id: "power" | "battery" | "fit" | "cost"; title: string; rows: SpecRow[] }

const n = (x: number, d = 0) => (Math.round(x * 10 ** d) / 10 ** d).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** a load against a limit: up to 80% is fine, up to 100% is tight, past it is over */
const load = (used: number, limit: number): Verdict => (limit <= 0 ? "info" : used > limit ? "over" : used > limit * 0.8 ? "tight" : "ok");

export function specSheet(r: Report): SpecGroup[] {
  const groups: SpecGroup[] = [];
  const src = r.source;
  const sum = (rail: string, k: "mA" | "peakmA") => r.budget.filter((b) => b.rail === rail).reduce((s, b) => s + b[k], 0);
  const i5 = sum("5 V", "mA") + sum("pin", "mA"), p5 = sum("5 V", "peakmA") + sum("pin", "peakmA");
  const i3 = sum("3.3 V", "mA"), p3 = sum("3.3 V", "peakmA");
  const boosted = !!src && r.boost && src.kind === "battery" && r.rail5?.[0] === 5;

  // --- power ------------------------------------------------------------------------------------------------
  const power: SpecRow[] = [];
  if (r.budget.length) {
    const list = r.budget.map((b) => `${n(b.mA)}`).join(" + ");
    power.push({
      key: "i_typ", label: "Typical current on the 5 V side", value: `${n(i5 + i3)} mA`,
      formula: "I = Σ I_part (3.3 V parts are fed from 5 V through the board's regulator)",
      working: `${list} = ${n(i5 + i3)} mA`, verdict: "info",
      note: "Everything idling or doing its usual job at once.",
    });
    power.push({
      key: "i_peak", label: "Peak current on the 5 V side", value: `${n(p5 + p3)} mA`,
      formula: "I_peak = Σ I_peak,part",
      working: `${r.budget.map((b) => n(b.peakmA)).join(" + ")} = ${n(p5 + p3)} mA`, verdict: "info",
      note: "Every part at full power in the same instant: the worst case the supply must survive.",
    });
    if (r.board && p3 > 0) {
      power.push({
        key: "reg3", label: "3.3 V regulator load", value: `${n(p3)} of ${n(r.board.max3v3mA)} mA (${pct(p3 / r.board.max3v3mA)})`,
        formula: "load = I_peak,3.3V ÷ I_max,regulator",
        working: `${n(p3)} ÷ ${n(r.board.max3v3mA)} = ${pct(p3 / r.board.max3v3mA)}`, verdict: load(p3, r.board.max3v3mA),
        note: "Above 80% the regulator runs hot; above 100% the 3.3 V parts brown out.",
      });
    }
  }
  if (src && r.budget.length) {
    if (boosted) {
      power.push({
        key: "i_batt", label: "Current from the battery (through the 5 V booster)", value: `${n(r.draw.mA)} mA typical, ${n(r.draw.peakmA)} mA peak`,
        formula: "I_batt = I_5V × 5 V ÷ (V_batt × η)",
        working: `${n(i5 + i3)} × 5 ÷ (${n(src.v[0], 1)} × ${BOOST_EFF}) = ${n(r.draw.mA)} mA`, verdict: "info",
        note: `A booster trades current for voltage: the battery gives more current than the parts take, plus ${pct(1 - BOOST_EFF)} lost as heat.`,
      });
    }
    power.push({
      key: "src_margin", label: `Peak against what the ${src.kind === "usb" ? "USB supply" : "battery"} can give`, value: `${n(r.draw.peakmA)} of ${n(src.maxmA)} mA (${pct(r.draw.peakmA / src.maxmA)})`,
      formula: "load = I_peak,source ÷ I_max,source",
      working: `${n(r.draw.peakmA)} ÷ ${n(src.maxmA)} = ${pct(r.draw.peakmA / src.maxmA)}`, verdict: load(r.draw.peakmA, src.maxmA),
      note: "Past 100% the voltage dips in bursts and the board can restart.",
    });
    const v = boosted ? src.v[0] : r.rail5?.[0] ?? src.v[0];
    power.push({
      key: "p", label: "Power drawn", value: `${n((v * r.draw.mA) / 1000, 2)} W typical, ${n((v * r.draw.peakmA) / 1000, 2)} W peak`,
      formula: "P = V × I",
      working: `${n(v, 1)} V × ${n(r.draw.mA)} mA = ${n((v * r.draw.mA) / 1000, 2)} W`, verdict: "info",
      note: "Below about 1 W nothing inside gets noticeably warm.",
    });
  }
  if (r.board && r.rail5) {
    const [, lo, hi] = r.rail5;
    power.push({
      key: "rail", label: src?.kind === "battery" ? "Supply voltage over the battery's life" : "Supply voltage range", value: `${n(lo, 2)} to ${n(hi, 2)} V`,
      formula: "V_min ≥ V_board,min",
      working: `${n(lo, 2)} V against the ${r.board.name.split(" ")[0]}'s ${n(r.board.minIn, 2)} V minimum`, verdict: lo >= r.board.minIn ? "ok" : "over",
      note: lo >= r.board.minIn
        ? (src?.kind === "battery" ? "The board keeps running until the battery is flat." : "Within what the board accepts, even at the low end of the supply's tolerance.")
        : (src?.kind === "battery" ? "Near the end of the battery the board will keep restarting." : "At the low end of the supply's tolerance the board can restart."),
    });
  }
  if (power.length) groups.push({ id: "power", title: "Power", rows: power });

  // --- battery ----------------------------------------------------------------------------------------------
  if (src?.kind === "battery" && r.hours != null) {
    const peakH = r.draw.peakmA > 0 ? (src.mAh * USABLE) / r.draw.peakmA : null;
    groups.push({
      id: "battery", title: "Battery life", rows: [
        {
          key: "life", label: "Running time on a full battery", value: hoursText(r.hours),
          formula: `t = C × ${USABLE} ÷ I_batt`,
          working: `${n(src.mAh)} mAh × ${USABLE} ÷ ${n(r.draw.mA)} mA = ${n(r.hours, 1)} h`, verdict: r.hours < 2 ? "tight" : "ok",
          note: `Only about ${pct(USABLE)} of the rated capacity is usable before the voltage sags too far.`,
        },
        ...(peakH ? [{
          key: "life_min", label: "Running time if everything stays at full power", value: hoursText(peakH),
          formula: `t_min = C × ${USABLE} ÷ I_peak`,
          working: `${n(src.mAh)} × ${USABLE} ÷ ${n(r.draw.peakmA)} = ${n(peakH, 1)} h`, verdict: "info" as Verdict,
          note: "The floor: real use sits between this and the typical figure.",
        }] : []),
      ],
    });
  }

  // --- fit --------------------------------------------------------------------------------------------------
  if (r.fit.partsVolume > 0) {
    const f = r.fit;
    const rows: SpecRow[] = [{
      key: "vol", label: "Volume of the parts", value: `${n(f.partsVolume, 1)} cm³`,
      formula: "V = Σ (l × w × h)", working: `sum of each part's box = ${n(f.partsVolume, 1)} cm³`, verdict: "info",
      note: "The parts' own outer boxes, before wires and mounting.",
    }];
    if (f.innerVolume) {
      const need = f.partsVolume * SPACE;
      rows.push({
        key: "fill", label: f.box ? `Space needed against the ${f.box.name}` : "Space needed against the room inside", value: `${n(need, 1)} of ${n(f.innerVolume, 1)} cm³ (${pct(need / f.innerVolume)})`,
        formula: `V_needed = V_parts × ${SPACE}`,
        working: `${n(f.partsVolume, 1)} × ${SPACE} = ${n(need, 1)} cm³; ${n(need, 1)} ÷ ${n(f.innerVolume, 1)} = ${pct(need / f.innerVolume)}`,
        verdict: f.state === "no" ? "over" : f.state === "tight" ? "tight" : "ok",
        note: "Wires, air and mounting take about as much room again as the parts.",
      });
    }
    if (f.tooBig.length) rows.push({ key: "toobig", label: "Too long for the space", value: f.tooBig.join(", "), formula: "each side ≤ the matching inner side", working: "largest side against largest room, and so on", verdict: "over", note: "These need to sit outside, in a base or a separate box." });
    groups.push({ id: "fit", title: "Fit", rows });
  }

  // --- cost -------------------------------------------------------------------------------------------------
  if (r.bom.length) {
    groups.push({
      id: "cost", title: "Cost", rows: [{
        key: "cost", label: "Parts cost", value: `₹${n(r.totalInr)}`,
        formula: "cost = Σ qty × unit price",
        working: r.bom.map((b) => (b.qty > 1 ? `${b.qty}×${n(b.each)}` : n(b.each))).join(" + ") + ` = ₹${n(r.totalInr)}`,
        verdict: "info", note: "Typical Indian online prices; shipping not included.",
      }],
    });
  }
  return groups;
}

export function hoursText(h: number): string {
  if (h >= 48) return `about ${n(h / 24, 1)} days`;
  if (h >= 1) return `about ${n(h, 1)} hours`;
  return `about ${n(h * 60)} minutes`;
}

/** The sheet as Markdown, for the project folder. */
export function specMarkdown(name: string, groups: SpecGroup[]): string {
  const mark: Record<Verdict, string> = { ok: "OK", tight: "Tight", over: "Over", info: "" };
  return [
    `# Engineering spec: ${name}`, "",
    "Every number below is worked out from the parts' datasheet figures. Each line shows the formula and the working, so you can check it by hand.", "",
    ...groups.flatMap((g) => [
      `## ${g.title}`, "",
      "| Quantity | Value | Formula | Working | Check |", "|---|---|---|---|---|",
      ...g.rows.map((x) => `| ${x.label} | **${x.value}** | ${x.formula} | ${x.working} | ${mark[x.verdict]} |`), "",
    ]),
  ].join("\n");
}
