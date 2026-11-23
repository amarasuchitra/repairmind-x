import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import gsap from "gsap";
import { VoiceOrb } from "./hud/VoiceOrb";
import { makeDemoVoice } from "./fx/demoVoice";
import { prefersReducedMotion } from "./fx/motion";
import { webglAvailable } from "./fx/gl/core";
import { Showroom } from "./fx/showroom/Showroom";
import { Arrow } from "./ui/Icons";
import { RingMark, Wordmark } from "./ui/RingMark";
import { sound } from "./fx/sound";

export interface LandingProps {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  lastRoom: string | null;
  onStart: (room?: string) => void;
  onInspect: () => void;
  onLab: () => void;
  /** false while the intro is still on screen: the entrance waits for it */
  entering: boolean;
  /** who signed in with the quick sign-in on this device, if anyone */
  profile: { name: string; guest?: boolean } | null;
  onSignOut: () => void;
}

const CHAPTERS = ["Overview", "Show it", "Talk it through", "Fix it", "Start"] as const;
const START = 4;
/** How fast the record turns in each chapter's shot (matches the 3D scene), for the vinyl crackle. */
const SPIN = [3.5, 0.4, 2.2, 0, 2];

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

/** Section heading block: an outlined chapter numeral behind a wide uppercase title. */
function Head({ i, kicker, children }: { i: number; kicker: string; children: ReactNode }) {
  return (
    <>
      <span className="sx-num" aria-hidden data-a>{String(i + 1).padStart(2, "0")}</span>
      <span className="sx-kicker" data-a>{kicker}</span>
      <h2 className="sx-h" data-a>{children}</h2>
    </>
  );
}

/** Header switch for the sound design: four bars that move while sound is on. */
function SoundSwitch() {
  const [on, setOn] = useState(sound.enabled);
  useEffect(() => sound.subscribe(setOn), []);
  return (
    <button className={`sx-sound${on ? " on" : ""}`} onClick={() => sound.toggle()} aria-pressed={on} aria-label={on ? "Sound on. Turn sound off" : "Sound off. Turn sound on"}>
      <span className="eq" aria-hidden><i /><i /><i /><i /></span>
      <span className="t" aria-hidden>{on ? "Sound" : "Muted"}</span>
    </button>
  );
}

export function Landing(p: LandingProps) {
  const [ch, setCh] = useState(0);
  const prevCh = useRef(0);
  const hovered = useRef<Element | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  const secs = useRef<HTMLElement[]>([]);
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

  // scrolling drives the scene: progress is measured in chapters, from section tops
  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("sx-snap");
    let raf = 0;
    const measure = () => {
      raf = 0;
      const y = window.scrollY;
      const tops = secs.current.map((s) => s.offsetTop);
      let prog = 0;
      for (let i = tops.length - 1; i >= 0; i--) {
        if (y >= tops[i] - 1) {
          prog = i + (i < tops.length - 1 ? Math.min(1, (y - tops[i]) / Math.max(1, tops[i + 1] - tops[i])) : 0);
          break;
        }
      }
      room.current?.setProgress(prog);
      const near = Math.round(prog);
      setCh(near);
      // pinned labels belong to one chapter: they fade out while the camera travels
      const off = Math.abs(prog - near);
      if (labels.current) labels.current.style.opacity = String(1 - Math.min(1, Math.max(0, (off - 0.08) / 0.16)));
      if (bar.current) bar.current.style.setProperty("--p", (prog / (tops.length - 1)).toFixed(4));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    measure();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      cancelAnimationFrame(raf);
      html.classList.remove("sx-snap");
      window.scrollTo(0, 0);
    };
  }, []);

  // each section's words and panel come in as it reaches the middle of the screen
  useEffect(() => {
    if (reduced) { secs.current.forEach((s) => s.classList.add("in")); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.3 });
    secs.current.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [reduced]);

  // sound: arm on first gesture, keep the beds only while this page is up
  useEffect(() => {
    sound.arm();
    sound.wake();
    return () => sound.quiet();
  }, []);

  // each chapter has its cue; the vinyl crackle follows the record's speed
  useEffect(() => {
    const from = prevCh.current;
    prevCh.current = ch;
    sound.setSpin(SPIN[ch]);
    if (from === ch || !p.entering) return;
    sound.whoosh(ch > from ? 1 : -1);
    if (ch === 1) { sound.scan(); sound.blips(3, 1.2); }
    if (ch === 2) sound.blips(3, 0.7);
    if (ch === 3) { sound.lift(); sound.lock(1.6); sound.blips(2, 2.1); }
    if (ch === 4) sound.settle();
    if (ch === 0 && from === 3) sound.needle();
  }, [ch, p.entering]);

  const onHover = (e: React.PointerEvent) => {
    const el = (e.target as Element).closest("button, a, label");
    if (el !== hovered.current) {
      hovered.current = el;
      if (el && e.pointerType === "mouse") sound.tick();
    }
  };
  const onPress = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button, a")) sound.tick(true);
  };

  const go = (i: number) => secs.current[i]?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });

  // entrance once the intro hands over
  useEffect(() => {
    if (!p.entering) return;
    room.current?.enter();
    const el = root.current;
    if (!el || reduced) return;
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.fromTo(el.querySelectorAll(".sx-top > *"), { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 1.2, stagger: 0.08 }, 0.2)
      .fromTo(el.querySelector(".ring-mark"), { opacity: 0, scale: 0.85, rotate: -25 }, { opacity: 1, scale: 1, rotate: 0, duration: 2 }, 0.1)
      .fromTo(el.querySelectorAll(".sx-rail, .sx-frame > *"), { opacity: 0 }, { opacity: 1, duration: 1.6 }, 0.4);
    return () => { tl.progress(1).kill(); };
  }, [p.entering, reduced]);

  const n = (i: number) => String(i + 1).padStart(2, "0");
  const sec = (i: number) => (el: HTMLElement | null) => { if (el) secs.current[i] = el; };

  return (
    <div ref={root} className={`sx sx-ch${ch} ${p.entering ? "" : "sx-wait"} ${gl ? "" : "sx-nogl"}`} onPointerOver={onHover} onPointerDown={onPress}>
      <div className="sx-stage" aria-hidden>
        <canvas ref={canvas} className="sx-canvas" />
        <div className="sx-shade" />
        <div ref={labels} className="sx-labels">
          <div key={ch}>
          {ch === 1 && <>
            <Tag at="model" k="Identified" side="l">EX-TT20 · 94%</Tag>
            <Tag at="tonearm" k="Tonearm">Static balance</Tag>
            <Tag at="speed" k="Controls" side="l" minor>33⅓ / 45 rpm</Tag>
          </>}
          {ch === 2 && <>
            <Tag at="platter" k="Cause 1 · 88%">Worn drive belt</Tag>
            <Tag at="pulley" k="Cause 2 · 8%" side="l">Dirty motor pulley</Tag>
            <Tag at="speed" k="Cause 3 · 4%" minor>Speed setting</Tag>
          </>}
          {ch === 3 && <>
            <div className="sx-lock" data-anchor="pulley" data-r="0.14"><i /><i /><i /><i />
              <svg className="sx-turn" viewBox="0 0 100 100"><path d="M78 30A36 36 0 1 1 30 22" /><path d="M24 12l6 10-11 3" /></svg>
            </div>
            <Tag at="pulley" k="Step 3 · Now" side="l">Loop the belt over the pulley</Tag>
            <Tag at="record" k="Step 2 · Done" side="l">Platter lifted off</Tag>
          </>}
          </div>
        </div>
        <div className="sx-frame">
          <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
        </div>
      </div>

      <header className="sx-top">
        <a className="sx-brand" href="#" onClick={(e) => { e.preventDefault(); go(0); }} aria-label="RepairMind X, back to top">
          <Wordmark />
        </a>
        <span className="sx-count" aria-live="polite">{n(ch)} <i>/</i> {n(CHAPTERS.length - 1)} <em>{CHAPTERS[ch]}</em></span>
        <nav className="sx-links">
          <SoundSwitch />
          <a href="#lab" onClick={(e) => { e.preventDefault(); p.onLab(); }}>Design lab</a>
          <a href="#inspect" onClick={(e) => { e.preventDefault(); p.onInspect(); }}>Bulk inspection</a>
          <button className="x-btn x-btn-line sx-cta" onClick={() => go(START)}>Start a repair <Arrow size={16} /></button>
        </nav>
      </header>

      <main className="sx-flow">
        <section ref={sec(0)} className="sx-sec sx-sec-l sx-hero" aria-label="Overview">
          <div className="sx-col">
            <div data-a><RingMark size={170} /></div>
            <span className="sx-kicker" data-a>Live video repair</span>
            <h1 className="sx-h sx-h1" data-a>Every machine has a solution.</h1>
            <p className="sx-p" data-a>Point your phone at the problem and talk. The mechanic sees what you see, marks the exact part on your screen and walks you through the fix, one checked step at a time.</p>
            <div className="sx-actions" data-a>
              <button className="x-btn x-btn-solid" onClick={() => go(START)}>Start a repair <Arrow size={18} /></button>
              <button className="x-btn x-btn-ghost" onClick={() => go(1)}>See how it works</button>
            </div>
            <dl className="sx-specrow" data-a>
              <div><dt>Vision</dt><dd>Live camera, AR</dd></div>
              <div><dt>Voice</dt><dd>Natural, two-way</dd></div>
              <div><dt>Safety</dt><dd>Cross-checked</dd></div>
            </dl>
          </div>
          <span className="sx-scroll" aria-hidden><i />Scroll</span>
        </section>

        <section ref={sec(1)} className="sx-sec sx-sec-r" aria-label="Show it">
          <div className="sx-col">
            <Head i={1} kicker="Step one">Show it.</Head>
            <p className="sx-p" data-a>Point your camera at the device. The mechanic reads its shape and label, names the make and model, and asks to see the label when it isn't sure.</p>
            <aside className="sx-panel" data-a>
              <h3 className="sx-ph">Identification <span className="ok">Confirmed</span></h3>
              <dl className="sx-rows">
                <div><dt>Device</dt><dd>Belt-drive turntable</dd></div>
                <div><dt>Model</dt><dd>EX-TT20</dd></div>
                <div><dt>Label</dt><dd>Read from the back panel</dd></div>
              </dl>
              <div className="sx-meter"><span>Match</span><b>94%</b><i style={{ ["--v" as string]: 0.94 }} /></div>
            </aside>
          </div>
        </section>

        <section ref={sec(2)} className="sx-sec sx-sec-l" aria-label="Talk it through">
          <div className="sx-col">
            <Head i={2} kicker="Step two">Talk it through.</Head>
            <p className="sx-p" data-a>Describe the fault in your own words. It asks a few sharp questions, ranks the likely causes and tells you how sure it is.</p>
            <aside className="sx-panel" data-a>
              <div className="sx-voice">
                <div className="sx-orb"><VoiceOrb state="speaking" bands={[]} voice={voice} size={88} /></div>
                <div className="sx-lines">
                  <p className="me"><b>You</b>It plays slow and the music wobbles.</p>
                  <p className="ai"><b>Mechanic</b>That sounds like the belt. Does it reach speed if you nudge the platter?</p>
                </div>
              </div>
              <h4 className="sx-sub">Likely causes</h4>
              <ol className="sx-bars">
                {[["Worn drive belt", 0.88], ["Dirty motor pulley", 0.08], ["Wrong speed setting", 0.04]].map(([t, v]) => (
                  <li key={t as string}><span>{t}</span><b>{Math.round((v as number) * 100)}%</b><i style={{ ["--v" as string]: v as number }} /></li>
                ))}
              </ol>
            </aside>
          </div>
        </section>

        <section ref={sec(3)} className="sx-sec sx-sec-r" aria-label="Fix it">
          <div className="sx-col">
            <Head i={3} kicker="Step three">Fix it.</Head>
            <p className="sx-p" data-a>Each step is marked on your live video. A second AI checks every risky instruction, and anything that can't be undone waits for your OK.</p>
            <aside className="sx-panel" data-a>
              <h3 className="sx-ph">Step 3 of 4</h3>
              <p className="sx-step">Loop the new belt round the sub-platter, then pull it over the motor pulley with the ribbon.</p>
              <ul className="sx-chips"><li>Cross-checked</li><li>Manual, p. 9</li><li>Waits for your OK</li></ul>
              <ol className="sx-steps">
                <li className="done">Unplug the turntable</li>
                <li className="done">Lift the platter off</li>
                <li className="active">Fit the new belt</li>
                <li>Check the speed</li>
              </ol>
            </aside>
          </div>
        </section>

        <section ref={sec(4)} className="sx-sec sx-sec-l sx-start" aria-label="Start">
          <div className="sx-col">
            <Head i={4} kicker="Before you start">Ready when you are.</Head>
            <p className="sx-p" data-a>Read this once. The mechanic holds itself to the same rules for the whole call.</p>
            <aside className="sx-panel sx-panel-solid" data-a>
              <h3 className="sx-ph">Safety notice</h3>
              <ol className="sx-notice">
                {NOTICE.map((x) => (
                  <li key={x.k} className={x.alert ? "alert" : ""}><span className="k">{x.k}</span><span className="t">{x.t}</span></li>
                ))}
              </ol>
              <div className="sx-consent">
                <label className="x-check">
                  <input type="checkbox" checked={p.accepted} onChange={(e) => { sound.confirm(e.target.checked); p.setAccepted(e.target.checked); }} />
                  <span className="box" aria-hidden />
                  <span>I understand and want to continue</span>
                </label>
                <div className="sx-go">
                  <button className="x-btn x-btn-solid" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(); }}>
                    {p.loading ? "Connecting…" : "Start AI Mechanic"} <Arrow size={18} />
                  </button>
                  {p.lastRoom && (
                    <button className="x-btn x-btn-line" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(p.lastRoom!); }}>Resume last repair</button>
                  )}
                </div>
                {p.error && <p className="x-error" role="alert">{p.error}</p>}
                <p className="sx-who">
                  {p.profile && !p.profile.guest
                    ? <>Signed in as <b>{p.profile.name}</b> · <button type="button" onClick={p.onSignOut}>Sign out</button></>
                    : p.profile?.guest
                      ? <>Continuing as a guest · <button type="button" onClick={p.onSignOut}>Sign in</button></>
                      : <>You'll sign in quickly before the call starts.</>}
                </p>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <nav className="sx-rail" aria-label="Chapters">
        <span className="sx-rail-bar"><span ref={bar} /></span>
        {CHAPTERS.map((c, i) => (
          <button key={c} className={i === ch ? "on" : ""} aria-current={i === ch ? "step" : undefined} onClick={() => go(i)} aria-label={c}>
            <span className="no">{n(i)}</span><span className="lb">{c}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
