import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CameraView } from "./fx/showroom/CameraView";
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
  // the AR marker follows the motor pulley as the handheld camera moves
  const [pin, setPin] = useState({ x: 0.3, y: 0.36 });
  const onPin = useCallback((x: number, y: number) => {
    setPin((p) => (Math.abs(p.x - x) + Math.abs(p.y - y) < 0.002 ? p : { x, y }));
  }, []);

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
      camera={<DemoCamera onPin={onPin} />}
      overlay={
        <div className="demo-ar">
          <MarkerOverlay m={{ x: pin.x, y: pin.y, w: 0.07, h: 0.1, label: "motor pulley" }} />
          <span className="ar-label demo-ar-label" style={{ left: `${pin.x * 100}%`, top: `${(pin.y - 0.11) * 100}%` }}>MOTOR PULLEY</span>
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

/** The camera feed stand-in: the record player rendered in 3D as if seen through a phone (./fx/showroom/CameraView). */
function DemoCamera({ onPin }: { onPin: (x: number, y: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pin = useRef(onPin);
  pin.current = onPin;
  useEffect(() => {
    if (!ref.current) return;
    let view: CameraView | null = null;
    try {
      view = new CameraView(ref.current, (x, y) => pin.current(x, y));
    } catch {
      /* no WebGL: the call screen still works without the picture */
    }
    return () => view?.dispose();
  }, []);
  return <canvas ref={ref} className="demo-cam" role="img" aria-label="Sample camera view: a record player on a desk with its platter lifted off, showing the belt and motor pulley" />;
}
