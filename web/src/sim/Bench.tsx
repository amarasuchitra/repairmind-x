import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import "./sim.css";
import type { Report } from "../build/engine.ts";
import { railFor } from "../build/engine.ts";
import { BY_ID, isBoard, isPower } from "../build/parts.ts";
import type { Project } from "../build/project.ts";
import { useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import { Bench, defaultEnv, defaultMods, type Env, type Event, type Frame, type Mods, type PartState } from "./bench.ts";
import { AvrRunner } from "./avr.ts";

/**
 * The "Try it" tab: the project on a virtual bench. Switch it on, play with the world around it, change values
 * and wiring, and watch what the parts do, including the ways they fail.
 */
export function BenchView({ project, report, initial }: {
  project: Project; report: Report;
  /** a set-up to start from (the build guide uses this to show what it just tested); remount to apply again */
  initial?: { env?: Env; mods?: Mods; power?: boolean };
}) {
  const { t, auto } = useI18n();
  const [mods, setMods] = useState<Mods>(() => initial?.mods ?? defaultMods(report));
  const [env, setEnv] = useState<Env>(() => initial?.env ?? defaultEnv());
  const [frame, setFrame] = useState<Frame | null>(null);
  const [speed, setSpeed] = useState(1);
  const [hex, setHex] = useState<{ name: string; text: string } | null>(null);
  const [hexErr, setHexErr] = useState("");
  const envRef = useRef(env);
  envRef.current = env;

  // a fresh bench when the parts, wiring plan or code change; what you set on the bench stays
  const key = JSON.stringify([project.parts.map((p) => [p.uid, p.id]), project.rules, hex?.name, hex?.text.length]);
  const { bench, loadErr } = useMemo(() => {
    const b = new Bench(project, mods);
    let loadErr = "";
    if (hex && b.board?.id === "nano") {
      try { b.external = new AvrRunner(hex.text, project, b.report); }
      catch (e) { loadErr = e instanceof Error ? e.message : String(e); }
    }
    return { bench: b, loadErr };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  bench.mods = mods;
  useEffect(() => { if (initial?.power) bench.setPower(true); }, [bench]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let raf = 0, last = performance.now(), lastShow = 0, acc = 0;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt * speed;
      const step = 0.005;
      let n = 0;
      const t0 = performance.now();
      while (acc >= step && n < 400) {
        bench.step(step, envRef.current);
        acc -= step;
        n++;
        // the emulated chip is heavy: never hold the page for more than ~12 ms a frame
        if (bench.external && performance.now() - t0 > 12) { acc = 0; break; }
      }
      if (now - lastShow > 80) { lastShow = now; setFrame(bench.frame()); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [bench, speed]);

  const f = frame ?? bench.frame();
  const set = (m: Partial<Mods>) => setMods((x) => ({ ...x, ...m }));
  const setE = (e: Partial<Env>) => setEnv((x) => ({ ...x, ...e }));
  const has = (id: string) => project.parts.some((p) => p.id === id);
  const board = report.board;

  if (!board) return <p className="lab-muted">{t("sim.noBoard")}</p>;
  if (!report.source) return <p className="lab-muted">{t("sim.noPower")}</p>;

  const status = !f.on ? t("sim.st.off") : f.board.status === "dead" ? t("sim.st.dead") : f.board.status === "running" ? t("sim.st.running") : f.board.status === "reset" ? t("sim.st.reset") : t("sim.st.booting");
  const broken = f.events.filter((e) => e.severity === "broken").length;

  const momentary = (k: keyof Env) => ({
    onPointerDown: () => setE({ [k]: true } as Partial<Env>),
    onPointerUp: () => setE({ [k]: false } as Partial<Env>),
    onPointerLeave: () => setE({ [k]: false } as Partial<Env>),
  });

  return (
    <div className="sim">
      <p className="lab-muted">{t("sim.intro")}</p>
      <div className="sim-bar">
        <button className={`sim-power${f.on ? " on" : ""}`} onClick={() => bench.setPower(!bench.on)} aria-pressed={f.on}>
          <span aria-hidden>⏻</span> {f.on ? t("sim.off") : t("sim.on")}
        </button>
        <div className="sim-state">
          <b className={`sim-dot ${f.on ? f.board.status : "off"}`}>{status}</b>
          {f.on && <span className="mono">{report.board?.id === "esp32" ? `5V ${f.rails.v5.toFixed(2)} · 3V3 ${f.rails.v33.toFixed(2)}` : `5V ${f.rails.v5.toFixed(2)}`} · {f.source.mA.toFixed(0)} mA{f.board.resets ? ` · ${t("sim.resets", { n: f.board.resets })}` : ""}</span>}
        </div>
        <label className="lab-speed">
          <span>{t("sim.speed")}</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0.1}>{t("sim.slow")}</option><option value={0.25}>¼×</option><option value={1}>1×</option><option value={4}>4×</option>
          </select>
        </label>
        {broken > 0 && <button className="lab-btn" onClick={() => bench.reset()}>{t("sim.replace")}</button>}
        <span className="sim-clock mono">{f.t.toFixed(1)} s</span>
      </div>

      <div className="sim-grid">
        <div className="sim-parts" aria-live="polite">
          {f.parts.map((p) => <PartTile key={p.uid} p={p} on={f.on} />)}
        </div>

        <div className="sim-side">
          {(has("touch") || has("button") || has("pir") || has("reed") || has("mic") || has("soundsensor") || has("light") || has("soil") || has("distance") || has("temp") || has("motion6")) && (
            <section className="lab-card sim-world">
              <span className="lab-kicker">{t("sim.world")}</span>
              <div className="sim-btns">
                {has("touch") && <button className={`lab-btn${env.touch ? " held" : ""}`} {...momentary("touch")}>{t("sim.touch")}</button>}
                {has("button") && <button className={`lab-btn${env.button ? " held" : ""}`} {...momentary("button")}>{t("sim.press")}</button>}
                {(has("mic") || has("soundsensor")) && <button className={`lab-btn${env.clap ? " held" : ""}`} onClick={() => { setE({ clap: true }); setTimeout(() => setE({ clap: false }), 250); }}>{t("sim.clap")}</button>}
                {has("pir") && <Toggle on={env.motion} set={(v) => setE({ motion: v })}>{t("sim.motion")}</Toggle>}
                {has("reed") && <Toggle on={env.door} set={(v) => setE({ door: v })}>{t("sim.door")}</Toggle>}
              </div>
              {has("light") && <Slider label={t("sim.lux")} value={env.lux} min={0} max={2000} step={1} unit="lux" log set={(v) => setE({ lux: v })} />}
              {has("soil") && <Slider label={t("sim.soil")} value={env.soilPct} min={0} max={100} step={1} unit="%" set={(v) => setE({ soilPct: v })} />}
              {has("distance") && <Slider label={t("sim.distance")} value={env.distanceCm} min={2} max={400} step={1} unit="cm" set={(v) => setE({ distanceCm: v })} />}
              {has("temp") && <Slider label={t("sim.temp")} value={env.tempC} min={-10} max={60} step={0.5} unit="°C" set={(v) => setE({ tempC: v })} />}
              {has("motion6") && <Slider label={t("sim.shake")} value={env.shakeG} min={0} max={3} step={0.05} unit="g" set={(v) => setE({ shakeG: v })} />}
            </section>
          )}

          <section className="lab-card sim-mods">
            <span className="lab-kicker">{t("sim.change")}</span>
            <p className="lab-muted">{t("sim.changeP")}</p>
            {report.source?.kind === "battery" && <Slider label={t("sim.charge")} value={Math.round(mods.charge * 100)} min={0} max={100} step={1} unit="%" set={(v) => set({ charge: v / 100 })} />}
            {report.boost && <Toggle on={mods.booster} set={(v) => set({ booster: v })}>{t("sim.booster")}</Toggle>}
            {report.boost && mods.booster && <Slider label={t("sim.boostV")} value={mods.boostV} min={3} max={12} step={0.1} unit="V" set={(v) => set({ boostV: v })} />}
            {has("led") && (
              <div className="sim-row">
                <label>{t("sim.ledR")}
                  <select value={mods.ledOhm} onChange={(e) => set({ ledOhm: Number(e.target.value) })}>
                    {[0, 22, 47, 100, 150, 220, 330, 470, 1000, 4700].map((r) => <option key={r} value={r}>{r === 0 ? t("sim.none") : r >= 1000 ? `${r / 1000} kΩ` : `${r} Ω`}</option>)}
                  </select>
                </label>
                <label>{t("sim.ledColor")}
                  <select value={mods.ledColor} onChange={(e) => set({ ledColor: e.target.value as Mods["ledColor"] })}>
                    {(["red", "green", "blue", "white"] as const).map((c) => <option key={c} value={c}>{t(`sim.color.${c}` as Key)}</option>)}
                  </select>
                </label>
              </div>
            )}
            {(has("ring") || has("strip")) && <Slider label={t("sim.bright")} value={Math.round(mods.ringBright * 100)} min={5} max={100} step={5} unit="%" set={(v) => set({ ringBright: v / 100 })} />}
            {has("servo") && <>
              <Slider label={t("sim.load")} value={mods.servoLoadG} min={0} max={1000} step={5} unit="g" set={(v) => set({ servoLoadG: v })} />
              <Slider label={t("sim.arm")} value={mods.servoArmCm} min={1} max={15} step={0.5} unit="cm" set={(v) => set({ servoArmCm: v })} />
            </>}
            {(has("servo") || has("ring") || has("strip")) && <Toggle on={mods.bulkCap} set={(v) => set({ bulkCap: v })}>{t("sim.cap")}</Toggle>}
            {has("distance") && board.id === "esp32" && <Toggle on={mods.echoDivider} set={(v) => set({ echoDivider: v })}>{t("sim.divider")}</Toggle>}
            {has("pump") && <Toggle on={mods.flyback} set={(v) => set({ flyback: v })}>{t("sim.flyback")}</Toggle>}
            <Toggle on={mods.thinWires} set={(v) => set({ thinWires: v })}>{t("sim.thin")}</Toggle>
            <RailPicker project={project} report={report} mods={mods} set={set} />
            <button className={`lab-btn sim-short${mods.short ? " on" : ""}`} onClick={() => set({ short: !mods.short })}>{mods.short ? t("sim.unshort") : t("sim.short")}</button>
            <button className="lab-btn ghost" onClick={() => setMods(defaultMods(report))}>{t("sim.asDesigned")}</button>
          </section>
        </div>
      </div>

      <Events events={f.events} onUndo={(m) => set(m)} />

      <details className="lab-fold sim-code">
        <summary>{t("sim.codeH")} · {bench.external ? t("sim.code.hex", { name: hex?.name ?? "" }) : t("sim.code.rules")}</summary>
        <p className="lab-muted">{board.id === "nano" ? t("sim.codeNano") : t("sim.codeEsp")}</p>
        {board.id === "nano" && (
          <div className="lab-row">
            <label className="lab-btn">{t("sim.loadHex")}
              <input type="file" accept=".hex,.ihex,text/plain" hidden onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                if (file.size > 300_000) { setHexErr(t("sim.hexBig")); return; }
                setHexErr("");
                setHex({ name: file.name, text: await file.text() });
              }} />
            </label>
            {hex && <button className="lab-btn" onClick={() => { setHex(null); setHexErr(""); }}>{t("sim.useRules")}</button>}
          </div>
        )}
        {(hexErr || loadErr) && <p className="lab-err">{auto(hexErr || loadErr)}</p>}
        <pre className="sim-serial mono" aria-label={t("sim.serial")}>{f.serial.slice(-40).join("\n") || t("sim.serialEmpty")}</pre>
      </details>
    </div>
  );
}

function PartTile({ p, on }: { p: PartState; on: boolean }) {
  const { t, auto } = useI18n();
  const part = BY_ID[p.id];
  return (
    <div className={`sim-part ${p.status}`}>
      <div className="sim-vis" aria-hidden>{visual(p, part?.icon ?? "□")}</div>
      <div className="sim-part-t">
        <b>{auto(p.name)}</b>
        {on && <small className="mono">{p.v ? `${p.v.toFixed(2)} V · ` : ""}{p.mA.toFixed(p.mA < 10 ? 1 : 0)} mA{p.tempC !== null && p.tempC > 30 ? ` · ${p.tempC.toFixed(0)} °C` : ""}</small>}
        {p.status !== "ok" && p.status !== "off" && <span className={`sim-chip ${p.status}`}>{t(`sim.part.${p.status}` as Key)}</span>}
      </div>
    </div>
  );
}

function visual(p: PartState, icon: string): ReactNode {
  const s = p.show;
  if (p.id === "led") {
    const c = s.color ?? "#ff4040";
    return (
      <svg viewBox="0 0 40 40" className="sim-led">
        {p.status === "broken" ? <>
          <circle cx="20" cy="18" r="9" fill="#2a2a2a" stroke="#555" />
          <path d="M14 12 L20 19 L17 22 L25 26" stroke="#888" fill="none" strokeWidth="1.2" />
        </> : <>
          <circle cx="20" cy="18" r="16" fill={c} opacity={(s.lit ?? 0) * 0.35} />
          <circle cx="20" cy="18" r="9" fill={c} opacity={0.25 + (s.lit ?? 0) * 0.75} />
        </>}
        <path d="M16 28 v9 M24 28 v6" stroke="#9fb4d6" strokeWidth="1.5" />
      </svg>
    );
  }
  if (p.id === "ring" || p.id === "strip") {
    const n = p.id === "ring" ? 12 : 15;
    return (
      <svg viewBox="0 0 40 40">
        {Array.from({ length: n }, (_, i) => {
          const c = s.ring?.[i * (p.id === "strip" ? 2 : 1)] ?? "#1b2437";
          const a = (i / n) * Math.PI * 2;
          return p.id === "ring"
            ? <circle key={i} cx={20 + Math.cos(a) * 14} cy={20 + Math.sin(a) * 14} r="3.2" fill={c} />
            : <rect key={i} x={1 + i * 2.6} y="17" width="2" height="6" fill={c} />;
        })}
      </svg>
    );
  }
  if (p.id === "servo") {
    return (
      <svg viewBox="0 0 40 40">
        <rect x="8" y="18" width="24" height="14" rx="2" fill="#2b3a57" />
        <g transform={`rotate(${-(s.deg ?? 0)} 20 20)`}>
          <rect x="20" y="18.5" width="17" height="3" rx="1.5" fill="#e8f1ff" />
          <circle cx="35" cy="20" r="2.4" fill="#f5b544" />
        </g>
        <circle cx="20" cy="20" r="3" fill="#9fb4d6" />
      </svg>
    );
  }
  if (p.id === "oled") return <div className="sim-oled mono">{s.text}</div>;
  if (p.id === "buzzer" || p.id === "player" || p.id === "amp" || p.id === "speaker") {
    const active = (s.tone ?? 0) > 0 || s.running;
    return <span className={`sim-icon${active ? " sound" : ""}`}>{icon}</span>;
  }
  if (p.id === "pump" || p.id === "vibe" || p.id === "relay") return <span className={`sim-icon${s.running ? " busy" : ""}`}>{icon}</span>;
  return <span className="sim-icon">{icon}</span>;
}

function Events({ events, onUndo }: { events: Event[]; onUndo: (m: Partial<Mods>) => void }) {
  const { t, auto } = useI18n();
  if (!events.length) return <p className="lab-muted sim-none">{t("sim.noEvents")}</p>;
  return (
    <section className="sim-events" aria-live="polite">
      <span className="lab-kicker">{t("sim.happened")}</span>
      {[...events].reverse().map((e) => (
        <article key={e.id} className={`sim-ev ${e.severity}`}>
          <header><b>{auto(e.title)}</b><small className="mono">{e.t.toFixed(1)} s</small></header>
          <p>{auto(e.why)}</p>
          <p className="sim-fix"><span className="lab-kicker">{t("sim.fix")}</span> {auto(e.fix)}</p>
          {e.undo && <button className="lab-btn" onClick={() => onUndo(e.undo!)}>{t("sim.undo")}</button>}
        </article>
      ))}
    </section>
  );
}

function RailPicker({ project, report, mods, set }: { project: Project; report: Report; mods: Mods; set: (m: Partial<Mods>) => void }) {
  const { t, auto } = useI18n();
  const movable = project.parts.map((p) => ({ p, part: BY_ID[p.id] })).filter((x) => x.part && !isBoard(x.part) && !isPower(x.part) && x.part.rail !== "none");
  if (!movable.length) return null;
  return (
    <details className="sim-rails">
      <summary>{t("sim.rails")}</summary>
      {movable.map(({ p, part }) => (
        <label key={p.uid} className="sim-row">
          <span>{auto(part.name.replace(/\s*\(.*\)\s*/g, " ").trim())}</span>
          <select value={mods.rails[p.uid] ?? railFor(part, report.board)} onChange={(e) => {
            const v = e.target.value as "5v" | "3v3";
            const rails = { ...mods.rails };
            if (v === railFor(part, report.board)) delete rails[p.uid]; else rails[p.uid] = v;
            set({ rails });
          }}>
            <option value="5v">5 V</option><option value="3v3">3.3 V</option>
          </select>
        </label>
      ))}
    </details>
  );
}

function Toggle({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="sim-toggle">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

function Slider({ label, value, min, max, step, unit, set, log }: { label: string; value: number; min: number; max: number; step: number; unit: string; set: (v: number) => void; log?: boolean }) {
  // a log slider for light, which spans dark rooms to daylight
  const toPos = (v: number) => (log ? (Math.log10(Math.max(v, 0.1)) + 1) / (Math.log10(max) + 1) * 1000 : v);
  const fromPos = (p: number) => (log ? Math.round(Math.pow(10, (p / 1000) * (Math.log10(max) + 1) - 1) * 10) / 10 : p);
  return (
    <label className="sim-slider">
      <span>{label}<b className="mono">{value} {unit}</b></span>
      <input type="range" min={log ? 0 : min} max={log ? 1000 : max} step={log ? 1 : step} value={toPos(value)} onChange={(e) => set(fromPos(Number(e.target.value)))} />
    </label>
  );
}
