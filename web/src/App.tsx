import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { Call } from "./Call";
import { Inspect } from "./Inspect";
import { VoiceOrb } from "./hud/VoiceOrb";
import { NetworkBackground } from "./fx/NetworkBackground";
import { Intro, shouldPlayIntro } from "./fx/Intro";
import { makeDemoVoice } from "./fx/demoVoice";
import { Alert, Arrow, Camera, Check2, Doc, Grid, Logo, Shield, Target, Wave, Wrench } from "./ui/Icons";

// The design preview (a fake call with sample data) only loads when someone opens #demo.
const Demo = lazy(() => import("./Demo").then((m) => ({ default: m.Demo })));

interface Connection {
  serverUrl: string;
  token: string;
  room: string;
}

const LAST_ROOM_KEY = "rmx.lastRoom";

function readLastRoom(): string | null {
  try {
    return localStorage.getItem(LAST_ROOM_KEY);
  } catch {
    return null;
  }
}

function writeLastRoom(room: string | null) {
  try {
    if (room) localStorage.setItem(LAST_ROOM_KEY, room);
    else localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* storage unavailable: resume just won't be offered */
  }
}

type Page = "call" | "inspect" | "demo";
const pageFromHash = (): Page =>
  window.location.hash === "#inspect" ? "inspect" : window.location.hash.startsWith("#demo") ? "demo" : "call";

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [intro, setIntro] = useState(() => pageFromHash() === "call" && shouldPlayIntro());
  const lastRoom = readLastRoom();
  const [page, setPage] = useState<Page>(pageFromHash);
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(next: "call" | "inspect") {
    window.location.hash = next === "inspect" ? "inspect" : "";
    setPage(next);
  }

  async function start(resumeRoom?: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accepted_notice: accepted, room: resumeRoom ?? null }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))).detail;
        throw new Error(
          detail ?? (res.status >= 500 ? "Can't reach the RepairMind server. Is the token server running?" : `Error ${res.status}`),
        );
      }
      const body = await res.json();
      writeLastRoom(body.room);
      setConn({ serverUrl: body.server_url, token: body.participant_token, room: body.room });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  let content;
  if (conn) {
    content = (
      <Call
        {...conn}
        onEnd={(finished) => {
          if (finished) writeLastRoom(null);
          setConn(null);
        }}
      />
    );
  } else if (page === "demo") {
    content = <Suspense fallback={null}><Demo /></Suspense>;
  } else if (page === "inspect") {
    content = <Inspect onBack={() => go("call")} />;
  } else {
    content = (
      <Landing
        accepted={accepted}
        setAccepted={setAccepted}
        loading={loading}
        error={error}
        lastRoom={lastRoom}
        onStart={start}
        onInspect={() => go("inspect")}
        entering={!intro}
      />
    );
  }

  return (
    <>
      <NetworkBackground intensity={conn || page === "demo" ? 0.55 : 1} />
      {content}
      {intro && !conn && <Intro onDone={() => setIntro(false)} />}
    </>
  );
}

interface LandingProps {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  lastRoom: string | null;
  onStart: (room?: string) => void;
  onInspect: () => void;
  entering: boolean;
}

function Landing(p: LandingProps) {
  const voice = useMemo(() => makeDemoVoice(), []);
  return (
    <div className={`site ${p.entering ? "site-in" : "site-wait"}`}>
      <header className="nav">
        <a className="nav-brand" href="#" onClick={(e) => e.preventDefault()}>
          <Logo size={30} />
          <span className="wordmark">REPAIRMIND<b>X</b></span>
        </a>
        <nav className="nav-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#safety">Safety</a>
          <a href="#inspect" onClick={(e) => { e.preventDefault(); p.onInspect(); }}>Bulk inspection</a>
        </nav>
        <span className="sys-pill"><i aria-hidden />SYSTEMS ONLINE</span>
      </header>

      <main className="landing-x">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow reveal" style={{ ["--d" as string]: "0.05s" }}>
              <span className="eyebrow-dot" aria-hidden /> Live video · AI mechanic · Step-by-step
            </p>
            <h1 className="reveal" style={{ ["--d" as string]: "0.12s" }}>
              Every machine has a solution.
              <span className="grad"> Let's find it.</span>
            </h1>
            <p className="lede reveal" style={{ ["--d" as string]: "0.2s" }}>
              Point your camera at the problem and talk. RepairMind sees what you see, marks the exact part on your
              screen, and walks you through the fix one checked step at a time.
            </p>

            <section className="launch reveal" id="safety" aria-label="Safety and privacy notice" style={{ ["--d" as string]: "0.3s" }}>
              <div className="launch-head">
                <span className="hud-kicker"><Shield size={16} /> Pre-flight safety check</span>
                <span className="launch-id">RMX · 01</span>
              </div>
              <ul className="launch-list">
                <li><Check2 size={18} /> The mechanic gives guidance, not a guarantee. You stay in control of every step.</li>
                <li>
                  <Shield size={18} /> It refuses dangerous jobs (microwave internals, mains wiring, gas, airbags, brakes,
                  refrigerant, high-voltage or swollen batteries) and points you to a professional.
                </li>
                <li className="li-alert"><Alert size={18} /> If you see smoke or sparks, smell gas or burning, or get hurt: stop and step away.</li>
                <li><Camera size={18} /> Your camera and microphone are streamed to the AI during the call. Video is not recorded.</li>
              </ul>
              <label className="check-x">
                <input type="checkbox" checked={p.accepted} onChange={(e) => p.setAccepted(e.target.checked)} />
                <span className="box" aria-hidden />
                <span>I understand and want to continue</span>
              </label>
              <div className="actions">
                <button className="btn-launch" disabled={!p.accepted || p.loading} onClick={() => p.onStart()}>
                  <span>{p.loading ? "Connecting…" : "Start AI Mechanic"}</span>
                  <Arrow size={18} />
                </button>
                {p.lastRoom && (
                  <button className="btn-ghost" disabled={!p.accepted || p.loading} onClick={() => p.onStart(p.lastRoom!)}>
                    Resume last repair
                  </button>
                )}
              </div>
              {p.error && <p className="error" role="alert">{p.error}</p>}
            </section>
          </div>

          <div className="hero-visual reveal" style={{ ["--d" as string]: "0.1s" }} aria-hidden>
            <div className="orb-stage">
              <div className="orb-plate" />
              <VoiceOrb state="speaking" bands={[]} voice={voice} size={420} detail="full" />
              <Callout className="co-a" label="VOICE LINK" value="ACTIVE" />
              <Callout className="co-b" label="OPTICS" value="TRACKING" />
              <Callout className="co-c" label="SAFETY GUARD" value="ARMED" />
              <Callout className="co-d" label="STEP CHECK" value="2× VERIFIED" />
            </div>
          </div>
        </section>

        <section className="how" id="how">
          <header className="sec-head">
            <span className="hud-kicker">Workflow</span>
            <h2>Three steps from broken to fixed</h2>
          </header>
          <ol className="how-grid">
            <HowCard n="01" icon={<Camera size={26} />} title="Show it">
              Start a call and point your phone at the device. The mechanic identifies the make and model and asks
              you to show the label when it isn't sure.
            </HowCard>
            <HowCard n="02" icon={<Wave size={26} />} title="Talk it through">
              Describe what's wrong in your own words. It asks a few questions, ranks the likely causes, and tells you
              how sure it is.
            </HowCard>
            <HowCard n="03" icon={<Wrench size={26} />} title="Fix it, step by step">
              Each step appears on screen with the exact part marked on your live video, and waits for your OK before
              anything that can't be undone.
            </HowCard>
          </ol>
        </section>

        <section className="features">
          <Feature icon={<Target size={22} />} title="Live AR pointing">Brackets lock onto the part on your moving camera, with arrows that show which way to turn, press or pull.</Feature>
          <Feature icon={<Shield size={22} />} title="Safety first">Risky jobs are flagged amber or red, precautions are checked off, and hazards stop the call cold.</Feature>
          <Feature icon={<Check2 size={22} />} title="Cross-checked steps">A second AI double-checks each instruction before you hear it.</Feature>
          <Feature icon={<Doc size={22} />} title="Your manual, cited">Upload the PDF manual and every step points to the page it came from.</Feature>
          <Feature icon={<Grid size={22} />} title="Bulk inspection">Factories and shops can check hundreds of unit photos and get an Excel report.</Feature>
          <Feature icon={<Wave size={22} />} title="Hands-free">Talk naturally while you work. Captions keep everything readable in a noisy room.</Feature>
        </section>

        <footer className="foot">
          <span className="nav-brand small"><Logo size={20} /><span className="wordmark">REPAIRMIND<b>X</b></span></span>
          <span>Guidance, not a guarantee. When in doubt, call a professional.</span>
        </footer>
      </main>
    </div>
  );
}

function Callout({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <div className={`callout ${className}`}>
      <span className="co-line" />
      <span className="co-text"><b>{label}</b><em>{value}</em></span>
    </div>
  );
}

function HowCard({ n, icon, title, children }: { n: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="how-card">
      <span className="how-n">{n}</span>
      <span className="how-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

function Feature({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="feature">
      <span className="feature-icon">{icon}</span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </div>
  );
}
