import { Suspense, lazy, useEffect, useMemo, useReducer, useRef, useState } from "react";
import "../lab/lab.css";
import "../build/build.css";
import "./studio.css";
import "./workspace.css";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import { VoiceOrb2D } from "../hud/VoiceOrb2D";
import { MicButton, recognitionCtor, uploadFiles, type AttachmentInfo, type Recognition } from "../lab/inputs.tsx";
import { firmware } from "../build/firmware.ts";
import { Call } from "../Call";
import { CallSummary } from "../CallSummary";
import { Wordmark } from "../ui/RingMark";
import { buildPack, buyCsv, buyList, buyText, readings, wireList, wiresText } from "./precision.ts";
import { APPS, isApp, type AppId } from "./apps.ts";
import { analyze, short, type Report } from "../build/engine.ts";
import { BY_ID } from "../build/parts.ts";
import { parseProject, type Project } from "../build/project.ts";
import { catalogForServer, offlineAssess, toProject, type Assessment, type IdeaInput } from "../build/assess.ts";
import { CodeTab, WiringTab } from "../build/Builder.tsx";
import { BenchView } from "../sim/Bench.tsx";
import { BodyView, load as loadBody } from "../sim/Body.tsx";
import type { Design } from "../lab/design.ts";
import { analyze as analyzeDesign, type Finding } from "../lab/analysis.ts";
import { SimView, runHeadless } from "../lab/SimView.tsx";
import { readLevel } from "../lab/learn.ts";
import {
  argMap, benchRun, benchSetup, bodyText, catalogText, editProject, forRequest, freshBody, parseMemory, remember,
  reportText, assessmentText, shapeBody, stateText, type BenchSetup, type BodySaved, type GuideTurn, type Memory,
  type Said, type ToolCall, type View, VIEWS,
} from "./tools.ts";

// The other tools open as panels inside this one screen, and load only when opened.
const Lab = lazy(() => import("../lab/Lab.tsx").then((m) => ({ default: m.Lab })));
const Builder = lazy(() => import("../build/Builder.tsx").then((m) => ({ default: m.Builder })));
const Redesign = lazy(() => import("../redesign/Redesign.tsx").then((m) => ({ default: m.Redesign })));
const Inspect = lazy(() => import("../Inspect.tsx").then((m) => ({ default: m.Inspect })));
const Demo = lazy(() => import("../Demo.tsx").then((m) => ({ default: m.Demo })));

// shared with the builder (#build) and the design lab (#lab), so "Show everything" opens the same project
const MEMORY = "rmx.guide";
const PROJECT = "rmx.build.project";
const IDEA = "rmx.build.idea";
const BODY = "rmx.build.body";
const DESIGN = "rmx.lab.design";
const MAX_HOPS = 4;
/** a goal handed over from the start page (the same key the builder used) */
const GOAL = "rmx.build.goal";

interface IdeaState { input: IdeaInput; assessment: Assessment | null; offline: boolean; files: AttachmentInfo[] }
const EMPTY_INPUT: IdeaInput = { idea: "", product: "", forKids: false, answers: [], attachment_ids: [] };

const read = <T,>(k: string, parse: (raw: string | null) => T): T => {
  try { return parse(localStorage.getItem(k)); } catch { return parse(null); }
};
const write = (k: string, v: unknown) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* kept for this visit */ }
};

const LAST_ROOM = "rmx.lastRoom";

interface LibHit { ref: string; title: string; source: string; kind: string; text: string }
interface WireVerdict { n: number; verdict: "ok" | "wrong" | "unclear"; note: string }
interface PhotoCheck { photo: "good" | "poor"; wires: WireVerdict[]; other_problems: string[]; better_photo: string; power_on: boolean; summary: string }

/** One still frame from a playing video (the camera or a shared screen) as a JPEG file. */
async function frameToFile(video: HTMLVideoElement, name: string, maxSide = 1600): Promise<File | null> {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.88));
  return blob ? new File([blob], name, { type: "image/jpeg" }) : null;
}

// --- chats: each conversation keeps its own project; the active one lives in the shared keys above ----------------

interface ChatMeta { id: string; title: string; at: number }
const CHATS = "rmx.chats";
const ACTIVE = "rmx.chat.active";
const SNAP = (id: string) => `rmx.chat.${id}`;
const SHARED = [MEMORY, PROJECT, IDEA, BODY, DESIGN];
const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function readChats(): ChatMeta[] {
  return read(CHATS, (r) => { const x = r ? JSON.parse(r) : []; return Array.isArray(x) ? x.filter((c) => c && typeof c.id === "string") : []; });
}
function rawGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function rawSet(k: string, v: string | null) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* kept for this visit */ } }
/** Save the active chat's project from the shared keys into its own slot. */
function stash(id: string) {
  const snap: Record<string, string | null> = {};
  for (const k of SHARED) snap[k] = rawGet(k);
  rawSet(SNAP(id), JSON.stringify(snap));
}
/** Put a chat's project into the shared keys, so every panel opens the same project. */
function unstash(id: string | null) {
  let snap: Record<string, string | null> = {};
  try { snap = id ? JSON.parse(rawGet(SNAP(id)) ?? "{}") : {}; } catch { snap = {}; }
  for (const k of SHARED) rawSet(k, snap[k] ?? null);
}

interface World {
  memory: Memory;
  project: Project | null;
  idea: IdeaState;
  body: BodySaved;
  bench: { setup: BenchSetup | null; text: string };
  design: Design | null;
  designText: string;
  /** remount counters: the agent changed the bench or the body, so the view starts from its set-up */
  benchKey: number;
  bodyKey: number;
}

function loadWorld(): World {
  return {
    memory: read(MEMORY, parseMemory),
    project: read(PROJECT, (r) => (r ? parseProject(r) : null)),
    idea: read(IDEA, (r) => { const x = r ? JSON.parse(r) : null; return x && x.input ? { input: { ...EMPTY_INPUT, ...x.input }, assessment: x.assessment ?? null, offline: !!x.offline, files: x.files ?? [] } : { input: EMPTY_INPUT, assessment: null, offline: false, files: [] }; }),
    body: loadBody() ?? freshBody(),
    bench: { setup: null, text: "" },
    design: read(DESIGN, (r) => (r ? (JSON.parse(r) as Design) : null)),
    designText: "",
    benchKey: 0,
    bodyKey: 0,
  };
}

async function post<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; detail: string }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok && data) return { ok: true, data: data as T };
    return { ok: false, status: res.status, detail: data && typeof data.detail === "string" ? data.detail : `Error ${res.status}` };
  } catch {
    return { ok: false, status: 0, detail: "Can't reach the RepairMind server." };
  }
}

function designSummary(d: Design, findings: Finding[]): string {
  const a = analyzeDesign(d);
  const checks = a.equations.filter((e) => e.pass !== null);
  return [
    `"${d.title}": ${d.summary}`,
    checks.length ? `Checks: ${checks.map((e) => `${e.eq.name} ${e.pass ? "passes" : "FAILS"}${e.margin !== null ? ` (margin ${e.margin.toFixed(2)})` : ""}`).join("; ")}` : "No numeric checks.",
    [...a.findings, ...findings].filter((f) => f.severity !== "info").slice(0, 10).map((f) => `[${f.severity}] ${f.where}: ${f.text}`).join("\n"),
    `Mass about ${a.totalMassKg.toFixed(2)} kg. Next: ${d.next_steps.slice(0, 2).join("; ")}`,
  ].filter(Boolean).join("\n");
}


/**
 * One calm screen: the guide talks, and the one view that helps right now (the plan, the parts, the wiring, the
 * virtual bench, the body, the design, a build step) appears beside it only when it's needed. The guide drives
 * those views itself with tools; the person can still open everything in the full builder.
 */
export interface WorkspaceProps {
  /** a tool to open beside the conversation straight away (from an old address or the start page) */
  initialApp?: AppId | null;
  /** changes each time a tool is asked for, so the same one can be opened again */
  appNonce?: number;
  /** start the live call as soon as the screen opens (the start page already took the safety notice) */
  callNow?: { room?: string } | null;
  /** back to the start page */
  onTour: () => void;
  profile: { name: string; guest?: boolean } | null;
}

/**
 * The one assistant screen. A conversation in the middle; every other tool (the live repair call, the design lab,
 * the parts canvas, redesign, inspection, references, and the project views) opens as a panel beside it, driven by
 * the assistant or by the person. Chats down the side, each with its own project.
 */
export function Workspace({ initialApp = null, appNonce = 0, callNow = null, onTour, profile }: WorkspaceProps) {
  const { t, auto, lang, speech, choice } = useI18n();
  const [chats, setChats] = useState<ChatMeta[]>(readChats);
  const [chatId, setChatId] = useState<string>(() => {
    const a = rawGet(ACTIVE);
    if (a) return a;
    const id = newId();
    rawSet(ACTIVE, id);
    return id;
  });
  const W = useRef<World>(loadWorld());
  const [app, setApp] = useState<AppId | null>(initialApp);
  const [wide, setWide] = useState(false);
  const [side, setSide] = useState(false);
  const [camera, setCamera] = useState<{ what: string } | null>(null);
  const [hands, setHands] = useState(false);
  const [check, setCheck] = useState<PhotoCheck | null>(null);
  const [call, setCall] = useState<{ serverUrl: string; token: string; room: string } | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [callErr, setCallErr] = useState("");
  const [accepted, setAccepted] = useState(!!callNow);
  // after a call: the repair summary, in the same panel
  const [summaryRoom, setSummaryRoom] = useState<string | null>(null);
  const folderIn = useRef<HTMLInputElement>(null);
  const handsRef = useRef(false);
  handsRef.current = hands;
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const [pending, setPending] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [voice, setVoice] = useState(() => read("rmx.guide.voice", (r) => r === "1"));
  const [speaking, setSpeaking] = useState(false);
  const [tick, setTick] = useState(0);
  const [ready, setReady] = useState<boolean | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const w = W.current;
  const m = w.memory;

  useEffect(() => {
    fetch("/api/guide/status").then((r) => r.json()).then((s) => setReady(!!s.ready)).catch(() => setReady(false));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [m.messages.length, busy]);
  useEffect(() => () => { try { speechSynthesis.cancel(); } catch { /* no speech */ } }, []);
  // an idea typed or spoken on the start page: the guide picks it up straight away (once, even under StrictMode)
  const took = useRef(false);
  useEffect(() => {
    if (took.current) return;
    took.current = true;
    let goal = "";
    try { goal = (sessionStorage.getItem(GOAL) ?? "").slice(0, 3000); sessionStorage.removeItem(GOAL); } catch { /* nothing handed over */ }
    if (goal.trim()) void talk(goal);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const report = useMemo<Report | null>(() => (w.project ? analyze(w.project) : null), [w.project]);

  function set(patch: Partial<World>) {
    Object.assign(W.current, patch);
    if ("project" in patch) write(PROJECT, W.current.project);
    if ("idea" in patch) write(IDEA, W.current.idea);
    if ("body" in patch) write(BODY, W.current.body);
    if ("design" in patch) write(DESIGN, W.current.design);
    render();
  }
  function setMem(patch: Partial<Memory>) {
    W.current.memory = { ...W.current.memory, ...patch };
    write(MEMORY, W.current.memory);
    render();
  }
  const say = (s: Said) => setMem({ messages: [...W.current.memory.messages, s].slice(-120) });

  function speak(words: string) {
    if ((!voice && !handsRef.current) || !words) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(words);
      u.lang = speech;
      u.rate = 1;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      speechSynthesis.speak(u);
    } catch { /* this browser can't speak */ }
  }

  // --- the tools --------------------------------------------------------------------------------------------------

  async function assess(input: IdeaInput, extra: { correction?: string } = {}): Promise<string> {
    const ids = W.current.idea.files.map((f) => f.id);
    const withFiles = { ...input, attachment_ids: ids };
    const r = await post<Assessment>("/api/upgrade/assess", {
      idea: withFiles.idea, product: withFiles.product, for_kids: withFiles.forKids, answers: withFiles.answers,
      attachment_ids: ids, language: lang, ...catalogForServer(),
      ...(extra.correction ? { correction: extra.correction, previous: W.current.idea.offline ? null : W.current.idea.assessment } : {}),
    });
    if (r.ok) {
      set({ idea: { ...W.current.idea, input: withFiles, assessment: r.data, offline: false } });
      return assessmentText(r.data);
    }
    if (r.status === 503 || r.status === 0) {
      const a = offlineAssess(extra.correction ? { ...withFiles, idea: `${withFiles.idea}. ${extra.correction}` } : withFiles);
      set({ idea: { ...W.current.idea, input: withFiles, assessment: a, offline: true } });
      return "(basic offline analysis from built-in product knowledge)\n" + assessmentText(a);
    }
    return `The analyst couldn't answer: ${r.detail}`;
  }

  async function design(idea: string, context: string): Promise<string> {
    const r = await post<Design>("/api/lab/design", { idea: idea.slice(0, 4000), context: context.slice(0, 4000), language: lang, level: readLevel(), attachment_ids: W.current.idea.files.map((f) => f.id) });
    if (!r.ok) return `The design engineer couldn't answer: ${r.detail}`;
    return afterDesign(r.data);
  }
  async function afterDesign(d: Design): Promise<string> {
    let sim: Finding[] = [];
    try { sim = (await runHeadless(d, analyzeDesign(d))).findings; } catch { sim = [{ severity: "warning", where: "simulation", text: "the physics engine couldn't run this assembly" }]; }
    const text = designSummary(d, sim);
    set({ design: d, designText: text });
    return text;
  }

  async function run(call: ToolCall): Promise<string> {
    const a = argMap(call.args);
    const cur = W.current;
    const edit = editProject(cur.project, call);
    if (edit) {
      set({ project: edit.project });
      return `${edit.text}\n${reportText(edit.project, analyze(edit.project))}`;
    }
    switch (call.tool) {
      case "understand_idea": {
        const input: IdeaInput = { ...EMPTY_INPUT, idea: (a.idea || cur.idea.input.idea).slice(0, 3000), product: (a.product ?? cur.idea.input.product).slice(0, 2000), forKids: /^(true|yes|1)$/i.test(a.for_kids ?? "") || cur.idea.input.forKids };
        if (input.idea.trim().length < 3) return "No idea to analyse yet.";
        const r = await assess(input);
        if (W.current.idea.assessment) setMem({ view: "plan" });
        return r;
      }
      case "answer_questions": {
        const answers = call.args.filter((x) => x.key.trim() && x.value.trim()).map((x) => ({ q: x.key.slice(0, 300), a: x.value.slice(0, 600) }));
        if (!answers.length) return "No answers given.";
        const prev = cur.idea.input;
        return assess({ ...prev, answers: [...prev.answers.filter((x) => !answers.some((y) => y.q === x.q)), ...answers] });
      }
      case "correct_understanding":
        return assess(cur.idea.input, { correction: (a.text || "").slice(0, 2000) });
      case "start_build": {
        if (!cur.idea.assessment) return "There's no plan yet: understand the idea first, or add parts.";
        const p = toProject(cur.idea.assessment, cur.idea.input);
        set({ project: p });
        setMem({ view: "parts" });
        return reportText(p, analyze(p));
      }
      case "check":
        return cur.project ? reportText(cur.project, analyze(cur.project)) : "No project yet.";
      case "show": {
        const v = (a.view ?? "none") as View;
        if (!VIEWS.includes(v)) return `No view called ${a.view}.`;
        setApp(null);
        setMem({ view: v });
        return `Showing ${v}.`;
      }
      case "test_on_bench": {
        if (!cur.project) return "No project to test yet.";
        const setup = benchSetup(analyze(cur.project), call.args);
        const text = benchRun(cur.project, setup);
        // the visible bench starts from the same set-up, with buttons and claps released for the person to try
        set({ bench: { setup: { ...setup, env: { ...setup.env, clap: false, touch: false, button: false } }, text }, benchKey: cur.benchKey + 1 });
        setMem({ view: "try" });
        return text;
      }
      case "shape_body": {
        if (!cur.project) return "No project yet: the body is shaped around the parts.";
        const r = shapeBody(cur.project, cur.body, call.args);
        set({ body: r.body, bodyKey: cur.bodyKey + 1 });
        setMem({ view: "body" });
        return r.text;
      }
      case "design_mechanism": {
        const idea = a.idea || cur.idea.assessment?.restated || cur.idea.input.idea;
        if (idea.trim().length < 8) return "Describe the mechanism first.";
        setMem({ view: "design" });
        return design(idea, a.context ?? "");
      }
      case "rethink_design": {
        const d = cur.design;
        if (!d) return "There's no design to rethink yet.";
        const findings = cur.designText.split("\n").filter((l) => l.startsWith("[error]") || l.startsWith("[warning]") || /FAILS/.test(l)).slice(0, 40);
        const r = await post<Design>("/api/lab/revise", { design: d, findings, note: (a.note ?? "").slice(0, 2000), language: lang, level: readLevel() });
        if (!r.ok) return `The design engineer couldn't rethink it: ${r.detail}`;
        setMem({ view: "design" });
        return afterDesign(r.data);
      }
      case "open_full_lab":
        if (cur.design) write(DESIGN, cur.design);
        openApp("design_lab");
        return "Opened the design lab panel.";
      case "show_step": {
        const n = Math.max(1, Math.round(Number(a.n) || 1));
        const steps = cur.project ? analyze(cur.project).steps : [];
        if (!steps[n - 1]) return `There's no step ${n} (there are ${steps.length}).`;
        setMem({ step: n, view: "steps" });
        const s = steps[n - 1];
        return `Step ${n} of ${steps.length}: ${s.title}. ${s.detail.join(" ")}${s.safety?.length ? ` Safety: ${s.safety.join(" ")}` : ""}`;
      }
      case "step_done": {
        const n = Math.max(1, Math.round(Number(a.n) || W.current.memory.step || 1));
        const done = [...new Set([...W.current.memory.done, n])].sort((x, y) => x - y);
        setMem({ done, step: n + 1 });
        return `Step ${n} marked done (${done.length} done).`;
      }
      case "open_panel": {
        const id = (a.panel ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
        if (!isApp(id)) return `No panel called ${a.panel}. Panels: ${APPS.join(", ")}.`;
        openApp(id);
        return `Opened ${id} beside the conversation.`;
      }
      case "start_repair_call":
        openApp("repair_call");
        return accepted ? "The live call panel is open; it starts when the person taps Start." : "The live call panel is open with the safety notice; the person reads it and taps Start.";
      case "search_library": {
        const q = (a.q || a.query || "").slice(0, 2000);
        if (!q.trim()) return "Nothing to search for.";
        try {
          const r = await fetch(`/api/library/search?q=${encodeURIComponent(q)}&k=5`);
          if (!r.ok) return `The library couldn't search (error ${r.status}).`;
          const hits = (await r.json()) as LibHit[];
          if (!hits.length) return "No references matched.";
          return hits.map((h, i) => `[R${i + 1}] ${h.title} (${h.source}): ${h.text.slice(0, 700)}`).join("\n\n");
        } catch { return "Can't reach the library."; }
      }
      case "ask_for_photo":
        setCamera({ what: (a.what ?? "").slice(0, 200) });
        return `Camera opened for: ${a.what || "a photo"}. Waiting for the person to take it.`;
      case "check_build_photo":
        return checkBuild();
      case "show_buy_list":
        if (!cur.project) return "No project yet.";
        setApp(null);
        setMem({ view: "buy" });
        return buyText(analyze(cur.project));
      case "export_build_pack":
        if (!cur.project) return "No project yet.";
        downloadPack(cur.project);
        return "The build pack (wiring table, code, parts, steps and test readings) was downloaded as a Markdown file, and the code as an .ino file.";
      default:
        return `Unknown tool ${call.tool}.`;
    }
  }

  /** What the assistant should know about the screen beyond the project. */
  function panelState(): string {
    const ph = lastPhoto();
    return [
      `\n\nSCREEN: panel open: ${app ?? (W.current.memory.view !== "none" ? `view ${W.current.memory.view}` : "none")}. Live repair call: ${call ? "in progress" : "not running"}.`,
      ph ? `Latest photo: ${ph.name}.` : "No photo sent yet.",
      check ? `Last photo check: ${check.summary}; power on: ${check.power_on ? "yes" : "not yet"}.` : "",
      profile && !profile.guest && profile.name ? `Their name: ${profile.name.split(" ")[0]}.` : "",
    ].filter(Boolean).join(" ");
  }

  // --- panels, the live call, photos and downloads -------------------------------------------------------------------

  function openApp(id: AppId | null) {
    setApp(id);
    if (id) setSide(false);
    if (id === "repair_call" || id === "builder" || id === "design_lab" || id === "inspection") setWide(true);
  }

  async function startCall(room?: string) {
    setCallErr("");
    setCallBusy(true);
    try {
      const res = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted_notice: true, room: room ?? null, language: choice, ui_language: lang }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.status >= 500 ? t("common.serverDown") : t("common.error", { n: res.status }));
      rawSet(LAST_ROOM, body.room);
      rawSet("rmx.lastCallRoom", body.room);
      setSummaryRoom(null);
      setCall({ serverUrl: body.server_url, token: body.participant_token, room: body.room });
      openApp("repair_call");
    } catch (e) {
      setCallErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCallBusy(false);
    }
  }
  function endCall(finished: boolean) {
    if (finished) rawSet(LAST_ROOM, null);
    if (call) setSummaryRoom(call.room);
    setCall(null);
    say({ role: "guide", text: finished ? t("ws.call.endedDone") : t("ws.call.ended"), at: Date.now() });
  }
  // the start page or an old address asked for a tool
  useEffect(() => { if (initialApp) openApp(initialApp); }, [initialApp, appNonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const started = useRef(false);
  useEffect(() => {
    if (!callNow || started.current) return;
    started.current = true;
    void startCall(callNow.room);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function lastPhoto(): AttachmentInfo | null {
    const all = [...W.current.idea.files, ...pending];
    for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === "image") return all[i];
    return null;
  }

  async function checkBuild(): Promise<string> {
    const cur = W.current;
    if (!cur.project) return "No project yet, so there's no wiring to check against.";
    const report = analyze(cur.project);
    const photo = lastPhoto();
    if (!photo) return "No photo yet: ask for one with ask_for_photo.";
    const wires = wireList(report).map((w) => ({ n: w.n, text: w.text }));
    if (!wires.length) return "There are no wires to check yet.";
    const steps = report.steps;
    const st = cur.memory.step && steps[cur.memory.step - 1] ? `${steps[cur.memory.step - 1].title}. ${steps[cur.memory.step - 1].detail.join(" ")}` : "";
    const r = await post<PhotoCheck & { text: string }>("/api/guide/check-build", { attachment_id: photo.id, wires, step: st.slice(0, 1500) });
    if (!r.ok) return `The photo check couldn't run: ${r.detail}`;
    setCheck(r.data);
    setApp(null);
    setMem({ view: "wiring" });
    return r.data.text;
  }

  function download(name: string, text: string, type = "text/plain") {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const el = document.createElement("a");
    el.href = url; el.download = name;
    document.body.appendChild(el); el.click(); el.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function downloadPack(p: Project) {
    const report = analyze(p);
    const code = firmware(p, report);
    const base = (p.name || "project").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "project";
    download(`${base}-build-pack.md`, buildPack(p, report, code), "text/markdown");
    setTimeout(() => download(`${code.name}.ino`, code.code), 400);
  }

  async function captureScreen() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const video = document.createElement("video");
      video.srcObject = stream; video.muted = true;
      await video.play();
      await new Promise((r) => setTimeout(r, 300));
      const file = await frameToFile(video, "screen.jpg", 1600);
      stream.getTracks().forEach((x) => x.stop());
      if (file) await attach([file]);
    } catch {
      setError({ text: t("ws.screen.blocked"), retry: false });
    }
  }

  // --- chats --------------------------------------------------------------------------------------------------------

  function touchChat(firstWords: string) {
    setChats((list) => {
      const have = list.find((c) => c.id === chatId);
      const title = have?.title && have.title !== t("ws.untitled") ? have.title : firstWords.replace(/\s+/g, " ").trim().slice(0, 60) || t("ws.untitled");
      const next = [{ id: chatId, title, at: Date.now() }, ...list.filter((c) => c.id !== chatId)].slice(0, 40);
      write(CHATS, next);
      return next;
    });
  }
  function switchChat(id: string | null) {
    try { speechSynthesis.cancel(); } catch { /* no speech */ }
    stash(chatId);
    const next = id ?? newId();
    unstash(id);
    rawSet(ACTIVE, next);
    W.current = loadWorld();
    setChatId(next);
    setPending([]); setError(null); setCheck(null); setApp(null); setSide(false); setText("");
    render();
  }
  function deleteChat(id: string) {
    rawSet(SNAP(id), null);
    setChats((list) => { const next = list.filter((c) => c.id !== id); write(CHATS, next); return next; });
    if (id === chatId) switchChat(null);
  }

  // --- one conversation turn ----------------------------------------------------------------------------------------

  async function talk(words?: string) {
    if (busy) return;
    setError(null);
    const files = pending;
    if (words !== undefined) {
      const clean = words.trim();
      if (!clean && !files.length) return;
      if (files.length) set({ idea: { ...W.current.idea, files: [...W.current.idea.files, ...files].slice(-20) } });
      say({ role: "user", text: clean || "(photo)", at: Date.now(), files: files.map((f) => f.name) });
      touchChat(clean || files.map((f) => f.name).join(", "));
      if (W.current.memory.checkpoint) setMem({ checkpoint: null });
      setPending([]);
      setText("");
    }
    try { speechSynthesis.cancel(); } catch { /* no speech */ }
    setBusy(t("gd.thinking"));
    try {
      for (let hop = 0; hop < MAX_HOPS; hop++) {
        const cur = W.current;
        const r = await post<GuideTurn>("/api/guide/turn", {
          messages: forRequest(cur.memory.messages),
          state: stateText({
            memory: cur.memory, project: cur.project, report: cur.project ? analyze(cur.project) : null, assessment: cur.idea.assessment,
            idea: cur.idea.input.idea, bench: cur.bench.text, body: cur.project ? bodyText(cur.project, cur.body) : "", design: cur.designText, language: lang,
          }) + panelState(),
          catalog: catalogText(),
          attachment_ids: hop === 0 ? files.map((f) => f.id) : [],
          language: lang,
        });
        if (!r.ok) {
          if (r.status === 503) setReady(false);
          setError({ text: r.detail, retry: r.status !== 503 });
          return;
        }
        const turn = r.data;
        setMem({
          messages: [...W.current.memory.messages, { role: "guide" as const, text: turn.say, at: Date.now() }].slice(-120),
          stage: turn.stage, chips: turn.chips,
          checkpoint: turn.checkpoint?.question ? turn.checkpoint : null,
          notes: remember(W.current.memory, turn.remember),
        });
        speak(turn.say);
        if (!turn.actions.length) break;
        const results: string[] = [];
        const whys: string[] = [];
        for (const call of turn.actions) {
          const label = call.why || t(`gd.tool.${call.tool}` as Key);
          setBusy(label);
          let out: string;
          try { out = await run(call); } catch (e) { out = `failed: ${e instanceof Error ? e.message : String(e)}`; }
          results.push(`${call.tool}: ${out}`);
          whys.push(label);
        }
        say({ role: "tool", text: results.join("\n\n"), brief: whys.join(" · "), at: Date.now() });
        if (!turn.then_continue) break;
        setBusy(t("gd.thinking"));
      }
    } finally {
      setBusy("");
    }
  }

  async function attach(list: File[]) {
    if (!list.length) return;
    setUploading(true);
    setError(null);
    try {
      const got = await uploadFiles(list.slice(0, 6));
      setPending((p) => [...p, ...got].slice(0, 6));
      // a photo of the product also gives the parts canvas and the body tracer something to work from
      const img = list.find((f) => f.type.startsWith("image/"));
      if (img && W.current.project && !W.current.project.product.photo) {
        const url = await smallPhoto(img).catch(() => "");
        if (url) set({ project: { ...W.current.project, product: { ...W.current.project.product, photo: url } } });
      }
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : String(e), retry: false });
    } finally {
      setUploading(false);
    }
  }

  function startOver() {
    try { speechSynthesis.cancel(); } catch { /* no speech */ }
    W.current = { ...loadWorld(), memory: { ...parseMemory(null) }, project: null, idea: { input: EMPTY_INPUT, assessment: null, offline: false, files: [] }, body: freshBody(), design: null, designText: "" };
    write(MEMORY, null); write(PROJECT, null); write(IDEA, null); write(BODY, null);
    setError(null); setPending([]); render();
  }

  // --- hands-free voice mode: listen, answer out loud, listen again --------------------------------------------------

  const talkRef = useRef(talk);
  talkRef.current = talk;
  const rec = useRef<Recognition | null>(null);
  const [heard, setHeard] = useState("");
  const canListen = recognitionCtor() !== null;
  useEffect(() => {
    if (!hands || busy || speaking || camera || !canListen) return;
    const Ctor = recognitionCtor()!;
    const r = new Ctor();
    r.continuous = false;
    r.interimResults = true;
    r.lang = speech;
    let final = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const x = e.results[i];
        if (x.isFinal) final += x[0].transcript; else interim += x[0].transcript;
      }
      setHeard((final + " " + interim).trim());
    };
    r.onerror = () => { /* no-speech and aborted just restart below */ };
    let restart: number | undefined;
    r.onend = () => {
      rec.current = null;
      const said = final.trim();
      setHeard("");
      if (said) void talkRef.current(said);
      // nothing heard: listen again after a breath, while voice mode stays on
      else restart = window.setTimeout(() => setTick((n) => n + 1), 400);
    };
    rec.current = r;
    try { r.start(); } catch { /* already running */ }
    return () => { window.clearTimeout(restart); r.onend = null; try { r.stop(); } catch { /* stopped */ } rec.current = null; };
  }, [hands, busy, speaking, camera, speech, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleHands() {
    const on = !hands;
    setHands(on);
    if (!on) { try { speechSynthesis.cancel(); } catch { /* no speech */ } setSpeaking(false); setHeard(""); }
  }

  // --- the screen -----------------------------------------------------------------------------------------------------

  const view = m.view;
  const shown = interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${interim}` : text;
  const orb = busy ? "thinking" : speaking ? "speaking" : hands ? "listening" : "idle";
  const last = [...m.messages].reverse().find((x) => x.role === "guide");
  const welcomeBack = m.messages.length > 0 && !busy && m.messages[m.messages.length - 1].at < Date.now() - 30 * 60_000;
  const steps = report?.steps ?? [];
  const panelOpen = app !== null || view !== "none";
  const panelTitle = app ? t(`ws.app.${app}` as Key) : t(`gd.view.${view}` as Key);
  const closePanel = () => { if (app) setApp(null); else setMem({ view: "none" }); setWide(false); };
  const name = profile && !profile.guest ? profile.name.split(" ")[0] : "";

  return (
    <div className={`ws${panelOpen ? " ws-panel-open" : ""}${wide && panelOpen ? " ws-wide" : ""}${side ? " ws-side-open" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void attach(Array.from(e.dataTransfer.files)); } }}>

      <aside className="ws-side" aria-label={t("ws.menu")}>
        <div className="ws-side-top">
          <a className="ws-brand" href="#" onClick={(e) => { e.preventDefault(); onTour(); }} aria-label={t("ws.tour")}><Wordmark /></a>
          <button className="ws-icon ws-only-narrow" aria-label={t("ws.closeMenu")} onClick={() => setSide(false)}>×</button>
        </div>
        <button className="ws-new" onClick={() => switchChat(null)}><span aria-hidden>＋</span> {t("ws.newChat")}</button>

        <nav className="ws-tools" aria-label={t("ws.tools")}>
          <span className="ws-label">{t("ws.tools")}</span>
          {APPS.map((id) => (
            <button key={id} className={app === id ? "on" : ""} onClick={() => openApp(app === id ? null : id)}>
              <b>{t(`ws.app.${id}` as Key)}</b><small>{t(`ws.app.${id}.d` as Key)}</small>
            </button>
          ))}
        </nav>

        <nav className="ws-chats" aria-label={t("ws.chats")}>
          <span className="ws-label">{t("ws.chats")}</span>
          {chats.map((c) => (
            <div key={c.id} className={`ws-chat${c.id === chatId ? " on" : ""}`}>
              <button onClick={() => (c.id === chatId ? setSide(false) : switchChat(c.id))} title={c.title}>{c.title}</button>
              <button className="ws-x" aria-label={`${t("gd.remove")} ${c.title}`} onClick={() => deleteChat(c.id)}>×</button>
            </div>
          ))}
        </nav>

        <div className="ws-side-foot">
          <LanguagePicker className="lab-lang" />
          <button className={`ws-chip${voice ? " on" : ""}`} aria-pressed={voice} onClick={() => { const v = !voice; setVoice(v); write("rmx.guide.voice", v ? 1 : 0); if (!v) try { speechSynthesis.cancel(); } catch { /* */ } }}>
            {voice ? t("gd.voiceOn") : t("gd.voiceOff")}
          </button>
        </div>
      </aside>
      {side && <div className="ws-scrim" onClick={() => setSide(false)} aria-hidden />}

      <main className="ws-main lab">
        <header className="ws-top">
          <button className="ws-icon ws-only-narrow" aria-label={t("ws.menu")} onClick={() => setSide(true)}>☰</button>
          <span className="ws-title">{chats.find((c) => c.id === chatId)?.title ?? t("gd.title")}</span>
          {w.project && (
            <details className="gd-more">
              <summary className="lab-chip">{t("gd.more")}</summary>
              <div className="gd-menu">
                {VIEWS.filter((v) => v !== "none").map((v) => <button key={v} onClick={(e) => { closeDetails(e); setApp(null); setMem({ view: v }); }}>{t(`gd.view.${v}` as Key)}</button>)}
                <button onClick={(e) => { closeDetails(e); downloadPack(w.project!); }}>{t("ws.pack")}</button>
              </div>
            </details>
          )}
        </header>

        <section className="ws-talk" aria-label={t("gd.title")}>
          {ready === false && <p className="gd-note" role="note">{t("gd.noModel")} <button className="lab-link" onClick={() => openApp("builder")}>{t("gd.everything")}</button></p>}

          <div className="gd-log" aria-live="polite">
            {!m.messages.length && (
              <div className="ws-hello">
                <div className="gd-orb" aria-hidden><VoiceOrb2D state={orb} bands={[]} size={120} detail="compact" /></div>
                <h1>{name ? t("home.hiName", { hi: t(greeting()), name }) : t(greeting())}</h1>
                <p>{t("gd.hello")}</p>
                <div className="ws-starters">
                  {(["ws.app.repair_call", "ia.ex2", "ia.ex3", "ia.ex4"] as Key[]).map((k) => (
                    <button key={k} className="lab-chip" onClick={() => (k === "ws.app.repair_call" ? openApp("repair_call") : void talk(t(k)))}>{t(k)}</button>
                  ))}
                </div>
              </div>
            )}
            {m.messages.map((x, i) => x.role === "tool" ? (
              <details key={i} className="gd-did"><summary>✓ {x.brief}</summary><pre>{x.text}</pre></details>
            ) : (
              <div key={i} className={`gd-msg ${x.role}`}>
                <p>{x.role === "user" ? x.text : auto(x.text)}</p>
                {x.files?.length ? <small>📎 {x.files.join(", ")}</small> : null}
              </div>
            ))}
            {welcomeBack && <div className="gd-msg guide soft"><p>{m.step && steps[m.step - 1] ? t("gd.backStep", { n: m.step, step: auto(steps[m.step - 1].title) }) : t("gd.back")}</p></div>}
            {busy && <p className="gd-busy" role="status"><span className="lab-spin" aria-hidden /> {busy}</p>}
            {error && (
              <div className="lab-fail" role="alert">
                <p>{auto(error.text)}</p>
                {error.retry && <button className="lab-btn solid" onClick={() => void talk()}>{t("lab.fail.retry")}</button>}
              </div>
            )}
            {!busy && m.checkpoint && (
              <div className="gd-check" role="group" aria-label={m.checkpoint.question}>
                <span className="lab-kicker">{m.checkpoint.step ? t("gd.checkStep", { n: m.checkpoint.step }) : t("gd.check")}</span>
                <b>{auto(m.checkpoint.question)}</b>
                <div className="gd-chips">
                  {m.checkpoint.options.map((o) => <button key={o} className="lab-btn" onClick={() => void talk(`${m.checkpoint!.question} ${o}`)}>{auto(o)}</button>)}
                  <button className="lab-btn ghost" onClick={() => setCamera({ what: m.checkpoint!.question })}>{t("ws.camera")}</button>
                </div>
              </div>
            )}
            {!busy && !m.checkpoint && last && m.chips.length > 0 && (
              <div className="gd-chips">{m.chips.map((c) => <button key={c} className="lab-chip" onClick={() => void talk(c)}>{auto(c)}</button>)}</div>
            )}
            <div ref={endRef} className="gd-end" />
          </div>

          {hands ? (
            <div className="ws-voice" role="group" aria-label={t("ws.voiceMode")}>
              <button className="ws-voice-orb" onClick={() => { if (speaking) { try { speechSynthesis.cancel(); } catch { /* */ } setSpeaking(false); } }} aria-label={speaking ? t("ws.voice.speaking") : t("ws.voiceMode")}>
                <VoiceOrb2D state={orb} bands={[]} size={110} detail="compact" />
              </button>
              <p className="ws-voice-state">{!canListen ? t("ws.voice.unsupported") : heard || (busy ? t("ws.voice.thinking") : speaking ? t("ws.voice.speaking") : t("ws.voice.listening"))}</p>
              <div className="ws-voice-row">
                <button className="lab-btn" onClick={() => setCamera({ what: "" })}>{t("ws.camera")}</button>
                <button className="lab-btn" onClick={() => void captureScreen()}>{t("ws.screen")}</button>
                <button className="lab-btn solid" onClick={toggleHands}>{t("ws.voice.end")}</button>
              </div>
            </div>
          ) : (
            <form className="ws-compose" onSubmit={(e) => { e.preventDefault(); void talk(shown); }}>
              {pending.length > 0 && (
                <div className="gd-pending">
                  {pending.map((f) => (
                    <span key={f.id} className="gd-file">{f.thumb ? <img src={f.thumb} alt="" /> : null}{f.name}
                      <button type="button" aria-label={t("gd.remove")} onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}>×</button></span>
                  ))}
                </div>
              )}
              <textarea rows={1} value={shown} maxLength={3000} placeholder={t("gd.ph")} aria-label={t("gd.ph")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void talk(shown); } }} />
              <div className="ws-compose-row">
                <details className="ws-plus">
                  <summary className="ws-icon" aria-label={t("gd.attach")} title={t("gd.attach")}>{uploading ? "…" : "+"}</summary>
                  <div className="gd-menu ws-plus-menu">
                    <button type="button" onClick={(e) => { closeDetails(e); fileIn.current?.click(); }}>{t("ws.files")}</button>
                    <button type="button" onClick={(e) => { closeDetails(e); folderIn.current?.click(); }}>{t("ws.folder")}</button>
                    <button type="button" onClick={(e) => { closeDetails(e); setCamera({ what: "" }); }}>{t("ws.camera")}</button>
                    <button type="button" onClick={(e) => { closeDetails(e); void captureScreen(); }}>{t("ws.screen")}</button>
                  </div>
                </details>
                <button type="button" className="ws-icon" aria-label={t("ws.camera")} title={t("ws.camera")} onClick={() => setCamera({ what: "" })}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path fill="currentColor" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" /></svg>
                </button>
                <span className="ws-grow" />
                <MicButton label=" " onInterim={setInterim}
                  onText={(x) => { setInterim(""); setText((v) => (v ? `${v.trimEnd()} ${x}` : x).slice(0, 3000)); }} />
                <button type="button" className="ws-icon ws-voice-btn" aria-label={t("ws.voiceMode")} title={t("ws.voiceMode")} onClick={toggleHands}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden><path fill="currentColor" d="M3 10h2v4H3zm4-3h2v10H7zm4-4h2v18h-2zm4 4h2v10h-2zm4 3h2v4h-2z" /></svg>
                </button>
                <button type="submit" className="ws-send" aria-label={t("gd.send")} disabled={!!busy || (!shown.trim() && !pending.length)}>↑</button>
              </div>
            </form>
          )}
          <input ref={fileIn} type="file" hidden multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.json,.stl,.obj,.step,.stp,.dxf,.ino,.c,.cpp,.h,.py"
            onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={folderIn} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => { void attach(Array.from(e.target.files ?? []).slice(0, 6)); e.target.value = ""; }} />
        </section>
      </main>

      {panelOpen && (
        <section className="ws-panel" aria-label={panelTitle}>
          <div className="ws-panel-head">
            <span className="lab-kicker">{panelTitle}</span>
            <span className="ws-grow" />
            <button className="lab-chip ws-only-wide" onClick={() => setWide((x) => !x)}>{wide ? t("ws.shrink") : t("ws.expand")}</button>
            <button className="ws-icon" aria-label={t("ws.close")} title={t("ws.close")} onClick={closePanel}>×</button>
          </div>
          <div className="ws-panel-body">
            {app ? (
              <Suspense fallback={<p className="lab-muted ws-pad"><span className="lab-spin" aria-hidden /> …</p>}>
                {app === "repair_call" && (call
                  ? <div className="ws-call"><Call {...call} onEnd={endCall} /></div>
                  : summaryRoom
                  ? <CallSummary room={summaryRoom} onResume={() => { const r = summaryRoom; setSummaryRoom(null); void startCall(r); }} onDone={() => setSummaryRoom(null)} />
                  : <CallStart accepted={accepted} setAccepted={setAccepted} busy={callBusy} error={callErr} lastRoom={rawGet(LAST_ROOM)} onStart={(room) => void startCall(room)} />)}
                {app === "design_lab" && <Lab onBack={() => setApp(null)} />}
                {app === "builder" && <Builder onBack={() => setApp(null)} />}
                {app === "redesign" && <Redesign onBack={() => setApp(null)} />}
                {app === "inspection" && <Inspect onBack={() => setApp(null)} />}
                {app === "library" && <Library />}
                {app === "demo" && <div className="ws-call"><Demo /></div>}
              </Suspense>
            ) : (
              <Stage view={view} world={w} report={report} memory={m} check={check}
                onStep={(n) => setMem({ step: n })}
                onDone={(n) => { setMem({ done: [...new Set([...m.done, n])], step: n + 1 }); void talk(t("gd.didStep", { n })); }}
                onPhoto={() => setCamera({ what: t("ws.wires.check") })}
                onPack={() => w.project && downloadPack(w.project)}
                onCsv={() => report && download(`${(w.project?.name || "parts").replace(/\W+/g, "-")}-parts.csv`, buyCsv(report), "text/csv")}
                onTicks={(ticks) => setMem({ wires: ticks })} />
            )}
          </div>
        </section>
      )}

      {camera && (
        <CameraSheet what={camera.what}
          onClose={() => setCamera(null)}
          onPhoto={async (f) => {
            setCamera(null);
            await attach([f]);
            // in voice mode, or when the assistant asked for it, send it straight away
            if (hands || camera.what) setTimeout(() => void talkRef.current(camera.what ? t("ws.cam.asked", { what: camera.what }) : ""), 50);
          }} />
      )}
    </div>
  );

}

async function smallPhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 960 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.78);
}

// --- the one view beside the conversation -------------------------------------------------------------------------

function Stage({ view, world, report, memory, check, onStep, onDone, onPhoto, onPack, onCsv, onTicks }: {
  view: View; world: World; report: Report | null; memory: Memory; check: PhotoCheck | null;
  onStep: (n: number) => void; onDone: (n: number) => void; onPhoto: () => void; onPack: () => void; onCsv: () => void;
  onTicks: (ticks: number[]) => void;
}) {
  const { t, auto } = useI18n();
  const p = world.project;
  const needProject = <p className="lab-muted">{t("gd.noProject")}</p>;
  switch (view) {
    case "plan": {
      const a = world.idea.assessment;
      if (!a) return <p className="lab-muted">{t("gd.noPlan")}</p>;
      return (
        <div className="gd-plan">
          {world.idea.offline && <p className="ia-offline">{t("ia.offline")}</p>}
          <h2 className={`v-${a.overall}`}>{t(`ia.overall.${a.overall}` as Key)}</h2>
          <p>{auto(a.overall_why)}</p>
          <ul className="gd-wishes">
            {a.wishes.map((x, i) => <li key={i} className={`w-${x.verdict}`}><span className="ia-pill">{t(`ia.v.${x.verdict}` as Key)}</span> {auto(x.wish)}</li>)}
          </ul>
          {a.plan.stages.length > 0 && <ol className="gd-path">{a.plan.stages.map((s, i) => <li key={i}><b>{auto(s.name)}</b> <span className="lab-muted">{auto(s.goal)}</span></li>)}</ol>}
          {a.plan.warnings.length > 0 && <div className="bd-safety"><ul>{a.plan.warnings.map((x) => <li key={x}>{auto(x)}</li>)}</ul></div>}
        </div>
      );
    }
    case "parts": {
      if (!p || !report) return needProject;
      const issues = report.issues.filter((i) => i.level !== "tip");
      return (
        <div className="gd-parts">
          <p className={`bd-head ${report.ready ? "ok" : "bad"}`}>{report.ready ? t("bd.ready") : t("bd.notReady", { n: issues.filter((i) => i.level === "block" || i.level === "fix").length })}
            <span className="bd-sum">{t("bd.cost", { n: report.totalInr.toLocaleString("en-IN") })}</span></p>
          <ul className="gd-partlist">
            {p.parts.map((x) => { const part = BY_ID[x.id]; return part ? <li key={x.uid}><span className="bd-ic" aria-hidden>{part.icon}</span><span>{auto(short(part))}<small>{auto(part.plain)}</small></span><span className="mono">₹{part.priceInr}</span></li> : null; })}
          </ul>
          {issues.length > 0 && <ul className="bd-issues">{issues.map((i) => <li key={i.text} className={`lv-${i.level}`}><span>{auto(i.text)}</span></li>)}</ul>}
        </div>
      );
    }
    case "wiring": return p && report ? <Wires report={report} ticks={memory.wires} check={check} onTicks={onTicks} onPhoto={onPhoto} /> : needProject;
    case "tests": return p && report ? <Tests report={report} /> : needProject;
    case "buy": return p && report ? <Buy report={report} onCsv={onCsv} onPack={onPack} /> : needProject;
    case "code": return p && report ? <CodeTab project={p} report={report} /> : needProject;
    case "try": return p && report ? <BenchView key={world.benchKey} project={p} report={report} initial={world.bench.setup ?? undefined} /> : needProject;
    case "body": return p ? <BodyView key={world.bodyKey} project={p} initial={world.body} /> : needProject;
    case "design": {
      const d = world.design;
      if (!d) return <p className="lab-muted">{t("gd.noDesign")}</p>;
      return <DesignCard d={d} />;
    }
    case "steps": {
      if (!report || !report.steps.length) return needProject;
      const n = Math.min(Math.max(memory.step || 1, 1), report.steps.length);
      const s = report.steps[n - 1];
      const done = memory.done.includes(n);
      return (
        <div className="gd-step">
          <div className="gd-dots" role="tablist">
            {report.steps.map((_, i) => <button key={i} role="tab" aria-selected={i + 1 === n} aria-label={t("gd.stepN", { n: i + 1 })}
              className={`${i + 1 === n ? "now" : ""}${memory.done.includes(i + 1) ? " done" : ""}`} onClick={() => onStep(i + 1)} />)}
          </div>
          <span className="lab-kicker">{t("gd.stepOf", { n, total: report.steps.length })}</span>
          <h2>{auto(s.title)}</h2>
          <ul>{s.detail.map((x) => <li key={x}>{auto(x)}</li>)}</ul>
          {s.safety && <div className="bd-safety"><span className="lab-kicker">{t("bd.safety")}</span><ul>{s.safety.map((x) => <li key={x}>{auto(x)}</li>)}</ul></div>}
          <div className="gd-chips">
            {n > 1 && <button className="lab-btn" onClick={() => onStep(n - 1)}>{t("gd.prev")}</button>}
            {!done && <button className="lab-btn solid" onClick={() => onDone(n)}>{t("gd.done")}</button>}
            {done && n < report.steps.length && <button className="lab-btn" onClick={() => onStep(n + 1)}>{t("gd.next")}</button>}
          </div>
        </div>
      );
    }
    default: return null;
  }
}

function DesignCard({ d }: { d: Design }) {
  const { t, auto } = useI18n();
  const analysis = useMemo(() => analyzeDesign(d), [d]);
  const checks = analysis.equations.filter((e) => e.pass !== null);
  return (
    <div className="gd-design">
      <h2>{auto(d.title)}</h2>
      <p>{auto(d.summary)}</p>
      {checks.length > 0 && (
        <ul className="gd-checks">
          {checks.map((e) => <li key={e.eq.id} className={e.pass ? "ok" : "bad"}>{e.pass ? "✓" : "✕"} {auto(e.eq.name)}{e.margin !== null ? <span className="mono"> MS {e.margin.toFixed(2)}</span> : null}</li>)}
        </ul>
      )}
      <SimView design={d} analysis={analysis} />
      <p className="lab-muted">{t("gd.fullLab")}: {t("ws.tools")} → {t("ws.app.design_lab")}</p>
    </div>
  );
}

// --- precise build views: wire by wire, readings, buying --------------------------------------------------------

function Wires({ report, ticks, check, onTicks, onPhoto }: {
  report: Report; ticks: number[]; check: PhotoCheck | null; onTicks: (t: number[]) => void; onPhoto: () => void;
}) {
  const { t, auto } = useI18n();
  const wires = useMemo(() => wireList(report), [report]);
  const verdict = new Map((check?.wires ?? []).map((v) => [v.n, v]));
  const toggle = (n: number) => onTicks(ticks.includes(n) ? ticks.filter((x) => x !== n) : [...ticks, n].sort((a, b) => a - b));
  return (
    <div className="ws-wires">
      <h2>{t("ws.wires.title")}</h2>
      <p className="lab-muted">{t("ws.wires.hint")} <b>{t("ws.wires.done", { n: ticks.filter((n) => n <= wires.length).length, total: wires.length })}</b></p>
      {check && (
        <div className={`ws-check ${check.power_on ? "ok" : "bad"}`} role="status">
          <span className="lab-kicker">{t("ws.check.result")}</span>
          <b>{check.power_on ? t("ws.check.power") : t("ws.check.notYet")}</b> <span>{auto(check.summary)}</span>
          {check.other_problems.length > 0 && <ul>{check.other_problems.map((x) => <li key={x}>{auto(x)}</li>)}</ul>}
          {check.better_photo && <p className="lab-muted">{auto(check.better_photo)}</p>}
        </div>
      )}
      <ol className="ws-wirelist">
        {wires.map((w) => {
          const v = verdict.get(w.n);
          return (
            <li key={w.n} className={v ? `v-${v.verdict}` : ""}>
              <label>
                <input type="checkbox" checked={ticks.includes(w.n)} onChange={() => toggle(w.n)} />
                <span className="ws-wn">{w.n}</span>
                <span className={`ws-swatch c-${w.colour}`} aria-label={`${w.colour} wire`} />
                <span className="ws-wt"><b>{w.from}</b> → <b>{w.to}</b>{w.via ? <small> ({w.via})</small> : null}</span>
              </label>
              {v && <span className="ws-verdict">{t(`ws.v.${v.verdict}` as Key)}{v.note ? `: ${auto(v.note)}` : ""}</span>}
            </li>
          );
        })}
      </ol>
      <button className="lab-btn solid" onClick={onPhoto}>{t("ws.wires.check")}</button>
      <details className="ws-diagram"><summary>{t("gd.view.wiring")}</summary><WiringTab report={report} /></details>
    </div>
  );
}

function Tests({ report }: { report: Report }) {
  const { t } = useI18n();
  const rows = useMemo(() => readings(report), [report]);
  return (
    <div className="ws-tests">
      <h2>{t("gd.view.tests")}</h2>
      <p className="lab-muted">{t("ws.tests.hint")}</p>
      <ol>
        {rows.map((r) => (
          <li key={r.what}>
            <span className={`ws-when ${r.when === "power off" ? "off" : "on"}`}>{r.when === "power off" ? t("ws.tests.off") : t("ws.tests.on")}</span>
            <b>{r.what}</b>
            <span className="lab-muted">{r.probes}</span>
            <span>{t("ws.tests.expect")} <b className="mono">{r.expect}</b></span>
            <small>{r.ifNot}</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Buy({ report, onCsv, onPack }: { report: Report; onCsv: () => void; onPack: () => void }) {
  const { t, auto } = useI18n();
  const { lines, total } = useMemo(() => buyList(report), [report]);
  return (
    <div className="ws-buy">
      <h2>{t("gd.view.buy")}</h2>
      <div className="ws-table">
        <table>
          <tbody>
            {lines.map((l) => (
              <tr key={l.name}>
                <td>{l.qty} ×</td>
                <td>{auto(l.name)}<div className="ws-shops">{l.shops.map((s) => <a key={s.name} href={s.url} target="_blank" rel="noreferrer">{s.name}</a>)}</div></td>
                <td className="mono">₹{l.total.toLocaleString("en-IN")}</td>
              </tr>
            ))}
            <tr className="ws-total"><td /><td>{t("ws.buy.total")}</td><td className="mono">₹{total.toLocaleString("en-IN")}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="gd-chips">
        <button className="lab-btn" onClick={onCsv}>{t("ws.buy.csv")}</button>
        <button className="lab-btn solid" onClick={onPack}>{t("ws.pack")}</button>
      </div>
    </div>
  );
}

// --- the live call's start, the camera, the references ------------------------------------------------------------

const NOTICE = ["control", "limits", "stop", "privacy"] as const;

function CallStart({ accepted, setAccepted, busy, error, lastRoom, onStart }: {
  accepted: boolean; setAccepted: (v: boolean) => void; busy: boolean; error: string; lastRoom: string | null; onStart: (room?: string) => void;
}) {
  const { t, auto } = useI18n();
  return (
    <div className="ws-callstart ws-pad">
      <h2>{t("ws.call.title")}</h2>
      <ul className="ws-notice">
        {NOTICE.map((id) => <li key={id} className={id === "stop" ? "alert" : ""}><b>{t(`start.notice.${id}.k` as Key)}</b> {t(`start.notice.${id}` as Key)}</li>)}
      </ul>
      <label className="ws-consent"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /> {t("start.consent")}</label>
      <div className="gd-chips">
        <button className="lab-btn solid" disabled={!accepted || busy} onClick={() => onStart()}>{busy ? t("ws.call.connecting") : t("ws.call.go")}</button>
        {lastRoom && <button className="lab-btn" disabled={!accepted || busy} onClick={() => onStart(lastRoom)}>{t("ws.call.resume")}</button>}
      </div>
      {error && <p className="lab-fail" role="alert">{auto(error)}</p>}
    </div>
  );
}

function CameraSheet({ what, onPhoto, onClose }: { what: string; onPhoto: (f: File) => void; onClose: () => void }) {
  const { t, auto } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [err, setErr] = useState("");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let gone = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => { if (gone) { s.getTracks().forEach((x) => x.stop()); return; } stream = s; if (video.current) { video.current.srcObject = s; void video.current.play(); } })
      .catch(() => setErr(t("ws.cam.blocked")));
    return () => { gone = true; stream?.getTracks().forEach((x) => x.stop()); };
  }, [facing]); // eslint-disable-line react-hooks/exhaustive-deps
  async function snap() {
    if (!video.current) return;
    const f = await frameToFile(video.current, `photo-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.jpg`, 1920);
    if (f) onPhoto(f);
  }
  return (
    <div className="ws-camera" role="dialog" aria-modal="true" aria-label={t("ws.cam.title")} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="ws-camera-box">
        <div className="ws-panel-head"><span className="lab-kicker">{what ? auto(what) : t("ws.cam.title")}</span><span className="ws-grow" />
          <button className="ws-icon" aria-label={t("ws.close")} onClick={onClose} autoFocus>×</button></div>
        {err ? <p className="lab-fail ws-pad">{err}</p> : <video ref={video} playsInline muted />}
        <div className="gd-chips ws-pad">
          <button className="lab-btn" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}>{t("ws.cam.flip")}</button>
          <button className="lab-btn solid" disabled={!!err} onClick={() => void snap()}>{t("ws.cam.snap")}</button>
        </div>
      </div>
    </div>
  );
}

function Library() {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LibHit[] | null>(null);
  const [info, setInfo] = useState<{ core: number; yours: { id: string; title: string }[] } | null>(null);
  const [msg, setMsg] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => fetch("/api/library").then((r) => r.json()).then(setInfo).catch(() => setInfo(null));
  useEffect(() => { void refresh(); }, []);
  async function search() {
    if (!q.trim()) return;
    try { const r = await fetch(`/api/library/search?q=${encodeURIComponent(q)}&k=10`); setHits(r.ok ? await r.json() : []); } catch { setHits([]); }
  }
  async function add(f: File) {
    setMsg("…");
    const form = new FormData();
    form.append("file", f, f.name);
    form.append("title", f.name.replace(/\.[^.]+$/, ""));
    const r = await fetch("/api/library/docs", { method: "POST", body: form }).catch(() => null);
    setMsg(r && r.ok ? "✓ " + f.name : (r ? (await r.json().catch(() => ({}))).detail : null) || t("common.serverDown"));
    void refresh();
  }
  return (
    <div className="ws-lib ws-pad">
      {info && <p className="lab-muted">{t("ws.lib.core", { n: info.core })}{info.yours.length ? ` · ${t("ws.lib.yours")}: ${info.yours.map((d) => d.title).join(", ")}` : ""}</p>}
      <form className="ws-lib-q" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ws.lib.ph")} aria-label={t("ws.lib.ph")} />
        <button className="lab-btn solid" type="submit">{t("ws.lib.search")}</button>
      </form>
      <button className="lab-btn" onClick={() => file.current?.click()}>{t("ws.lib.add")}</button> {msg && <small>{msg}</small>}
      <input ref={file} type="file" hidden accept=".pdf,.txt,.md" onChange={(e) => { const f = e.target.files?.[0]; if (f) void add(f); e.target.value = ""; }} />
      {hits && !hits.length && <p className="lab-muted">{t("ws.lib.none")}</p>}
      {hits && hits.length > 0 && (
        <ol className="ws-hits">
          {hits.map((h) => <li key={h.ref}><b>{h.title}</b><small>{h.source}</small><p>{h.text}</p></li>)}
        </ol>
      )}
    </div>
  );
}

function greeting(): Key {
  const h = new Date().getHours();
  return h < 5 ? "home.hi.evening" : h < 12 ? "home.hi.morning" : h < 18 ? "home.hi.afternoon" : "home.hi.evening";
}

/** Close the "+" menu after picking from it. */
function closeDetails(e: { currentTarget: HTMLElement }) {
  e.currentTarget.closest("details")?.removeAttribute("open");
}
