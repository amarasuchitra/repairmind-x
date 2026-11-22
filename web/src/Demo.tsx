import { useEffect, useMemo, useState } from "react";
import { CallHud, MarkerOverlay } from "./hud/CallHud";
import type { OrbState } from "./hud/VoiceOrb";
import { makeDemoVoice } from "./fx/demoVoice";
import type { SessionView } from "./types";

/**
 * Design preview at #demo: the real call screen with sample data and a simulated voice, so the
 * interface can be reviewed without a server, camera or LiveKit. #demo-alert shows a hazard stop,
 * #demo-amber shows a job that needs precautions.
 */
const VIEW: SessionView = {
  session_id: "demo",
  device: "Example 30 cm desk fan (EX-DF30B)",
  device_type: "fan",
  model_confirmed: true,
  risk_level: "green",
  risk_reasons: [],
  precautions: [
    { id: "p1", text: "Unplugged from the wall", done: true },
    { id: "p2", text: "Blade has stopped", done: true },
  ],
  diagnosis: "Dust build-up on blade",
  confidence: 0.92,
  hypotheses: [],
  steps: [
    { id: "s1", text: "Switch the fan off and unplug it from the wall.", status: "done", risk: "green", irreversible: [], source: "procedure example-desk-fan/clean-blade#s1" },
    { id: "s2", text: "Undo the guard clips and lift the front guard off.", status: "done", risk: "green", irreversible: [], source: "procedure example-desk-fan/clean-blade#s2", cross_checked: true },
    { id: "s3", text: "Turn the blade cap clockwise to loosen it, because it has a left-hand thread, then take it off.", status: "active", risk: "green", irreversible: [], source: "procedure example-desk-fan/clean-blade#s3" },
    { id: "s4", text: "Slide the blade off the shaft and wipe both sides with a damp cloth, then dry it.", status: "pending", risk: "green", irreversible: [], source: "procedure example-desk-fan/clean-blade#s4" },
  ],
  hazard: "",
  escalated: false,
};

const CYCLE: { state: OrbState; secs: number }[] = [
  { state: "speaking", secs: 4.2 },
  { state: "listening", secs: 3 },
  { state: "thinking", secs: 1.8 },
];

export function Demo() {
  const variant = window.location.hash.replace("#demo", "").replace(/^-/, "");
  const voice = useMemo(() => makeDemoVoice(12, 3.6, 0.6), []);
  const [phase, setPhase] = useState(0);
  const fixed = new URLSearchParams(window.location.search).get("state") as OrbState | null;
  useEffect(() => {
    if (fixed) return;
    const id = window.setTimeout(() => setPhase((p) => (p + 1) % CYCLE.length), CYCLE[phase].secs * 1000);
    return () => window.clearTimeout(id);
  }, [phase, fixed]);
  const orbState = fixed ?? CYCLE[phase].state;
  const [alertOpen, setAlertOpen] = useState(variant === "alert");

  const view: SessionView =
    variant === "amber"
      ? { ...VIEW, risk_level: "amber", risk_reasons: ["Sharp blade edges"], precautions: [...VIEW.precautions, { id: "p3", text: "Wear gloves when handling the blade", done: false }] }
      : variant === "alert"
        ? { ...VIEW, risk_level: "red", hazard: "Smoke near the motor housing" }
        : VIEW;

  return (
    <CallHud
      status={{ speaking: "Speaking", listening: "Listening", thinking: "Thinking", connecting: "Connecting", idle: "Online" }[orbState]}
      orbState={orbState}
      bands={[]}
      voice={voice}
      view={view}
      captions={[
        { who: "You", text: "Okay, the front guard is off." },
        { who: "Mechanic", text: "Great. Now turn the yellow blade cap clockwise. It has a left-hand thread, so clockwise loosens it." },
      ]}
      camera={<DemoCamera />}
      overlay={
        <div className="demo-ar">
          <MarkerOverlay m={{ x: 0.5, y: 0.47, w: 0.13, h: 0.13, label: "blade cap" }} />
          <span className="ar-label demo-ar-label" style={{ left: "50%", top: "38%" }}>BLADE CAP</span>
        </div>
      }
      frozen={null}
      onCloseFrozen={() => undefined}
      micOn
      onToggleMic={() => undefined}
      onSwitchCamera={() => undefined}
      onEnd={() => { window.location.hash = ""; window.location.reload(); }}
      alert={alertOpen ? { kind: "hazard_stop", message: "I can see smoke near the motor. Unplug the fan at the wall if it's safe to reach, step back, and don't touch it until it has cooled down." } : null}
      onDismissAlert={() => setAlertOpen(false)}
    />
  );
}

/** A drawn stand-in for the camera feed: a desk fan on a workbench. */
function DemoCamera() {
  const spokes = Array.from({ length: 24 }, (_, i) => (i / 24) * Math.PI * 2);
  return (
    <svg className="demo-cam" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" aria-label="Sample camera view of a desk fan">
      <defs>
        <linearGradient id="dc-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d2836" /><stop offset="1" stopColor="#2b3646" />
        </linearGradient>
        <linearGradient id="dc-bench" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5a4632" /><stop offset="1" stopColor="#2c2117" />
        </linearGradient>
        <radialGradient id="dc-light" cx="0.5" cy="0.35" r="0.6">
          <stop offset="0" stopColor="rgba(255,240,220,.18)" /><stop offset="1" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
      </defs>
      <rect width="1000" height="560" fill="url(#dc-wall)" />
      <rect y="540" width="1000" height="160" fill="url(#dc-bench)" />
      <rect width="1000" height="700" fill="url(#dc-light)" />
      <ellipse cx="500" cy="610" rx="170" ry="26" fill="#cfd6df" />
      <rect x="485" y="500" width="30" height="110" fill="#aeb7c2" />
      <g transform="translate(500 330)">
        {[0, 120, 240].map((a) => (
          <path key={a} transform={`rotate(${a + 15})`} d="M0 0 C 40 -40 60 -150 10 -175 C -30 -150 -35 -60 0 0" fill="rgba(110,200,220,.55)" />
        ))}
        <circle r="200" fill="none" stroke="#e8edf2" strokeWidth="5" />
        {[50, 90, 130, 170].map((r) => <circle key={r} r={r} fill="none" stroke="#dfe5ea" strokeWidth="2.5" opacity=".9" />)}
        {spokes.map((a, i) => (
          <line key={i} x1={Math.cos(a) * 36} y1={Math.sin(a) * 36} x2={Math.cos(a) * 200} y2={Math.sin(a) * 200} stroke="#dfe5ea" strokeWidth="2.5" />
        ))}
        <circle r="36" fill="#f2b33d" stroke="#c98a1a" strokeWidth="3" />
        {Array.from({ length: 10 }, (_, i) => (i / 10) * Math.PI * 2).map((a, i) => (
          <line key={i} x1={Math.cos(a) * 12} y1={Math.sin(a) * 12} x2={Math.cos(a) * 30} y2={Math.sin(a) * 30} stroke="#9a6a12" strokeWidth="3" />
        ))}
        <ellipse rx="140" ry="62" fill="none" stroke="#f5b544" strokeWidth="5" transform="rotate(8)" strokeDasharray="700 200" />
        <path d="M -140 -10 l -22 26 l 30 4 z" fill="#f5b544" />
      </g>
    </svg>
  );
}
