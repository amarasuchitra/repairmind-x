import { useEffect, useState, type ReactNode } from "react";
import type { Alert, Marker, SessionView, StepView } from "../types";
import { VoiceOrb, type OrbState } from "./VoiceOrb";
import { Flip, Logo, Mic, MicOff, PhoneOff } from "../ui/Icons";

export interface Caption {
  who: "You" | "Mechanic";
  text: string;
}

export interface CallHudProps {
  status: string;
  orbState: OrbState;
  bands: number[];
  view: SessionView | null;
  captions: Caption[];
  camera: ReactNode; // the live <video> or a placeholder
  overlay?: ReactNode; // live AR layer
  side?: ReactNode; // 3D viewer for the current step: shown first
  tools?: ReactNode; // manual upload: shown last
  frozen: { src: string; marker: Marker } | null;
  onCloseFrozen: () => void;
  micOn: boolean;
  onToggleMic: () => void;
  onSwitchCamera: () => void;
  onEnd: () => void;
  alert: Alert | null;
  onDismissAlert: () => void;
  hostRef?: (el: HTMLElement | null) => void;
  /** Optional per-frame audio source for the orb (used by the design preview). */
  voice?: () => number[];
}

const STATE_LINE: Record<OrbState, string> = {
  speaking: "Talking you through it",
  listening: "Listening to you",
  thinking: "Working it out",
  connecting: "Opening the voice link",
  idle: "Standing by",
};

function useElapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** The call screen. Pure: everything comes in as props, so it can be previewed without a live call. */
export function CallHud(p: CallHudProps) {
  const v = p.view;
  const risk = v?.risk_level ?? "green";
  const elapsed = useElapsed();
  return (
    <div className="call-grid hud">
      <header className="call-top">
        <div className="hud-brand">
          <Logo size={24} />
          <span className="wordmark">REPAIRMIND<b>X</b></span>
          <span className="live-tag"><i aria-hidden />LIVE <span className="timer">{elapsed}</span></span>
        </div>
        <span className={`hud-chip state-${p.orbState}`}><i aria-hidden />{p.status}</span>
      </header>

      <section className="camera" ref={p.hostRef}>
        {p.camera}
        <div className="hud-frame" aria-hidden>
          <span className="br tl" /><span className="br tr" /><span className="br bl" /><span className="br br-" />
          <span className="scan" />
        </div>
        {p.overlay}
        <div className="hud-readout" aria-label="Session status">
          <div><b>DEVICE</b> {v?.device || "scanning…"}</div>
          <div className="ro-extra"><b>MODEL</b> {v?.device ? (v.model_confirmed ? "confirmed" : "not confirmed") : "—"}</div>
          {v?.diagnosis && <div className="ro-extra"><b>DIAG</b> {Math.round(v.confidence * 100)}%</div>}
        </div>
        {risk !== "green" && (
          <div className={`risk-banner risk-${risk}`} role="status">
            {risk === "red" ? "⚠ PROFESSIONAL REPAIR ONLY" : "⚠ SAFETY PRECAUTIONS REQUIRED"}
          </div>
        )}
        {v?.hazard && <div className="risk-banner risk-red hazard-banner" role="alert">⛔ STOP: {v.hazard}</div>}
        <div className="captions" aria-live="polite">
          {p.captions.map((c, i) => (
            <p key={i} className={c.who === "You" ? "me" : "ai"}>
              <b>{c.who === "You" ? "YOU" : "MECHANIC"}</b> {c.text}
            </p>
          ))}
        </div>
      </section>

      {p.frozen && (
        <section className="frozen" aria-label="The mechanic is pointing at this">
          <div className="frozen-img">
            <img src={p.frozen.src} alt="Still frame from your camera" />
            <MarkerOverlay m={p.frozen.marker} />
          </div>
          <div className="frozen-bar">
            <span>
              Look here: {p.frozen.marker.label}
              {p.frozen.marker.precise === false && <em className="approx"> (approximate)</em>}
            </span>
            <button className="ghost" onClick={p.onCloseFrozen}>Back to live</button>
          </div>
        </section>
      )}

      <aside className="panel">
        <div className={`presence presence-${p.orbState}`}>
          <VoiceOrb state={p.orbState} bands={p.bands} voice={p.voice} size={220} detail="full" />
          <div className="presence-text">
            <span className="hud-h">MECHANIC</span>
            <b>{p.status}</b>
            <span className="dim small">{STATE_LINE[p.orbState]}</span>
          </div>
        </div>
        {p.side}
        <RepairPanel view={v} />
        {p.tools}
      </aside>

      <footer className="controls">
        <button className={p.micOn ? "ctl" : "ctl off"} onClick={p.onToggleMic} aria-pressed={!p.micOn}>
          {p.micOn ? <Mic size={18} /> : <MicOff size={18} />}<span>{p.micOn ? "Mute" : "Unmute"}</span>
        </button>
        <div className="orb-slot"><VoiceOrb state={p.orbState} bands={p.bands} voice={p.voice} size={100} /></div>
        <button className="ctl" onClick={p.onSwitchCamera}><Flip size={18} /><span>Flip cam</span></button>
        <button className="ctl danger" onClick={p.onEnd}><PhoneOff size={18} /><span>End</span></button>
      </footer>

      {p.alert && (
        <div className="modal" role="alertdialog" aria-modal>
          <div className={`modal-card ${p.alert.kind === "hazard_stop" ? "hazard" : "red"}`}>
            <h2>{p.alert.kind === "hazard_stop" ? "Stop now" : "This needs a professional"}</h2>
            <p>{p.alert.message}</p>
            <button className="primary" onClick={p.onDismissAlert}>I understand</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MarkerOverlay({ m }: { m: Marker }) {
  const hasBox = m.w > 0.01 && m.h > 0.01;
  const x0 = (m.x - m.w / 2) * 100, y0 = (m.y - m.h / 2) * 100, x1 = x0 + m.w * 100, y1 = y0 + m.h * 100;
  const c = Math.min(m.w, m.h) * 30 + 1.5;
  return (
    <svg className="marker" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {hasBox ? (
        <path className="mk-box" d={brackets(x0, y0, x1, y1, c)} />
      ) : (
        <circle cx={m.x * 100} cy={m.y * 100} r="5" className="mk-box" />
      )}
      <line x1={Math.min(95, m.x * 100 + 18)} y1={Math.max(5, m.y * 100 - 18)} x2={m.x * 100 + 4}
            y2={m.y * 100 - 4} className="mk-arrow" />
    </svg>
  );
}

/** Four corner brackets around a box: the HUD targeting look, used for markers on stills and live AR. */
export function brackets(x0: number, y0: number, x1: number, y1: number, c: number): string {
  return [
    `M ${x0} ${y0 + c} V ${y0} H ${x0 + c}`, `M ${x1 - c} ${y0} H ${x1} V ${y0 + c}`,
    `M ${x1} ${y1 - c} V ${y1} H ${x1 - c}`, `M ${x0 + c} ${y1} H ${x0} V ${y1 - c}`,
  ].join(" ");
}

const STATUS_LABEL: Record<StepView["status"], string> = {
  pending: "Queued", awaiting_confirmation: "Needs your OK", active: "Now", done: "Done", failed: "Failed",
  blocked: "Blocked",
};

function RepairPanel({ view }: { view: SessionView | null }) {
  if (!view) {
    return (
      <div className="hud-card">
        <h2 className="hud-h">DIAGNOSTICS</h2>
        <p className="dim">Show the mechanic your device. This fills in as it identifies the device and works out
          what's wrong.</p>
      </div>
    );
  }
  const done = view.steps.filter((s) => s.status === "done").length;
  return (
    <div className="panel-body">
      <div className="hud-card">
        <h2 className="hud-h">DIAGNOSTICS</h2>
        <div className="diag">
          <Gauge value={view.diagnosis ? view.confidence : view.hypotheses[0]?.confidence ?? 0} />
          <div>
            <span className="lbl">{view.diagnosis ? "Diagnosis" : view.hypotheses.length ? "Leading cause" : "Device"}</span>
            <b>{view.diagnosis || view.hypotheses[0]?.cause || view.device || "Not identified yet"}</b>
            {view.device && !view.model_confirmed && <em className="warn-t">Model not confirmed: show the label</em>}
          </div>
        </div>
        {!view.diagnosis && view.hypotheses.length > 1 && (
          <ul className="hyp">
            {view.hypotheses.slice(1).map((h) => (
              <li key={h.cause}><span>{h.cause}</span><Bar value={h.confidence} /></li>
            ))}
          </ul>
        )}
      </div>

      <div className={`hud-card safety safety-${view.risk_level}`}>
        <h2 className="hud-h">SAFETY <span className={`lvl lvl-${view.risk_level}`}>{view.risk_level.toUpperCase()}</span></h2>
        {view.risk_reasons.length > 0 && <p className="dim small">{view.risk_reasons.join(" · ")}</p>}
        {view.precautions.length > 0 ? (
          <ul className="checklist">
            {view.precautions.map((p) => (
              <li key={p.id} className={p.done ? "done" : ""}><i aria-hidden>{p.done ? "✓" : ""}</i>{p.text}</li>
            ))}
          </ul>
        ) : (
          <p className="dim small">No special precautions for this job so far.</p>
        )}
      </div>

      <div className="hud-card">
        <h2 className="hud-h">PROCEDURE <span className="dim">{view.steps.length ? `${done}/${view.steps.length}` : ""}</span></h2>
        {view.steps.length === 0 ? (
          <p className="dim small">No steps yet. Diagnosis comes first.</p>
        ) : (
          <ol className="timeline">
            {view.steps.map((s, i) => (
              <li key={s.id} className={`st-${s.status}`}>
                <span className="node" aria-hidden>{s.status === "done" ? "✓" : i + 1}</span>
                <div>
                  <span className="tag">{STATUS_LABEL[s.status]}</span>
                  <p>{s.text}</p>
                  {s.irreversible.length > 0 && <p className="warn">Can't be undone: {s.irreversible.join(", ")}</p>}
                  {s.source && <p className="src">Source: {s.source}</p>}
                  {s.cross_checked && <p className="checked">Double-checked by a second AI</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {view.escalated && <p className="note">Handed to a human expert with the full repair history.</p>}
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const cls = pct >= 85 ? "hi" : pct >= 75 ? "mid" : "lo";
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg className={`gauge g-${cls}`} viewBox="0 0 64 64" role="img" aria-label={`${pct}% sure`}>
      <circle className="g-track" cx="32" cy="32" r={r} />
      <circle className="g-val" cx="32" cy="32" r={r} strokeDasharray={`${(c * pct) / 100} ${c}`}
              transform="rotate(-90 32 32)" />
      <text x="32" y="36" textAnchor="middle">{pct}%</text>
    </svg>
  );
}

function Bar({ value }: { value: number }) {
  return <span className="bar" aria-label={`${Math.round(value * 100)}%`}><span style={{ width: `${value * 100}%` }} /></span>;
}
