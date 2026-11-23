import { useEffect, useState } from "react";
import "../lab/lab.css";
import "./redesign.css";
import { Attachments, MicButton, type AttachmentInfo } from "../lab/inputs.tsx";
import {
  api, BRIEF_ID_KEY, EMPTY_BRIEF, LAB_BRIEF_KEY, LAST_CALL_KEY, read, store,
  type Check, type DesignBrief, type FailureMode, type LibraryRecord, type LibraryStats, type Measure, type Outcome,
} from "./brief";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";

type Answer = { brief: DesignBrief; check: Check };
const SOURCES: Measure["source"][] = ["measured", "label", "spec", "user", "estimated"];
/** This page's attachments survive a reload in this tab; they go to the design lab, never the failure library. */
const ATT_KEY = "rmx.redesign.attachments";
function readAtt(): AttachmentInfo[] {
  try { return JSON.parse(sessionStorage.getItem(ATT_KEY) ?? "[]"); } catch { return []; }
}
function writeAtt(a: AttachmentInfo[]) {
  try { sessionStorage.setItem(ATT_KEY, JSON.stringify(a)); } catch { /* not kept across reloads; fine */ }
}
const OUTCOMES: Outcome[] = ["pending", "holding", "failed_again"];

/** Turn a repair call into a checked design brief, send it to the design lab, and keep a failure library. */
export function Redesign({ onBack }: { onBack: () => void }) {
  const { t, auto } = useI18n();
  const [tab, setTab] = useState<"brief" | "library">("brief");
  const [brief, setBrief] = useState<DesignBrief | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [modes, setModes] = useState<FailureMode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const lastRoom = read(LAST_CALL_KEY);
  const [files, setFilesState] = useState<AttachmentInfo[]>(readAtt);
  const [canHear, setCanHear] = useState(false);
  const setFiles = (a: AttachmentInfo[]) => { setFilesState(a); writeAtt(a); };
  useEffect(() => {
    api<{ media?: boolean }>("/api/lab/status").then((s) => setCanHear(!!s.media)).catch(() => undefined);
  }, []);

  useEffect(() => {
    api<{ modes: FailureMode[] }>("/api/redesign/failure-modes").then((r) => setModes(r.modes)).catch(() =>
      setError(t("common.serverDown")));
    const id = read(BRIEF_ID_KEY);
    if (id) api<Answer>(`/api/redesign/briefs/${id}`).then(take).catch(() => store(BRIEF_ID_KEY, null));
  }, []);

  function take(a: Answer) {
    setBrief(a.brief);
    setCheck(a.check);
    setDirty(false);
    store(BRIEF_ID_KEY, a.brief.id);
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError("");
    setNote("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  const fromCall = () => run(t("rd.busy.reading"), async () => {
    if (lastRoom) take(await api<Answer>("/api/redesign/briefs/from-session", { room: lastRoom }));
  });
  const blank = () => run(t("rd.busy.starting"), async () => take(await api<Answer>("/api/redesign/briefs", EMPTY_BRIEF)));
  const save = () => run(t("rd.busy.checking"), async () => { if (brief) take(await api<Answer>("/api/redesign/briefs", brief)); });

  async function toLab() {
    if (!brief) return;
    await run(t("rd.busy.handoff"), async () => {
      const saved = await api<Answer>("/api/redesign/briefs", brief);
      take(saved);
      const handoff = await api<{ idea: string; context: string }>(`/api/redesign/briefs/${saved.brief.id}/lab`, {});
      try {
        sessionStorage.setItem(LAB_BRIEF_KEY, JSON.stringify({ ...handoff, attachment_ids: files.map((f) => f.id) }));
      } catch {
        throw new Error(t("rd.handoffBlocked"));
      }
      window.location.hash = "lab";
    });
  }

  async function share() {
    if (!brief) return;
    await run(t("rd.busy.adding"), async () => {
      const saved = await api<Answer>("/api/redesign/briefs", brief);
      take(saved);
      await api(`/api/redesign/briefs/${saved.brief.id}/share`, {});
      setBrief({ ...saved.brief, share_to_library: true });
      setNote(t("rd.added"));
    });
  }

  function set<K extends keyof DesignBrief>(k: K, v: DesignBrief[K]) {
    if (!brief) return;
    setBrief({ ...brief, [k]: v });
    setDirty(true);
  }

  const mode = modes.find((m) => m.id === brief?.failure_mode);

  return (
    <main className="lab rd">
      <header className="lab-top">
        <button className="lab-btn ghost" onClick={onBack}>← {t("common.back")}</button>
        <div className="lab-brand"><span className="lab-mark" aria-hidden>◆</span> RepairMind X <i>/</i> <b>{t("rd.title")}</b></div>
        <LanguagePicker className="lab-lang" />
        <nav className="lab-tabs rd-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "brief"} className={tab === "brief" ? "on" : ""} onClick={() => setTab("brief")}>{t("rd.tab.brief")}</button>
          <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>{t("rd.tab.library")}</button>
        </nav>
      </header>
      {error && <p className="lab-err" role="alert">{auto(error)}</p>}
      {note && <p className="rd-note" role="status">{note}</p>}

      {tab === "library" ? <Library modes={modes} /> : !brief ? (
        <section className="rd-start">
          <p className="lab-lede">{t("rd.intro")}</p>
          <div className="rd-start-row">
            <button className="lab-btn solid" disabled={!lastRoom || !!busy} onClick={fromCall}>{t("rd.fromCall")}</button>
            <button className="lab-btn" disabled={!!busy} onClick={blank}>{t("rd.blank")}</button>
          </div>
          {!lastRoom && <p className="lab-muted">{t("rd.noCall")}</p>}
        </section>
      ) : (
        <div className="lab-grid rd-grid">
          <aside className="lab-side">
            <CheckPanel check={check} dirty={dirty} />
            <section className="lab-card">
              <button className="lab-btn" disabled={!!busy || !dirty} onClick={save}>{busy === t("rd.busy.checking") ? t("rd.checkingBtn") : t("rd.save")}</button>
              <button className="lab-btn solid" disabled={!!busy || !!check?.blocked} onClick={toLab}>{t("rd.toLab")}</button>
              <button className="lab-btn" disabled={!!busy || !!check?.blocked || brief.share_to_library} onClick={share}>
                {brief.share_to_library ? t("rd.inLibrary") : t("rd.addLibrary")}
              </button>
              <small>{t("rd.libraryKeeps")}</small>
              <button className="lab-btn ghost" disabled={!!busy} onClick={() => { store(BRIEF_ID_KEY, null); setBrief(null); setCheck(null); }}>{t("rd.another")}</button>
              {busy && <span className="lab-muted" aria-live="polite">{busy}…</span>}
            </section>
          </aside>

          <section className="lab-main rd-form">
            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.thePart")}</legend>
              <div className="rd-row3">
                <Field label={t("rd.device")} value={brief.device} onChange={(v) => set("device", v)} placeholder={t("rd.devicePh")} />
                <Field label={t("rd.brand")} value={brief.brand} onChange={(v) => set("brand", v)} />
                <Field label={t("rd.model")} value={brief.model} onChange={(v) => set("model", v)} />
              </div>
              <Field label={t("rd.whichPart")} value={brief.part} onChange={(v) => set("part", v)} placeholder={t("rd.partPh")} />
              <Field label={t("rd.mustDo")} value={brief.part_function} onChange={(v) => set("part_function", v)} placeholder={t("rd.mustDoPh")} long />
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.howFailed")}</legend>
              <div className="rd-row2">
                <label className="rd-field"><span>{t("rd.failureMode")}</span>
                  <select value={brief.failure_mode} onChange={(e) => set("failure_mode", e.target.value)}>
                    <option value="unknown">{t("rd.notSure")}</option>
                    {modes.map((m) => <option key={m.id} value={m.id}>{auto(m.name)}</option>)}
                  </select>
                </label>
                <label className="rd-field"><span>{t("rd.howSure")}</span>
                  <select value={brief.failure_mode_certainty} onChange={(e) => set("failure_mode_certainty", e.target.value as DesignBrief["failure_mode_certainty"])}>
                    <option value="">—</option>
                    <option value="seen">{t("rd.seen")}</option>
                    <option value="suspected">{t("rd.suspected")}</option>
                  </select>
                </label>
              </div>
              {!!check?.suggested_modes.length && (
                <div className="lab-examples">
                  <span className="lab-muted">{t("rd.fromDesc")}</span>
                  {check.suggested_modes.map((s) => (
                    <button key={s.id} className={`lab-chip${s.id === brief.failure_mode ? " on" : ""}`} onClick={() => set("failure_mode", s.id)}>{auto(s.name)}</button>
                  ))}
                </div>
              )}
              {mode && (
                <div className="rd-mode">
                  <div><b>{t("rd.lookFor")}</b><ul>{mode.signs.map((x) => <li key={x}>{auto(x)}</li>)}</ul></div>
                  <div><b>{t("rd.causes")}</b><ul>{mode.causes.map((x) => <li key={x}>{auto(x)}</li>)}</ul></div>
                  <div><b>{t("rd.ask")}</b><ul>{mode.questions.map((x) => <li key={x}>{auto(x)}</li>)}</ul></div>
                </div>
              )}
              <Field label={t("rd.diagnosis")} value={brief.diagnosis} onChange={(v) => set("diagnosis", v)} long />
              <MicButton label={t("rd.byVoice")} onText={(t) => set("diagnosis", (brief.diagnosis ? `${brief.diagnosis.trimEnd()} ${t}` : t).slice(0, 400))} />
              {!!brief.observations.length && (
                <details><summary className="lab-muted">{t("rd.notes", { n: brief.observations.length })}</summary>
                  <ul>{brief.observations.map((o, i) => <li key={i}>{o}</li>)}</ul></details>
              )}
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.files")}</legend>
              <small>{t("rd.filesP")}</small>
              <Attachments items={files} onChange={setFiles} canHearMedia={canHear} compact />
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.sizes")}</legend>
              <Measures items={brief.dimensions} onChange={(v) => set("dimensions", v)} namePh={t("rd.sizePh")} valuePh="2 mm" />
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.loads")}</legend>
              <Measures items={brief.operating} onChange={(v) => set("operating", v)} namePh={t("rd.loadPh")} valuePh="20 N" />
              <small>{t("rd.loadsP")}</small>
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">{t("rd.materialMaking")}</legend>
              <div className="rd-row2">
                <Field label={t("rd.oldMaterial")} value={brief.material} onChange={(v) => set("material", v)} placeholder={t("rd.materialPh")} />
                <label className="rd-field"><span>{t("rd.knownFrom")}</span>
                  <select value={brief.material_source} onChange={(e) => set("material_source", e.target.value as Measure["source"])}>
                    <option value="">—</option>
                    {SOURCES.map((s) => <option key={s} value={s}>{t(`rd.src.${s}` as Key)}</option>)}
                  </select>
                </label>
              </div>
              <div className="rd-row2">
                <Field label={t("rd.madeBy")} value={brief.manufacturing} onChange={(v) => set("manufacturing", v)} placeholder={t("rd.madeByPh")} />
                <label className="rd-field"><span>{t("rd.safetyFactor")}</span>
                  <input type="number" min={1} max={10} step={0.1} value={brief.safety_factor}
                    onChange={(e) => set("safety_factor", Math.min(10, Math.max(1, Number(e.target.value) || 1.5)))} />
                </label>
              </div>
              <label className="rd-field"><span>{t("rd.constraints")}</span>
                <textarea rows={3} value={brief.constraints.join("\n")} placeholder={t("rd.constraintsPh")}
                  onChange={(e) => set("constraints", e.target.value.split("\n").map((s) => s.slice(0, 200)).slice(0, 20))} />
              </label>
            </fieldset>
          </section>
        </div>
      )}
    </main>
  );
}

function Field(p: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; long?: boolean }) {
  return (
    <label className="rd-field"><span>{p.label}</span>
      {p.long
        ? <textarea rows={2} value={p.value} placeholder={p.placeholder} maxLength={400} onChange={(e) => p.onChange(e.target.value)} />
        : <input value={p.value} placeholder={p.placeholder} maxLength={120} onChange={(e) => p.onChange(e.target.value)} />}
    </label>
  );
}

function Measures({ items, onChange, namePh, valuePh }: { items: Measure[]; onChange: (m: Measure[]) => void; namePh: string; valuePh: string }) {
  const { t } = useI18n();
  const edit = (i: number, patch: Partial<Measure>) => onChange(items.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="rd-measures">
      {items.map((m, i) => (
        <div className="rd-measure" key={i}>
          <input aria-label={t("rd.name")} value={m.name} placeholder={namePh} maxLength={80} onChange={(e) => edit(i, { name: e.target.value })} />
          <input aria-label={t("rd.valueUnit")} value={m.value} placeholder={valuePh} maxLength={40} onChange={(e) => edit(i, { value: e.target.value })} />
          <select aria-label={t("rd.source")} value={m.source} onChange={(e) => edit(i, { source: e.target.value as Measure["source"] })}>
            <option value="">{t("rd.src.q")}</option>
            {SOURCES.map((s) => <option key={s} value={s}>{t(`rd.src.${s}` as Key)}</option>)}
          </select>
          <button className="lab-btn ghost" aria-label={t("rd.remove")} onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {items.length < 30 && <button className="lab-btn" onClick={() => onChange([...items, { name: "", value: "", source: "" }])}>{t("rd.add")}</button>}
    </div>
  );
}

function CheckPanel({ check, dirty }: { check: Check | null; dirty: boolean }) {
  const { t, auto } = useI18n();
  if (!check) return null;
  return (
    <section className="lab-card rd-check" aria-live="polite">
      <span className="lab-kicker">{t("rd.check")}{dirty ? t("rd.unsaved") : ""}</span>
      {check.blocked ? <p className="rd-bad"><b>{t("rd.cant")}</b> {auto(check.blocked)}</p>
        : check.ready ? <p className="rd-ok">{t("rd.ready")}</p>
          : <p className="rd-warn">{t("rd.notReady")}</p>}
      {check.needs_signoff && <p className="rd-warn"><b>{t("rd.signoff")}</b> {auto(check.signoff_reason)}</p>}
      {!!check.errors.length && <><b>{t("rd.fixThese")}</b><ul className="rd-bad">{check.errors.map((x) => <li key={x}>{auto(x)}</li>)}</ul></>}
      {!!check.missing.length && <><b>{t("rd.missing")}</b><ul>{check.missing.map((x) => <li key={x}>{auto(x)}</li>)}</ul></>}
      {!!check.assumptions.length && <><b>{t("rd.assumptions")}</b><ul className="lab-muted">{check.assumptions.map((x) => <li key={x}>{auto(x)}</li>)}</ul></>}
      <b>{t("rd.mustPass")}</b>
      <ul>{check.required_analyses.map((a) => <li key={a.id}>{auto(a.text)}</li>)}</ul>
    </section>
  );
}

function Library({ modes }: { modes: FailureMode[] }) {
  const { t, auto } = useI18n();
  const [q, setQ] = useState("");
  const [mode, setMode] = useState("");
  const [rows, setRows] = useState<LibraryRecord[]>([]);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [error, setError] = useState("");

  const load = () => {
    const params = new URLSearchParams({ q, mode });
    Promise.all([api<LibraryRecord[]>(`/api/redesign/library?${params}`), api<LibraryStats>("/api/redesign/library/stats")])
      .then(([r, s]) => { setRows(r); setStats(s); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [mode]);

  async function mark(id: string, outcome: Outcome) {
    try {
      const rec = await api<LibraryRecord>(`/api/redesign/library/${id}/outcome`, { outcome });
      setRows((rs) => rs.map((r) => (r.brief_id === id ? rec : r)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const max = Math.max(1, ...(stats?.by_mode.map((m) => m.count) ?? [1]));
  return (
    <section className="rd-lib">
      <p className="lab-lede">{t("rd.lib.intro")}</p>
      {error && <p className="lab-err">{auto(error)}</p>}
      {stats && stats.total > 0 && (
        <div className="lab-card rd-stats">
          <span className="lab-kicker">{t("rd.lib.stats", { n: stats.total, hold: stats.outcomes.holding ?? 0, again: stats.outcomes.failed_again ?? 0 })}</span>
          {stats.by_mode.map((m) => (
            <div className="rd-bar" key={m.id}><span>{auto(m.name)}</span><i style={{ width: `${(m.count / max) * 100}%` }} /><b>{m.count}</b></div>
          ))}
        </div>
      )}
      <form className="rd-search" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("rd.lib.searchPh")} aria-label={t("rd.lib.search")} />
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label={t("rd.failureMode")}>
          <option value="">{t("rd.lib.all")}</option>
          {modes.map((m) => <option key={m.id} value={m.id}>{auto(m.name)}</option>)}
        </select>
        <button className="lab-btn">{t("rd.lib.search")}</button>
      </form>
      {rows.length === 0 ? <p className="lab-muted">{t("rd.lib.empty")}</p> : (
        <div className="lab-scroll">
          <table className="lab-table">
            <thead><tr><th>{t("rd.device")}</th><th>{t("rd.lib.part")}</th><th>{t("rd.lib.failure")}</th><th>{t("rd.lib.material")}</th><th>{t("rd.lib.held")}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.brief_id}>
                  <td>{r.device}{r.model ? ` (${[r.brand, r.model].filter(Boolean).join(" ")})` : ""}</td>
                  <td>{r.part}</td>
                  <td>{auto(modes.find((m) => m.id === r.failure_mode)?.name ?? r.failure_mode)}{r.certainty === "suspected" ? ` (${t("rd.suspected")})` : ""}</td>
                  <td>{r.material || "—"}</td>
                  <td>
                    <select value={r.outcome} aria-label={t("rd.lib.outcome")} onChange={(e) => mark(r.brief_id, e.target.value as Outcome)}>
                      {OUTCOMES.map((o) => <option key={o} value={o}>{t(`rd.out.${o}` as Key)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
