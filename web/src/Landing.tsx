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
import { LanguagePicker, useI18n } from "./i18n";
import type { Key } from "./i18n/en";

export interface LandingProps {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  lastRoom: string | null;
  onStart: (room?: string) => void;
  onInspect: () => void;
  onLab: () => void;
  onRedesign: () => void;
  /** false while the intro is still on screen: the entrance waits for it */
  entering: boolean;
  /** who signed in with the quick sign-in on this device, if anyone */
  profile: { name: string; guest?: boolean } | null;
  onSignOut: () => void;
}

const CHAPTERS: Key[] = ["start.ch.overview", "start.ch.show", "start.ch.talk", "start.ch.fix", "start.ch.start"];
const START = 4;
/** How fast the record turns in each chapter's shot (matches the 3D scene), for the vinyl crackle. */
const SPIN = [3.5, 0.4, 2.2, 0, 2];

const NOTICE: { id: string; alert?: boolean }[] = [{ id: "control" }, { id: "limits" }, { id: "stop", alert: true }, { id: "privacy" }];

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
  const { t } = useI18n();
  const [on, setOn] = useState(sound.enabled);
  useEffect(() => sound.subscribe(setOn), []);
  return (
    <button className={`sx-sound${on ? " on" : ""}`} onClick={() => sound.toggle()} aria-pressed={on} aria-label={on ? t("start.sound.onAria") : t("start.sound.offAria")}>
      <span className="eq" aria-hidden><i /><i /><i /><i /></span>
      <span className="t" aria-hidden>{on ? t("start.sound.on") : t("start.sound.off")}</span>
    </button>
  );
}

export function Landing(p: LandingProps) {
  const { t, tn, choice, language } = useI18n();
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
            <Tag at="model" k={t("start.tag.identified")} side="l">EX-TT20 · 94%</Tag>
            <Tag at="tonearm" k={t("start.tag.tonearm")}>{t("start.tag.tonearm.v")}</Tag>
            <Tag at="speed" k={t("start.tag.controls")} side="l" minor>33⅓ / 45 rpm</Tag>
          </>}
          {ch === 2 && <>
            <Tag at="platter" k={`${t("start.tag.cause", { n: 1 })} · 88%`}>{t("start.cause.belt")}</Tag>
            <Tag at="pulley" k={`${t("start.tag.cause", { n: 2 })} · 8%`} side="l">{t("start.cause.pulley")}</Tag>
            <Tag at="speed" k={`${t("start.tag.cause", { n: 3 })} · 4%`} minor>{t("start.cause.speed")}</Tag>
          </>}
          {ch === 3 && <>
            <div className="sx-lock" data-anchor="pulley" data-r="0.14"><i /><i /><i /><i />
              <svg className="sx-turn" viewBox="0 0 100 100"><path d="M78 30A36 36 0 1 1 30 22" /><path d="M24 12l6 10-11 3" /></svg>
            </div>
            <Tag at="pulley" k={t("start.tag.stepNow")} side="l">{t("start.tag.loop")}</Tag>
            <Tag at="record" k={t("start.tag.stepDone")} side="l">{t("start.tag.lifted")}</Tag>
          </>}
          </div>
        </div>
        <div className="sx-frame">
          <span className="c tl" /><span className="c tr" /><span className="c bl" /><span className="c br" />
        </div>
      </div>

      <header className="sx-top">
        <a className="sx-brand" href="#" onClick={(e) => { e.preventDefault(); go(0); }} aria-label={t("start.backTop")}>
          <Wordmark />
        </a>
        <span className="sx-count" aria-live="polite">{n(ch)} <i>/</i> {n(CHAPTERS.length - 1)} <em>{t(CHAPTERS[ch])}</em></span>
        <nav className="sx-links">
          <LanguagePicker />
          <SoundSwitch />
          <a href="#lab" onClick={(e) => { e.preventDefault(); p.onLab(); }}>{t("start.nav.lab")}</a>
          <a href="#redesign" onClick={(e) => { e.preventDefault(); p.onRedesign(); }}>{t("start.nav.redesign")}</a>
          <a href="#inspect" onClick={(e) => { e.preventDefault(); p.onInspect(); }}>{t("start.nav.inspect")}</a>
          <button className="x-btn x-btn-line sx-cta" onClick={() => go(START)}>{t("start.cta")} <Arrow size={16} /></button>
        </nav>
      </header>

      <main className="sx-flow">
        <section ref={sec(0)} className="sx-sec sx-sec-l sx-hero" aria-label={t("start.ch.overview")}>
          <div className="sx-col">
            <div data-a><RingMark size={170} /></div>
            <span className="sx-kicker" data-a>{t("start.kicker")}</span>
            <h1 className="sx-h sx-h1" data-a>{t("start.h1")}</h1>
            <p className="sx-p" data-a>{t("start.lede")}</p>
            <div className="sx-actions" data-a>
              <button className="x-btn x-btn-solid" onClick={() => go(START)}>{t("start.cta")} <Arrow size={18} /></button>
              <button className="x-btn x-btn-ghost" onClick={() => go(1)}>{t("start.how")}</button>
            </div>
            <dl className="sx-specrow" data-a>
              <div><dt>{t("start.spec.vision")}</dt><dd>{t("start.spec.vision.v")}</dd></div>
              <div><dt>{t("start.spec.voice")}</dt><dd>{t("start.spec.voice.v")}</dd></div>
              <div><dt>{t("start.spec.safety")}</dt><dd>{t("start.spec.safety.v")}</dd></div>
            </dl>
          </div>
          <span className="sx-scroll" aria-hidden><i />{t("start.scroll")}</span>
        </section>

        <section ref={sec(1)} className="sx-sec sx-sec-r" aria-label={t("start.ch.show")}>
          <div className="sx-col">
            <Head i={1} kicker={t("start.step1")}>{t("start.show.h")}</Head>
            <p className="sx-p" data-a>{t("start.show.p")}</p>
            <aside className="sx-panel" data-a>
              <h3 className="sx-ph">{t("start.show.panel")} <span className="ok">{t("start.show.confirmed")}</span></h3>
              <dl className="sx-rows">
                <div><dt>{t("start.show.device")}</dt><dd>{t("start.show.device.v")}</dd></div>
                <div><dt>{t("start.show.model")}</dt><dd>EX-TT20</dd></div>
                <div><dt>{t("start.show.label")}</dt><dd>{t("start.show.label.v")}</dd></div>
              </dl>
              <div className="sx-meter"><span>{t("start.show.match")}</span><b>94%</b><i style={{ ["--v" as string]: 0.94 }} /></div>
            </aside>
          </div>
        </section>

        <section ref={sec(2)} className="sx-sec sx-sec-l" aria-label={t("start.ch.talk")}>
          <div className="sx-col">
            <Head i={2} kicker={t("start.step2")}>{t("start.talk.h")}</Head>
            <p className="sx-p" data-a>{t("start.talk.p")}</p>
            <aside className="sx-panel" data-a>
              <div className="sx-voice">
                <div className="sx-orb"><VoiceOrb state="speaking" bands={[]} voice={voice} size={88} /></div>
                <div className="sx-lines">
                  <p className="me"><b>{t("start.talk.you")}</b>{t("start.talk.youSaid")}</p>
                  <p className="ai"><b>{t("start.talk.mechanic")}</b>{t("start.talk.mechSaid")}</p>
                </div>
              </div>
              <h4 className="sx-sub">{t("start.talk.causes")}</h4>
              <ol className="sx-bars">
                {[[t("start.cause.belt"), 0.88], [t("start.cause.pulley"), 0.08], [t("start.cause.speed"), 0.04]].map(([c, v]) => (
                  <li key={c as string}><span>{c}</span><b>{Math.round((v as number) * 100)}%</b><i style={{ ["--v" as string]: v as number }} /></li>
                ))}
              </ol>
            </aside>
          </div>
        </section>

        <section ref={sec(3)} className="sx-sec sx-sec-r" aria-label={t("start.ch.fix")}>
          <div className="sx-col">
            <Head i={3} kicker={t("start.step3")}>{t("start.fix.h")}</Head>
            <p className="sx-p" data-a>{t("start.fix.p")}</p>
            <aside className="sx-panel" data-a>
              <h3 className="sx-ph">{t("start.fix.stepOf")}</h3>
              <p className="sx-step">{t("start.fix.step")}</p>
              <ul className="sx-chips"><li>{t("start.fix.chip.checked")}</li><li>{t("start.fix.chip.manual")}</li><li>{t("start.fix.chip.waits")}</li></ul>
              <ol className="sx-steps">
                <li className="done">{t("start.fix.s1")}</li>
                <li className="done">{t("start.fix.s2")}</li>
                <li className="active">{t("start.fix.s3")}</li>
                <li>{t("start.fix.s4")}</li>
              </ol>
            </aside>
          </div>
        </section>

        <section ref={sec(4)} className="sx-sec sx-sec-l sx-start" aria-label={t("start.ch.start")}>
          <div className="sx-col">
            <Head i={4} kicker={t("start.before")}>{t("start.ready.h")}</Head>
            <p className="sx-p" data-a>{t("start.ready.p")}</p>
            <aside className="sx-panel sx-panel-solid" data-a>
              <h3 className="sx-ph">{t("start.notice.h")}</h3>
              <ol className="sx-notice">
                {NOTICE.map((x) => (
                  <li key={x.id} className={x.alert ? "alert" : ""}><span className="k">{t(`start.notice.${x.id}.k` as Key)}</span><span className="t">{t(`start.notice.${x.id}` as Key)}</span></li>
                ))}
              </ol>
              <div className="sx-consent">
                <label className="x-check">
                  <input type="checkbox" checked={p.accepted} onChange={(e) => { sound.confirm(e.target.checked); p.setAccepted(e.target.checked); }} />
                  <span className="box" aria-hidden />
                  <span>{t("start.consent")}</span>
                </label>
                <div className="sx-go">
                  <button className="x-btn x-btn-solid" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(); }}>
                    {p.loading ? t("start.connecting") : t("start.go")} <Arrow size={18} />
                  </button>
                  {p.lastRoom && (
                    <button className="x-btn x-btn-line" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(p.lastRoom!); }}>{t("start.resume")}</button>
                  )}
                </div>
                <p className="sx-who sx-lang">{choice === "auto" ? t("start.callLangAuto") : t("start.callLang", { name: language.name })}</p>
                {p.error && <p className="x-error" role="alert">{p.error}</p>}
                <p className="sx-who">
                  {p.profile && !p.profile.guest
                    ? <>{tn("start.signedIn", { name: <b>{p.profile.name}</b> })} · <button type="button" onClick={p.onSignOut}>{t("start.signOut")}</button></>
                    : p.profile?.guest
                      ? <>{t("start.guest")} · <button type="button" onClick={p.onSignOut}>{t("start.signIn")}</button></>
                      : <>{t("start.willSignIn")}</>}
                </p>
              </div>
            </aside>
          </div>
        </section>
      </main>

      <nav className="sx-rail" aria-label={t("start.chapters")}>
        <span className="sx-rail-bar"><span ref={bar} /></span>
        {CHAPTERS.map((c, i) => (
          <button key={c} className={i === ch ? "on" : ""} aria-current={i === ch ? "step" : undefined} onClick={() => go(i)} aria-label={t(c)}>
            <span className="no">{n(i)}</span><span className="lb">{t(c)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
