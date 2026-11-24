import { useEffect, useMemo, useRef, useState } from "react";
import "./home.css";
import { VoiceOrb, type OrbState } from "../hud/VoiceOrb";
import { makeDemoVoice } from "../fx/demoVoice";
import { sound } from "../fx/sound";
import { Arrow } from "../ui/Icons";
import { Wordmark } from "../ui/RingMark";
import { MicButton } from "../lab/inputs";
import { LAB_BRIEF_KEY as BRIEF_KEY } from "../redesign/brief";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";

export interface HomeProps {
  accepted: boolean;
  setAccepted: (v: boolean) => void;
  loading: boolean;
  error: string | null;
  lastRoom: string | null;
  onStart: (room?: string) => void;
  onInspect: () => void;
  onLab: () => void;
  onRedesign: () => void;
  /** the hardware project builder */
  onBuild: () => void;
  /** the scrolling 3D walkthrough of how a repair call works */
  onTour: () => void;
  profile: { name: string; guest?: boolean } | null;
  onSignOut: () => void;
}

type Intent = "fix" | "design" | "redesign" | "build";

/** Hand-off to the hardware builder, which suggests parts for this goal once. Same key as build/Builder.tsx. */
const BUILD_GOAL_KEY = "rmx.build.goal";

/**
 * A first guess at what someone typed or said. English keywords only: anything else starts a repair,
 * which is the main job, and the suggestions under the box are always there to pick another.
 */
export function guessIntent(text: string): Intent {
  const x = text.toLowerCase();
  if (/\b(redesign|re-design|replacement part|new part|stronger part|3d[- ]?print|print (a|me|one))\b/.test(x)) return "redesign";
  const broken = /\b(broken|fix|repair|not working|stopped|won't|doesn't)\b/.test(x);
  if (!broken && /\b(toy|gadget|invent\w*|idea|sensors?|arduino|esp32|electronics?|circuit|robot|leds?|smart|wiring|microcontroller|lights? up|make (it|my \w+) (talk|speak|glow|light up|listen|move|beep))\b/.test(x)) return "build";
  if (/\b(design|build|invent|create|prototype|idea for|make (a|an|me))\b/.test(x)) return "design";
  return "fix";
}

const NOTICE: { id: string; alert?: boolean }[] = [{ id: "control" }, { id: "limits" }, { id: "stop", alert: true }, { id: "privacy" }];

function greetingKey(): Key {
  const h = new Date().getHours();
  return h < 5 ? "home.hi.evening" : h < 12 ? "home.hi.morning" : h < 18 ? "home.hi.afternoon" : "home.hi.evening";
}

/**
 * The start page: one assistant, one question. Say or type what you need, or pick one of three
 * suggestions. Everything else (the design lab, redesign, bulk inspection, the walkthrough) sits in
 * the menu, one tap away.
 */
export function Home(p: HomeProps) {
  const { t, choice, language } = useI18n();
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [said, setSaid] = useState("");
  const [mode, setMode] = useState<Intent | null>(null);
  const [talking, setTalking] = useState(false);
  const [menu, setMenu] = useState(false);
  const voice = useMemo(() => makeDemoVoice(12, 1.6, 0.4), []);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // the orb "answers" for a moment whenever the assistant replies
  useEffect(() => {
    if (!mode) return;
    setTalking(true);
    const id = window.setTimeout(() => setTalking(false), 1800);
    return () => window.clearTimeout(id);
  }, [mode]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  useEffect(() => { sound.arm(); }, []);

  function choose(intent: Intent, words = "") {
    if (intent === "design") {
      if (words) {
        try { sessionStorage.setItem(BRIEF_KEY, JSON.stringify({ idea: words, context: "" })); } catch { /* the lab just opens empty */ }
      }
      p.onLab();
      return;
    }
    if (intent === "redesign") { p.onRedesign(); return; }
    if (intent === "build") {
      if (words) {
        try { sessionStorage.setItem(BUILD_GOAL_KEY, words); } catch { /* the builder just opens on its start page */ }
      }
      p.onBuild();
      return;
    }
    setSaid(words);
    setMode("fix");
  }

  function submit() {
    const words = `${text} ${interim}`.trim();
    if (!words) { input.current?.focus(); return; }
    setText("");
    choose(guessIntent(words), words);
  }

  const orb: OrbState = interim ? "listening" : talking ? "speaking" : "idle";
  const name = p.profile && !p.profile.guest ? p.profile.name.split(" ")[0] : "";
  const shown = interim ? `${text}${text && !text.endsWith(" ") ? " " : ""}${interim}` : text;

  return (
    <div className={`as${mode ? " as-engaged" : ""}`}>
      <header className="as-top">
        <a className="as-brand" href="#" onClick={(e) => { e.preventDefault(); setMode(null); }} aria-label={t("home.homeAria")}>
          <Wordmark />
        </a>
        <div className="as-top-r">
          <LanguagePicker />
          <div className="as-menu" ref={menuRef}>
            <button className="as-menu-btn" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu((m) => !m)}>
              <span className="as-dots" aria-hidden><i /><i /><i /></span><span className="as-more-t">{t("home.more")}</span>
            </button>
            {menu && (
              <div className="as-menu-list" role="menu">
                <button role="menuitem" onClick={() => { setMenu(false); choose("fix"); }}>{t("home.s.fix")}<small>{t("home.s.fix.d")}</small></button>
                <button role="menuitem" onClick={() => { setMenu(false); p.onLab(); }}>{t("start.nav.lab")}<small>{t("home.s.design.d")}</small></button>
                <button role="menuitem" onClick={() => { setMenu(false); p.onBuild(); }}>{t("start.nav.build")}<small>{t("home.s.build.d")}</small></button>
                <button role="menuitem" onClick={() => { setMenu(false); p.onRedesign(); }}>{t("start.nav.redesign")}<small>{t("home.s.redesign.d")}</small></button>
                <button role="menuitem" onClick={() => { setMenu(false); p.onInspect(); }}>{t("start.nav.inspect")}<small>{t("home.inspect.d")}</small></button>
                <hr />
                <button role="menuitem" onClick={() => { setMenu(false); p.onTour(); }}>{t("start.how")}</button>
                {p.profile && (
                  <button role="menuitem" onClick={() => { setMenu(false); p.onSignOut(); }}>
                    {p.profile.guest ? t("start.signIn") : t("start.signOut")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="as-main">
        <div className={`as-orb as-orb-${orb}`} aria-hidden>
          <VoiceOrb state={orb} bands={[]} voice={orb === "speaking" ? voice : undefined} size={mode ? 150 : 230} detail="full" />
        </div>

        {!mode ? (
          <>
            <h1 className="as-hi">{name ? t("home.hiName", { hi: t(greetingKey()), name }) : t(greetingKey())}</h1>
            <p className="as-ask">{t("home.ask")}</p>

            <form className="as-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <textarea ref={input} rows={1} value={shown} placeholder={t("home.ph")} aria-label={t("home.ph")}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
              <MicButton label={t("home.talk")} onInterim={setInterim}
                onText={(w) => setText((v) => (v ? `${v.trimEnd()} ${w}` : w).slice(0, 4000))} />
              <button type="submit" className="as-send" aria-label={t("home.send")} disabled={!shown.trim()}><Arrow size={18} /></button>
            </form>

            <div className="as-suggest" aria-label={t("home.suggest")}>
              <button onClick={() => choose("fix")}><b>{t("home.s.fix")}</b><span>{t("home.s.fix.d")}</span></button>
              <button onClick={() => choose("design")}><b>{t("home.s.design")}</b><span>{t("home.s.design.d")}</span></button>
              <button onClick={() => choose("build")}><b>{t("home.s.build")}</b><span>{t("home.s.build.d")}</span></button>
              <button onClick={() => choose("redesign")}><b>{t("home.s.redesign")}</b><span>{t("home.s.redesign.d")}</span></button>
            </div>
          </>
        ) : (
          <section className="as-thread" aria-live="polite">
            {said && <p className="as-me">{said}</p>}
            <p className="as-ai">{t("home.fix.reply")}</p>

            <div className="as-card">
              <h2>{t("home.fix.before")}</h2>
              <ul className="as-rules">
                {NOTICE.map((x) => (
                  <li key={x.id} className={x.alert ? "alert" : ""}>{t(`start.notice.${x.id}` as Key)}</li>
                ))}
              </ul>
              <label className="x-check">
                <input type="checkbox" checked={p.accepted} onChange={(e) => { sound.confirm(e.target.checked); p.setAccepted(e.target.checked); }} />
                <span className="box" aria-hidden />
                <span>{t("start.consent")}</span>
              </label>
              <div className="as-go">
                <button className="x-btn x-btn-solid" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(); }}>
                  {p.loading ? t("start.connecting") : t("home.fix.go")} <Arrow size={18} />
                </button>
                {p.lastRoom && (
                  <button className="x-btn x-btn-line" disabled={!p.accepted || p.loading} onClick={() => { sound.launch(); p.onStart(p.lastRoom!); }}>{t("start.resume")}</button>
                )}
              </div>
              {p.error && <p className="x-error" role="alert">{p.error}</p>}
              <p className="as-fine">
                {choice === "auto" ? t("start.callLangAuto") : t("start.callLang", { name: language.name })}
                {" "}
                {!p.profile && t("start.willSignIn")}
              </p>
            </div>
            <button className="as-back" onClick={() => setMode(null)}>{t("home.fix.other")}</button>
          </section>
        )}
      </main>
    </div>
  );
}
