import { useEffect, useState, type ReactNode } from "react";
import type { Alert, Diagram, Marker, PartSearch, SessionView, StepView } from "../types";
import { VoiceOrb, type OrbState } from "./VoiceOrb";
import { Cart, Flip, Hand, Lasso, Logo, Mic, MicOff, NextStep, PhoneOff, Wake } from "../ui/Icons";
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
  /** Hands-on tools: circle to ask, "What next?" and push-to-talk. Left out, the call screen hides them. */
  actions?: HudActions;
  /** The circle-to-ask drawing layer, shown over the live video while circling. */
  ask?: ReactNode;
  diagram?: Diagram | null;
  onCloseDiagram?: () => void;
  /** Shopping searches for parts the mechanic looked up. */
  parts?: PartSearch[];
  /** The call notes so far (session copilot), newest last. */
  notes?: { at: string; text: string }[];
  /** A short confirmation, e.g. "Sent. The mechanic is looking." */
  toast?: string;
  /** Optional per-frame audio source for the orb (used by the design preview). */
  voice?: () => number[];
}

export interface HudActions {
  circling: boolean;
  onCircle: () => void;
  onNext: () => void;
  ptt: boolean; // push-to-talk mode: the mic is open only while the hold button (or Space) is held
  talking: boolean;
  onTogglePtt: () => void;
  onTalk: (down: boolean) => void;
  /** Hands-free wake word. Left out when this device can't listen on-device. */
  wake?: { state: "off" | "on" | "installing"; onToggle: () => void };
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
  // one line under the picture: the newest thing said (the full captions would cover the view)
  const last = p.captions.length ? p.captions[p.captions.length - 1] : null;
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

      {/* The live view carries only the picture and what points at the real part. Everything else sits
          in the dock under it, so nothing covers what the camera sees. */}
      <div className="stage">
        <section className="camera" ref={p.hostRef}>
          {p.camera}
          {p.overlay}
          {p.ask}
          {v?.hazard ? (
            <div className="risk-strip risk-red hazard-banner" role="alert">{t("call.stop", { what: auto(v.hazard) })}</div>
          ) : risk !== "green" ? (
            <div className={`risk-strip risk-${risk}`} role="status">{risk === "red" ? t("call.proOnly") : t("call.precautionsReq")}</div>
          ) : null}
        </section>
        <div className="dock">
          <div className="dock-line" aria-live="polite">
            {p.toast ? (
              <p className="dock-toast" role="status">{p.toast}</p>
            ) : last ? (
              <p className={last.who === "You" ? "me" : "ai"}>
                <b>{last.who === "You" ? t("call.you") : t("call.mechanic")}</b> {last.text}
              </p>
            ) : (
              <p className="dim">{v?.device ? auto(v.device) : t("call.scanning")}</p>
            )}
          </div>
          {p.actions && !p.actions.circling && (
            <div className="dock-tools">
              <button aria-label={t("call.circle")} className="tool" onClick={p.actions.onCircle} title={t("call.circle.hint")}>
                <Lasso size={18} /><span>{t("call.circle")}</span>
              </button>
              <button aria-label={t("call.next")} className="tool" onClick={p.actions.onNext}>
                <NextStep size={18} /><span>{t("call.next")}</span>
              </button>
              <button aria-label={t("call.ptt")} className={`tool${p.actions.ptt ? " on" : ""}`} aria-pressed={p.actions.ptt} onClick={p.actions.onTogglePtt}
                      title={p.actions.ptt ? t("call.ptt.on") : t("call.ptt.off")}>
                <Hand size={18} /><span>{t("call.ptt")}</span>
              </button>
              {p.actions.wake && (
                <button aria-label={t("call.wake")} className={`tool${p.actions.wake.state !== "off" ? " on" : ""}`} aria-pressed={p.actions.wake.state === "on"}
                        disabled={p.actions.wake.state === "installing"} onClick={p.actions.wake.onToggle}
                        title={p.actions.wake.state === "on" ? t("call.wake.on") : t("call.wake.off")}>
                  <Wake size={18} /><span>{t("call.wake")}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

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

      {p.diagram && <DiagramView d={p.diagram} onClose={p.onCloseDiagram} />}

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
        {p.parts && p.parts.length > 0 && <PartsCard parts={p.parts} />}
        {p.side}
        <button className="hud-more" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          {details ? t("call.details.hide") : t("call.details.show")}
          <span aria-hidden className="chev" />
        </button>
        {details && (
          <>
            <RepairPanel view={v} />
            {p.notes && (
              <div className="hud-card">
                <h2 className="hud-h">{t("call.notes")}</h2>
                {p.notes.length ? (
                  <ul className="notes">{p.notes.slice(-12).map((n, i) => <li key={i}><time>{n.at}</time>{auto(n.text)}</li>)}</ul>
                ) : (
                  <p className="dim small">{t("call.notes.empty")}</p>
                )}
              </div>
            )}
            {p.tools}
          </>
        )}
      </aside>

      <footer className="controls">
        {p.actions?.ptt ? (
          <button className={`ctl ptt${p.actions.talking ? " talking" : ""}`} aria-pressed={p.actions.talking}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); p.actions!.onTalk(true); }}
                  onPointerUp={() => p.actions!.onTalk(false)} onPointerCancel={() => p.actions!.onTalk(false)}
                  onContextMenu={(e) => e.preventDefault()}>
            <Mic size={18} /><span>{p.actions.talking ? t("call.ptt.talking") : t("call.ptt.hold")}</span>
          </button>
        ) : (
          <button className={p.micOn ? "ctl" : "ctl off"} onClick={p.onToggleMic} aria-pressed={!p.micOn}>
            {p.micOn ? <Mic size={18} /> : <MicOff size={18} />}<span>{p.micOn ? t("call.mute") : t("call.unmute")}</span>
          </button>
        )}
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

/** Teach mode: a still of the camera with numbered parts, and the names in a numbered list under it,
 *  so labels never cover the parts or each other, even on a small phone screen. */
export function DiagramView({ d, onClose }: { d: Diagram; onClose?: () => void }) {
  const { t, auto } = useI18n();
  return (
    <section className="frozen diagram" aria-label={t("call.diagram")}>
      <div className="frozen-img">
        <img src={d.image} alt={t("call.still")} />
        <svg className="diagram-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {d.items.map((i) => {
            const x0 = (i.x - i.w / 2) * 100, y0 = (i.y - i.h / 2) * 100;
            return <path key={i.n} className="mk-box" d={brackets(x0, y0, x0 + i.w * 100, y0 + i.h * 100, Math.min(i.w, i.h) * 30 + 1.5)} />;
          })}
        </svg>
        {d.items.map((i) => (
          <b key={i.n} className="dg-num" aria-hidden
             style={{ left: `${Math.max(0, i.x - i.w / 2) * 100}%`, top: `${Math.max(0, i.y - i.h / 2) * 100}%` }}>{i.n}</b>
        ))}
      </div>
      <div className="frozen-bar diagram-bar">
        <div>
          <b>{auto(d.title)}</b>
          <ol className="dg-legend">
            {d.items.map((i) => <li key={i.n}><b>{i.n}</b>{auto(i.label)}</li>)}
          </ol>
        </div>
        {onClose && <button className="ghost" onClick={onClose}>{t("call.backLive")}</button>}
      </div>
    </section>
  );
}

function PartsCard({ parts }: { parts: PartSearch[] }) {
  const { t, auto } = useI18n();
  return (
    <div className="hud-card parts">
      <h2 className="hud-h"><Cart size={14} /> {t("call.parts")}</h2>
      {parts.slice(-3).reverse().map((p) => (
        <div key={p.query} className="part">
          <b>{auto(p.part)}</b>{p.number && <span className="dim small"> {p.number}</span>}
          <div className="part-links">
            {p.links.map((l) => <a key={l.shop} href={l.url} target="_blank" rel="noopener noreferrer">{l.shop}</a>)}
          </div>
        </div>
      ))}
      <p className="dim small">{t("call.parts.note")}</p>
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

/** How sure, in words, matching the agent's thresholds (reasoning/evidence.py certainty()). */
function certainKey(p: number): Key {
  return (p >= 0.9 ? "call.certain.sure" : p >= 0.75 ? "call.certain.fairly" : p >= 0.5 ? "call.certain.leaning" : "call.certain.unsure") as Key;
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
    sub = `${t(certainKey(pct / 100))} · ${t("call.sure", { pct })}`;
  } else if (view.next_test) {
    k = t("call.now.test");
    body = auto(view.next_test.test);
  } else if (view.hypotheses.length) {
    k = t("call.now.likely");
    body = auto(view.hypotheses[0].cause);
    sub = `${t(certainKey(pct / 100))} · ${t("call.sure", { pct })}`;
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
      {!step && !view.diagnosis && view.next_test && (
        <ul className="now-test">
          {view.next_test.outcomes.map((o) => (
            <li key={o.reading}><b>{t("call.test.means", { reading: auto(o.reading) })}</b> {o.means.map(auto).join(", ")}</li>
          ))}
        </ul>
      )}
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
        {(view.hypotheses.length > 0 || view.diagnosis) && (
          <p className="dim small certain">{t(certainKey(view.diagnosis ? view.confidence : view.hypotheses[0]?.confidence ?? 0))}</p>
        )}
        {!view.diagnosis && view.hypotheses.length > 1 && (
          <ul className="hyp">
            {view.hypotheses.slice(1).map((h) => (
              <li key={h.cause}><span>{auto(h.cause)}</span><Bar value={h.confidence} /></li>
            ))}
          </ul>
        )}
        {(view.unexplained ?? 0) >= 0.3 && <p className="warn-t small">{t("call.unexplained", { pct: Math.round((view.unexplained ?? 0) * 100) })}</p>}
        {!!view.readings?.length && (
          <>
            <span className="lbl readings-h">{t("call.readings")}</span>
            <ul className="readings">
              {view.readings.map((r, i) => <li key={i}><span>{auto(r.test)}</span><b>{auto(r.reading)}</b></li>)}
            </ul>
          </>
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
