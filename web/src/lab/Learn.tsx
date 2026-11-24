import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import type { Design } from "./design.ts";
import { experiment, learnSteps, LEVELS, type Direction, type Level } from "./learn.ts";
import { fmt } from "./units.ts";

/**
 * Learn how it works: one idea at a time, at the learner's level. Each step asks for a prediction first, then the
 * page runs the experiment on the design's own equations and shows what really happens, and why.
 */
export function Learn(p: {
  design: Design; overrides: Record<string, number>; level: Level; setLevel: (l: Level) => void;
  onTry: (symbol: string, value: number | null) => void;
}) {
  const { t, auto } = useI18n();
  const steps = useMemo(() => learnSteps(p.design), [p.design]);
  const [i, setI] = useState(0);
  const [guess, setGuess] = useState<Record<number, Direction>>({});
  const [tried, setTried] = useState<string | null>(null);
  if (!steps.length) return null;
  const n = Math.min(i, steps.length - 1);
  const s = steps[n];
  const out = experiment(p.design, tried ? Object.fromEntries(Object.entries(p.overrides).filter(([k]) => k !== tried)) : p.overrides, s);
  const g = guess[n];
  const right = g && out ? g === out.direction : false;
  const v = p.design.variables.find((x) => x.symbol === s.try_variable);
  const eq = p.design.equations.find((e) => e.id === s.equation_id);
  const factorWord = s.try_factor === 2 ? t("learn.doubled") : s.try_factor === 0.5 ? t("learn.halved") : t("learn.timesN", { f: fmt(s.try_factor, 3) });
  const question = s.question ? auto(s.question) : t("learn.q", { v: v?.name ?? s.try_variable, how: factorWord, eq: eq?.name ?? s.equation_id });

  return (
    <section className="learn" aria-label={t("learn.title")}>
      <div className="learn-head">
        <div>
          <span className="lab-kicker">{t("learn.title")}</span>
          <p className="lab-muted">{t("learn.sub")}</p>
        </div>
        <div className="learn-level" role="radiogroup" aria-label={t("learn.level")}>
          {LEVELS.map((l) => (
            <button key={l} role="radio" aria-checked={p.level === l} className={`lab-chip${p.level === l ? " on" : ""}`} onClick={() => p.setLevel(l)}>
              {t(`learn.level.${l}` as Key)}
            </button>
          ))}
        </div>
      </div>

      <div className="learn-step">
        <span className="learn-count">{t("learn.step", { n: n + 1, of: steps.length })}</span>
        <h3>{auto(s.concept)}</h3>
        <p>{auto(s.intuition)}</p>
        {s.why_here && <p className="lab-muted"><b>{t("learn.whyHere")}</b> {auto(s.why_here)}</p>}

        <div className="learn-predict">
          <p><b>{t("learn.predict")}</b> {question}</p>
          <div className="lab-row">
            {(["up", "same", "down"] as Direction[]).map((d) => (
              <button key={d} className={`lab-chip${g === d ? " on" : ""}`} aria-pressed={g === d} onClick={() => setGuess({ ...guess, [n]: d })}>
                {t(`learn.dir.${d}` as Key)}
              </button>
            ))}
          </div>
        </div>

        {g && out && (
          <div className={`learn-result ${right ? "right" : "wrong"}`} role="status">
            <b>{right ? t("learn.right") : t("learn.notQuite")}</b>
            <p>
              {t("learn.result", {
                v: out.varName, a: fmt(out.varBefore), b: fmt(out.varAfter), vu: out.varUnit,
                eq: out.eqName, x: fmt(out.before), y: fmt(out.after), u: out.unit,
              })}
              {Number.isFinite(out.ratio) && ` (×${fmt(out.ratio, 3)})`}
            </p>
            {out.law !== "other" && out.law !== "none" && <p>{t(`learn.law.${out.law}` as Key)}</p>}
            {out.passBefore !== null && out.passAfter !== null && out.passBefore !== out.passAfter && (
              <p className={out.passAfter ? "ok" : "bad"}>{out.passAfter ? t("learn.nowPasses") : t("learn.nowFails", { ms: fmt(out.marginAfter ?? 0, 2) })}</p>
            )}
            {s.explain_after && <p>{s.generated && <b>{t("learn.assumes")} </b>}{auto(s.explain_after)}</p>}
            {s.walkthrough.length > 0 && (
              <details>
                <summary>{t("learn.working")}</summary>
                <ol className="learn-work">{s.walkthrough.map((w) => <li key={w}><code>{s.generated ? w : auto(w)}</code></li>)}</ol>
              </details>
            )}
            <div className="lab-row">
              {tried === s.try_variable ? (
                <button className="lab-btn" onClick={() => { p.onTry(s.try_variable, null); setTried(null); }}>{t("learn.undo")}</button>
              ) : (
                <button className="lab-btn" onClick={() => { p.onTry(s.try_variable, out.varAfter); setTried(s.try_variable); }}>{t("learn.apply")}</button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="learn-nav">
        <button className="lab-btn ghost" disabled={n === 0} onClick={() => setI(n - 1)}>← {t("learn.prev")}</button>
        <span className="learn-dots" aria-hidden>{steps.map((_, k) => <i key={k} className={k === n ? "on" : guess[k] ? "done" : ""} />)}</span>
        <button className="lab-btn" disabled={n === steps.length - 1} onClick={() => setI(n + 1)}>{t("learn.next")} →</button>
      </div>
    </section>
  );
}
