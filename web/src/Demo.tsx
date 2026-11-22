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
  device: "Example belt-drive turntable (EX-TT20)",
  device_type: "turntable",
  model_confirmed: true,
  risk_level: "green",
  risk_reasons: [],
  precautions: [
    { id: "p1", text: "Unplugged from the wall", done: true },
    { id: "p2", text: "Stylus guard on, arm clipped in its rest", done: true },
  ],
  diagnosis: "Worn drive belt",
  confidence: 0.88,
  hypotheses: [],
  steps: [
    { id: "s1", text: "Switch the turntable off and unplug it from the wall.", status: "done", risk: "green", irreversible: [], source: "procedure example-turntable/replace-belt#s1" },
    { id: "s2", text: "Take the mat off, then lift the platter straight up and set it down face first on a towel.", status: "done", risk: "green", irreversible: [], source: "procedure example-turntable/replace-belt#s2", cross_checked: true },
    { id: "s3", text: "Loop the new belt round the sub-platter, then pull it over the motor pulley with the ribbon.", status: "active", risk: "green", irreversible: [], source: "procedure example-turntable/replace-belt#s3" },
    { id: "s4", text: "Refit the platter, turn it by hand to seat the belt, then check the speed with the strobe dots.", status: "pending", risk: "green", irreversible: [], source: "procedure example-turntable/replace-belt#s4" },
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
      ? { ...VIEW, risk_level: "amber", risk_reasons: ["Fragile stylus near your hands"], precautions: [...VIEW.precautions, { id: "p3", text: "Take the cartridge off if the arm won\u2019t clip down", done: false }] }
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
        { who: "You", text: "Okay, the platter is off and the old belt is out." },
        { who: "Mechanic", text: "Good. Loop the new belt round the sub-platter, then use the ribbon to pull it over the brass pulley at the back left." },
      ]}
      camera={<DemoCamera />}
      overlay={
        <div className="demo-ar">
          <MarkerOverlay m={{ x: 0.3, y: 0.36, w: 0.09, h: 0.12, label: "motor pulley" }} />
          <span className="ar-label demo-ar-label" style={{ left: "30%", top: "26%" }}>MOTOR PULLEY</span>
        </div>
      }
      frozen={null}
      onCloseFrozen={() => undefined}
      micOn
      onToggleMic={() => undefined}
      onSwitchCamera={() => undefined}
      onEnd={() => { window.location.hash = ""; window.location.reload(); }}
      alert={alertOpen ? { kind: "hazard_stop", message: "I can see smoke near the motor. Unplug the turntable at the wall if it's safe to reach, step back, and don't touch it until it has cooled down." } : null}
      onDismissAlert={() => setAlertOpen(false)}
    />
  );
}

/** A drawn stand-in for the camera feed: a record player on a desk with its platter off. */
function DemoCamera() {
  return (
    <svg className="demo-cam" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid slice" aria-label="Sample camera view of a record player with the platter off">
      <defs>
        <linearGradient id="dc-desk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a3a2a" /><stop offset="1" stopColor="#2a2018" />
        </linearGradient>
        <linearGradient id="dc-deck" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a2f38" /><stop offset="1" stopColor="#15191f" />
        </linearGradient>
        <radialGradient id="dc-light" cx="0.45" cy="0.3" r="0.7">
          <stop offset="0" stopColor="rgba(255,240,220,.16)" /><stop offset="1" stopColor="rgba(0,0,0,0)" />
        </radialGradient>
      </defs>
      <rect width="1000" height="700" fill="url(#dc-desk)" />
      {/* plinth seen from above and in front */}
      <path d="M120 170 L880 150 L930 560 L80 590 Z" fill="url(#dc-deck)" stroke="#3a414c" strokeWidth="3" />
      <path d="M80 590 L930 560 L930 600 L80 632 Z" fill="#0d1014" />
      {/* motor pulley (back left) and power knob */}
      <circle cx="300" cy="252" r="22" fill="#121418" />
      <ellipse cx="300" cy="248" rx="14" ry="12" fill="#c9a24a" stroke="#8a6b26" strokeWidth="3" />
      <circle cx="175" cy="215" r="26" fill="#8d96a4" stroke="#5b6370" strokeWidth="3" />
      {/* sub-platter with the new belt on it, pulled toward the pulley */}
      <ellipse cx="430" cy="380" rx="118" ry="100" fill="#1d2128" stroke="#4b5260" strokeWidth="4" />
      <ellipse cx="430" cy="372" rx="26" ry="22" fill="#9aa3b1" />
      <path d="M318 405 C 300 340 290 290 300 262 C 312 250 330 262 350 290 C 400 300 520 300 548 370 C 552 440 470 486 400 478 C 352 470 326 440 318 405" fill="none" stroke="#0a0b0d" strokeWidth="7" />
      <path d="M300 262 L 262 226" stroke="#e85c9a" strokeWidth="4" strokeLinecap="round" />
      {/* tonearm clipped in its rest, speed buttons, pitch slider */}
      <circle cx="770" cy="250" r="42" fill="#15181d" stroke="#3d4450" strokeWidth="3" />
      <circle cx="770" cy="250" r="14" fill="#b8c0cc" />
      <path d="M770 250 L 800 520" stroke="#cfd6df" strokeWidth="7" strokeLinecap="round" />
      <rect x="784" y="508" width="34" height="46" rx="6" fill="#1b1f25" stroke="#aab2bf" strokeWidth="2" transform="rotate(-6 800 530)" />
      <circle cx="745" cy="200" r="20" fill="#20242b" stroke="#6b7380" strokeWidth="3" />
      <ellipse cx="185" cy="520" rx="26" ry="18" fill="#8d96a4" /><ellipse cx="250" cy="518" rx="26" ry="18" fill="#8d96a4" />
      <rect x="870" y="300" width="12" height="160" rx="6" fill="#0d0f12" /><rect x="860" y="370" width="32" height="22" rx="5" fill="#9aa3b1" />
      <rect width="1000" height="700" fill="url(#dc-light)" />
    </svg>
  );
}
