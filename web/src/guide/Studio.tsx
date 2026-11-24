import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import "../lab/lab.css";
import "../build/build.css";
import "./studio.css";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import { VoiceOrb2D } from "../hud/VoiceOrb2D";
import { MicButton, uploadFiles, type AttachmentInfo } from "../lab/inputs.tsx";
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

const STAGES: { id: Memory["stage"]; key: Key; view: View }[] = [
  { id: "idea", key: "gd.st.idea", view: "none" },
  { id: "plan", key: "gd.st.plan", view: "plan" },
  { id: "design", key: "gd.st.design", view: "design" },
  { id: "simulate", key: "gd.st.try", view: "try" },
  { id: "body", key: "gd.st.body", view: "body" },
  { id: "build", key: "gd.st.build", view: "steps" },
];
const ORDER: Memory["stage"][] = ["idea", "understand", "plan", "design", "simulate", "body", "build", "done"];

/**
 * One calm screen: the guide talks, and the one view that helps right now (the plan, the parts, the wiring, the
 * virtual bench, the body, the design, a build step) appears beside it only when it's needed. The guide drives
 * those views itself with tools; the person can still open everything in the full builder.
 */
export function Studio({ onBack }: { onBack: () => void }) {
  const { t, auto, lang, speech } = useI18n();
  const W = useRef<World>(loadWorld());
  const [, render] = useReducer((x: number) => x + 1, 0);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const [pending, setPending] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const [voice, setVoice] = useState(() => read("rmx.guide.voice", (r) => r === "1"));
  const [speaking, setSpeaking] = useState(false);
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
    if (!voice || !words) return;
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
        window.location.hash = "lab";
        return "Opened the full design lab.";
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
      default:
        return `Unknown tool ${call.tool}.`;
    }
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
          }),
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

  // --- the screen -----------------------------------------------------------------------------------------------------

  const view = m.view;
  const shown = interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${interim}` : text;
  const orb = busy ? "thinking" : speaking ? "speaking" : "idle";
  const reached = ORDER.indexOf(m.stage);
  const last = [...m.messages].reverse().find((x) => x.role === "guide");
  const welcomeBack = m.messages.length > 0 && !busy && m.messages[m.messages.length - 1].at < Date.now() - 30 * 60_000;
  const steps = report?.steps ?? [];

  return (
    <main className={`lab gd${view !== "none" ? " gd-split" : ""}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void attach(Array.from(e.dataTransfer.files)); } }}>
      <header className="gd-top">
        <button className="lab-btn ghost" onClick={onBack}>← {t("common.back")}</button>
        <div className="lab-brand"><span className="lab-mark" aria-hidden>◆</span> RepairMind X <i>/</i> <b>{t("gd.title")}</b></div>
        <ol className="gd-rail" aria-label={t("gd.progress")}>
          {STAGES.map((s) => {
            const i = ORDER.indexOf(s.id);
            // a step counts as passed only if this project went through it (not every idea needs a design or a body)
            const went = s.id === "design" ? !!w.design : s.id === "body" ? w.bodyKey > 0 || read(BODY, (r) => !!r) : true;
            const state = m.stage === s.id || (s.id === "plan" && m.stage === "understand") ? "now" : i < reached && went ? "done" : "";
            return <li key={s.id} className={state}><button disabled={!state} onClick={() => setMem({ view: s.view })}>{t(s.key)}</button></li>;
          })}
        </ol>
        <div className="gd-top-r">
          <button className={`lab-chip${voice ? " on" : ""}`} aria-pressed={voice} onClick={() => { const v = !voice; setVoice(v); write("rmx.guide.voice", v ? 1 : 0); if (!v) try { speechSynthesis.cancel(); } catch { /* */ } }}>
            {voice ? t("gd.voiceOn") : t("gd.voiceOff")}
          </button>
          <LanguagePicker className="lab-lang" />
          <details className="gd-more">
            <summary className="lab-chip">{t("gd.more")}</summary>
            <div className="gd-menu">
              <button onClick={() => { window.location.hash = "build"; }}>{t("gd.everything")}</button>
              {w.design && <button onClick={() => { write(DESIGN, w.design); window.location.hash = "lab"; }}>{t("gd.fullLab")}</button>}
              {VIEWS.filter((v) => v !== "none").map((v) => <button key={v} onClick={() => setMem({ view: v })}>{t(`gd.view.${v}` as Key)}</button>)}
              <button className="gd-danger" onClick={startOver}>{t("gd.startOver")}</button>
            </div>
          </details>
        </div>
      </header>

      <div className="gd-body">
        <section className="gd-talk" aria-label={t("gd.title")}>
          <div className="gd-orb" aria-hidden><VoiceOrb2D state={orb} bands={[]} size={view === "none" ? 150 : 76} detail="compact" /></div>
          {ready === false && <p className="gd-note" role="note">{t("gd.noModel")} <button className="lab-link" onClick={() => { window.location.hash = "build"; }}>{t("gd.everything")}</button></p>}

          <div className="gd-log" aria-live="polite">
            {!m.messages.length && (
              <div className="gd-msg guide gd-hello">
                <p>{t("gd.hello")}</p>
                <div className="gd-chips">
                  {(["ia.ex2", "ia.ex3", "ia.ex4"] as Key[]).map((k) => <button key={k} className="lab-chip" onClick={() => void talk(t(k))}>{t(k)}</button>)}
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
                  <button className="lab-btn ghost" onClick={() => fileIn.current?.click()}>{t("gd.sendPhoto")}</button>
                </div>
              </div>
            )}
            {!busy && !m.checkpoint && last && m.chips.length > 0 && (
              <div className="gd-chips">{m.chips.map((c) => <button key={c} className="lab-chip" onClick={() => void talk(c)}>{auto(c)}</button>)}</div>
            )}
            <div ref={endRef} className="gd-end" />
          </div>

          <form className="gd-compose" onSubmit={(e) => { e.preventDefault(); void talk(shown); }}>
            {pending.length > 0 && (
              <div className="gd-pending">
                {pending.map((f) => (
                  <span key={f.id} className="gd-file">{f.thumb ? <img src={f.thumb} alt="" /> : null}{f.name}
                    <button type="button" aria-label={t("gd.remove")} onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}>×</button></span>
                ))}
              </div>
            )}
            <div className="gd-row">
              <button type="button" className="gd-icon" aria-label={t("gd.attach")} title={t("gd.attach")} disabled={uploading} onClick={() => fileIn.current?.click()}>{uploading ? "…" : "+"}</button>
              <textarea rows={1} value={shown} maxLength={3000} placeholder={t("gd.ph")} aria-label={t("gd.ph")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void talk(shown); } }} />
              <MicButton label={t("home.talk")} onInterim={setInterim}
                onText={(x) => { setInterim(""); if (!voice) { setVoice(true); write("rmx.guide.voice", 1); } setText((v) => (v ? `${v.trimEnd()} ${x}` : x).slice(0, 3000)); }} />
              <button type="submit" className="lab-btn solid" disabled={!!busy || (!shown.trim() && !pending.length)}>{t("gd.send")}</button>
            </div>
            <input ref={fileIn} type="file" hidden multiple accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.csv,.stl,.step,.stp,.dxf"
              onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          </form>
        </section>

        {view !== "none" && (
          <section className="gd-stage" aria-label={t(`gd.view.${view}` as Key)}>
            <div className="gd-stage-head">
              <span className="lab-kicker">{t(`gd.view.${view}` as Key)}</span>
              <button className="gd-icon" aria-label={t("gd.hide")} title={t("gd.hide")} onClick={() => setMem({ view: "none" })}>×</button>
            </div>
            <div className="gd-stage-body">
              <Stage view={view} world={w} report={report} memory={m}
                onStep={(n) => setMem({ step: n })}
                onDone={(n) => { setMem({ done: [...new Set([...m.done, n])], step: n + 1 }); void talk(t("gd.didStep", { n })); }} />
            </div>
          </section>
        )}
      </div>
    </main>
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

function Stage({ view, world, report, memory, onStep, onDone }: {
  view: View; world: World; report: Report | null; memory: Memory; onStep: (n: number) => void; onDone: (n: number) => void;
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
    case "wiring": return p && report ? <WiringTab report={report} /> : needProject;
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
      <button className="lab-btn" onClick={() => { write(DESIGN, d); window.location.hash = "lab"; }}>{t("gd.fullLab")}</button>
    </div>
  );
}
