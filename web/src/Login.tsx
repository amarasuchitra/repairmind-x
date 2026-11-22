import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Arrow } from "./ui/Icons";
import { RingMark, Wordmark } from "./ui/RingMark";
import { prefersReducedMotion } from "./fx/motion";
import { sound } from "./fx/sound";

/**
 * Quick sign-in between the start page and the live call. It asks for a name (and an optional email) so
 * the app can greet the person, and remembers it on this device only. It is not an account system: there
 * is no password, nothing is sent to a server, and "Continue as guest" skips it.
 */

export interface Profile { name: string; email?: string; guest?: boolean }

const KEY = "rmx.profile";

export function readProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

export function writeProfile(p: Profile | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: asked again next time */
  }
}

export function Login({ onDone, onBack }: { onDone: (p: Profile) => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const nameOk = name.trim().length > 0;
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  useEffect(() => {
    if (prefersReducedMotion() || !root.current) return;
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.fromTo(root.current.querySelectorAll("[data-a]"), { opacity: 0, y: 22, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.1, stagger: 0.07 })
      .fromTo(root.current.querySelector(".ring-mark"), { rotate: -30, scale: 0.85 }, { rotate: 0, scale: 1, duration: 1.6 }, 0);
    return () => { tl.progress(1).kill(); };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!nameOk || !emailOk) return;
    sound.confirm(true);
    onDone({ name: name.trim(), email: email.trim() || undefined });
  };

  return (
    <div ref={root} className="lg">
      <header className="lg-top">
        <a className="sx-brand" href="#" onClick={(e) => { e.preventDefault(); onBack(); }} aria-label="RepairMind X, back to the start page"><Wordmark /></a>
        <button className="lg-back" onClick={onBack}><span aria-hidden>←</span> Back</button>
      </header>

      <main className="lg-main">
        <section className="lg-copy">
          <div data-a><RingMark size={150} /></div>
          <span className="sx-kicker" data-a>One quick step</span>
          <h1 className="sx-h" data-a>Sign in.</h1>
          <p className="sx-p" data-a>Tell the mechanic who it's talking to. Your name stays on this device; there's no password and nothing to set up.</p>
        </section>

        <form className="lg-card" onSubmit={submit} noValidate data-a>
          <h2 className="sx-ph">Your details</h2>
          <label className="lg-field">
            <span>Name</span>
            <input autoFocus autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should it call you?" aria-invalid={touched && !nameOk} />
            {touched && !nameOk && <em role="alert">Enter a name, or continue as a guest.</em>}
          </label>
          <label className="lg-field">
            <span>Email <i>optional</i></span>
            <input type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-invalid={touched && !emailOk} />
            {touched && !emailOk && <em role="alert">That email doesn't look right.</em>}
          </label>
          <button className="x-btn x-btn-solid lg-go" type="submit">Continue to the mechanic <Arrow size={18} /></button>
          <button className="lg-guest" type="button" onClick={() => { sound.tick(true); onDone({ name: "Guest", guest: true }); }}>Continue as guest</button>
          <p className="lg-note">Saved only in this browser. Sign out any time from the start page.</p>
        </form>
      </main>
    </div>
  );
}
