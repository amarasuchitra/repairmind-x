import type { Design } from "../lab/design.ts";
import type { SimEvent } from "../lab/physics.ts";
import { fmt } from "../lab/units.ts";
import { useI18n } from "../i18n";
import { JOINT_STRENGTHS, isEdited, type Edits } from "./edit.ts";

const GRAVITY: { label: string; g: number }[] = [
  { label: "Earth", g: 9.80665 }, { label: "Moon", g: 1.62 }, { label: "Mars", g: 3.71 }, { label: "Jupiter", g: 24.79 }, { label: "None (space)", g: 0 },
];

/** The sandbox's "Change it" panel: edit the assembly the way you would the real one, and give joints a strength. */
export function SandboxEdit({ design, edits, setEdits, loads }: {
  design: Design;
  edits: Edits;
  setEdits: (e: Edits) => void;
  loads: { index: number; peak: number; broken: boolean; breakN: number | null }[];
}) {
  const { t, auto } = useI18n();
  const sim = design.simulation;
  const body = (id: string, k: string, v: number | boolean) => setEdits({ ...edits, bodies: { ...edits.bodies, [id]: { ...edits.bodies?.[id], [k]: v } } });
  const joint = (i: number, k: string, v: number) => setEdits({ ...edits, joints: { ...edits.joints, [i]: { ...edits.joints?.[i], [k]: v } } });
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const g = edits.gravity ?? sim.gravity;

  return (
    <details className="lab-fold sbx" open={isEdited(edits) || undefined}>
      <summary>{t("sbx.h")}</summary>
      <p className="lab-muted">{t("sbx.p")}</p>
      <div className="sbx-row">
        <label>{t("sbx.gravity")}
          <select value={GRAVITY.find((x) => Math.abs(x.g - g) < 0.01)?.label ?? "custom"} onChange={(e) => { const x = GRAVITY.find((y) => y.label === e.target.value); if (x) setEdits({ ...edits, gravity: x.g }); }}>
            {GRAVITY.map((x) => <option key={x.label} value={x.label}>{auto(x.label)} ({x.g} m/s²)</option>)}
            {!GRAVITY.some((x) => Math.abs(x.g - g) < 0.01) && <option value="custom">{fmt(g)} m/s²</option>}
          </select>
        </label>
        <label>{t("sbx.duration")}
          <input type="number" min={0.5} max={60} step={0.5} value={edits.duration_s ?? sim.duration_s} onChange={(e) => setEdits({ ...edits, duration_s: num(e.target.value) })} />
        </label>
      </div>

      <div className="lab-scroll">
        <table className="lab-table sbx-table">
          <thead><tr><th>{t("sbx.body")}</th><th>{t("sbx.mass")}</th><th>{t("sbx.size")}</th><th>{t("sbx.friction")}</th><th>{t("sbx.fixed")}</th></tr></thead>
          <tbody>
            {sim.bodies.map((b) => {
              const e = edits.bodies?.[b.id] ?? {};
              return (
                <tr key={b.id}>
                  <td>{auto(b.label || b.id)}</td>
                  <td><input type="number" min={0.001} step="any" value={e.mass_kg ?? b.mass_kg} disabled={e.fixed ?? b.fixed} onChange={(x) => body(b.id, "mass_kg", Number(x.target.value))} aria-label={`${b.label} ${t("sbx.mass")}`} /></td>
                  <td><input type="number" min={0.1} max={10} step={0.1} value={e.scale ?? 1} onChange={(x) => body(b.id, "scale", Number(x.target.value))} aria-label={`${b.label} ${t("sbx.size")}`} /></td>
                  <td><input type="number" min={0} max={2} step={0.05} value={e.friction ?? b.friction} onChange={(x) => body(b.id, "friction", Number(x.target.value))} aria-label={`${b.label} ${t("sbx.friction")}`} /></td>
                  <td><input type="checkbox" checked={e.fixed ?? b.fixed} onChange={(x) => body(b.id, "fixed", x.target.checked)} aria-label={`${b.label} ${t("sbx.fixed")}`} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {sim.joints.length > 0 && (
        <div className="lab-scroll">
          <table className="lab-table sbx-table">
            <thead><tr><th>{t("sbx.joint")}</th><th>{t("sbx.drive")}</th><th>{t("sbx.strength")}</th><th>{t("sbx.load")}</th></tr></thead>
            <tbody>
              {sim.joints.map((j, i) => {
                const e = edits.joints?.[i] ?? {};
                const l = loads.find((x) => x.index === i);
                const strength = edits.breakN?.[i] ?? null;
                return (
                  <tr key={i} className={l?.broken ? "sbx-broken" : ""}>
                    <td>{j.kind}<small>{j.a} – {j.b}</small></td>
                    <td>
                      {j.kind === "revolute" && <span className="sbx-pair">
                        <label>{t("sbx.speed")}<input type="number" step="any" value={e.motor_speed ?? j.motor_speed} onChange={(x) => joint(i, "motor_speed", Number(x.target.value))} /></label>
                        <label>{t("sbx.torque")}<input type="number" min={0} step="any" value={e.motor_max_torque ?? j.motor_max_torque} onChange={(x) => joint(i, "motor_max_torque", Number(x.target.value))} /></label>
                      </span>}
                      {j.kind === "spring" && <span className="sbx-pair">
                        <label>{t("sbx.k")}<input type="number" min={0} step="any" value={e.stiffness ?? j.stiffness} onChange={(x) => joint(i, "stiffness", Number(x.target.value))} /></label>
                        <label>{t("sbx.damping")}<input type="number" min={0} step="any" value={e.damping ?? j.damping} onChange={(x) => joint(i, "damping", Number(x.target.value))} /></label>
                      </span>}
                      {j.kind !== "revolute" && j.kind !== "spring" && <span className="lab-muted">–</span>}
                    </td>
                    <td>
                      <select value={strength === null ? "" : String(strength)} onChange={(x) => setEdits({ ...edits, breakN: { ...edits.breakN, [i]: x.target.value === "" ? null : Number(x.target.value) } })}>
                        {JOINT_STRENGTHS.map((s) => <option key={s.label} value={s.n === null ? "" : String(s.n)} title={s.note}>{auto(s.label)}{s.n ? ` (${s.n} N)` : ""}</option>)}
                      </select>
                    </td>
                    <td className="num">{l ? `${fmt(l.peak)} N` : "–"}{l?.broken && <span className="lab-pill bad">{t("sbx.broke")}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="lab-muted">{t("sbx.loadNote")}</p>
      {isEdited(edits) && <button className="lab-btn" onClick={() => setEdits({})}>{t("sim.asDesigned")}</button>}
    </details>
  );
}

/** What went wrong in the run, and why. */
export function SandboxEvents({ events }: { events: SimEvent[] }) {
  const { t, auto } = useI18n();
  if (!events.length) return null;
  return (
    <section className="sim-events sbx-events" aria-live="polite">
      <span className="lab-kicker">{t("sim.happened")}</span>
      {events.map((e, i) => (
        <article key={i} className={`sim-ev ${e.kind === "break" ? "broken" : "warning"}`}>
          <header><b>{auto(e.title)}</b><small className="mono">{e.t.toFixed(2)} s</small></header>
          <p>{auto(e.why)}</p>
          <p className="sim-fix"><span className="lab-kicker">{t("sim.fix")}</span> {auto(e.fix)}</p>
        </article>
      ))}
    </section>
  );
}
