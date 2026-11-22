import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { VoiceOrb } from "./hud/VoiceOrb";
import { makeDemoVoice } from "./fx/demoVoice";
import { prefersReducedMotion } from "./fx/motion";
import { webglAvailable } from "./fx/gl/core";
import { Showroom } from "./fx/showroom/Showroom";
import { Arrow, Logo } from "./ui/Icons";

export interface LandingProps {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  lastRoom: string | null;
  onStart: (room?: string) => void;
  onInspect: () => void;
  /** false while the intro is still on screen: the entrance waits for it */
  entering: boolean;
}

const CHAPTERS = ["Overview", "Show it", "Talk it through", "Fix it", "Start"] as const;
const START = 4;
const AUTO_MS = 9000;

const NOTICE = [
  { k: "Control", t: "The mechanic gives guidance, not a guarantee. You stay in control of every step." },
  { k: "Limits", t: "It refuses dangerous jobs (microwave internals, mains wiring, gas, airbags, brakes, refrigerant, high-voltage or swollen batteries) and points you to a professional." },
  { k: "Stop", t: "If you see smoke or sparks, smell gas or burning, or get hurt: stop and step away.", alert: true },
  { k: "Privacy", t: "Your camera and microphone are streamed to the AI during the call. Video is not recorded." },
];

/** A label pinned to a point on the 3D model. `side` says which way the leader line runs. */
function Tag({ at, side = "r", k, children, minor }: { at: string; side?: "l" | "r"; k: string; children: ReactNode; minor?: boolean }) {
  return (
    <div className={`sx-tag sx-tag-${side}${minor ? " minor" : ""}`} data-anchor={at}>
      <span className="dot" />
      <span className="lead" />
      <span className="box"><span className="k">{k}</span><span className="v">{children}</span></span>
    </div>
  );
}

export function Landing(p: LandingProps) {
  const [ch, setCh] = useState(0);
  const [auto, setAuto] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const room = useRef<Showroom | null>(null);
  const reduced = useMemo(prefersReducedMotion, []);
  const [gl] = useState(webglAvailable);
  const voice = useMemo(() => makeDemoVoice(12, 3.2, 1.2), []);

  // one 3D scene for the life of the page
  useEffect(() => {
    if (!gl || !canvas.current || !labels.current) return;
    let r: Showroom | null = null;
    try {
      r = new Showroom({ canvas: canvas.current, labels: labels.current, reduced });
      room.current = r;
    } catch {
      /* no 3D: the page still works on its own */
    }
    return () => { r?.dispose(); room.current = null; };
  }, [gl, reduced]);

  const go = useCallback((i: number, user = true) => {
    if (user) setAuto(false);
    setCh((cur) => (i === cur ? cur : i));
  }, []);

  useEffect(() => { room.current?.goTo(ch); }, [ch]);

  // chapters advance on their own until the visitor takes over
  useEffect(() => {
    if (!auto || reduced || !p.entering || ch >= START) return;
    const id = window.setTimeout(() => go((ch + 1) % START, false), AUTO_MS);
    return () => window.clearTimeout(id);
  }, [auto, ch, reduced, p.entering, go]);

  // keyboard: arrows move between chapters
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "BUTTON" && e.key === " ")) return;
      if (e.key === "ArrowRight") go(Math.min(START, ch + 1));
      if (e.key === "ArrowLeft") go(Math.max(0, ch - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ch, go]);

  // entrance once the intro hands over
  useEffect(() => {
    if (!p.entering) return;
    room.current?.enter();
    const el = root.current;
    if (!el || reduced) return;
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.fromTo(el.querySelectorAll(".sx-top > *"), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 1.2, stagger: 0.08 }, 0.2)
      .fromTo(el.querySelectorAll(".sx-rail button"), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 1.1, stagger: 0.06 }, 0.5)
      .fromTo(el.querySelectorAll(".sx-frame > *"), { opacity: 0 }, { opacity: 1, duration: 1.6 }, 0.3);
    return () => { tl.progress(1).kill(); };
  }, [p.entering, reduced]);

  // copy and panel change with each chapter
  useEffect(() => {
    if (reduced || !p.entering) return;
    const items = [...(copy.current?.querySelectorAll("[data-a]") ?? []), ...(panel.current ? [panel.current] : [])];
    const tw = gsap.fromTo(items, { opacity: 0, y: 18, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1, ease: "expo.out", stagger: 0.06, delay: 0.25 });
    return () => { tw.progress(1).kill(); };
  }, [ch, reduced, p.entering]);

  const n = (i: number) => String(i + 1).padStart(2, "0");

  return (
    <div ref={root} className={`sx sx-ch${ch} ${p.entering ? "" : "sx-wait"} ${gl ? "" : "sx-nogl"}`}>
      <canvas ref={canvas} className="sx-canvas" aria-hidden />
      <div className="sx-shade" aria-hidden />

      <div ref={labels} className="sx-labels" aria-hidden>
        <div key={ch}>
        {ch === 1 && <>
          <Tag at="model" k="Identified">EX-DF30B · 96%</Tag>
          <Tag at="clip" k="Fixings" side="r">4 guard clips</Tag>
          <Tag at="motor" k="Housing" side="l" minor>Motor, sealed</Tag>
        </>}
        {ch === 2 && <>
          <Tag at="blade" k="Cause 1 · 92%" side="l">Dust build-up</Tag>
          <Tag at="motor" k="Cause 2 · 5%" side="l">Worn bearing</Tag>
          <Tag at="cap" k="Cause 3 · 3%" side="l" minor>Loose blade cap</Tag>
        </>}
        {ch === 3 && <>
          <div className="sx-lock" data-anchor="cap" data-r="0.3"><i /><i /><i /><i />
            <svg className="sx-turn" viewBox="0 0 100 100"><path d="M78 30A36 36 0 1 1 30 22" /><path d="M24 12l6 10-11 3" /></svg>
          </div>
          <Tag at="cap" k="Step 3 · Turn clockwise">Left-hand thread</Tag>
          <Tag at="guard" k="Step 2 · Done" side="l" minor>Front guard off</Tag>
        </>}
        </div>
      </div>

      <div className="sx-frame" aria-hidden>
        <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
      </div>

      <div className="sx-ui">
        <header className="sx-top">
          <a className="x-brand" href="#" onClick={(e) => { e.preventDefault(); go(0); }} aria-label="RepairMind X home">
            <Logo size={26} /><span>RepairMind</span><b>X</b>
          </a>
          <span className="sx-count" aria-live="polite">{n(ch)} <i>/</i> {n(CHAPTERS.length - 1)}</span>
          <nav className="sx-links">
            <a href="#inspect" onClick={(e) => { e.preventDefault(); p.onInspect(); }}>Bulk inspection</a>
            <button className="x-btn x-btn-line sx-cta" onClick={() => go(START)}>Start a repair <Arrow size={16} /></button>
          </nav>
        </header>

        <section ref={copy} className="sx-copy" key={`c${ch}`} aria-live="polite">
          {ch === 0 && <>
            <span className="sx-kicker" data-a>Live video repair</span>
            <h1 className="sx-h" data-a>Every machine<br />has a solution.</h1>
            <p className="sx-p" data-a>Point your phone at the problem and talk. The mechanic sees what you see, marks the exact part on your screen and walks you through the fix, one checked step at a time.</p>
            <div className="sx-actions" data-a>
              <button className="x-btn x-btn-solid" onClick={() => go(START)}>Start a repair <Arrow size={18} /></button>
              <button className="x-btn x-btn-ghost" onClick={() => go(1)}>See how it works</button>
            </div>
          </>}
          {ch === 1 && <>
            <span className="sx-kicker" data-a>Step one</span>
            <h1 className="sx-h" data-a>Show it.</h1>
            <p className="sx-p" data-a>Point your camera at the device. The mechanic reads its shape and label, names the make and model, and asks to see the label when it isn't sure.</p>
          </>}
          {ch === 2 && <>
            <span className="sx-kicker" data-a>Step two</span>
            <h1 className="sx-h" data-a>Talk it through.</h1>
            <p className="sx-p" data-a>Describe the fault in your own words. It asks a few sharp questions, ranks the likely causes and tells you how sure it is.</p>
          </>}
          {ch === 3 && <>
            <span className="sx-kicker" data-a>Step three</span>
            <h1 className="sx-h" data-a>Fix it.</h1>
            <p className="sx-p" data-a>Each step is marked on your live video. A second AI checks every risky instruction, and anything that can't be undone waits for your OK.</p>
          </>}
          {ch === START && <>
            <span className="sx-kicker" data-a>Before you start</span>
            <h1 className="sx-h" data-a>Ready when<br />you are.</h1>
            <p className="sx-p" data-a>Read this once. The mechanic holds itself to the same rules for the whole call.</p>
          </>}
          {ch < START && ch > 0 && (
            <div className="sx-actions" data-a>
              <button className="x-btn x-btn-line" onClick={() => go(ch + 1)}>{ch === 3 ? "Start a repair" : "Next"} <Arrow size={16} /></button>
            </div>
          )}
        </section>

        <aside ref={panel} className={`sx-panel${ch === START ? " sx-panel-solid" : ""}`} key={`p${ch}`}>
          {ch === 0 && <>
            <h2 className="sx-ph">System</h2>
            <dl className="sx-spec">
              <div><dt>Vision</dt><dd>Live camera, AR markers</dd><i /></div>
              <div><dt>Voice</dt><dd>Natural, two-way</dd><i /></div>
              <div><dt>Safety</dt><dd>Gated and cross-checked</dd><i /></div>
              <div><dt>Manuals</dt><dd>Steps cite the page</dd><i /></div>
            </dl>
          </>}
          {ch === 1 && <>
            <h2 className="sx-ph">Identification <span className="ok">Confirmed</span></h2>
            <dl className="sx-rows">
              <div><dt>Device</dt><dd>Desk fan, 30 cm</dd></div>
              <div><dt>Model</dt><dd>EX-DF30B</dd></div>
              <div><dt>Label</dt><dd>Read from the base</dd></div>
            </dl>
            <div className="sx-meter"><span>Match</span><b>96%</b><i style={{ ["--v" as string]: 0.96 }} /></div>
          </>}
          {ch === 2 && <>
            <h2 className="sx-ph">Conversation</h2>
            <div className="sx-voice">
              <div className="sx-orb"><VoiceOrb state="speaking" bands={[]} voice={voice} size={88} /></div>
              <div className="sx-lines">
                <p className="me"><b>You</b>It rattles and it's slower than it used to be.</p>
                <p className="ai"><b>Mechanic</b>I can see dust on the blade. Does it rattle on the lowest speed too?</p>
              </div>
            </div>
            <h3 className="sx-sub">Likely causes</h3>
            <ol className="sx-bars">
              {[["Dust build-up on blade", 0.92], ["Worn motor bearing", 0.05], ["Loose blade cap", 0.03]].map(([t, v]) => (
                <li key={t as string}><span>{t}</span><b>{Math.round((v as number) * 100)}%</b><i style={{ ["--v" as string]: v as number }} /></li>
              ))}
            </ol>
          </>}
          {ch === 3 && <>
            <h2 className="sx-ph">Step 3 of 4</h2>
            <p className="sx-step">Turn the blade cap clockwise to loosen it. It has a left-hand thread.</p>
            <ul className="sx-chips"><li>Cross-checked</li><li>Manual, p. 12</li><li>Waits for your OK</li></ul>
            <ol className="sx-steps">
              <li className="done">Unplug the fan</li>
              <li className="done">Remove the front guard</li>
              <li className="active">Loosen the blade cap</li>
              <li>Clean the blade</li>
            </ol>
          </>}
          {ch === START && <>
            <h2 className="sx-ph">Safety notice</h2>
            <ol className="sx-notice">
              {NOTICE.map((x) => (
                <li key={x.k} className={x.alert ? "alert" : ""}><span className="k">{x.k}</span><span className="t">{x.t}</span></li>
              ))}
            </ol>
            <div className="sx-consent">
            <label className="x-check">
              <input type="checkbox" checked={p.accepted} onChange={(e) => p.setAccepted(e.target.checked)} />
              <span className="box" aria-hidden />
              <span>I understand and want to continue</span>
            </label>
            <div className="sx-go">
              <button className="x-btn x-btn-solid" disabled={!p.accepted || p.loading} onClick={() => p.onStart()}>
                {p.loading ? "Connecting…" : "Start AI Mechanic"} <Arrow size={18} />
              </button>
              {p.lastRoom && (
                <button className="x-btn x-btn-line" disabled={!p.accepted || p.loading} onClick={() => p.onStart(p.lastRoom!)}>Resume last repair</button>
              )}
            </div>
            {p.error && <p className="x-error" role="alert">{p.error}</p>}
            </div>
          </>}
        </aside>

        <nav className="sx-rail" aria-label="Chapters">
          {CHAPTERS.map((c, i) => (
            <button key={c} className={i === ch ? "on" : i < ch ? "past" : ""} aria-current={i === ch ? "step" : undefined} onClick={() => go(i)}>
              <span className="bar"><i className={i === ch && auto && !reduced && p.entering && ch < START ? "run" : ""} style={{ animationDuration: `${AUTO_MS}ms` }} /></span>
              <span className="no">{n(i)}</span>
              <span className="lb">{c}</span>
            </button>
          ))}
        </nav>
        {gl && <span className="sx-hint" aria-hidden>Drag to turn</span>}
      </div>
    </div>
  );
}
