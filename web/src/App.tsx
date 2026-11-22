import { Suspense, lazy, useEffect, useState } from "react";
import { Call } from "./Call";
import { Inspect } from "./Inspect";
import { Landing } from "./Landing";
import { NetworkBackground } from "./fx/NetworkBackground";
import { Intro, shouldPlayIntro } from "./fx/Intro";

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
      {/* the landing page draws its own 3D scene */}
      {(conn || page !== "call") && <NetworkBackground intensity={conn || page === "demo" ? 0.55 : 1} />}
      {content}
      {intro && !conn && <Intro onDone={() => setIntro(false)} />}
    </>
  );
}
