import { useEffect, useState, type ReactNode } from "react";
import type { Alert, Marker, SessionView, StepView } from "../types";
import { VoiceOrb, type OrbState } from "./VoiceOrb";
import { Flip, Logo, Mic, MicOff, PhoneOff } from "../ui/Icons";
import { AnatomyFigure, hasAnatomy } from "../anatomy/Anatomy";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";

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

const STATE_LINE: Record<OrbState, Key> = {
  speaking: "call.line.speaking",
  listening: "call.line.listening",
  thinking: "call.line.thinking",
  connecting: "call.line.connecting",
  idle: "call.line.idle",
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
  const { t, auto } = useI18n();
  const v = p.view;
  const risk = v?.risk_level ?? "green";
  const elapsed = useElapsed();
  // the full diagnostics, safety list, procedure and manual upload stay one tap away
  const [details, setDetails] = useState(false);
  return (
    <div className="call-grid hud">
      <header className="call-top">
        <div className="hud-brand">
          <Logo size={24} />
          <span className="wordmark">REPAIRMIND<b>X</b></span>
          <span className="live-tag"><i aria-hidden />{t("call.live")} <span className="timer">{elapsed}</span></span>
        </div>
        <div className="hud-top-r">
          <LanguagePicker className="hud-lang" />
          <span className={`hud-chip state-${p.orbState}`}><i aria-hidden />{p.status}</span>
        </div>
      </header>

      <section className="camera" ref={p.hostRef}>
        {p.camera}
        <div className="hud-frame" aria-hidden>
          <span className="br tl" /><span className="br tr" /><span className="br bl" /><span className="br br-" />
          <span className="scan" />
        </div>
        {p.overlay}
        <div className="hud-readout" aria-label="Session status">
          <div><b>{t("call.device")}</b> {v?.device ? auto(v.device) : t("call.scanning")}</div>
        </div>
        {risk !== "green" && (
          <div className={`risk-banner risk-${risk}`} role="status">
            {risk === "red" ? t("call.proOnly") : t("call.precautionsReq")}
          </div>
        )}
        {v?.hazard && <div className="risk-banner risk-red hazard-banner" role="alert">{t("call.stop", { what: auto(v.hazard) })}</div>}
        <div className="captions" aria-live="polite">
          {p.captions.map((c, i) => (
            <p key={i} className={c.who === "You" ? "me" : "ai"}>
              <b>{c.who === "You" ? t("call.you") : t("call.mechanic")}</b> {c.text}
            </p>
          ))}
        </div>
      </section>

      {p.frozen && (
        <section className="frozen" aria-label={t("call.pointing")}>
          <div className="frozen-img">
            <img src={p.frozen.src} alt={t("call.still")} />
            <MarkerOverlay m={p.frozen.marker} />
          </div>
          <div className="frozen-bar">
            <span>
              {t("call.lookHere", { label: auto(p.frozen.marker.label) })}
              {p.frozen.marker.precise === false && <em className="approx"> {t("call.approx")}</em>}
            </span>
            <button className="ghost" onClick={p.onCloseFrozen}>{t("call.backLive")}</button>
          </div>
        </section>
      )}

      <aside className="panel">
        <div className={`presence presence-${p.orbState}`}>
          <VoiceOrb state={p.orbState} bands={p.bands} voice={p.voice} size={160} detail="full" />
          <div className="presence-text">
            <span className="hud-h">{t("call.mechanic")}</span>
            <b>{p.status}</b>
            <span className="dim small">{t(STATE_LINE[p.orbState])}</span>
          </div>
        </div>
        <NowCard view={v} />
        {p.side}
        <button className="hud-more" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          {details ? t("call.details.hide") : t("call.details.show")}
          <span aria-hidden className="chev" />
        </button>
        {details && (
          <>
            <RepairPanel view={v} />
            {p.tools}
          </>
        )}
      </aside>

      <footer className="controls">
        <button className={p.micOn ? "ctl" : "ctl off"} onClick={p.onToggleMic} aria-pressed={!p.micOn}>
          {p.micOn ? <Mic size={18} /> : <MicOff size={18} />}<span>{p.micOn ? t("call.mute") : t("call.unmute")}</span>
        </button>
        <div className="orb-slot"><VoiceOrb state={p.orbState} bands={p.bands} voice={p.voice} size={92} /></div>
        <button className="ctl" onClick={p.onSwitchCamera}><Flip size={18} /><span>{t("call.flip")}</span></button>
        <button className="ctl danger" onClick={p.onEnd}><PhoneOff size={18} /><span>{t("call.end")}</span></button>
      </footer>

      {p.alert && (
        <div className="modal" role="alertdialog" aria-modal>
          <div className={`modal-card ${p.alert.kind === "hazard_stop" ? "hazard" : "red"}`}>
            <h2>{p.alert.kind === "hazard_stop" ? t("call.alert.stop") : t("call.alert.pro")}</h2>
            <p>{p.alert.kind === "hazard_stop" ? t("call.hazardMessage") : auto(p.alert.message)}</p>
            <button className="primary" onClick={p.onDismissAlert}>{t("call.alert.ok")}</button>
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

/** The one thing that matters right now, in plain words: the current step, or what's wrong so far. */
function NowCard({ view }: { view: SessionView | null }) {
  const { t, auto } = useI18n();
  if (!view) {
    return (
      <div className="hud-card now">
        <span className="now-k">{t("call.now.start")}</span>
        <p className="now-t">{t("call.now.show")}</p>
      </div>
    );
  }
  const steps = view.steps;
  const cur = steps.findIndex((s) => s.status === "active" || s.status === "awaiting_confirmation" || s.status === "blocked" || s.status === "failed");
  const step = cur >= 0 ? steps[cur] : null;
  const allDone = steps.length > 0 && steps.every((s) => s.status === "done");
  const left = view.precautions.filter((x) => !x.done).length;
  const pct = Math.round((view.diagnosis ? view.confidence : view.hypotheses[0]?.confidence ?? 0) * 100);
  let k: string, body: string, sub = "";
  if (step) {
    k = step.status === "awaiting_confirmation" ? t("call.step.awaiting_confirmation") : t("call.now.step", { n: cur + 1, total: steps.length });
    body = auto(step.text);
    if (step.irreversible.length) sub = t("call.irreversible", { what: step.irreversible.map(auto).join(", ") });
  } else if (allDone) {
    k = t("call.now.doneK");
    body = t("call.now.done");
  } else if (view.diagnosis) {
    k = t("call.now.diag");
    body = auto(view.diagnosis);
    sub = t("call.sure", { pct });
  } else if (view.hypotheses.length) {
    k = t("call.now.likely");
    body = auto(view.hypotheses[0].cause);
    sub = t("call.sure", { pct });
  } else if (view.device) {
    k = t("call.now.device");
    body = auto(view.device);
    if (!view.model_confirmed) sub = t("call.showLabel");
  } else {
    k = t("call.now.start");
    body = t("call.now.show");
  }
  return (
    <div className={`hud-card now${step?.status === "awaiting_confirmation" ? " now-ok" : ""}`}>
      <span className="now-k">{k}</span>
      <p className="now-t">{body}</p>
      {sub && <p className={`now-s${step ? " warn" : ""}`}>{sub}</p>}
      {steps.length > 0 && (
        <div className="now-bar" aria-hidden>
          {steps.map((s) => <i key={s.id} className={`st-${s.status}`} />)}
        </div>
      )}
      {left > 0 && view.risk_level !== "green" && <p className="now-safety">{t("call.now.safety", { n: left })}</p>}
    </div>
  );
}

function RepairPanel({ view }: { view: SessionView | null }) {
  const { t, auto } = useI18n();
  const status = (s: StepView["status"]) => t(`call.step.${s}` as Key);
  const precaution = (id: string, text: string) => {
    const key = `call.precaution.${id}` as Key;
    const got = t(key);
    return got === key ? auto(text) : got;
  };
  if (!view) {
    return (
      <div className="hud-card">
        <h2 className="hud-h">{t("call.diagnostics")}</h2>
        <p className="dim">{t("call.diagEmpty")}</p>
      </div>
    );
  }
  const done = view.steps.filter((s) => s.status === "done").length;
  return (
    <div className="panel-body">
      <div className="hud-card">
        <h2 className="hud-h">{t("call.diagnostics")}</h2>
        <div className="diag">
          <Gauge value={view.diagnosis ? view.confidence : view.hypotheses[0]?.confidence ?? 0} />
          <div>
            <span className="lbl">{view.diagnosis ? t("call.diagnosis") : view.hypotheses.length ? t("call.leading") : t("call.deviceLbl")}</span>
            <b>{auto(view.diagnosis || view.hypotheses[0]?.cause || view.device) || t("call.notIdentified")}</b>
            {view.device && !view.model_confirmed && <em className="warn-t">{t("call.showLabel")}</em>}
          </div>
        </div>
        {!view.diagnosis && view.hypotheses.length > 1 && (
          <ul className="hyp">
            {view.hypotheses.slice(1).map((h) => (
              <li key={h.cause}><span>{auto(h.cause)}</span><Bar value={h.confidence} /></li>
            ))}
          </ul>
        )}
      </div>

      {hasAnatomy(view) && (
        <div className="hud-card anat-wrap">
          <h2 className="hud-h">{t("call.anatomy")}</h2>
          <AnatomyFigure view={view} />
        </div>
      )}

      <div className={`hud-card safety safety-${view.risk_level}`}>
        <h2 className="hud-h">{t("call.safety")} <span className={`lvl lvl-${view.risk_level}`}>{t(`call.risk.${view.risk_level}` as Key)}</span></h2>
        {view.risk_reasons.length > 0 && <p className="dim small">{view.risk_reasons.map(auto).join(" · ")}</p>}
        {view.precautions.length > 0 ? (
          <ul className="checklist">
            {view.precautions.map((p) => (
              <li key={p.id} className={p.done ? "done" : ""}><i aria-hidden>{p.done ? "✓" : ""}</i>{precaution(p.id, p.text)}</li>
            ))}
          </ul>
        ) : (
          <p className="dim small">{t("call.noPrecautions")}</p>
        )}
      </div>

      <div className="hud-card">
        <h2 className="hud-h">{t("call.procedure")} <span className="dim">{view.steps.length ? `${done}/${view.steps.length}` : ""}</span></h2>
        {view.steps.length === 0 ? (
          <p className="dim small">{t("call.noSteps")}</p>
        ) : (
          <ol className="timeline">
            {view.steps.map((s, i) => (
              <li key={s.id} className={`st-${s.status}`}>
                <span className="node" aria-hidden>{s.status === "done" ? "✓" : i + 1}</span>
                <div>
                  <span className="tag">{status(s.status)}</span>
                  <p>{auto(s.text)}</p>
                  {s.irreversible.length > 0 && <p className="warn">{t("call.irreversible", { what: s.irreversible.map(auto).join(", ") })}</p>}
                  {s.source && <p className="src">{t("call.source", { src: s.source })}</p>}
                  {s.cross_checked && <p className="checked">{t("call.checked")}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {view.escalated && <p className="note">{t("call.escalated")}</p>}
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const { t } = useI18n();
  const pct = Math.round(value * 100);
  const cls = pct >= 85 ? "hi" : pct >= 75 ? "mid" : "lo";
  const r = 26, c = 2 * Math.PI * r;
  return (
    <svg className={`gauge g-${cls}`} viewBox="0 0 64 64" role="img" aria-label={t("call.sure", { pct })}>
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
