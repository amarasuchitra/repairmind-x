import { Suspense, lazy, useEffect, useState } from "react";
import { Landing } from "./Landing";
import { readProfile, writeProfile, type Profile } from "./Login";
import { Intro, shouldPlayIntro } from "./fx/Intro";
import { appFromHash, isWorkspaceHash, type AppId } from "./workspace/apps.ts";

// The assistant (and every tool it opens as a panel) loads when someone leaves the start page.
const Workspace = lazy(() => import("./workspace/Workspace.tsx").then((m) => ({ default: m.Workspace })));

/**
 * Three screens: the intro, the scrolling start page, and the assistant. Everything else (the live repair call,
 * the design lab, the parts canvas, redesign, inspection, references) opens inside the assistant as a panel.
 * Old addresses (#lab, #build, #redesign, #inspect, #demo...) open the assistant with that tool beside it.
 */
export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [intro, setIntro] = useState(() => !isWorkspaceHash(window.location.hash) && shouldPlayIntro());
  const [profile, setProfile] = useState<Profile | null>(readProfile);
  const [inside, setInside] = useState(() => isWorkspaceHash(window.location.hash));
  const [app, setAppState] = useState<{ id: AppId | null; n: number }>(() => ({ id: appFromHash(window.location.hash), n: 0 }));
  // a counter, so asking for the tool that is already chosen opens it again
  const setApp = (id: AppId | null) => setAppState((x) => ({ id, n: x.n + 1 }));
  const [callNow, setCallNow] = useState<{ room?: string } | null>(null);
  const lastRoom = (() => { try { return localStorage.getItem("rmx.lastRoom"); } catch { return null; } })();

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash;
      setInside(isWorkspaceHash(h));
      const a = appFromHash(h);
      if (a) {
        setApp(a);
        // keep the address on the assistant, so asking for the same tool again opens it again
        if (!h.startsWith("#demo")) history.replaceState(null, "", "#assistant");
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function enter(next: AppId | null, call: { room?: string } | null = null) {
    setApp(next);
    setCallNow(call);
    setInside(true);
    window.location.hash = "assistant";
  }

  if (inside) {
    return (
      <Suspense fallback={null}>
        <Workspace initialApp={app.id} appNonce={app.n} callNow={callNow} profile={profile}
          onTour={() => { setInside(false); setCallNow(null); window.location.hash = ""; }} />
      </Suspense>
    );
  }

  return (
    <>
      <Landing
        accepted={accepted}
        setAccepted={setAccepted}
        loading={false}
        error={null}
        lastRoom={lastRoom}
        // the start page took the safety notice: the call starts inside the assistant straight away
        onStart={(room) => enter("repair_call", accepted ? { room } : null)}
        profile={profile}
        onSignOut={() => { writeProfile(null); setProfile(null); }}
        onInspect={() => enter("inspection")}
        onLab={() => enter("design_lab")}
        onMake={() => enter(null)}
        onRedesign={() => enter("redesign")}
        onAssistant={() => enter(null)}
        entering={!intro}
      />
      {intro && <Intro onDone={() => setIntro(false)} />}
    </>
  );
}
