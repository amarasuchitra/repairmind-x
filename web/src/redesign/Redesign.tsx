import { useEffect, useState } from "react";
import "../lab/lab.css";
import "./redesign.css";
import {
  api, BRIEF_ID_KEY, EMPTY_BRIEF, LAB_BRIEF_KEY, LAST_CALL_KEY, read, store,
  type Check, type DesignBrief, type FailureMode, type LibraryRecord, type LibraryStats, type Measure, type Outcome,
} from "./brief";

type Answer = { brief: DesignBrief; check: Check };
const SOURCES: { v: Measure["source"]; label: string }[] = [
  { v: "measured", label: "measured" }, { v: "label", label: "from label" }, { v: "spec", label: "from spec" },
  { v: "user", label: "user said" }, { v: "estimated", label: "estimate" },
];
const OUTCOME_LABEL: Record<Outcome, string> = { pending: "Not known yet", holding: "Fix is holding", failed_again: "Failed again" };

/** Turn a repair call into a checked design brief, send it to the design lab, and keep a failure library. */
export function Redesign({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<"brief" | "library">("brief");
  const [brief, setBrief] = useState<DesignBrief | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [modes, setModes] = useState<FailureMode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const lastRoom = read(LAST_CALL_KEY);

  useEffect(() => {
    api<{ modes: FailureMode[] }>("/api/redesign/failure-modes").then((r) => setModes(r.modes)).catch(() =>
      setError("Can't reach the RepairMind server. Is the token server running?"));
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

  const fromCall = () => run("Reading the call", async () => {
    if (lastRoom) take(await api<Answer>("/api/redesign/briefs/from-session", { room: lastRoom }));
  });
  const blank = () => run("Starting", async () => take(await api<Answer>("/api/redesign/briefs", EMPTY_BRIEF)));
  const save = () => run("Checking", async () => { if (brief) take(await api<Answer>("/api/redesign/briefs", brief)); });

  async function toLab() {
    if (!brief) return;
    await run("Preparing the hand-off", async () => {
      const saved = await api<Answer>("/api/redesign/briefs", brief);
      take(saved);
      const handoff = await api<{ idea: string; context: string }>(`/api/redesign/briefs/${saved.brief.id}/lab`, {});
      try {
        sessionStorage.setItem(LAB_BRIEF_KEY, JSON.stringify(handoff));
      } catch {
        throw new Error("This browser blocked the hand-off. Copy the brief into the design lab by hand.");
      }
      window.location.hash = "lab";
    });
  }

  async function share() {
    if (!brief) return;
    await run("Adding", async () => {
      const saved = await api<Answer>("/api/redesign/briefs", brief);
      take(saved);
      await api(`/api/redesign/briefs/${saved.brief.id}/share`, {});
      setBrief({ ...saved.brief, share_to_library: true });
      setNote("Added to the failure library. Come back and mark whether the fix held up.");
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
        <button className="lab-btn ghost" onClick={onBack}>← Back</button>
        <div className="lab-brand"><span className="lab-mark" aria-hidden>◆</span> RepairMind X <i>/</i> <b>Redesign a broken part</b></div>
        <nav className="lab-tabs rd-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "brief"} className={tab === "brief" ? "on" : ""} onClick={() => setTab("brief")}>Design brief</button>
          <button role="tab" aria-selected={tab === "library"} className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>Failure library</button>
        </nav>
      </header>
      {error && <p className="lab-err" role="alert">{error}</p>}
      {note && <p className="rd-note" role="status">{note}</p>}

      {tab === "library" ? <Library modes={modes} /> : !brief ? (
        <section className="rd-start">
          <p className="lab-lede">Turn what broke on a repair call into a design brief the design lab can work from: the part, how it failed, its sizes and the loads it has to survive.</p>
          <div className="rd-start-row">
            <button className="lab-btn solid" disabled={!lastRoom || !!busy} onClick={fromCall}>Start from my last repair call</button>
            <button className="lab-btn" disabled={!!busy} onClick={blank}>Start a blank brief</button>
          </div>
          {!lastRoom && <p className="lab-muted">No repair call on this device yet. You can still start a blank brief.</p>}
        </section>
      ) : (
        <div className="lab-grid rd-grid">
          <aside className="lab-side">
            <CheckPanel check={check} dirty={dirty} />
            <section className="lab-card">
              <button className="lab-btn" disabled={!!busy || !dirty} onClick={save}>{busy === "Checking" ? "Checking…" : "Save and check"}</button>
              <button className="lab-btn solid" disabled={!!busy || !!check?.blocked} onClick={toLab}>Send to design lab</button>
              <button className="lab-btn" disabled={!!busy || !!check?.blocked || brief.share_to_library} onClick={share}>
                {brief.share_to_library ? "In the failure library" : "Add to failure library"}
              </button>
              <small>The library keeps the part, failure, material, sizes and loads. It never keeps names, photos, the call or your notes.</small>
              <button className="lab-btn ghost" disabled={!!busy} onClick={() => { store(BRIEF_ID_KEY, null); setBrief(null); setCheck(null); }}>Start another brief</button>
              {busy && <span className="lab-muted" aria-live="polite">{busy}…</span>}
            </section>
          </aside>

          <section className="lab-main rd-form">
            <fieldset className="lab-card">
              <legend className="lab-kicker">The part</legend>
              <div className="rd-row3">
                <Field label="Device" value={brief.device} onChange={(v) => set("device", v)} placeholder="washing machine" />
                <Field label="Brand" value={brief.brand} onChange={(v) => set("brand", v)} />
                <Field label="Model" value={brief.model} onChange={(v) => set("model", v)} />
              </div>
              <Field label="Which part failed" value={brief.part} onChange={(v) => set("part", v)} placeholder="door hinge clip" />
              <Field label="What it has to do" value={brief.part_function} onChange={(v) => set("part_function", v)} placeholder="hold the door shut against the seal, about 20 N" long />
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">How it failed</legend>
              <div className="rd-row2">
                <label className="rd-field"><span>Failure mode</span>
                  <select value={brief.failure_mode} onChange={(e) => set("failure_mode", e.target.value)}>
                    <option value="unknown">Not sure yet</option>
                    {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label className="rd-field"><span>How sure</span>
                  <select value={brief.failure_mode_certainty} onChange={(e) => set("failure_mode_certainty", e.target.value as DesignBrief["failure_mode_certainty"])}>
                    <option value="">—</option>
                    <option value="seen">Seen on the break surface</option>
                    <option value="suspected">Suspected</option>
                  </select>
                </label>
              </div>
              {!!check?.suggested_modes.length && (
                <div className="lab-examples">
                  <span className="lab-muted">From the description:</span>
                  {check.suggested_modes.map((s) => (
                    <button key={s.id} className={`lab-chip${s.id === brief.failure_mode ? " on" : ""}`} onClick={() => set("failure_mode", s.id)}>{s.name}</button>
                  ))}
                </div>
              )}
              {mode && (
                <div className="rd-mode">
                  <div><b>Look for</b><ul>{mode.signs.map((x) => <li key={x}>{x}</li>)}</ul></div>
                  <div><b>Usual causes</b><ul>{mode.causes.map((x) => <li key={x}>{x}</li>)}</ul></div>
                  <div><b>Ask</b><ul>{mode.questions.map((x) => <li key={x}>{x}</li>)}</ul></div>
                </div>
              )}
              <Field label="Diagnosis" value={brief.diagnosis} onChange={(v) => set("diagnosis", v)} long />
              {!!brief.observations.length && (
                <details><summary className="lab-muted">{brief.observations.length} notes from the call</summary>
                  <ul>{brief.observations.map((o, i) => <li key={i}>{o}</li>)}</ul></details>
              )}
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">Sizes of the old part</legend>
              <Measures items={brief.dimensions} onChange={(v) => set("dimensions", v)} namePh="wall thickness" valuePh="2 mm" />
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">Loads and conditions</legend>
              <Measures items={brief.operating} onChange={(v) => set("operating", v)} namePh="closing force" valuePh="20 N" />
              <small>Force, torque, pressure, weight, temperature, speed, cycles. Every value needs a unit. A rough estimate is fine: mark it as one.</small>
            </fieldset>

            <fieldset className="lab-card">
              <legend className="lab-kicker">Material and making it</legend>
              <div className="rd-row2">
                <Field label="Old material" value={brief.material} onChange={(v) => set("material", v)} placeholder="ABS plastic, or unknown" />
                <label className="rd-field"><span>Known from</span>
                  <select value={brief.material_source} onChange={(e) => set("material_source", e.target.value as Measure["source"])}>
                    <option value="">—</option>
                    {SOURCES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="rd-row2">
                <Field label="Will be made by" value={brief.manufacturing} onChange={(v) => set("manufacturing", v)} placeholder="FDM 3D print in PETG" />
                <label className="rd-field"><span>Safety factor</span>
                  <input type="number" min={1} max={10} step={0.1} value={brief.safety_factor}
                    onChange={(e) => set("safety_factor", Math.min(10, Math.max(1, Number(e.target.value) || 1.5)))} />
                </label>
              </div>
              <label className="rd-field"><span>Constraints, one per line</span>
                <textarea rows={3} value={brief.constraints.join("\n")} placeholder={"must fit the existing two M4 holes 30 mm apart\nno metal parts"}
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
  const edit = (i: number, patch: Partial<Measure>) => onChange(items.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <div className="rd-measures">
      {items.map((m, i) => (
        <div className="rd-measure" key={i}>
          <input aria-label="Name" value={m.name} placeholder={namePh} maxLength={80} onChange={(e) => edit(i, { name: e.target.value })} />
          <input aria-label="Value with unit" value={m.value} placeholder={valuePh} maxLength={40} onChange={(e) => edit(i, { value: e.target.value })} />
          <select aria-label="Source" value={m.source} onChange={(e) => edit(i, { source: e.target.value as Measure["source"] })}>
            <option value="">source?</option>
            {SOURCES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
          <button className="lab-btn ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      {items.length < 30 && <button className="lab-btn" onClick={() => onChange([...items, { name: "", value: "", source: "" }])}>+ Add</button>}
    </div>
  );
}

function CheckPanel({ check, dirty }: { check: Check | null; dirty: boolean }) {
  if (!check) return null;
  return (
    <section className="lab-card rd-check" aria-live="polite">
      <span className="lab-kicker">Brief check{dirty ? " (unsaved changes)" : ""}</span>
      {check.blocked ? <p className="rd-bad"><b>Can't redesign this here.</b> {check.blocked}</p>
        : check.ready ? <p className="rd-ok">Ready for the design lab.</p>
          : <p className="rd-warn">Not ready yet. Fill in what's missing below.</p>}
      {check.needs_signoff && <p className="rd-warn"><b>Needs an engineer's sign-off.</b> {check.signoff_reason}</p>}
      {!!check.errors.length && <><b>Fix these</b><ul className="rd-bad">{check.errors.map((x) => <li key={x}>{x}</li>)}</ul></>}
      {!!check.missing.length && <><b>Missing</b><ul>{check.missing.map((x) => <li key={x}>{x}</li>)}</ul></>}
      {!!check.assumptions.length && <><b>Assumptions</b><ul className="lab-muted">{check.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></>}
      <b>The redesign must pass</b>
      <ul>{check.required_analyses.map((a) => <li key={a.id}>{a.text}</li>)}</ul>
    </section>
  );
}

function Library({ modes }: { modes: FailureMode[] }) {
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
      <p className="lab-lede">Every shared failure, so the next redesign starts from what has already broken and whether the fix held.</p>
      {error && <p className="lab-err">{error}</p>}
      {stats && stats.total > 0 && (
        <div className="lab-card rd-stats">
          <span className="lab-kicker">{stats.total} {stats.total === 1 ? "failure" : "failures"} · {stats.outcomes.holding ?? 0} fixes holding · {stats.outcomes.failed_again ?? 0} failed again</span>
          {stats.by_mode.map((m) => (
            <div className="rd-bar" key={m.id}><span>{m.name}</span><i style={{ width: `${(m.count / max) * 100}%` }} /><b>{m.count}</b></div>
          ))}
        </div>
      )}
      <form className="rd-search" onSubmit={(e) => { e.preventDefault(); load(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search device, part or material" aria-label="Search" />
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Failure mode">
          <option value="">All failure modes</option>
          {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button className="lab-btn">Search</button>
      </form>
      {rows.length === 0 ? <p className="lab-muted">Nothing here yet. Briefs you add to the library show up here.</p> : (
        <div className="lab-scroll">
          <table className="lab-table">
            <thead><tr><th>Device</th><th>Part</th><th>Failure</th><th>Material</th><th>Did the fix hold?</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.brief_id}>
                  <td>{r.device}{r.model ? ` (${[r.brand, r.model].filter(Boolean).join(" ")})` : ""}</td>
                  <td>{r.part}</td>
                  <td>{modes.find((m) => m.id === r.failure_mode)?.name ?? r.failure_mode}{r.certainty === "suspected" ? " (suspected)" : ""}</td>
                  <td>{r.material || "—"}</td>
                  <td>
                    <select value={r.outcome} aria-label="Outcome" onChange={(e) => mark(r.brief_id, e.target.value as Outcome)}>
                      {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>)}
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
