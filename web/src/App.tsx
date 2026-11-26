import { Suspense, lazy, useEffect, useState } from "react";
import { Call } from "./Call";
import { CallSummary } from "./CallSummary";
import { Inspect } from "./Inspect";
import { Home } from "./home/Home";
import { Landing } from "./Landing";
import { Login, readProfile, writeProfile, type Profile } from "./Login";
import { NetworkBackground } from "./fx/NetworkBackground";
import { Intro, shouldPlayIntro } from "./fx/Intro";
import { useI18n } from "./i18n";

// The design preview (a fake call with sample data) only loads when someone opens #demo.
const Demo = lazy(() => import("./Demo").then((m) => ({ default: m.Demo })));
// The design lab (physics engine, 3D sandbox) only loads when someone opens #lab.
const Lab = lazy(() => import("./lab/Lab.tsx").then((m) => ({ default: m.Lab })));
// Redesign a broken part (design brief + failure library) only loads when someone opens #redesign.
const Redesign = lazy(() => import("./redesign/Redesign.tsx").then((m) => ({ default: m.Redesign })));
// The hardware project builder (drag parts, get wiring, code and costs) only loads when someone opens #build.
const Builder = lazy(() => import("./build/Builder.tsx").then((m) => ({ default: m.Builder })));

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
    if (room) {
      localStorage.setItem(LAST_ROOM_KEY, room);
      localStorage.setItem("rmx.lastCallRoom", room); // kept after the call ends, for "Redesign the part"
    } else localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* storage unavailable: resume just won't be offered */
  }
}

type Page = "call" | "inspect" | "demo" | "lab" | "redesign" | "build" | "assistant";
const pageFromHash = (): Page => {
  const h = window.location.hash;
  return h === "#inspect" ? "inspect" : h === "#assistant" ? "assistant" : h === "#lab" ? "lab" : h === "#redesign" ? "redesign" : h === "#build" ? "build" : h.startsWith("#demo") ? "demo" : "call";
};

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [conn, setConn] = useState<Connection | null>(null);
  const [summaryRoom, setSummaryRoom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [intro, setIntro] = useState(() => pageFromHash() === "call" && shouldPlayIntro());
  const lastRoom = readLastRoom();
  const [profile, setProfile] = useState<Profile | null>(readProfile);
  // set while the quick sign-in is showing: the call it should start afterwards (a room to resume, or a new one)
  const [signingIn, setSigningIn] = useState<{ room?: string } | null>(null);
  const [page, setPage] = useState<Page>(pageFromHash);
  const { t, choice, lang } = useI18n();
  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function go(next: "call" | "inspect" | "lab" | "redesign" | "build" | "assistant") {
    window.location.hash = next === "call" ? "" : next;
    setPage(next);
  }

  async function start(resumeRoom?: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // the mechanic speaks the chosen language; "auto" means it answers in whatever language you speak
        body: JSON.stringify({ accepted_notice: accepted, room: resumeRoom ?? null, language: choice, ui_language: lang }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))).detail;
        throw new Error(
          detail ?? (res.status >= 500 ? t("common.serverDown") : t("common.error", { n: res.status })),
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

  // the flow is intro, start page, quick sign-in (once per device), then the live call
  const requestStart = (room?: string) => {
    if (profile) void start(room);
    else setSigningIn({ room });
  };

  let content;
  if (conn) {
    content = (
      <Call
        {...conn}
        onEnd={(finished) => {
          if (finished) writeLastRoom(null);
          setSummaryRoom(conn.room);
          setConn(null);
        }}
      />
    );
  } else if (summaryRoom) {
    const room = summaryRoom;
    content = (
      <CallSummary
        room={room}
        onResume={() => { setSummaryRoom(null); requestStart(room); }}
        onDone={() => setSummaryRoom(null)}
      />
    );
  } else if (page === "redesign") {
    content = <Suspense fallback={null}><Redesign onBack={() => go("call")} /></Suspense>;
  } else if (page === "build") {
    content = <Suspense fallback={null}><Builder onBack={() => go("call")} /></Suspense>;
  } else if (page === "lab") {
    content = <Suspense fallback={null}><Lab onBack={() => go("call")} /></Suspense>;
  } else if (page === "demo") {
    content = <Suspense fallback={null}><Demo /></Suspense>;
  } else if (signingIn) {
    content = (
      <Login
        onBack={() => setSigningIn(null)}
        onDone={(p) => {
          writeProfile(p);
          setProfile(p);
          const room = signingIn.room;
          setSigningIn(null);
          void start(room);
        }}
      />
    );
  } else if (page === "inspect") {
    content = <Inspect onBack={() => go("call")} />;
  } else if (page !== "assistant") {
    // the start page: the scrolling 3D walkthrough, with the calm assistant one tap away
    content = (
        <Landing
          accepted={accepted}
          setAccepted={setAccepted}
          loading={loading}
          error={error}
          lastRoom={lastRoom}
          onStart={requestStart}
          profile={profile}
          onSignOut={() => { writeProfile(null); setProfile(null); }}
          onInspect={() => go("inspect")}
          onLab={() => go("lab")}
          onRedesign={() => go("redesign")}
          onAssistant={() => go("assistant")}
          entering={!intro}
        />
    );
  } else {
    content = (
      <Home
        accepted={accepted}
        setAccepted={setAccepted}
        loading={loading}
        error={error}
        lastRoom={lastRoom}
        onStart={requestStart}
        profile={profile}
        onSignOut={() => { writeProfile(null); setProfile(null); }}
        onInspect={() => go("inspect")}
        onLab={() => go("lab")}
        onRedesign={() => go("redesign")}
        onBuild={() => go("build")}
        onTour={() => go("call")}
      />
    );
  }

  return (
    <>
      {/* the walkthrough draws its own 3D scene; the lab and redesign pages have their own backdrop */}
      {(conn || signingIn || (page !== "call" && page !== "lab" && page !== "redesign" && page !== "build")) && (
        <NetworkBackground intensity={conn || page === "demo" ? 0.55 : page === "assistant" ? 0.7 : 1} />
      )}
      {content}
      {intro && !conn && <Intro onDone={() => setIntro(false)} />}
    </>
  );
}
