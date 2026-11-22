import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { VoiceOrb } from "./hud/VoiceOrb";
import { makeDemoVoice } from "./fx/demoVoice";
import { prefersReducedMotion } from "./fx/motion";
import { Arrow, Logo } from "./ui/Icons";

gsap.registerPlugin(ScrollTrigger);

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

const NOTICE = [
  { k: "Control", t: "The mechanic gives guidance, not a guarantee. You stay in control of every step." },
  {
    k: "Limits",
    t: "It refuses dangerous jobs (microwave internals, mains wiring, gas, airbags, brakes, refrigerant, high-voltage or swollen batteries) and points you to a professional.",
  },
  { k: "Stop", t: "If you see smoke or sparks, smell gas or burning, or get hurt: stop and step away.", alert: true },
  { k: "Privacy", t: "Your camera and microphone are streamed to the AI during the call. Video is not recorded." },
];

const STEPS = [
  { n: "01", t: "Show it", d: "Point your phone at the device. The mechanic identifies the make and model, and asks to see the label when it isn't sure." },
  { n: "02", t: "Talk it through", d: "Describe the fault in your own words. It asks a few sharp questions, ranks the likely causes and tells you how sure it is." },
  { n: "03", t: "Fix it", d: "Each step is marked on your live video and waits for your OK before anything that can't be undone." },
];

const CAPS = [
  { t: "Live AR pointing", d: "Targeting brackets lock onto the part on your moving camera, with arrows for turn, press, pull and slide." },
  { t: "Safety gates", d: "Jobs are rated green, amber or red. Precautions are checked off before work starts, and a hazard stops the call." },
  { t: "Cross-checked steps", d: "A second, independent AI reviews each risky instruction before you hear it." },
  { t: "Your manual, cited", d: "Upload the PDF manual and every step points to the page it came from." },
  { t: "Bulk inspection", d: "Factories and repair shops check hundreds of unit photos and get an Excel report." },
];

export function Landing(p: LandingProps) {
  const voice = useMemo(() => makeDemoVoice(12, 3.2, 1.6), []);
  const root = useRef<HTMLDivElement>(null);

  // Hero entrance: runs once the intro has handed over.
  useEffect(() => {
    const el = root.current;
    if (!el || !p.entering || prefersReducedMotion()) return;
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.fromTo(el.querySelector(".x-nav"), { opacity: 0, y: -12 }, { opacity: 1, y: 0, duration: 1 }, 0)
      .fromTo(el.querySelectorAll(".x-hero-h .ln > span"), { yPercent: 110 }, { yPercent: 0, duration: 1.3, stagger: 0.09 }, 0.1)
      .fromTo(el.querySelector(".x-stage"), { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 2.2, ease: "power3.out" }, 0)
      .fromTo(el.querySelectorAll(".x-hero [data-in]"), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 1.1, stagger: 0.07 }, 0.45);
    return () => { tl.progress(1).kill(); };
  }, [p.entering]);

  // Scroll choreography: sections rise in as they enter, the hero orb drifts back as you leave it.
  useEffect(() => {
    const el = root.current;
    if (!el || prefersReducedMotion()) return;
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((s) => {
        gsap.fromTo(s.querySelectorAll("[data-r]"), { opacity: 0, y: 28 }, {
          opacity: 1, y: 0, duration: 1.1, ease: "expo.out", stagger: 0.08,
          scrollTrigger: { trigger: s, start: "top 80%" },
        });
      });
      gsap.to(".x-stage", {
        yPercent: 18, scale: 0.92, opacity: 0.35, ease: "none",
        scrollTrigger: { trigger: ".x-hero", start: "top top", end: "bottom top", scrub: true },
      });
      // past the hero the backdrop steps back so long-form text stays easy to read
      gsap.to(".fx-bg-canvas", {
        opacity: 0.4, ease: "none",
        scrollTrigger: { trigger: ".x-hero", start: "60% top", end: "bottom top", scrub: true },
      });
      ScrollTrigger.create({
        start: 80, end: "max",
        onToggle: (st) => el.querySelector(".x-nav")?.classList.toggle("solid", st.isActive),
      });
      gsap.utils.toArray<HTMLElement>(".x-cap").forEach((row) => {
        gsap.fromTo(row.querySelector(".x-cap-line"), { scaleX: 0 }, {
          scaleX: 1, duration: 1.4, ease: "expo.inOut", scrollTrigger: { trigger: row, start: "top 88%" },
        });
      });
    }, el);
    return () => {
      ctx.revert();
      gsap.set(".fx-bg-canvas", { clearProps: "opacity" });
    };
  }, []);

  const toStart = (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById("start")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  };

  return (
    <div ref={root} className={`x-site ${p.entering ? "" : "x-wait"}`}>
      <header className="x-nav">
        <a className="x-brand" href="#" onClick={(e) => e.preventDefault()} aria-label="RepairMind X home">
          <Logo size={26} />
          <span>RepairMind</span><b>X</b>
        </a>
        <nav className="x-links" aria-label="Sections">
          <a href="#process">Process</a>
          <a href="#start">Safety</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#inspect" onClick={(e) => { e.preventDefault(); p.onInspect(); }}>Inspection</a>
        </nav>
        <a className="x-btn x-btn-line x-nav-cta" href="#start" onClick={toStart}>Start a repair <Arrow size={16} /></a>
      </header>

      <main>
        <section className="x-hero" aria-labelledby="hero-h">
          <div className="x-stage" aria-hidden>
            <VoiceOrb state="speaking" bands={[]} voice={voice} size={900} detail="full" />
            <div className="x-stage-label l1"><i />Voice link · live</div>
            <div className="x-stage-label l2"><i />Optics · tracking</div>
          </div>

          <div className="x-hero-meta" data-in>
            <span>RMX — 01</span>
            <span className="x-online"><i />All systems online</span>
          </div>

          <div className="x-hero-copy">
            <h1 id="hero-h" className="x-hero-h">
              <span className="ln"><span>Every machine</span></span>
              <span className="ln"><span>has a solution.</span></span>
              <span className="ln dim"><span>Let's find it.</span></span>
            </h1>
            <p className="x-lede" data-in>
              A live video mechanic. Point your camera at the problem and talk: it sees what you see, marks the exact
              part on your screen, and walks you through the fix one checked step at a time.
            </p>
            <div className="x-hero-cta" data-in>
              <a className="x-btn x-btn-solid" href="#start" onClick={toStart}>Start a repair <Arrow size={18} /></a>
              <a className="x-btn x-btn-ghost" href="#process">How it works</a>
            </div>
          </div>

          <dl className="x-spec" data-in>
            <div><dt>Vision</dt><dd>Live camera, AR markers</dd></div>
            <div><dt>Guidance</dt><dd>Spoken, step by step</dd></div>
            <div><dt>Safety</dt><dd>Gated and cross-checked</dd></div>
          </dl>
          <div className="x-scroll" aria-hidden data-in><span /></div>
        </section>

        <section className="x-sec x-preflight" id="start" data-reveal aria-labelledby="pf-h">
          <div className="x-sec-head">
            <span className="x-idx" data-r>01 — Before you start</span>
            <h2 id="pf-h" data-r>Safety comes before<br />the first screw.</h2>
            <p data-r>Read this once. The mechanic holds itself to the same rules for the whole call.</p>
          </div>
          <div className="x-panel" data-r>
            <ol className="x-notice">
              {NOTICE.map((n, i) => (
                <li key={n.k} className={n.alert ? "alert" : ""}>
                  <span className="no">{String(i + 1).padStart(2, "0")}</span>
                  <span className="k">{n.k}</span>
                  <span className="t">{n.t}</span>
                </li>
              ))}
            </ol>
            <label className="x-check">
              <input type="checkbox" checked={p.accepted} onChange={(e) => p.setAccepted(e.target.checked)} />
              <span className="box" aria-hidden />
              <span>I understand and want to continue</span>
            </label>
            <div className="x-actions">
              <button className="x-btn x-btn-solid x-go" disabled={!p.accepted || p.loading} onClick={() => p.onStart()}>
                {p.loading ? "Connecting…" : "Start AI Mechanic"} <Arrow size={18} />
              </button>
              {p.lastRoom && (
                <button className="x-btn x-btn-line" disabled={!p.accepted || p.loading} onClick={() => p.onStart(p.lastRoom!)}>
                  Resume last repair
                </button>
              )}
            </div>
            {p.error && <p className="x-error" role="alert">{p.error}</p>}
          </div>
        </section>

        <section className="x-sec" id="process" data-reveal aria-labelledby="pr-h">
          <div className="x-sec-head">
            <span className="x-idx" data-r>02 — Process</span>
            <h2 id="pr-h" data-r>From broken to fixed,<br />in one conversation.</h2>
          </div>
          <ol className="x-steps">
            {STEPS.map((s) => (
              <li key={s.n} data-r>
                <span className="n">{s.n}</span>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="x-sec" id="capabilities" data-reveal aria-labelledby="cp-h">
          <div className="x-sec-head">
            <span className="x-idx" data-r>03 — Capabilities</span>
            <h2 id="cp-h" data-r>Built like a workshop tool.</h2>
            <p data-r>Every feature exists to get a real repair done, safely, on the first try.</p>
          </div>
          <ul className="x-caps">
            {CAPS.map((c, i) => (
              <li key={c.t} className="x-cap" data-r>
                <span className="x-cap-line" aria-hidden />
                <span className="i">{String(i + 1).padStart(2, "0")}</span>
                <h3>{c.t}</h3>
                <p>{c.d}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="x-close" data-reveal>
          <h2 data-r>Ready when you are.</h2>
          <a className="x-btn x-btn-solid" href="#start" onClick={toStart} data-r>Start a repair <Arrow size={18} /></a>
        </section>
      </main>

      <footer className="x-foot">
        <span className="x-brand small"><Logo size={18} /><span>RepairMind</span><b>X</b></span>
        <span>Guidance, not a guarantee. When in doubt, call a professional.</span>
      </footer>
    </div>
  );
}
