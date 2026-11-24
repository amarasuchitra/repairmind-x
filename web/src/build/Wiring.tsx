import type { Conn, Report } from "./engine.ts";
import { short } from "./engine.ts";
import { useI18n } from "../i18n";

/**
 * The wiring diagram, drawn from the checker's connection list: power on the left, the brain in the middle,
 * parts on the right, one coloured wire per connection.
 */
interface Box { name: string; x: number; y: number; w: number; h: number; left: string[]; right: string[] }

const ROW = 22;
const HEAD = 30;
const W = 740;

export function WiringDiagram({ report }: { report: Report }) {
  const { auto } = useI18n();
  const board = report.board;
  if (!board || !report.conns.length) return null;
  const B = short(board);
  const powerNames = new Set<string>();
  if (report.source) powerNames.add(short(report.source));
  if (report.conns.some((c) => c.from === "5 V booster")) powerNames.add("5 V booster");

  const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);
  const toBoard = report.conns.filter((c) => c.to === B);
  const fromParts = toBoard.filter((c) => !powerNames.has(c.from));
  const rank = (p: string) => (/5V|VIN/.test(p) ? 0 : p === "3V3" ? 1 : p === "GND" ? 2 : 3);
  const boardRight = uniq(fromParts.map((c) => c.toPin)).sort((a, b) => rank(a) - rank(b));
  const boardLeft = uniq(toBoard.filter((c) => powerNames.has(c.from)).map((c) => c.toPin));
  const boards: Box = { name: B, x: 250, y: 16, w: 170, h: HEAD + Math.max(boardRight.length, boardLeft.length, 2) * ROW, left: boardLeft, right: boardRight };

  const audio = report.conns.filter((c) => c.kind === "audio");
  const partNames = uniq([...fromParts.map((c) => c.from), ...audio.map((c) => c.from)]);
  let y = 16;
  const parts: Box[] = partNames.map((name) => {
    const left = uniq(fromParts.filter((c) => c.from === name).map((c) => c.fromPin));
    const right = uniq([...audio.filter((c) => c.from === name).map((c) => c.fromPin), ...audio.filter((c) => c.to === name).map((c) => c.toPin)]);
    const box = { name, x: 540, y, w: 180, h: HEAD + Math.max(left.length, right.length, 1) * ROW, left, right };
    y += box.h + 14;
    return box;
  });

  const power: Box[] = [];
  let py = 16;
  for (const name of powerNames) {
    const out = report.conns.filter((c) => c.from === name);
    const inn = report.conns.filter((c) => c.to === name);
    const box = { name, x: 16, y: py, w: 160, h: HEAD + Math.max(out.length, inn.length, 1) * ROW, left: uniq(inn.map((c) => c.toPin)), right: uniq(out.map((c) => c.fromPin)) };
    power.push(box);
    py += box.h + 40;
  }
  // the booster sits between the battery and the board: shift it right a little so its wires read left to right
  const H = Math.max(boards.y + boards.h, y, py) + 16;
  const all = [boards, ...parts, ...power];
  const find = (n: string) => all.find((b) => b.name === n);
  const at = (b: Box, side: "left" | "right", pin: string) => {
    const list = side === "left" ? b.left : b.right;
    return { x: side === "left" ? b.x : b.x + b.w, y: b.y + HEAD + Math.max(0, list.indexOf(pin)) * ROW + ROW / 2 - 4 };
  };

  const wires: { d: string; kind: Conn["kind"]; via?: string; mx: number; my: number }[] = [];
  for (const c of report.conns) {
    const a = find(c.from);
    const b = find(c.to);
    if (!a || !b) continue;
    let p1, p2, d;
    if (c.kind === "audio") {
      p1 = at(a, "right", c.fromPin);
      p2 = at(b, "right", c.toPin);
      const bend = Math.max(p1.x, p2.x) + 14;
      d = `M${p1.x},${p1.y} C${bend},${p1.y} ${bend},${p2.y} ${p2.x},${p2.y}`;
    } else if (powerNames.has(c.from)) {
      p1 = at(a, "right", c.fromPin);
      p2 = at(b, "left", c.toPin);
      const dx = (p2.x - p1.x) / 2;
      d = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
    } else {
      p1 = at(b, "right", c.toPin);
      p2 = at(a, "left", c.fromPin);
      const dx = (p2.x - p1.x) / 2;
      d = `M${p1.x},${p1.y} C${p1.x + dx},${p1.y} ${p2.x - dx},${p2.y} ${p2.x},${p2.y}`;
    }
    wires.push({ d, kind: c.kind, via: c.via, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 });
  }

  return (
    <div className="bd-wiring-scroll">
      <svg className="bd-wiring" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${B} wiring diagram`}>
        {wires.map((w, i) => <path key={i} d={w.d} className={`w-${w.kind}`} />)}
        {all.map((b) => (
          <g key={b.name} className={b === boards ? "box brain" : powerNames.has(b.name) ? "box power" : "box"}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={8} />
            <text x={b.x + 10} y={b.y + 19} className="t-name">{auto(b.name)}</text>
            {b.left.map((p, i) => <text key={`l${p}`} x={b.x + 8} y={b.y + HEAD + i * ROW + ROW / 2} className="t-pin">{p}</text>)}
            {b.right.map((p, i) => <text key={`r${p}`} x={b.x + b.w - 8} y={b.y + HEAD + i * ROW + ROW / 2} className="t-pin" textAnchor="end">{p}</text>)}
            {b.left.map((p, i) => <circle key={`lc${p}`} cx={b.x} cy={b.y + HEAD + i * ROW + ROW / 2 - 4} r={3} />)}
            {b.right.map((p, i) => <circle key={`rc${p}`} cx={b.x + b.w} cy={b.y + HEAD + i * ROW + ROW / 2 - 4} r={3} />)}
          </g>
        ))}
        {wires.filter((w) => w.via).map((w, i) => (
          <text key={`v${i}`} x={w.mx} y={w.my - 4} className="t-via" textAnchor="middle">{shortVia(w.via!)}</text>
        ))}
      </svg>
    </div>
  );
}

const shortVia = (v: string) => (v.startsWith("divider") ? "1k/2k divider" : v.replace(" resistor", "").replace("on/off ", ""));
