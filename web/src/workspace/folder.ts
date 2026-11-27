/**
 * The project as a real folder: the Arduino sketch in its own folder (the IDE needs the folder and the .ino to share
 * a name), the build guide, wiring, tests, tools, the parts list as a spreadsheet, the printable body and the
 * project file. It can be written straight into a folder on the person's computer (Chrome and Edge on a desktop)
 * or downloaded as one .zip anywhere else.
 *
 * Pure functions apart from saveToFolder, so the tests build the same folder in Node.
 */
import type { Report } from "../build/engine.ts";
import { firmware } from "../build/firmware.ts";
import type { Project } from "../build/project.ts";
import { buildShell, halfMesh, stl, type ShellSpec } from "../sim/shell.ts";
import { buildPack, buyCsv, readings, toolsFor, wireList } from "./precision.ts";

export interface FolderFile {
  /** path inside the project folder, with forward slashes */
  path: string;
  data: string | Uint8Array;
  /** what it is, in a few words, for the file list */
  about: string;
}

export const slug = (s: string) => (s || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "project";

export function projectFiles(project: Project, report: Report, body?: { spec: ShellSpec } | null): { root: string; files: FolderFile[] } {
  const root = slug(project.name);
  const code = firmware(project, report);
  const sketch = code.name.replace(/\.ino$/, "");
  const wires = wireList(report);
  const tests = readings(report);
  const tools = toolsFor(project, report);
  const files: FolderFile[] = [
    { path: "README.md", about: "Build guide: parts, tools, wiring, tests, steps, code", data: buildPack(project, report, code) },
    { path: `${sketch}/${sketch}.ino`, about: "The program for the board (open in Arduino IDE)", data: code.code },
    {
      path: "wiring.md", about: "Every wire, numbered, with its colour",
      data: [`# Wiring: ${project.name}`, "", ...wires.map((w) => `- [ ] ${w.n}. ${w.text}`), "", ...(report.pinMap.length ? ["## Board pins", "", ...report.pinMap.map((p) => `- ${p.pin}: ${p.use}`)] : [])].join("\n") + "\n",
    },
    {
      path: "tests.md", about: "What the multimeter should read",
      data: [`# Tests: ${project.name}`, "", ...tests.map((t) => `- **${t.what}** (${t.when}). ${t.probes}. Expect **${t.expect}**. ${t.ifNot}`)].join("\n") + "\n",
    },
    {
      path: "tools.md", about: "Tools and instruments, with shop links",
      data: [`# Tools and instruments: ${project.name}`, "", ...tools.map((x) => `- [ ] ${x.must ? "**Needed:**" : "Helpful:"} ${x.name}. ${x.why} ${x.shops.map((s) => `[${s.name}](${s.url})`).join(" · ")}`)].join("\n") + "\n",
    },
    { path: "parts.csv", about: "Parts to buy, with prices and shop links", data: buyCsv(report) + "\n" },
    { path: "project.json", about: "The project, to open again in RepairMind X", data: JSON.stringify(project, null, 2) + "\n" },
  ];
  if (body?.spec) {
    const shell = buildShell(body.spec);
    for (const [side, name] of [[1, "front"], [-1, "back"]] as const) {
      files.push({ path: `body/${root}_${name}.stl`, about: `Printable ${name} half of the body`, data: new Uint8Array(stl(halfMesh(shell, side), `${project.name} ${name}`)) });
    }
  }
  return { root, files };
}

// --- a plain .zip (stored, no compression: every browser and OS opens it) --------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const bytes = (d: string | Uint8Array) => (typeof d === "string" ? new TextEncoder().encode(d) : d);

export function zip(root: string, files: FolderFile[], when = new Date()): Uint8Array<ArrayBuffer> {
  const time = ((when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2)) & 0xffff;
  const date = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(`${root}/${f.path}`);
    const data = bytes(f.data);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    local.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, b) => n + b.length, 0)));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// --- writing the folder on the person's computer ----------------------------------------------------------------

interface DirHandle {
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<{ createWritable(): Promise<{ write(d: Uint8Array | string): Promise<void>; close(): Promise<void> }> }>;
}

export const canSaveFolder = () => typeof window !== "undefined" && "showDirectoryPicker" in window && window.isSecureContext;

/** Asks where to put it, then creates the project folder there with every file inside. Returns the folder's name. */
export async function saveToFolder(root: string, files: FolderFile[]): Promise<string> {
  const pick = (window as unknown as { showDirectoryPicker: (o?: object) => Promise<DirHandle> }).showDirectoryPicker;
  const base = await pick({ id: "rmx-projects", mode: "readwrite", startIn: "documents" });
  const top = await base.getDirectoryHandle(root, { create: true });
  for (const f of files) {
    const parts = f.path.split("/");
    let dir = top;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await w.write(f.data);
    await w.close();
  }
  return root;
}
