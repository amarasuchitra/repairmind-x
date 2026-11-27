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
import { Logo, Mic, MicOff, Shield } from "../ui/Icons";
import { SAMPLE, SAMPLE_BODY } from "./explode.ts";
import { canSaveFolder, projectFiles, saveToFolder, slug, zip, type FolderFile } from "./folder.ts";
import { hoursText, specMarkdown, specSheet } from "../build/spec.ts";
import { CommandBar, typing, type Cmd } from "./Command.tsx";
import { briefFor, type AppAction, type Brief } from "./coach.ts";
import type { LiveState } from "./GuideLive.tsx";
const GuideLive = lazy(() => import("./GuideLive.tsx").then((m) => ({ default: m.GuideLive })));
const BuildCall = lazy(() => import("./BuildCall.tsx").then((m) => ({ default: m.BuildCall })));
import type { ShellSpec } from "../sim/shell.ts";
import { buildPack, buyCsv, buyList, buyText, readings, toolsFor, wireList, wiresText, type ToolLine } from "./precision.ts";
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
// the 3D view loads after the rest of the screen, so the conversation is ready first
const Exploded = lazy(() => import("./Exploded.tsx").then((m) => ({ default: m.Exploded })));
const SAMPLE_REPORT = analyze(SAMPLE);

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

/**
 * The three things RepairMind X is for. Every tool lives under one of them: building something new (the workbench,
 * with the design lab, parts canvas and references), repairing a product (the live call, and redesigning a broken
 * part), and finding manufacturing defects in bulk.
 */
type SectionId = "build" | "repair" | "inspect";
const SECTIONS: { id: SectionId; icon: string; main: AppId | null; more: AppId[] }[] = [
  { id: "build", icon: "build", main: null, more: ["design_lab", "builder", "library"] },
  { id: "repair", icon: "repair_call", main: "repair_call", more: ["redesign"] },
  { id: "inspect", icon: "inspection", main: "inspection", more: [] },
];

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
  // always listening by default: the guide hears you, answers out loud and listens again (tap the orb to pause)
  // always listening: there is no button to turn it off; a blocked microphone is the only thing that stops it
  const [hands, setHands] = useState(true);
  const [micBlocked, setMicBlocked] = useState(false);
  // the live voice (Gemini Live, like the repair call); the browser's own speech is the fallback when it can't connect
  const [liveTok, setLive] = useState<{ serverUrl: string; token: string } | null>(null);
  const [liveFail, setLiveFail] = useState(false);
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const liveSend = useRef<((text: string) => void) | null>(null);
  // one live voice per computer: the tab you're looking at takes it, every other RepairMind tab goes quiet
  const [liveOwner, setLiveOwner] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const me = Math.random().toString(36).slice(2);
    const ch = new BroadcastChannel("rmx-live-voice");
    const claim = () => { if (document.visibilityState === "visible") { setLiveOwner(true); ch.postMessage(me); } };
    ch.onmessage = (e) => { if (e.data !== me) setLiveOwner(false); };
    const onVis = () => { if (document.visibilityState === "visible") claim(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", claim);
    claim();
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", claim); ch.close(); };
  }, []);
  const [check, setCheck] = useState<PhotoCheck | null>(null);
  const [call, setCall] = useState<{ serverUrl: string; token: string; room: string } | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [coach, setCoach] = useState<{ serverUrl: string; token: string; brief: Brief } | null>(null);
  const [coachBig, setCoachBig] = useState(false);
  const [coachNote, setCoachNote] = useState("");
  const [saveAsked, setSaveAsked] = useState(false);
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
  const [sampleStep, setSampleStep] = useState(1);
  const [tab, setTab] = useState<"3d" | "spec" | "code" | "tools" | "shop">("3d");
  const [cmdOpen, setCmdOpen] = useState(false);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const w = W.current;
  const m = w.memory;

  useEffect(() => {
    fetch("/api/guide/status").then((r) => r.json()).then((s) => setReady(!!s.ready)).catch(() => setReady(false));
  }, []);
  useEffect(() => { if (m.messages.length || busy) endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [m.messages.length, busy]);
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
    if ((!voice && !handsRef.current) || !words || liveSend.current) return;
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
  /** The live build coach: the project goes with it, so it guides exactly this build. */
  async function startCoach() {
    const p = w.project ?? SAMPLE;
    setCoachNote("");
    try {
      const res = await fetch("/api/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted_notice: true, mode: "build", language: choice, ui_language: lang }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === "string" ? body.detail : res.status >= 500 ? t("common.serverDown") : t("common.error", { n: res.status }));
      setCoach({ serverUrl: body.server_url, token: body.participant_token, brief: briefFor(p, analyze(p)) });
    } catch (e) {
      setCoachNote(e instanceof Error ? e.message : String(e));
    }
  }
  const onCoachAction = (a: AppAction) => {
    if (a.action === "show_tab") { if (app) setApp(null); else if (view !== "none") setMem({ view: "none" }); setTab(a.target as typeof tab); }
    else if (a.action === "download_pack") downloadPack(w.project ?? SAMPLE);
    else if (a.action === "save_folder") setSaveAsked(true); // the browser only opens a folder picker on a tap
    else if (a.action === "go_to_step") { const n = Number(a.target); if (n > 0) (w.project ? setMem({ step: n }) : setSampleStep(n)); }
  };
  async function saveFolderNow() {
    setSaveAsked(false);
    const p = w.project ?? SAMPLE;
    const { root, files } = projectFiles(p, analyze(p), w.project ? w.body : SAMPLE_BODY);
    if (canSaveFolder()) { try { await saveToFolder(root, files); return; } catch { /* cancelled: fall back to the zip */ } }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([zip(root, files)], { type: "application/zip" })); a.download = `${root}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
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
    setTimeout(() => download(`${code.name.replace(/\.ino$/, "")}.ino`, code.code), 400);
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

  function guideState(): string {
    const cur = W.current;
    return stateText({
      memory: cur.memory, project: cur.project, report: cur.project ? analyze(cur.project) : null, assessment: cur.idea.assessment,
      idea: cur.idea.input.idea, bench: cur.bench.text, body: cur.project ? bodyText(cur.project, cur.body) : "", design: cur.designText, language: lang,
    }) + panelState();
  }

  async function talk(words?: string) {
    // in a live voice conversation, typed words go into it too
    if (liveSend.current && words?.trim() && !pending.length) {
      say({ role: "user", text: words.trim(), at: Date.now() });
      touchChat(words.trim());
      setText("");
      liveSend.current(words.trim());
      return;
    }
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
          state: guideState(),
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
    if (!hands || !liveFail || busy || speaking || camera || !canListen) return;
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
    let pause = 400;
    r.onerror = (e: { error?: string }) => {
      // no microphone permission: stop retrying and say so; no-speech and aborted just restart below
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed" || e?.error === "audio-capture") { setMicBlocked(true); setHands(false); }
      else if (e?.error === "network") pause = 3000;
    };
    let restart: number | undefined;
    r.onend = () => {
      rec.current = null;
      const said = final.trim();
      setHeard("");
      if (said) void talkRef.current(said);
      // nothing heard: listen again after a breath, while voice mode stays on
      else restart = window.setTimeout(() => setTick((n) => n + 1), pause);
    };
    rec.current = r;
    setMicBlocked(false);
    try { r.start(); } catch { /* already running */ }
    return () => { window.clearTimeout(restart); r.onend = null; try { r.stop(); } catch { /* stopped */ } rec.current = null; };
  }, [hands, liveFail, busy, speaking, camera, speech, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // listening means a live voice conversation: get it a room when listening starts, drop it when it stops
  useEffect(() => {
    if (!hands) { setLive(null); liveSend.current = null; return; }
    if (liveTok || liveFail || ready === false) { if (ready === false) setLiveFail(true); return; }
    let gone = false;
    fetch("/api/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted_notice: true, mode: "guide", language: choice, ui_language: lang }) })
      .then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(String(b.detail ?? r.status)); return b; })
      .then((b) => { if (!gone) setLive({ serverUrl: b.server_url, token: b.participant_token }); })
      .catch(() => { if (!gone) setLiveFail(true); });
    return () => { gone = true; };
  }, [hands, ready, liveTok, liveFail]); // eslint-disable-line react-hooks/exhaustive-deps

  // if the voice never joins (the agent worker isn't running), fall back to the browser's own speech
  useEffect(() => {
    if (!liveTok || liveState !== "connecting") return;
    const id = window.setTimeout(() => { setLive(null); liveSend.current = null; setLiveFail(true); }, 20000);
    return () => window.clearTimeout(id);
  }, [liveTok, liveState]);

  async function liveTool(call: ToolCall): Promise<{ result: string; state: string }> {
    const label = call.why || t(`gd.tool.${call.tool}` as Key);
    setBusy(label);
    let out: string;
    try { out = await run(call); } catch (e) { out = `failed: ${e instanceof Error ? e.message : String(e)}`; }
    finally { setBusy(""); }
    say({ role: "tool", text: `${call.tool}: ${out}`, brief: label, at: Date.now() });
    return { result: out, state: guideState() };
  }

  function toggleHands() {
    const on = !hands;
    setHands(on);
    write("rmx.guide.hands", on ? 1 : 0);
    if (!on) { try { speechSynthesis.cancel(); } catch { /* no speech */ } setSpeaking(false); setHeard(""); }
  }

  // --- the screen -----------------------------------------------------------------------------------------------------

  const view = m.view;
  const shown = interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${interim}` : text;
  const orb = liveTok && hands
    ? (busy ? "thinking" : liveState === "connecting" ? "connecting" : liveState === "idle" ? "listening" : liveState)
    : busy ? "thinking" : speaking ? "speaking" : hands ? "listening" : "idle";
  const last = [...m.messages].reverse().find((x) => x.role === "guide");
  const welcomeBack = m.messages.length > 0 && !busy && m.messages[m.messages.length - 1].at < Date.now() - 30 * 60_000;
  const steps = report?.steps ?? [];
  const panelOpen = app !== null || view !== "none";
  const panelTitle = app ? t(`ws.app.${app}` as Key) : t(`gd.view.${view}` as Key);
  const closePanel = () => { if (app) setApp(null); else setMem({ view: "none" }); setWide(false); };
  const TABS = ["3d", "spec", "code", "tools", "shop"] as const;
  // Ctrl+K / ⌘K opens the command bar; 1 to 5 switch the stage tabs; / jumps to the message box
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((x) => !x); return; }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || cmdOpen) return;
      const n = Number(e.key);
      if (n >= 1 && n <= TABS.length && !panelOpen) { setTab(TABS[n - 1]); return; }
      if (e.key === "/") { e.preventDefault(); askRef.current?.focus(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [panelOpen, cmdOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const commands: Cmd[] = [
    ...TABS.map((k, i) => ({ id: `tab-${k}`, label: t("cmd.show", { what: t(`ws.tab.${k}` as Key) }), hint: String(i + 1), run: () => { closePanel(); setTab(k); } })),
    { id: "ask", label: t("cmd.ask"), hint: "/", run: () => askRef.current?.focus() },
    { id: "coach", label: t("bc.start"), hint: t("bc.startHint"), run: () => void startCoach() },
    ...(["builder", "design_lab", "repair_call", "redesign", "inspection", "library"] as const).map((id) => ({ id: `app-${id}`, label: t(`ws.app.${id}` as Key), hint: t(`ws.app.${id}.d` as Key), run: () => openApp(id) })),
    ...(w.project ? [{ id: "pack", label: t("ws.pack"), run: () => downloadPack(w.project!) }] : []),
    { id: "new", label: t("ws.newProject"), run: () => switchChat(null) },
  ];
  const live = report ?? SAMPLE_REPORT;
  const flags = live.issues.filter((x) => x.level === "fix" || x.level === "block").length + live.issues.filter((x) => x.level === "warn").length;
  const name = profile && !profile.guest ? profile.name.split(" ")[0] : "";
  const section: SectionId = app === "repair_call" || app === "redesign" || app === "demo" ? "repair" : app === "inspection" ? "inspect" : "build";
  // the step card follows the person's own build, or walks through the example until they start one
  const stepList = w.project ? steps : SAMPLE_REPORT.steps;
  const stepAt = w.project ? Math.min(Math.max(1, m.step || 1), Math.max(1, steps.length)) : sampleStep;

  return (
    <div className={`ws${panelOpen ? " ws-panel-open" : ""}${wide && panelOpen ? " ws-wide" : ""}${side ? " ws-side-open" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void attach(Array.from(e.dataTransfer.files)); } }}>

      <aside className="ws-side" aria-label={t("ws.menu")}>
        <div className="ws-side-top">
          <a className="ws-brand" href="#" onClick={(e) => { e.preventDefault(); onTour(); }} aria-label={t("ws.tour")}>
            <Logo size={34} />
            <span><b>RepairMind <em>X</em></b><small>{t("ws.tagline")}</small></span>
          </a>
          <button className="ws-icon ws-only-narrow" aria-label={t("ws.closeMenu")} onClick={() => setSide(false)}>×</button>
        </div>

        <nav className="ws-nav" aria-label={t("ws.tools")}>
          {SECTIONS.map((sec) => {
            const here = section === sec.id;
            return (
              <div key={sec.id} className={`ws-sec${here ? " on" : ""}`}>
                <button className={`ws-sec-main${here ? " on" : ""}`} aria-current={here ? "page" : undefined}
                  onClick={() => { if (sec.main) openApp(sec.main); else { setApp(null); setMem({ view: "none" }); } setSide(false); }}>
                  <NavIcon id={sec.icon} />
                  <span><b>{t(`ws.sec.${sec.id}` as Key)}</b><small>{t(`ws.sec.${sec.id}.d` as Key)}</small></span>
                </button>
                {here && sec.more.length > 0 && (
                  <div className="ws-sub">
                    {sec.more.map((id) => (
                      <button key={id} className={app === id ? "on" : ""} aria-current={app === id ? "page" : undefined} title={t(`ws.app.${id}.d` as Key)} onClick={() => openApp(app === id ? null : id)}>
                        {t(`ws.app.${id}` as Key)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <nav className="ws-chats" aria-label={t("ws.projects")}>
          <div className="ws-label-row">
            <span className="ws-label">{t("ws.projects")}</span>
            <button className="ws-new" onClick={() => switchChat(null)} aria-label={t("ws.newProject")} title={t("ws.newProject")}>＋</button>
          </div>
          {chats.map((c) => (
            <div key={c.id} className={`ws-chat${c.id === chatId ? " on" : ""}`}>
              <button onClick={() => (c.id === chatId ? setSide(false) : switchChat(c.id))} title={c.title}>{c.title}</button>
              <button className="ws-x" aria-label={`${t("gd.remove")} ${c.title}`} onClick={() => deleteChat(c.id)}>×</button>
            </div>
          ))}
          {!chats.length && <p className="ws-none">{t("ws.noProjects")}</p>}
        </nav>

        <div className="ws-side-foot">
          <div className="ws-badge">
            <Shield size={18} />
            <span><b>{t("ws.badge")}</b><small>{t("ws.badge.d")}</small></span>
          </div>
        </div>
      </aside>
      {side && <div className="ws-scrim" onClick={() => setSide(false)} aria-hidden />}

      <CommandBar open={cmdOpen} onClose={() => setCmdOpen(false)} commands={commands} />
      <main className="ws-main lab">
        <header className="ws-top">
          <button className="ws-icon ws-only-narrow" aria-label={t("ws.menu")} onClick={() => setSide(true)}>☰</button>
          <label className="ws-proj">
            <span className="sr-only">{t("ws.projects")}</span>
            <select value={chatId} onChange={(e) => (e.target.value === "__new" ? switchChat(null) : switchChat(e.target.value))}>
              {!chats.some((c) => c.id === chatId) && <option value={chatId}>{w.project?.name || t("xv.untitled")}</option>}
              {chats.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              <option value="__new">＋ {t("ws.newProject")}</option>
            </select>
          </label>
          <span className={`ws-status ${ready ? "on" : ready === false ? "off" : ""}`} role="status">
            <i aria-hidden />{ready ? t("ws.online") : ready === false ? t("ws.offline") : t("ws.checking")}
          </span>
          <dl className="ws-readout ws-only-roomy" aria-label={t("ro.title")} title={w.project ? undefined : t("xv.example")}>
            <div><dt>{t("ro.parts")}</dt><dd>{(w.project ?? SAMPLE).parts.length}</dd></div>
            <div><dt>{t("ro.draw")}</dt><dd>{live.draw.mA}<small>mA</small></dd></div>
            <div><dt>{t("ro.peak")}</dt><dd>{live.draw.peakmA}<small>mA</small></dd></div>
            <div><dt>{t("ro.life")}</dt><dd>{live.hours != null ? hoursText(live.hours).replace(/^about /, "") : live.source?.kind === "usb" ? "USB" : "–"}</dd></div>
            <div><dt>{t("ro.cost")}</dt><dd>₹{live.totalInr.toLocaleString("en-IN")}</dd></div>
            <div className={flags ? "warn" : "ok"}><dt>{t("ro.checks")}</dt><dd>{flags ? t("ro.flags", { n: flags }) : t("ro.pass")}</dd></div>
          </dl>
          <span className="ws-grow" />
          <button className="ws-cmd-btn ws-only-roomy" onClick={() => setCmdOpen(true)} aria-label={t("cmd.title")}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>
            <span>{t("cmd.btn")}</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          {w.project && (
            <details className="gd-more">
              <summary className="lab-chip">{t("gd.more")}</summary>
              <div className="gd-menu">
                {VIEWS.filter((v) => v !== "none").map((v) => <button key={v} onClick={(e) => { closeDetails(e); setApp(null); setMem({ view: v }); }}>{t(`gd.view.${v}` as Key)}</button>)}
                <button onClick={(e) => { closeDetails(e); downloadPack(w.project!); }}>{t("ws.pack")}</button>
              </div>
            </details>
          )}
          <LanguagePicker className="lab-lang ws-only-roomy" />
          <Clock />
          <span className="ws-avatar" title={profile?.name ?? t("ws.guest")} aria-label={profile?.name ?? t("ws.guest")}>{initials(profile?.guest ? "" : profile?.name ?? "") || <PersonIcon />}</span>
        </header>

        <section className="ws-stage" aria-label={panelOpen ? panelTitle : t("xv.title")}>
          {saveAsked && (
            <div className="bc-ask" role="alert">
              <span>{t("bc.saveAsk")}</span>
              <button className="lab-btn solid" onClick={() => void saveFolderNow()}>{t("bc.saveBtn")}</button>
              <button className="ws-icon" aria-label={t("ws.close")} onClick={() => setSaveAsked(false)}>×</button>
            </div>
          )}
          {panelOpen ? (
            <div className="ws-panel">
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
                    onTicks={(ticks) => setMem({ wires: ticks })} onSay={(s) => void talk(s)} />
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="ws-tabs" role="tablist" aria-label={t("xv.title")}>
                {(["3d", "spec", "code", "tools", "shop"] as const).map((k) => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                    <TabIcon id={k} /><span>{t(`ws.tab.${k}` as Key)}</span><kbd className="ws-tab-key" aria-hidden>{["3d", "spec", "code", "tools", "shop"].indexOf(k) + 1}</kbd>
                  </button>
                ))}
                {!w.project && <span className="ws-pill dim ws-tabs-note">{t("xv.example")}</span>}
              </div>
              <div className="ws-stage-body">
                {tab === "3d" && (
                  <Suspense fallback={<div className="xv xv-wait"><span className="lab-spin" aria-hidden /></div>}>
                    <Exploded project={w.project ?? SAMPLE} body={w.project ? w.body : SAMPLE_BODY} sample={!w.project}
                      onAsk={(part) => void talk(w.project ? t("xv.ask", { part }) : t("xv.askSample", { part }))} />
                  </Suspense>
                )}
                {tab === "code" && <CodePane project={w.project ?? SAMPLE} report={report ?? SAMPLE_REPORT} body={w.project ? w.body : SAMPLE_BODY} sample={!w.project} />}
                {tab === "spec" && <SpecPane project={w.project ?? SAMPLE} report={report ?? SAMPLE_REPORT} sample={!w.project} />}
                {tab === "tools" && <ToolsPane project={w.project ?? SAMPLE} report={report ?? SAMPLE_REPORT} sample={!w.project} />}
                {tab === "shop" && <ShopPane report={report ?? SAMPLE_REPORT} sample={!w.project}
                  onCsv={() => download(`${((w.project ?? SAMPLE).name || "parts").replace(/\W+/g, "-")}-parts.csv`, buyCsv(report ?? SAMPLE_REPORT), "text/csv")}
                  onPack={() => downloadPack(w.project ?? SAMPLE)} />}
              </div>
            </>
          )}
        </section>

        {!panelOpen && (
          <div className="ws-dock">
            {coach ? (
              <Suspense fallback={<section className="ws-card ws-camcard"><span className="lab-spin" aria-hidden /></section>}>
                <BuildCall serverUrl={coach.serverUrl} token={coach.token} brief={coach.brief} big={coachBig}
                  onBig={() => setCoachBig((x) => !x)} onAction={onCoachAction} onEnd={(problem) => { setCoach(null); setCoachBig(false); if (problem) setCoachNote(t("bc.failed", { msg: problem })); }} />
              </Suspense>
            ) : (
              <CameraCard onShow={async (f) => { await attach([f]); setTimeout(() => void talkRef.current(t("ws.cam.look")), 50); }} onCall={() => openApp("repair_call")}
                onBuild={() => void startCoach()} note={coachNote} />
            )}
            <StepCard steps={stepList} at={stepAt} done={w.project ? m.done : []} sample={!w.project}
              onGo={(n) => (w.project ? setMem({ step: n }) : setSampleStep(n))}
              onDone={(n) => { setMem({ done: [...new Set([...m.done, n])], step: n + 1 }); void talk(t("gd.didStep", { n })); }}
              onOpen={() => (w.project ? setMem({ view: "steps" }) : void talk(t("xv.startSample")))} />
          </div>
        )}

        <aside className="ws-ai" aria-label={t("ws.ai")}>
          <div className="ws-ai-head">
            <span className="ws-ai-name">{t("ws.ai")}</span>
            <span className={`ws-dot ${ready ? "on" : ready === false ? "off" : ""}`} aria-hidden />
          </div>
          {liveTok && hands && liveOwner && !call && !coach && (
            <Suspense fallback={null}>
              <GuideLive serverUrl={liveTok.serverUrl} token={liveTok.token}
                context={() => ({ state: guideState(), catalog: catalogText() })}
                onTool={liveTool}
                onLine={(who, text) => { say({ role: who, text, at: Date.now() }); if (who === "user") touchChat(text); }}
                onState={setLiveState}
                onReady={(send) => { liveSend.current = send; }}
                onEnd={() => { setLive(null); liveSend.current = null; if (handsRef.current) setLiveFail(true); }} />
            </Suspense>
          )}
          <div className="ws-ai-me">
            <button className="ws-voice-orb" onClick={() => { if (speaking) { try { speechSynthesis.cancel(); } catch { /* */ } setSpeaking(false); } else if (!hands) { setMicBlocked(false); setHands(true); } }}
              aria-label={speaking ? t("ws.voice.speaking") : hands ? t("ws.voice.end") : t("ws.talk")}>
              <VoiceOrb2D state={orb} bands={[]} size={96} detail="compact" />
            </button>
            {(hands || busy || speaking || micBlocked) && (
              <p className="ws-voice-state" role="status">{micBlocked ? t("ws.voice.blocked") : hands && !canListen ? t("ws.voice.unsupported") : heard || (busy ? busy : liveTok && hands ? t(`ws.live.${liveState}` as Key) : speaking ? t("ws.voice.speaking") : t("ws.voice.listening"))}</p>
            )}
          </div>

          <div className="gd-log" aria-live="polite">
            {ready === false && <p className="gd-note" role="note">{t("gd.noModel")} <button className="lab-link" onClick={() => openApp("builder")}>{t("gd.everything")}</button></p>}
            {!m.messages.length && (
              <div className="ws-hello">
                <h1>{name ? t("home.hiName", { hi: t(greeting()), name }) : t(greeting())}</h1>
                <p>{t("gd.hello")}</p>
                <div className="ws-starters">
                  <button className="lab-chip" onClick={() => void talk(t("ws.start.build.say"))}>{t("ws.sec.build")}</button>
                  <button className="lab-chip" onClick={() => openApp("repair_call")}>{t("ws.sec.repair")}</button>
                  <button className="lab-chip" onClick={() => openApp("inspection")}>{t("ws.sec.inspect")}</button>
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

          <div className="ws-ai-controls" role="group" aria-label={t("ws.voiceMode")}>
            <Waveform live={hands || speaking} />
          </div>

          <form className="ws-compose" onSubmit={(e) => { e.preventDefault(); void talk(shown); }}>
            {pending.length > 0 && (
              <div className="gd-pending">
                {pending.map((f) => (
                  <span key={f.id} className="gd-file">{f.thumb ? <img src={f.thumb} alt="" /> : null}{f.name}
                    <button type="button" aria-label={t("gd.remove")} onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}>×</button></span>
                ))}
              </div>
            )}
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
              <textarea ref={askRef} rows={1} value={shown} maxLength={3000} placeholder={t("gd.ph")} aria-label={t("gd.ph")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void talk(shown); } }} />
              <MicButton label=" " onInterim={setInterim}
                onText={(x) => { setInterim(""); setText((v) => (v ? `${v.trimEnd()} ${x}` : x).slice(0, 3000)); }} />
              <button type="submit" className="ws-send" aria-label={t("gd.send")} disabled={!!busy || (!shown.trim() && !pending.length)}>↑</button>
            </div>
          </form>
          <input ref={fileIn} type="file" hidden multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.md,.csv,.json,.stl,.obj,.step,.stp,.dxf,.ino,.c,.cpp,.h,.py"
            onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={folderIn} type="file" hidden multiple {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => { void attach(Array.from(e.target.files ?? []).slice(0, 6)); e.target.value = ""; }} />
        </aside>
      </main>

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

function Stage({ view, world, report, memory, check, onStep, onDone, onPhoto, onPack, onCsv, onTicks, onSay }: {
  view: View; world: World; report: Report | null; memory: Memory; check: PhotoCheck | null;
  onStep: (n: number) => void; onDone: (n: number) => void; onPhoto: () => void; onPack: () => void; onCsv: () => void;
  onTicks: (ticks: number[]) => void;
  onSay: (words: string) => void;
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
          {(a.concepts?.length ?? 0) > 0 && (
            <section className="gd-concepts" aria-label={t("gd.concepts")}>
              <span className="lab-kicker">{t("gd.concepts")}</span>
              <ol>
                {a.concepts!.map((c, i) => (
                  <li key={c.title} className={i === 0 ? "on" : ""}>
                    <div className="gd-c-head">
                      <span className="gd-c-n">{i + 1}</span>
                      <div><b>{auto(c.title)}</b><p>{auto(c.pitch)}</p></div>
                      {i === 0 ? <span className="ws-pill">{t("gd.c.building")}</span>
                        : <button className="lab-btn" onClick={() => onSay(t("gd.c.pick", { title: c.title }))}>{t("gd.c.build")}</button>}
                    </div>
                    <dl>
                      <dt>{t("gd.c.for")}</dt><dd>{auto(c.for_user)}</dd>
                      <dt>{t("gd.c.tech")}</dt><dd>{auto(c.tech)}</dd>
                      <dt>{t("gd.c.new")}</dt><dd>{auto(c.new_because)}</dd>
                      <dt>{t("gd.c.risk")}</dt><dd>{auto(c.risk)}</dd>
                    </dl>
                    <div className="gd-c-foot">
                      <span className="mono">₹{c.cost_inr.toLocaleString("en-IN")}</span>
                      <span>{t(`gd.c.effort.${c.effort}` as Key)}</span>
                      <span className="gd-c-parts">{c.parts.map((id) => BY_ID[id] ? auto(short(BY_ID[id])) : id).join(" · ")}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}
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

// --- the frame around the assistant: navigation icons, clock, avatar, waveform, camera and step cards -------------

function NavIcon({ id }: { id: string }) {
  const d: Record<string, string> = {
    home: "M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z",
    build: "M12 3v2M5.6 5.6l1.4 1.4M3 12h2M18.4 5.6 17 7M21 12h-2M9 18h6M10 21h4M12 7a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9Z",
    repair_call: "M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3",
    design_lab: "M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3M7.5 15h9",
    builder: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7",
    redesign: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
    inspection: "M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4",
    library: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10",
  };
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d[id] ?? d.home} />
    </svg>
  );
}

function PersonIcon() {
  return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>;
}

function SpeakerIcon({ off = false }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {off ? <path d="m16 9 5 6M21 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
    </svg>
  );
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length ? (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() : "";
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = window.setInterval(() => setNow(new Date()), 20_000); return () => window.clearInterval(id); }, []);
  return <time className="ws-clock ws-only-roomy" dateTime={now.toISOString()}>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>;
}

/** Calm bars under the assistant: they move only while it is listening or speaking. */
function Waveform({ live }: { live: boolean }) {
  return (
    <div className={`ws-wave${live ? " live" : ""}`} aria-hidden>
      {Array.from({ length: 28 }, (_, i) => <i key={i} style={{ animationDelay: `${(i % 7) * -0.13}s`, height: `${30 + 50 * Math.abs(Math.sin(i * 0.7))}%` }} />)}
    </div>
  );
}

/**
 * The camera, small, under the 3D view. Off until the person turns it on; nothing is sent until they tap
 * "Show the assistant", and the full live call (where the assistant watches continuously) is one tap away.
 */
function CameraCard({ onShow, onCall, onBuild, note }: { onShow: (f: File) => void | Promise<void>; onCall: () => void; onBuild: () => void; note: string }) {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [err, setErr] = useState(false);
  const [sending, setSending] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null, gone = false;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      .then((s) => { if (gone) { s.getTracks().forEach((x) => x.stop()); return; } stream = s; if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => {}); } })
      .catch(() => { setErr(true); setOn(false); });
    return () => { gone = true; stream?.getTracks().forEach((x) => x.stop()); };
  }, [on]);
  async function show() {
    if (!video.current || sending) return;
    setSending(true);
    const f = await frameToFile(video.current, `camera-${Date.now()}.jpg`);
    if (f) await onShow(f);
    setSending(false);
  }
  return (
    <section className="ws-card ws-camcard" aria-label={t("ws.cam.live")}>
      <div className="ws-card-head">
        <span className="ws-card-title"><Camera2 /> {t("ws.cam.live")}</span>
        {on && <span className="ws-pill"><i aria-hidden /> {t("ws.cam.on")}</span>}
        <span className="ws-grow" />
        <button className="ws-icon" onClick={onCall} aria-label={t("ws.cam.call")} title={t("ws.cam.call")}>
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg>
        </button>
      </div>
      <div className="ws-cam-view">
        {on ? (
          <>
            <video ref={video} muted playsInline />
            <div className="ws-cam-actions">
              <button className="lab-btn solid" onClick={() => void show()} disabled={sending}>{sending ? "…" : t("ws.cam.show")}</button>
              <button className="lab-btn" onClick={() => setOn(false)}>{t("ws.cam.off")}</button>
            </div>
          </>
        ) : (
          <div className="ws-cam-off">
            <button className="lab-btn solid bc-start" onClick={onBuild}><i className="bc-live" aria-hidden />{t("bc.start")}</button>
            <button className="lab-btn" onClick={() => { setErr(false); setOn(true); }}>{t("ws.cam.turnOn")}</button>
            <small>{note || (err ? t("ws.cam.blocked") : t("bc.startHint"))}</small>
          </div>
        )}
      </div>
    </section>
  );
}

function Camera2() {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3" /></svg>;
}

/** One build step at a time, with where you are in the whole build. */
function StepCard({ steps, at, done, sample, onGo, onDone, onOpen }: {
  steps: { title: string; detail: string[]; safety?: string[] }[];
  at: number; done: number[]; sample: boolean;
  onGo: (n: number) => void; onDone: (n: number) => void; onOpen: () => void;
}) {
  const { t, auto } = useI18n();
  const total = steps.length;
  if (!total) {
    return (
      <section className="ws-card ws-stepcard">
        <div className="ws-card-head"><span className="ws-card-title">{t("ws.step.none")}</span></div>
        <p className="ws-step-text">{t("ws.step.noneP")}</p>
      </section>
    );
  }
  const n = Math.min(Math.max(1, at), total);
  const s = steps[n - 1];
  const isDone = done.includes(n);
  return (
    <section className="ws-card ws-stepcard" aria-label={t("ws.step.of", { n, total })}>
      <div className="ws-card-head">
        <span className="ws-card-title">{t("ws.step.of", { n, total })}</span>
        {sample && <span className="ws-pill dim">{t("xv.example")}</span>}
        <span className="ws-grow" />
        <ol className="ws-dots" aria-label={t("ws.step.all")}>
          {steps.map((x, i) => (
            <li key={i}><button className={`${i + 1 === n ? "now" : ""}${done.includes(i + 1) ? " done" : ""}`} aria-label={`${i + 1}. ${auto(x.title)}`} aria-current={i + 1 === n ? "step" : undefined} onClick={() => onGo(i + 1)} /></li>
          ))}
        </ol>
      </div>
      <div className="ws-step-body">
        <span className="ws-step-n" aria-hidden>{isDone ? "✓" : n}</span>
        <div>
          <b>{auto(s.title)}</b>
          {s.detail[0] && <p className="ws-step-text">{auto(s.detail[0])}</p>}
          {s.safety?.[0] && <p className="ws-step-safe"><Shield size={14} /> {auto(s.safety[0])}</p>}
        </div>
      </div>
      <div className="ws-step-nav">
        <button className="lab-btn" disabled={n <= 1} onClick={() => onGo(n - 1)}>‹ {t("ws.step.back")}</button>
        <button className="lab-link" onClick={onOpen}>{sample ? t("ws.step.startSample") : t("ws.step.all")}</button>
        {!sample && !isDone
          ? <button className="lab-btn solid" onClick={() => onDone(n)}>{t("ws.step.did")}</button>
          : <button className="lab-btn solid" disabled={n >= total} onClick={() => onGo(n + 1)}>{t("ws.step.next")} ›</button>}
      </div>
    </section>
  );
}

// --- beside the 3D view: the code, the tools, and the parts to buy ---------------------------------------------------

function TabIcon({ id }: { id: "3d" | "spec" | "code" | "tools" | "shop" }) {
  const d = {
    "3d": "M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12l-8-4.5",
    spec: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    code: "m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
    tools: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z",
    shop: "M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  }[id];
  return <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

function saveText(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const el = document.createElement("a");
  el.href = url; el.download = name;
  document.body.appendChild(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function SampleNote({ sample }: { sample: boolean }) {
  const { t } = useI18n();
  return sample ? <p className="ws-pane-note">{t("ws.pane.sample")}</p> : null;
}

/**
 * The project as a folder, like a code editor: the files down the side, the open one on the right. Saved straight
 * into a folder on the computer where the browser allows it, otherwise downloaded as a .zip.
 */
function CodePane({ project, report, body, sample }: { project: Project; report: Report; body: { spec: ShellSpec } | null; sample: boolean }) {
  const { t } = useI18n();
  const { root, files } = useMemo(() => projectFiles(project, report, body), [project, report, body]);
  const ino = files.find((f) => f.path.endsWith(".ino"))!;
  const [open, setOpen] = useState(ino.path);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const file = files.find((f) => f.path === open) ?? ino;
  const board = project.parts.some((p) => p.id === "esp32") ? "ESP32 Dev Module" : "Arduino Nano";
  // the folder tree: top-level files, then each subfolder with its files
  const dirs = [...new Set(files.filter((f) => f.path.includes("/")).map((f) => f.path.split("/")[0]))];
  const top = files.filter((f) => !f.path.includes("/"));

  function downloadZip() {
    const blob = new Blob([zip(root, files)], { type: "application/zip" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${root}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setNote(t("ws.folder.zipped", { name: `${root}.zip` }));
  }
  async function save() {
    try { const name = await saveToFolder(root, files); setNote(t("ws.folder.saved", { name, n: files.length })); }
    catch (e) { if (!(e instanceof DOMException && e.name === "AbortError")) setNote(t("ws.folder.failed")); }
  }
  const row = (f: FolderFile, depth: number) => (
    <li key={f.path}>
      <button className={f.path === file.path ? "on" : ""} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setOpen(f.path)} title={f.about}>
        <FileIcon name={f.path} /><span>{f.path.split("/").pop()}</span>
      </button>
    </li>
  );
  return (
    <div className="ws-pane ws-ide">
      <SampleNote sample={sample} />
      <div className="ws-pane-head">
        <div>
          <h2><FolderIcon /> {root}</h2>
          <p className="ws-pane-sub">{t("ws.folder.sub", { n: files.length, board })}</p>
        </div>
        <span className="ws-grow" />
        {canSaveFolder() && <button className="lab-btn solid" onClick={() => void save()}>{t("ws.folder.save")}</button>}
        <button className={`lab-btn${canSaveFolder() ? "" : " solid"}`} onClick={downloadZip}>{t("ws.folder.zip")}</button>
      </div>
      {note && <p className="ws-pane-ok" role="status">{note}</p>}
      {report.libs.length > 0 && (
        <p className="ws-libs"><b>{t("ws.code.libs")}</b> {report.libs.map((l) => <code key={l}>{l}</code>)}</p>
      )}
      <div className="ws-ide-body">
        <nav className="ws-tree" aria-label={t("ws.folder.files")}>
          <div className="ws-tree-root"><FolderIcon open /> {root}</div>
          <ul>
            {dirs.map((d) => (
              <li key={d}>
                <div className="ws-tree-dir" style={{ paddingLeft: 26 }}><FolderIcon open /> {d}</div>
                <ul>{files.filter((f) => f.path.startsWith(`${d}/`)).map((f) => row(f, 2))}</ul>
              </li>
            ))}
            {top.map((f) => row(f, 1))}
          </ul>
        </nav>
        <section className="ws-file" aria-label={file.path}>
          <div className="ws-file-head">
            <span className="mono">{file.path}</span>
            <small>{file.about}</small>
            <span className="ws-grow" />
            {typeof file.data === "string" && (
              <button className="lab-chip" onClick={() => { void navigator.clipboard?.writeText(file.data as string).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }).catch(() => {}); }}>
                {copied ? t("ws.code.copied") : t("ws.code.copy")}
              </button>
            )}
          </div>
          {typeof file.data === "string"
            ? <pre className="ws-code"><code>{file.data}</code></pre>
            : <p className="ws-file-bin">{t("ws.folder.stl", { kb: Math.max(1, Math.round(file.data.length / 1024)) })}</p>}
          {file === ino && <p className="ws-pane-sub">{t("ws.code.how", { board })}</p>}
        </section>
      </div>
    </div>
  );
}

function FolderIcon({ open = false }: { open?: boolean }) {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" className="ws-ficon dir">
    {open ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19zM3 19l2.6-7.6A2 2 0 0 1 7.5 10H21l-2.7 7.7a2 2 0 0 1-1.9 1.3z" /> : <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
  </svg>;
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop() ?? "";
  const kind = ext === "ino" ? "code" : ext === "stl" ? "model" : ext === "csv" ? "sheet" : ext === "json" ? "data" : "doc";
  return <span className={`ws-ficon ${kind}`} aria-hidden>{{ code: "</>", model: "3D", sheet: "▦", data: "{}", doc: "¶" }[kind]}</span>;
}

/** The instruments and hand tools this build needs, with where to get them. */
function ToolsPane({ project, report, sample }: { project: Project; report: Report; sample: boolean }) {
  const { t, auto } = useI18n();
  const tools = useMemo(() => toolsFor(project, report), [project, report]);
  const groups: ToolLine["group"][] = ["measure", "software", "assemble", "solder", "make", "safety"];
  return (
    <div className="ws-pane">
      <SampleNote sample={sample} />
      <div className="ws-pane-head"><div><h2>{t("ws.tools.title")}</h2><p className="ws-pane-sub">{t("ws.tools.sub", { n: tools.filter((x) => x.must).length })}</p></div></div>
      {groups.map((g) => {
        const list = tools.filter((x) => x.group === g);
        if (!list.length) return null;
        return (
          <section key={g} className="ws-toolgroup">
            <span className="lab-kicker">{t(`ws.tools.g.${g}` as Key)}</span>
            <ul>
              {list.map((x) => (
                <li key={x.name}>
                  <span className={`ws-need ${x.must ? "must" : ""}`}>{x.must ? t("ws.tools.must") : t("ws.tools.nice")}</span>
                  <div className="ws-tool-text"><b>{auto(x.name)}</b><small>{auto(x.why)}</small></div>
                  {!/Arduino IDE/.test(x.name) && <div className="ws-buybtns">{x.shops.map((s) => <a key={s.name} className="ws-buy-btn" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>)}</div>}
                  {g === "software" && /Arduino IDE/.test(x.name) && <div className="ws-buybtns"><a className="ws-buy-btn" href="https://www.arduino.cc/en/software" target="_blank" rel="noreferrer">{t("ws.tools.getIde")}</a></div>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The engineering spec: every number the checks rest on, with its formula and the working, so anyone can redo it
 * by hand. A load bar shows how close each limit is.
 */
function SpecPane({ project, report, sample }: { project: Project; report: Report; sample: boolean }) {
  const { t, auto } = useI18n();
  const groups = useMemo(() => specSheet(report), [report]);
  const [open, setOpen] = useState<string | null>(null);
  const flagged = groups.flatMap((g) => g.rows).filter((r) => r.verdict === "over" || r.verdict === "tight").length;
  return (
    <div className="ws-pane spec">
      <SampleNote sample={sample} />
      <div className="ws-pane-head">
        <div><h2>{t("ws.spec.title")}</h2><p className="ws-pane-sub">{t("ws.spec.sub")}</p></div>
        <div className="ws-buybtns">
          <span className={`spec-status ${flagged ? "warn" : "ok"}`}>{flagged ? t("ws.spec.flagged", { n: flagged }) : t("ws.spec.clear")}</span>
          <button className="ws-buy-btn" onClick={() => saveText(`${slug(project.name)}-spec.md`, specMarkdown(project.name || "Project", groups), "text/markdown")}>{t("ws.spec.save")}</button>
        </div>
      </div>
      {!groups.length && <p className="ws-pane-sub">{t("ws.spec.empty")}</p>}
      {groups.map((g) => (
        <section key={g.id} className="spec-group">
          <span className="lab-kicker">{t(`ws.spec.g.${g.id}` as Key)}</span>
          <ul>
            {g.rows.map((r) => {
              const ratio = /\((\d+)%\)/.exec(r.value);
              const shown = open === r.key;
              return (
                <li key={r.key} className={`spec-row ${r.verdict}`}>
                  <button className="spec-line" aria-expanded={shown} onClick={() => setOpen(shown ? null : r.key)}>
                    <span className="spec-label">{auto(r.label)}</span>
                    <span className="spec-value">{r.value}</span>
                    {r.verdict !== "info" && <span className={`spec-tag ${r.verdict}`}>{t(`ws.spec.v.${r.verdict}` as Key)}</span>}
                  </button>
                  {ratio && <span className="spec-bar" aria-hidden><i style={{ width: `${Math.min(100, Number(ratio[1]))}%` }} />{r.key !== "fill" && <b style={{ left: "80%" }} />}</span>}
                  {shown && (
                    <div className="spec-math">
                      <code className="spec-f">{r.formula}</code>
                      <code className="spec-w">{r.working}</code>
                      <p>{auto(r.note)}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Every part to buy, with quantity, typical price and buttons that open the shops. */
function ShopPane({ report, sample, onCsv, onPack }: { report: Report; sample: boolean; onCsv: () => void; onPack: () => void }) {
  const { t, auto } = useI18n();
  const { lines, total } = buyList(report);
  return (
    <div className="ws-pane">
      <SampleNote sample={sample} />
      <div className="ws-pane-head">
        <div><h2>{t("ws.shop.title")}</h2><p className="ws-pane-sub">{t("ws.shop.sub")}</p></div>
        <span className="ws-grow" />
        <button className="lab-btn" onClick={onCsv}>{t("ws.buy.csv")}</button>
        <button className="lab-btn solid" onClick={onPack}>{t("ws.pack")}</button>
      </div>
      <ul className="ws-shoplist">
        {lines.map((l) => (
          <li key={l.name}>
            <span className="ws-qty">{l.qty}×</span>
            <div className="ws-tool-text"><b>{auto(l.name)}</b><small>₹{l.each.toLocaleString("en-IN")} {t("ws.shop.each")} · ₹{l.total.toLocaleString("en-IN")}</small></div>
            <div className="ws-buybtns">{l.shops.map((s) => <a key={s.name} className="ws-buy-btn" href={s.url} target="_blank" rel="noreferrer">{t("ws.shop.buyAt", { shop: s.name })}</a>)}</div>
          </li>
        ))}
      </ul>
      <div className="ws-shop-total"><span>{t("ws.shop.total")}</span><b>₹{total.toLocaleString("en-IN")}</b></div>
      <p className="ws-pane-sub">{t("ws.shop.check")}</p>
    </div>
  );
}
