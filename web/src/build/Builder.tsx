import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from "react";
import "../lab/lab.css";
import "../redesign/redesign.css";
import "./build.css";
import { MicButton, uploadFiles, type AttachmentInfo } from "../lab/inputs.tsx";
import { LAB_BRIEF_KEY } from "../redesign/brief";
import { catalogForServer, offlineAssess, toProject, type Assessment, type IdeaInput } from "./assess.ts";
import { AssessmentView, IdeaStart } from "./Assistant.tsx";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import { BY_ID, CATEGORIES, ALL, isBoard, isPower, type Part } from "./parts.ts";
import { analyze, applyFix, freeSpot, pinLabel, short, type Report } from "./engine.ts";
import { firmware } from "./firmware.ts";
import { ACTIONS, TRIGGERS, emptyProject, parseProject, uid, type Project, type Rule } from "./project.ts";
import { autoRules, suggest } from "./templates.ts";
import { WiringDiagram } from "./Wiring.tsx";

const STORE = "rmx.build.project";
/** Hand-off from the start page: a goal typed or spoken there. The builder suggests parts for it once. */
export const BUILD_GOAL_KEY = "rmx.build.goal";
const PART_MIME = "text/x-rmx-part";

function readStored(): Project | null {
  try { const raw = localStorage.getItem(STORE); return raw ? parseProject(raw) : null; } catch { return null; }
}
/** Returns false when the photo made it too big to keep. */
function store(p: Project | null): boolean {
  try {
    if (!p) { localStorage.removeItem(STORE); return true; }
    try { localStorage.setItem(STORE, JSON.stringify(p)); return true; }
    catch { localStorage.setItem(STORE, JSON.stringify({ ...p, product: { ...p.product, photo: undefined } })); return false; }
  } catch { return true; /* storage off: kept for this visit */ }
}
function takeGoal(): string {
  try { const g = sessionStorage.getItem(BUILD_GOAL_KEY) ?? ""; sessionStorage.removeItem(BUILD_GOAL_KEY); return g.slice(0, 400); } catch { return ""; }
}

/** Shrink a photo to a small JPEG so the project stays light enough to save. */
async function photoData(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 960 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.78);
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Drop rules whose parts are gone, so removing a part doesn't leave a list of errors behind. */
function pruneRules(p: Project): Project {
  const ids = new Set(p.parts.map((x) => x.id));
  const ok = (needs: string[]) => !needs.length || needs.some((n) => ids.has(n));
  return { ...p, rules: p.rules.filter((r) => ok(TRIGGERS.find((t) => t.id === r.when)!.needs) && ok(ACTIONS.find((a) => a.id === r.then)!.needs)) };
}

type Tab = "wiring" | "parts" | "code" | "steps" | "details";

const IDEA_STORE = "rmx.build.idea";
interface IdeaState { input: IdeaInput; assessment: Assessment | null; offline: boolean; files: AttachmentInfo[] }
const EMPTY_IDEA: IdeaState = { input: { idea: "", product: "", forKids: false, answers: [], attachment_ids: [] }, assessment: null, offline: false, files: [] };
function readIdea(): IdeaState {
  try { const raw = localStorage.getItem(IDEA_STORE); return raw ? { ...EMPTY_IDEA, ...JSON.parse(raw) } : EMPTY_IDEA; } catch { return EMPTY_IDEA; }
}
function storeIdea(s: IdeaState) {
  try { localStorage.setItem(IDEA_STORE, JSON.stringify(s)); } catch { /* kept for this visit */ }
}

type View = "idea" | "plan" | "build";

/**
 * From an idea to a real thing. Step 1: the person describes an invention, or something they own and how it
 * should be better, with photos or files. Step 2: the analyst (an AI model on the server, or built-in product
 * knowledge offline) says what it understood, asks a few plain questions, judges each wish and lays out a path
 * from a desk prototype to a finished product. Step 3: "Build it" opens the plan on the parts canvas, where the
 * checker (engine.ts) verifies it and produces the wiring, parts list, code and build steps.
 */
export function Builder({ onBack }: { onBack: () => void }) {
  const { t, auto, lang } = useI18n();
  const [project, setProjectState] = useState<Project | null>(readStored);
  const [idea, setIdeaState] = useState<IdeaState>(readIdea);
  const [view, setView] = useState<View>(() => (readStored() ? "build" : readIdea().assessment ? "plan" : "idea"));
  const [busy, setBusy] = useState(false);
  const [goal, setGoal] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<{ input: IdeaInput; extra: { correction?: string } } | null>(null);
  const [over, setOver] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);

  const setProject = (p: Project | null) => {
    setProjectState(p);
    if (!store(p)) setError(t("bd.storageFull"));
  };
  const setIdea = (s: IdeaState) => { setIdeaState(s); storeIdea(s); };

  /** Ask the analyst. Falls back to built-in knowledge when no server or no AI model is available. */
  async function think(input: IdeaInput, extra: { correction?: string } = {}) {
    setBusy(true);
    setError("");
    setFailed(null);
    const withFiles = { ...input, attachment_ids: idea.files.map((f) => f.id) };
    try {
      const res = await fetch("/api/upgrade/assess", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea: withFiles.idea, product: withFiles.product, for_kids: withFiles.forKids, answers: withFiles.answers,
          attachment_ids: withFiles.attachment_ids, language: lang, ...catalogForServer(),
          ...(extra.correction ? { correction: extra.correction, previous: idea.offline ? null : idea.assessment } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) { setIdea({ ...idea, input: withFiles, assessment: body as Assessment, offline: false }); setView("plan"); return; }
      const detail = body && typeof body.detail === "string" ? body.detail : "";
      // the AI is configured but couldn't answer: say so and offer a retry, never a template answer in its place
      if (res.status !== 503 && detail) { setError(detail); setFailed({ input, extra }); return; }
      throw new Error("offline");
    } catch {
      const merged = extra.correction ? { ...withFiles, idea: `${withFiles.idea}. ${extra.correction}` } : withFiles;
      setIdea({ ...idea, input: withFiles, assessment: offlineAssess(merged), offline: true });
      setView("plan");
    } finally {
      setBusy(false);
    }
  }

  function runGoal(text: string, base?: Project) {
    const words = text.trim();
    if (!words) return;
    const s = suggest(words, base);
    if (!s.reasons.length) { setNote(t("bd.noMatch")); return; }
    setProject(s.project);
    setNote(t("bd.suggested", { list: s.reasons.map(auto).join(", ") }));
    setGoal("");
  }

  // an idea typed on the start page: think it through straight away
  useEffect(() => {
    const g = takeGoal();
    if (g) { const input = { ...EMPTY_IDEA.input, idea: g }; setIdea({ ...EMPTY_IDEA, input }); void think(input); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function takeFiles(files: File[]) {
    setError("");
    if (view !== "build") {
      // on the idea and plan steps, dropped files are evidence for the analyst
      try {
        const got = await uploadFiles(files.slice(0, 20 - idea.files.length));
        setIdea({ ...idea, files: [...idea.files, ...got] });
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      return;
    }
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        try {
          const photo = await photoData(f);
          const base = project ?? emptyProject("upgrade");
          setProject({ ...base, product: { ...base.product, photo } });
        } catch { setError(t("bd.badFile")); }
      } else if (f.name.endsWith(".json") || f.type === "application/json") {
        const p = parseProject(await f.text());
        if (p) { setProject(p); setNote(""); } else setError(t("bd.badFile"));
      }
    }
  }

  const pageDrop = {
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: (e: DragEvent) => { if (e.currentTarget === e.target) setOver(false); },
    onDrop: (e: DragEvent) => { if (e.dataTransfer.files.length) { e.preventDefault(); setOver(false); void takeFiles(Array.from(e.dataTransfer.files)); } },
  };

  function build() {
    if (!idea.assessment) return;
    const p = toProject(idea.assessment, idea.input);
    setProject(p);
    setNote("");
    setView("build");
  }

  function toLab() {
    const a = idea.assessment;
    if (!a) return;
    try {
      sessionStorage.setItem(LAB_BRIEF_KEY, JSON.stringify({
        idea: `${a.restated}\n\n${a.plan.summary}`.slice(0, 4000),
        context: [a.plan.other_parts.map((x) => `${x.name}: ${x.why}`).join("\n"), a.wishes.map((w) => `${w.wish}: ${w.verdict}, ${w.why}`).join("\n")].filter(Boolean).join("\n\n").slice(0, 4000),
        attachment_ids: idea.files.map((f) => f.id),
      }));
    } catch { /* the lab opens empty */ }
    window.location.hash = "lab";
  }

  return (
    <main className={`lab bd${over ? " bd-over" : ""}`} {...pageDrop}>
      <header className="lab-top">
        <button className="lab-btn ghost" onClick={view === "build" && idea.assessment ? () => setView("plan") : view === "plan" ? () => setView("idea") : onBack}>
          ← {view === "build" && idea.assessment ? t("ia.backToPlan") : t("common.back")}
        </button>
        <div className="lab-brand"><span className="lab-mark" aria-hidden>◆</span> RepairMind X <i>/</i> <b>{t("bd.title")}</b></div>
        <LanguagePicker className="lab-lang" />
        <div className="bd-top-actions">
          {view === "build" && <button className="lab-btn" onClick={() => fileIn.current?.click()}>{t("bd.openFile")}</button>}
          {view === "build" && project && <button className="lab-btn" onClick={() => download(`${(project.name || "project").replace(/[^\w-]+/g, "_")}.json`, JSON.stringify(project, null, 1), "application/json")}>{t("bd.saveFile")}</button>}
          {view !== "idea" && <button className="lab-btn" onClick={() => { setProject(null); setIdea(EMPTY_IDEA); setNote(""); setView("idea"); }}>{t("bd.new")}</button>}
        </div>
        <input ref={fileIn} type="file" accept=".json,application/json,image/*" hidden onChange={(e) => { void takeFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      </header>
      {error && !failed && <p className="lab-err" role="alert">{auto(error)}</p>}
      {error && failed && (
        <div className="lab-fail" role="alert">
          <b>{t("ia.fail")}</b>
          <p>{auto(error)}</p>
          <div className="lab-row">
            <button className="lab-btn solid" disabled={busy} onClick={() => void think(failed.input, failed.extra)}>{t("lab.fail.retry")}</button>
            <button className="lab-btn" disabled={busy} onClick={() => {
              const merged = failed.extra.correction ? { ...failed.input, idea: `${failed.input.idea}. ${failed.extra.correction}` } : failed.input;
              setIdea({ ...idea, input: { ...failed.input, attachment_ids: idea.files.map((f) => f.id) }, assessment: offlineAssess(merged), offline: true });
              setError(""); setFailed(null); setView("plan");
            }}>{t("ia.fail.basic")}</button>
          </div>
        </div>
      )}

      {view === "idea" && (
        <IdeaStart input={idea.input} setInput={(input) => setIdea({ ...idea, input })} files={idea.files} setFiles={(files) => setIdea({ ...idea, files })}
          busy={busy} onThink={() => void think({ ...idea.input, answers: [] })}
          onCanvas={() => { setProject(project ?? emptyProject("new")); setView("build"); }} />
      )}
      {view === "plan" && idea.assessment && (
        <AssessmentView a={idea.assessment} input={idea.input} offline={idea.offline} busy={busy}
          onAnswers={(answers) => void think({ ...idea.input, answers: [...idea.input.answers.filter((x) => !answers.some((y) => y.q === x.q)), ...answers] })}
          onCorrect={(text) => void think(idea.input, { correction: text })}
          onBuild={build} onLab={toLab} onStartOver={() => { setIdea(EMPTY_IDEA); setView("idea"); }} />
      )}
      {view === "build" && project && (
        <Workspace project={project} setProject={setProject} note={note} setNote={setNote}
          goal={goal} setGoal={setGoal} onGoal={() => runGoal(goal, project)} takeFiles={takeFiles} />
      )}
    </main>
  );
}

// --- start ------------------------------------------------------------------------------------------------

function Composer({ goal, setGoal, onGoal, placeholder, button }: { goal: string; setGoal: (s: string) => void; onGoal: () => void; placeholder: string; button: string }) {
  const { t } = useI18n();
  const [interim, setInterim] = useState("");
  const shown = interim ? `${goal}${goal && !goal.endsWith(" ") ? " " : ""}${interim}` : goal;
  return (
    <form className="bd-composer" onSubmit={(e) => { e.preventDefault(); onGoal(); }}>
      <textarea rows={1} value={shown} placeholder={placeholder} aria-label={placeholder} maxLength={400}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onGoal(); } }} />
      <MicButton label={t("home.talk")} onInterim={setInterim} onText={(w) => setGoal((goal ? `${goal.trimEnd()} ${w}` : w).slice(0, 400))} />
      <button type="submit" className="lab-btn solid" disabled={!shown.trim()}>{button}</button>
    </form>
  );
}

// --- the workspace ----------------------------------------------------------------------------------------

function Workspace(p: {
  project: Project; setProject: (p: Project) => void; note: string; setNote: (s: string) => void;
  goal: string; setGoal: (s: string) => void; onGoal: () => void; takeFiles: (f: File[]) => Promise<void>;
}) {
  const { t, auto } = useI18n();
  const { project, setProject } = p;
  const report = useMemo(() => analyze(project), [project]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("wiring");

  const add = (id: string, at?: { x: number; y: number }) => {
    if (isBoard(BY_ID[id]) && project.parts.some((x) => isBoard(BY_ID[x.id]))) {
      // one brain: dropping another swaps it
      const next = { ...project, parts: project.parts.map((x) => (isBoard(BY_ID[x.id]) ? { ...x, id } : x)) };
      setProject(next);
      return;
    }
    const parts = [...project.parts, { uid: uid(), id, ...(at ?? freeSpot(project.parts)) }];
    const next = { ...project, parts };
    setProject({ ...next, rules: autoRules(next) });
  };
  const remove = (u: string) => { setSelected(null); setProject(pruneRules({ ...project, parts: project.parts.filter((x) => x.uid !== u) })); };
  const blockers = report.issues.filter((i) => i.level !== "tip");
  const tips = report.issues.filter((i) => i.level === "tip");
  const toFix = report.issues.filter((i) => i.level === "block" || i.level === "fix").length;

  return (
    <div className="bd-work">
      <section className="lab-card bd-status" aria-live="polite">
        <div className="bd-status-top">
          <input className="bd-name" value={project.name} placeholder={t("bd.namePh")} aria-label={t("bd.namePh")} maxLength={80}
            onChange={(e) => setProject({ ...project, name: e.target.value })} />
          <div className="bd-seg" role="radiogroup">
            {(["upgrade", "new"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={project.mode === m} className={project.mode === m ? "on" : ""}
                onClick={() => setProject({ ...project, mode: m })}>{t(`bd.mode.${m}` as Key)}</button>
            ))}
          </div>
        </div>
        <p className={`bd-head ${!project.parts.length ? "" : report.ready ? "ok" : "bad"}`}>
          {!project.parts.length ? t("bd.empty") : report.ready ? t("bd.ready") : t("bd.notReady", { n: toFix })}
          {project.parts.length > 0 && <span className="bd-sum">
            {t("bd.cost", { n: report.totalInr.toLocaleString("en-IN") })}
            {" · "}{report.hours !== null ? t("bd.battery", { h: report.hours < 10 ? report.hours.toFixed(1) : Math.round(report.hours) }) : report.source?.kind === "usb" ? t("bd.usbPowered") : ""}
          </span>}
        </p>
        {blockers.length > 0 && (
          <ul className="bd-issues">
            {blockers.map((i) => (
              <li key={i.text} className={`lv-${i.level}`}>
                <span>{auto(i.text)}</span>
                {i.fix && <button className="lab-btn" onClick={() => { const next = pruneRules(applyFix(project, i.fix!, uid)); setProject({ ...next, rules: autoRules(next) }); }}>{auto(i.fix.label)}</button>}
              </li>
            ))}
          </ul>
        )}
        {tips.length > 0 && (
          <details className="lab-fold bd-tips">
            <summary>{t("bd.moreNotes", { n: tips.length })}</summary>
            <ul className="bd-issues">
              {tips.map((i) => (
                <li key={i.text} className="lv-tip"><span>{auto(i.text)}</span>
                  {i.fix && <button className="lab-btn" onClick={() => setProject(pruneRules(applyFix(project, i.fix!, uid)))}>{auto(i.fix.label)}</button>}</li>
              ))}
            </ul>
          </details>
        )}
        <Composer goal={p.goal} setGoal={p.setGoal} onGoal={p.onGoal} placeholder={t("bd.changePh")} button={t("bd.add")} />
        {p.note && <p className="bd-note" role="status">{p.note} <button className="lab-link" onClick={() => p.setNote("")}>{t("bd.close")}</button></p>}
      </section>

      <div className="bd-build">
        <Palette onAdd={(id) => add(id)} />
        <div className="bd-canvas-col">
          <Canvas project={project} report={report} selected={selected} setSelected={setSelected}
            onMove={(u, x, y) => setProject({ ...project, parts: project.parts.map((q) => (q.uid === u ? { ...q, x, y } : q)) })}
            onDropPart={(id, at) => add(id, at)} onFiles={p.takeFiles} />
          {selected && <Selected uid={selected} project={project} report={report} onRemove={remove} onClose={() => setSelected(null)} />}
          <Rules project={project} setProject={setProject} />
          {project.mode === "upgrade" && <ProductForm project={project} setProject={setProject} onFiles={p.takeFiles} />}
        </div>
      </div>

      <section className="bd-out">
        <nav className="lab-tabs" role="tablist">
          {(["wiring", "parts", "code", "steps", "details"] as Tab[]).map((x) => (
            <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>{t(`bd.tab.${x}` as Key)}</button>
          ))}
        </nav>
        <div className="lab-panel">
          {tab === "wiring" && <WiringTab report={report} />}
          {tab === "parts" && <PartsTab report={report} />}
          {tab === "code" && <CodeTab project={project} report={report} />}
          {tab === "steps" && <StepsTab report={report} />}
          {tab === "details" && <DetailsTab project={project} report={report} />}
        </div>
      </section>
    </div>
  );
}

function Palette({ onAdd }: { onAdd: (id: string) => void }) {
  const { t, auto } = useI18n();
  const [q, setQ] = useState("");
  const match = (x: Part) => !q || `${x.name} ${x.plain}`.toLowerCase().includes(q.toLowerCase());
  return (
    <aside className="bd-palette" aria-label={t("bd.parts")}>
      <div className="bd-pal-head">
        <b>{t("bd.parts")}</b>
        <input type="search" value={q} placeholder={t("bd.search")} aria-label={t("bd.search")} onChange={(e) => setQ(e.target.value)} />
        <small>{t("bd.dragOr")}</small>
      </div>
      <div className="bd-pal-list">
        {CATEGORIES.map((c) => {
          const parts = ALL.filter((x) => x.category === c.id && match(x));
          if (!parts.length) return null;
          return (
            <div key={c.id} className="bd-pal-group">
              <span className="lab-kicker">{auto(c.label)}</span>
              {parts.map((x) => (
                <button key={x.id} className={`bd-chip cat-${x.category}`} draggable title={auto(x.plain)}
                  onDragStart={(e) => { e.dataTransfer.setData(PART_MIME, x.id); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => onAdd(x.id)}>
                  <span className="bd-ic" aria-hidden>{x.icon}</span>
                  <span className="bd-chip-t">{auto(short(x))}<small>₹{x.priceInr}</small></span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function Canvas(p: {
  project: Project; report: Report; selected: string | null; setSelected: (u: string | null) => void;
  onMove: (uid: string, x: number, y: number) => void; onDropPart: (id: string, at: { x: number; y: number }) => void; onFiles: (f: File[]) => Promise<void>;
}) {
  const { t, auto } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ uid: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [hot, setHot] = useState(false);
  const rel = (cx: number, cy: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(0.95, Math.max(0.05, (cx - r.left) / r.width)), y: Math.min(0.93, Math.max(0.07, (cy - r.top) / r.height)) };
  };
  const brain = p.project.parts.find((x) => isBoard(BY_ID[x.id]));
  const power = p.project.parts.find((x) => isPower(BY_ID[x.id]) && (BY_ID[x.id] as { kind?: string }).kind !== "switch" && (BY_ID[x.id] as { kind?: string }).kind !== "boost");
  const flagged = new Set(p.report.issues.filter((i) => i.level === "fix" || i.level === "block").flatMap((i) => i.fix?.remove ?? []));

  const down = (e: RPointerEvent, u: string) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    drag.current = { uid: u, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2), sx: e.clientX, sy: e.clientY, moved: false };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
    d.moved = true;
    const at = rel(e.clientX - d.dx, e.clientY - d.dy);
    p.onMove(d.uid, at.x, at.y);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) p.setSelected(p.selected === d.uid ? null : d.uid);
  };

  return (
    <div ref={box} className={`bd-canvas${hot ? " hot" : ""}${p.project.product.photo ? " photo" : ""}`} aria-label={t("bd.canvasAria")} role="region"
      style={p.project.product.photo ? { backgroundImage: `linear-gradient(rgba(5,10,20,0.45), rgba(5,10,20,0.45)), url(${p.project.product.photo})` } : undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes(PART_MIME) || e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setHot(true); } }}
      onDragLeave={() => setHot(false)}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation(); setHot(false);
        const id = e.dataTransfer.getData(PART_MIME);
        if (id && BY_ID[id]) p.onDropPart(id, rel(e.clientX, e.clientY));
        else if (e.dataTransfer.files.length) void p.onFiles(Array.from(e.dataTransfer.files));
      }}>
      {!p.project.parts.length && <p className="bd-canvas-empty">{t("bd.canvasEmpty")}<small>{p.project.mode === "upgrade" && !p.project.product.photo ? t("bd.canvasPhoto") : ""}</small></p>}
      <svg className="bd-wires" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {brain && p.project.parts.filter((x) => x.uid !== brain.uid && !isPower(BY_ID[x.id])).map((x) => (
          <line key={x.uid} x1={brain.x * 100} y1={brain.y * 100} x2={x.x * 100} y2={x.y * 100} className={`cw-${BY_ID[x.id].category}`} />
        ))}
        {brain && power && <line x1={power.x * 100} y1={power.y * 100} x2={brain.x * 100} y2={brain.y * 100} className="cw-power" />}
      </svg>
      {p.project.parts.map((x) => {
        const part = BY_ID[x.id];
        if (!part) return null;
        const pins = p.report.pinsOf[x.uid];
        const pinText = pins ? Object.values(pins).map((v) => pinLabel(p.report.board, v)).join(", ") : "";
        return (
          <button key={x.uid} className={`bd-token cat-${part.category}${p.selected === x.uid ? " sel" : ""}${flagged.has(x.uid) ? " flag" : ""}`}
            style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%` }}
            onPointerDown={(e) => down(e, x.uid)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }}
            onKeyDown={(e) => {
              const step = 0.02;
              const dir: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              if (dir[e.key]) { e.preventDefault(); p.onMove(x.uid, Math.min(0.95, Math.max(0.05, x.x + dir[e.key][0])), Math.min(0.93, Math.max(0.07, x.y + dir[e.key][1]))); }
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.setSelected(p.selected === x.uid ? null : x.uid); }
            }}
            aria-label={auto(part.name)}>
            <span className="bd-ic" aria-hidden>{part.icon}</span>
            <span className="bd-token-t">{auto(short(part))}</span>
            {pinText && <small className="mono">{pinText}</small>}
          </button>
        );
      })}
    </div>
  );
}

function Selected({ uid: u, project, report, onRemove, onClose }: { uid: string; project: Project; report: Report; onRemove: (u: string) => void; onClose: () => void }) {
  const { t, auto } = useI18n();
  const placed = project.parts.find((x) => x.uid === u);
  const part = placed && BY_ID[placed.id];
  if (!part) return null;
  const pins = report.pinsOf[u];
  return (
    <div className="lab-card bd-selected">
      <div className="bd-sel-head">
        <span className="bd-ic" aria-hidden>{part.icon}</span>
        <b>{auto(part.name)}</b>
        <span className="lab-muted">₹{part.priceInr}</span>
        <button className="lab-btn" onClick={() => onRemove(u)}>{t("bd.remove")}</button>
        <button className="lab-btn ghost" onClick={onClose} aria-label={t("bd.close")}>✕</button>
      </div>
      <p>{auto(part.plain)}</p>
      {(part.note || pins || part.kids) && (
        <details className="lab-fold">
          <summary>{t("bd.tab.details")}</summary>
          {pins && <p className="mono">{Object.entries(pins).map(([k, v]) => `${k} → ${pinLabel(report.board, v)}`).join(" · ")}</p>}
          {part.note && <p>{auto(part.note)}</p>}
          {part.mA > 0 && <p className="lab-muted">{part.mA} mA typical, {part.peakmA} mA peak{part.volts ? ` · ${part.volts[0]}–${part.volts[1]} V` : ""}</p>}
          {part.kids && project.product.forKids && <p className="bd-kids">{auto(part.kids)}</p>}
        </details>
      )}
    </div>
  );
}

function Rules({ project, setProject }: { project: Project; setProject: (p: Project) => void }) {
  const { t, auto } = useI18n();
  const ids = new Set(project.parts.map((x) => x.id));
  const avail = (needs: string[]) => !needs.length || needs.some((n) => ids.has(n));
  const edit = (id: string, patch: Partial<Rule>) => setProject({ ...project, rules: project.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const addRule = () => {
    const when = TRIGGERS.find((x) => x.needs.length && avail(x.needs))?.id ?? "start";
    const then = ACTIONS.find((x) => avail(x.needs))?.id ?? "light";
    setProject({ ...project, rules: [...project.rules, { id: uid("r"), when, then, text: then === "say" || then === "show" ? "Hello!" : undefined, color: then === "light" ? "#46e2ff" : undefined }] });
  };
  return (
    <section className="lab-card bd-rules">
      <span className="lab-kicker">{t("bd.does")}</span>
      <small>{t("bd.doesP")}</small>
      {project.rules.map((r) => (
        <div key={r.id} className="bd-rule">
          <span className="bd-rule-w">{t("bd.when")}</span>
          <select value={r.when} aria-label={t("bd.when")} onChange={(e) => edit(r.id, { when: e.target.value as Rule["when"] })}>
            {TRIGGERS.map((x) => <option key={x.id} value={x.id}>{auto(x.label.replace(/^When /, ""))}{avail(x.needs) ? "" : " (+)"}</option>)}
          </select>
          <span className="bd-rule-w">{t("bd.then")}</span>
          <select value={r.then} aria-label={t("bd.then")} onChange={(e) => {
            const then = e.target.value as Rule["then"];
            edit(r.id, { then, text: then === "say" || then === "show" ? r.text || "Hello!" : r.text, color: then === "light" ? r.color || "#46e2ff" : r.color });
          }}>
            {ACTIONS.map((x) => <option key={x.id} value={x.id}>{auto(x.label)}{avail(x.needs) ? "" : " (+)"}</option>)}
          </select>
          {(r.then === "say" || r.then === "show") && (
            <input value={r.text ?? ""} maxLength={r.then === "show" ? 20 : 120} aria-label={r.then === "say" ? t("bd.words") : t("bd.screenText")}
              placeholder={r.then === "say" ? t("bd.words") : t("bd.screenText")} onChange={(e) => edit(r.id, { text: e.target.value })} />
          )}
          {r.then === "light" && <input type="color" value={r.color ?? "#46e2ff"} aria-label={t("bd.colour")} onChange={(e) => edit(r.id, { color: e.target.value })} />}
          <button className="lab-btn ghost" aria-label={t("bd.removeRule")} onClick={() => setProject({ ...project, rules: project.rules.filter((x) => x.id !== r.id) })}>✕</button>
        </div>
      ))}
      <button className="lab-btn bd-add-rule" onClick={addRule}>{t("bd.addRule")}</button>
    </section>
  );
}

function ProductForm({ project, setProject, onFiles }: { project: Project; setProject: (p: Project) => void; onFiles: (f: File[]) => Promise<void> }) {
  const { t } = useI18n();
  const pr = project.product;
  const set = (patch: Partial<Project["product"]>) => setProject({ ...project, product: { ...pr, ...patch } });
  const pick = useRef<HTMLInputElement>(null);
  const dim = (i: number, v: string) => {
    const n = Math.max(0, Math.min(2000, Number(v) || 0));
    const cur = pr.inner ?? [0, 0, 0];
    const next = cur.map((x, j) => (j === i ? n : x)) as [number, number, number];
    set({ inner: next.every((x) => x > 0) ? next : next.some((x) => x > 0) ? next : null });
  };
  const empty = !pr.what && !pr.does;
  return (
    <details className="lab-fold bd-product" open={empty || undefined}>
      <summary>{t("bd.product")}{pr.what ? `: ${pr.what}` : ""}</summary>
      <small>{t("bd.productP")}</small>
      <div className="bd-row2">
        <label className="rd-field"><span>{t("bd.what")}</span><input value={pr.what} maxLength={120} placeholder={t("bd.whatPh")} onChange={(e) => set({ what: e.target.value })} /></label>
        <label className="rd-field"><span>{t("bd.doesNow")}</span><input value={pr.does} maxLength={200} placeholder={t("bd.doesNowPh")} onChange={(e) => set({ does: e.target.value })} /></label>
      </div>
      <div className="bd-row2">
        <label className="rd-field"><span>{t("bd.poweredBy")}</span>
          <select value={pr.power} onChange={(e) => set({ power: e.target.value as Project["product"]["power"] })}>
            {(["battery", "usb", "wall", "none"] as const).map((x) => <option key={x} value={x}>{t(`bd.pw.${x}` as Key)}</option>)}
          </select>
        </label>
        <div className="rd-field"><span>{t("bd.inside")}</span>
          <div className="bd-dims">
            {["W", "H", "D"].map((l, i) => (
              <input key={l} type="number" min={0} max={2000} inputMode="numeric" aria-label={`${t("bd.inside")} ${l}`} placeholder={l}
                value={pr.inner?.[i] || ""} onChange={(e) => dim(i, e.target.value)} />
            ))}
          </div>
        </div>
      </div>
      <label className="x-check bd-kids-check">
        <input type="checkbox" checked={pr.forKids} onChange={(e) => set({ forKids: e.target.checked })} />
        <span className="box" aria-hidden />
        <span>{t("bd.forKids")}</span>
      </label>
      <div className="bd-photo-row">
        <span className="lab-muted">{t("bd.photo")}</span>
        {pr.photo && <img src={pr.photo} alt="" />}
        <button className="lab-btn" onClick={() => pick.current?.click()}>{t("bd.addPhoto")}</button>
        {pr.photo && <button className="lab-btn ghost" onClick={() => set({ photo: undefined })}>{t("bd.removePhoto")}</button>}
        <input ref={pick} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      </div>
    </details>
  );
}

// --- outputs ----------------------------------------------------------------------------------------------

function WiringTab({ report }: { report: Report }) {
  const { t, auto } = useI18n();
  if (!report.conns.length) return <p className="lab-muted">{t("bd.stepsEmpty")}</p>;
  return (
    <>
      <p className="lab-muted">{t("bd.wiringP")}</p>
      <WiringDiagram report={report} />
      <details className="lab-fold">
        <summary>{t("bd.wireTable")}</summary>
        <div className="lab-scroll">
          <table className="lab-table">
            <thead><tr><th>{t("bd.from")}</th><th>{t("bd.to")}</th><th>{t("bd.through")}</th></tr></thead>
            <tbody>
              {report.conns.map((c, i) => (
                <tr key={i} className={`k-${c.kind}`}><td>{auto(c.from)} <span className="mono">{c.fromPin}</span></td><td>{auto(c.to)} <span className="mono">{c.toPin}</span></td><td>{c.via ? auto(c.via) : ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

function PartsTab({ report }: { report: Report }) {
  const { t, auto } = useI18n();
  if (!report.bom.length) return <p className="lab-muted">{t("bd.stepsEmpty")}</p>;
  return (
    <>
      <div className="lab-scroll">
        <table className="lab-table bd-bom">
          <thead><tr><th>{t("bd.qty")}</th><th>{t("bd.item")}</th><th>{t("bd.each")}</th><th>{t("bd.total")}</th></tr></thead>
          <tbody>
            {report.bom.map((l) => (
              <tr key={l.id}><td>{l.qty}</td><td>{auto(l.name)}{l.note && <small>{auto(l.note)}</small>}</td><td>₹{l.each}</td><td>₹{l.total}</td></tr>
            ))}
            <tr className="bd-bom-total"><td /><td>{t("bd.total")}</td><td /><td>₹{report.totalInr.toLocaleString("en-IN")}</td></tr>
          </tbody>
        </table>
      </div>
      <small>{t("bd.priceNote")}</small>
    </>
  );
}

function CodeTab({ project, report }: { project: Project; report: Report }) {
  const { t } = useI18n();
  const { name, code } = useMemo(() => firmware(project, report), [project, report]);
  const [copied, setCopied] = useState(false);
  if (!report.board) return <p className="lab-muted">{t("bd.noCode")}</p>;
  return (
    <>
      <p className="lab-muted">{t("bd.codeP")}</p>
      <div className="bd-code-actions">
        <span className="mono">{name}</span>
        <button className="lab-btn" onClick={() => { void navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? t("bd.copied") : t("bd.copy")}</button>
        <button className="lab-btn" onClick={() => download(name, code, "text/plain")}>{t("bd.download")}</button>
      </div>
      <pre className="bd-code"><code>{code}</code></pre>
    </>
  );
}

function StepsTab({ report }: { report: Report }) {
  const { t, auto } = useI18n();
  if (!report.steps.length) return <p className="lab-muted">{t("bd.stepsEmpty")}</p>;
  return (
    <ol className="bd-steps">
      {report.steps.map((s) => (
        <li key={s.title}>
          <b>{auto(s.title)}</b>
          <ul>{s.detail.map((d) => <li key={d}>{auto(d)}</li>)}</ul>
          {s.safety && <div className="bd-safety"><span className="lab-kicker">{t("bd.safety")}</span><ul>{s.safety.map((d) => <li key={d}>{auto(d)}</li>)}</ul></div>}
        </li>
      ))}
    </ol>
  );
}

function DetailsTab({ project, report }: { project: Project; report: Report }) {
  const { t, auto } = useI18n();
  const f = report.fit;
  const v = Math.round(f.partsVolume);
  const inner = f.innerVolume ? Math.round(f.innerVolume) : 0;
  const seen = new Set<string>();
  const notes = project.parts.map((x) => BY_ID[x.id]).filter((x) => x && x.note && !seen.has(x.id) && seen.add(x.id));
  return (
    <div className="bd-details">
      <h4>{t("bd.power")}</h4>
      {report.rail5 && <p className="lab-muted">{t("bd.supply", { v: report.rail5[0] === report.rail5[2] ? `${report.rail5[0]} V` : `${report.rail5[1]}–${report.rail5[2]} V (${report.rail5[0]} V nominal)` })}</p>}
      <div className="lab-scroll">
        <table className="lab-table">
          <thead><tr><th>{t("bd.item")}</th><th>{t("bd.rail")}</th><th>{t("bd.typical")}</th><th>{t("bd.peak")}</th></tr></thead>
          <tbody>{report.budget.map((b, i) => <tr key={i}><td>{auto(b.name)}</td><td>{b.rail}</td><td>{b.mA} mA</td><td>{b.peakmA} mA</td></tr>)}</tbody>
        </table>
      </div>
      <p>{t("bd.atSource", { mA: report.draw.mA, peak: report.draw.peakmA })}{report.hours !== null ? ` ${t("bd.battery", { h: report.hours.toFixed(1) })}.` : ""}</p>
      {report.pinMap.length > 0 && <>
        <h4>{t("bd.pins")}</h4>
        <ul className="mono bd-pins">{report.pinMap.map((x) => <li key={x.pin}>{pinLabel(report.board, x.pin)}: {auto(x.use)}</li>)}</ul>
      </>}
      <h4>{t("bd.fit")}</h4>
      <p>{f.state === "unknown" ? t("bd.fit.unknown", { v }) : project.mode === "new" ? (f.box ? t("bd.fit.box", { name: f.box.name }) : t("bd.fit.no", { v, inner })) : t(`bd.fit.${f.state}` as Key, { v, inner })}</p>
      {notes.length > 0 && <>
        <h4>{t("bd.partNotes")}</h4>
        <ul>{notes.map((x) => <li key={x.id}><b>{auto(short(x))}:</b> {auto(x.note!)}</li>)}</ul>
      </>}
    </div>
  );
}
