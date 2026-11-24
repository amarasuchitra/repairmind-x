import { useState } from "react";
import { useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import type { Brief, QA } from "./brief.ts";
import { collectAnswers } from "./brief.ts";

/**
 * The engineer's understanding of the idea, before the design: what it heard, whether physics allows it (with the
 * numbers), the one assumption to test first, a few ways to do it, and the questions that change the design most.
 */
export function ThinkFirst(p: {
  brief: Brief; earlier: QA[]; busy: boolean;
  onDesign: (answers: QA[]) => void;
  onRethink: (answers: QA[], correction: string) => void;
  onClose: () => void;
}) {
  const { t, auto } = useI18n();
  const b = p.brief;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [concept, setConcept] = useState(b.recommended_concept);
  const [fixing, setFixing] = useState(false);
  const [correction, setCorrection] = useState("");
  const answers = () => collectAnswers(b, picked, concept, p.earlier);
  const unanswered = b.questions.filter((q) => !(picked[q.q] ?? "").trim()).length;
  const blocked = b.feasibility.verdict === "not_physically_possible";

  return (
    <section className="tf" aria-label={t("tf.title")}>
      <div className="tf-head">
        <span className="lab-kicker">{t("tf.title")}</span>
        <button className="lab-btn ghost" onClick={p.onClose}>{t("tf.close")}</button>
      </div>

      <p className="tf-restated">{auto(b.restated)}</p>
      <p className="lab-muted">{t("tf.goal")} {auto(b.real_goal)}</p>
      {!fixing ? (
        <button className="tf-link" onClick={() => setFixing(true)}>{t("tf.notRight")}</button>
      ) : (
        <div className="tf-fix">
          <textarea rows={2} value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder={t("tf.fixPh")} />
          <button className="lab-btn" disabled={p.busy || correction.trim().length < 3} onClick={() => p.onRethink(answers(), correction)}>{t("tf.fixGo")}</button>
        </div>
      )}

      <div className={`tf-verdict ${b.feasibility.verdict}`}>
        <b>{t(`tf.v.${b.feasibility.verdict}` as Key)}</b>
        <p>{auto(b.feasibility.why)}</p>
        {b.feasibility.deciding_numbers.length > 0 && (
          <details>
            <summary>{t("tf.numbers")}</summary>
            <ul className="tf-nums">{b.feasibility.deciding_numbers.map((n) => <li key={n}><code>{n}</code></li>)}</ul>
          </details>
        )}
        {b.feasibility.closest_alternative && <p><b>{t("tf.instead")}</b> {auto(b.feasibility.closest_alternative)}</p>}
      </div>

      {b.questions.length > 0 && (
        <div className="tf-qs">
          <h3>{t("tf.questions")}</h3>
          {b.questions.map((q) => (
            <div className="tf-q" key={q.q}>
              <p><b>{auto(q.q)}</b> <small className="lab-muted">{auto(q.why)}</small></p>
              <div className="tf-opts">
                {q.options.map((o) => (
                  <button key={o} className={`lab-chip${picked[q.q] === o ? " on" : ""}`} aria-pressed={picked[q.q] === o}
                    onClick={() => setPicked({ ...picked, [q.q]: picked[q.q] === o ? "" : o })}>{auto(o)}</button>
                ))}
                <input className="tf-own" placeholder={t("tf.own")} aria-label={t("tf.own")}
                  value={q.options.includes(picked[q.q] ?? "") ? "" : picked[q.q] ?? ""}
                  onChange={(e) => setPicked({ ...picked, [q.q]: e.target.value })} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="tf-risk">
        <h3>{t("tf.risk")}</h3>
        <p><b>{auto(b.riskiest.statement)}</b></p>
        <p className="lab-muted">{auto(b.riskiest.why_it_matters)}</p>
        <p><b>{t("tf.test")}</b> {auto(b.riskiest.cheapest_test)}</p>
        <p><b>{t("tf.passIf")}</b> {auto(b.riskiest.pass_if)}</p>
        <p className="lab-muted">{t("tf.testCost", { inr: b.riskiest.test_cost_inr.toLocaleString("en-IN"), time: b.riskiest.test_time })}</p>
      </div>

      {b.concepts.length > 0 && (
        <div className="tf-concepts">
          <h3>{t("tf.ways")}</h3>
          <div className="tf-grid">
            {b.concepts.map((c) => (
              <button key={c.name} className={`tf-concept${concept === c.name ? " on" : ""}`} aria-pressed={concept === c.name} onClick={() => setConcept(c.name)}>
                <b>{c.name}{c.name === b.recommended_concept && <em> · {t("tf.recommended")}</em>}</b>
                <span>{auto(c.how_it_works)}</span>
                {c.pros.map((x) => <small key={x} className="pro">+ {auto(x)}</small>)}
                {c.cons.map((x) => <small key={x} className="con">− {auto(x)}</small>)}
              </button>
            ))}
          </div>
          <p className="lab-muted">{auto(b.recommended_why)}</p>
        </div>
      )}

      <details className="tf-known">
        <summary>{t("tf.known", { n: b.known.length })}</summary>
        <ul>{b.known.map((k) => <li key={k.fact}><span className={`tf-src ${k.source}`}>{t(`tf.src.${k.source}` as Key)}{k.ref ? ` ${k.ref}` : ""}</span> {auto(k.fact)}</li>)}</ul>
      </details>

      <div className="lab-row tf-go">
        <button className="lab-btn solid" disabled={p.busy || blocked} onClick={() => p.onDesign(answers())}>
          {unanswered && b.questions.length ? t("tf.designAnyway") : t("tf.design")}
        </button>
        {Object.values(picked).some((v) => v.trim()) && (
          <button className="lab-btn" disabled={p.busy} onClick={() => p.onRethink(answers(), "")}>{t("tf.again")}</button>
        )}
      </div>
    </section>
  );
}
