import { useState } from "react";
import { Call } from "./Call";
import { Inspect } from "./Inspect";
import { VoiceOrb } from "./hud/VoiceOrb";

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

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRoom = readLastRoom();
  const [page, setPage] = useState(() => (window.location.hash === "#inspect" ? "inspect" : "call"));

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

  if (page === "inspect" && !conn) return <Inspect onBack={() => go("call")} />;

  if (conn) {
    return (
      <Call
        {...conn}
        onEnd={(finished) => {
          if (finished) writeLastRoom(null);
          setConn(null);
        }}
      />
    );
  }

  return (
    <main className="landing hud-landing">
      <div className="hud-brand">
        <span className="hud-mark" aria-hidden />
        <span>REPAIRMIND<span className="dim"> // X</span></span>
      </div>
      <div className="landing-orb" aria-hidden><VoiceOrb state="idle" bands={[]} size={132} /></div>
      <h1>Every machine has a solution. Let's find it.</h1>
      <p className="lede">
        Start a live video call with an AI mechanic. Show it the problem, answer a few questions, and it
        will talk you through the fix one checked step at a time.
      </p>

      <section className="notice" aria-label="Safety and privacy notice">
        <h2>Before you start</h2>
        <ul>
          <li>The mechanic gives guidance, not a guarantee. You stay in control of every step.</li>
          <li>
            It will refuse dangerous jobs (microwave internals, mains wiring, gas, airbags, brakes, refrigerant,
            high-voltage or swollen batteries) and point you to a professional.
          </li>
          <li>If you see smoke or sparks, smell gas or burning, or get hurt: stop and step away.</li>
          <li>Your camera and microphone are streamed to the AI during the call. Video is not recorded.</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>I understand and want to continue</span>
        </label>
      </section>

      <div className="actions">
        <button className="primary" disabled={!accepted || loading} onClick={() => start()}>
          {loading ? "Connecting…" : "Start AI Mechanic"}
        </button>
        {lastRoom && (
          <button className="secondary" disabled={!accepted || loading} onClick={() => start(lastRoom)}>
            Resume last repair
          </button>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="link-inspect">
        Checking many units for a factory or shop?{" "}
        <a href="#inspect" onClick={(e) => { e.preventDefault(); go("inspect"); }}>Bulk inspection</a>
      </p>
    </main>
  );
}
