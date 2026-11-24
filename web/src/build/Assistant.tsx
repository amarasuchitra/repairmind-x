import { useEffect, useState } from "react";
import { Attachments, MicButton, type AttachmentInfo } from "../lab/inputs.tsx";
import { useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import type { Assessment, IdeaInput } from "./assess.ts";

/** Step 1: the idea, in the person's own words, with photos or files dropped in. */
export function IdeaStart(p: {
  input: IdeaInput; setInput: (i: IdeaInput) => void; files: AttachmentInfo[]; setFiles: (f: AttachmentInfo[]) => void;
  busy: boolean; onThink: () => void; onCanvas: () => void;
}) {
  const { t } = useI18n();
  const [interim, setInterim] = useState("");
  const [have, setHave] = useState(!!p.input.product);
  const [canHear, setCanHear] = useState(false);
  useEffect(() => {
    fetch("/api/lab/status").then((r) => r.json()).then((s) => setCanHear(!!s.media)).catch(() => undefined);
  }, []);
  const idea = interim ? `${p.input.idea}${p.input.idea && !p.input.idea.endsWith(" ") ? " " : ""}${interim}` : p.input.idea;
  const set = (patch: Partial<IdeaInput>) => p.setInput({ ...p.input, ...patch });
  const ready = idea.trim().length > 2 && (!have || p.input.product.trim().length > 1);
  return (
    <section className="bd-start ia-start">
      <h1>{t("ia.ask")}</h1>
      <p className="lab-lede">{t("ia.askP")}</p>
      <form className="ia-form" onSubmit={(e) => { e.preventDefault(); if (ready) p.onThink(); }}>
        <div className="ia-idea">
          <textarea rows={3} value={idea} maxLength={3000} placeholder={t("ia.ideaPh")} aria-label={t("ia.ask")}
            onChange={(e) => set({ idea: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && ready) { e.preventDefault(); p.onThink(); } }} />
          <MicButton label={t("home.talk")} onInterim={setInterim} onText={(w) => set({ idea: (p.input.idea ? `${p.input.idea.trimEnd()} ${w}` : w).slice(0, 3000) })} />
        </div>
        <label className="x-check ia-check">
          <input type="checkbox" checked={have} onChange={(e) => { setHave(e.target.checked); if (!e.target.checked) set({ product: "" }); }} />
          <span className="box" aria-hidden /><span>{t("ia.have")}</span>
        </label>
        {have && (
          <input className="ia-product" value={p.input.product} maxLength={2000} placeholder={t("ia.productPh")} aria-label={t("ia.productPh")}
            onChange={(e) => set({ product: e.target.value })} />
        )}
        <label className="x-check ia-check">
          <input type="checkbox" checked={p.input.forKids} onChange={(e) => set({ forKids: e.target.checked })} />
          <span className="box" aria-hidden /><span>{t("ia.kids")}</span>
        </label>
        <details className="lab-fold" open={p.files.length > 0 || undefined}>
          <summary>{t("ia.files")}</summary>
          <Attachments items={p.files} onChange={p.setFiles} canHearMedia={canHear} compact />
        </details>
        <button type="submit" className="lab-btn solid ia-go" disabled={!ready || p.busy}>{p.busy ? t("ia.thinking") : t("ia.think")}</button>
      </form>
      <div className="ia-examples">
        <span className="lab-kicker">{t("ia.examples")}</span>
        {(["ia.ex1", "ia.ex2", "ia.ex3", "ia.ex4", "ia.ex5"] as Key[]).map((k) => (
          <button key={k} className="lab-chip" onClick={() => set({ idea: t(k) })}>{t(k)}</button>
        ))}
      </div>
      <button className="lab-link ia-direct" onClick={p.onCanvas}>{t("ia.canvasDirect")}</button>
    </section>
  );
}

/** Step 2: what it understood, the honest verdict, questions, and the path to a real product. */
export function AssessmentView(p: {
  a: Assessment; input: IdeaInput; offline: boolean; busy: boolean;
  onAnswers: (answers: { q: string; a: string }[]) => void;
  onCorrect: (text: string) => void;
  onBuild: () => void; onLab: () => void; onStartOver: () => void;
}) {
  const { t, auto } = useI18n();
  const { a } = p;
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [fix, setFix] = useState("");
  const canBuild = a.overall !== "not_recommended" && a.plan.parts.length > 0;
  const answers = Object.entries(picked).filter(([, v]) => v.trim()).map(([q, v]) => ({ q, a: v.trim() }));

  return (
    <section className="ia-flow" aria-busy={p.busy}>
      {p.offline && <p className="ia-offline" role="note">{t("ia.offline")}</p>}
      <div className="ia-said">
        <p className="as-me">{p.input.product ? `${p.input.product}: ${p.input.idea}` : p.input.idea}</p>
      </div>

      <div className="lab-card ia-understood">
        <span className="lab-kicker">{t("ia.understood")}</span>
        <p className="ia-restated">{auto(a.restated)}</p>
        <details className="lab-fold ia-correct">
          <summary>{t("ia.notQuite")}</summary>
          <form onSubmit={(e) => { e.preventDefault(); if (fix.trim()) { p.onCorrect(fix.trim()); setFix(""); } }}>
            <textarea rows={2} value={fix} maxLength={2000} placeholder={t("ia.correctPh")} onChange={(e) => setFix(e.target.value)} />
            <MicButton label={t("home.talk")} onText={(w) => setFix((v) => (v ? `${v.trimEnd()} ${w}` : w).slice(0, 2000))} />
            <button className="lab-btn" disabled={!fix.trim() || p.busy}>{t("ia.correct")}</button>
            {!p.offline && <small>{t("ia.learned")}</small>}
          </form>
        </details>
      </div>

      <div className={`lab-card ia-verdict v-${a.overall}`}>
        <h2>{t(`ia.overall.${a.overall}` as Key)}</h2>
        <p>{auto(a.overall_why)}</p>
        {a.plan.summary && <p className="ia-summary">{auto(a.plan.summary)}</p>}
        <div className="ia-actions">
          {canBuild && <button className="lab-btn solid" onClick={p.onBuild}>{t("ia.build")}</button>}
          {a.design_lab && <button className="lab-btn" onClick={p.onLab}>{t("ia.toLab")}</button>}
          <button className="lab-btn ghost" onClick={p.onStartOver}>{t("ia.startOver")}</button>
        </div>
        {p.busy && <p className="lab-busy" role="status"><span className="lab-spin" aria-hidden /> {t("ia.thinking")}</p>}
      </div>

      {a.plan.warnings.length > 0 && (
        <div className="bd-safety ia-warnings"><span className="lab-kicker">{t("ia.warnings")}</span><ul>{a.plan.warnings.map((w) => <li key={w}>{auto(w)}</li>)}</ul></div>
      )}

      {a.questions.length > 0 && (
        <div className="lab-card ia-questions">
          <span className="lab-kicker">{t("ia.questions")}</span>
          {a.questions.map((q) => (
            <div key={q.q} className="ia-q">
              <b>{auto(q.q)}</b>
              {q.why && <small>{auto(q.why)}</small>}
              <div className="lab-examples">
                {q.options.map((o) => (
                  <button key={o} className={`lab-chip${picked[q.q] === o && !other[q.q] ? " on" : ""}`} aria-pressed={picked[q.q] === o && !other[q.q]}
                    onClick={() => { setOther({ ...other, [q.q]: false }); setPicked({ ...picked, [q.q]: o }); }}>{auto(o)}</button>
                ))}
                <button className={`lab-chip${other[q.q] ? " on" : ""}`} onClick={() => { setOther({ ...other, [q.q]: true }); setPicked({ ...picked, [q.q]: "" }); }}>{t("ia.other")}</button>
              </div>
              {other[q.q] && <input value={picked[q.q] ?? ""} maxLength={600} placeholder={t("ia.otherPh")} aria-label={q.q} onChange={(e) => setPicked({ ...picked, [q.q]: e.target.value })} />}
            </div>
          ))}
          <button className="lab-btn solid" disabled={!answers.length || p.busy} onClick={() => { p.onAnswers(answers); setPicked({}); setOther({}); }}>{t("ia.update")}</button>
        </div>
      )}

      <div className="ia-wishes">
        <span className="lab-kicker">{t("ia.wishes")}</span>
        {a.wishes.map((w, i) => (
          <article key={i} className={`lab-card ia-wish w-${w.verdict}`}>
            <div className="ia-wish-head">
              <span className="ia-pill">{t(`ia.v.${w.verdict}` as Key)}</span>
              <b>{auto(w.wish)}</b>
              <span className="lab-muted">{t(`ia.e.${w.effort}` as Key)}{w.cost_inr > 0 ? ` · ${t("ia.addedCost", { n: w.cost_inr.toLocaleString("en-IN") })}` : ""}</span>
            </div>
            <p>{auto(w.why)}</p>
            {w.how && <p><span className="ia-lbl">{t("ia.how")}</span> {auto(w.how)}</p>}
            {w.alternative && <p><span className="ia-lbl">{t("ia.instead")}</span> {auto(w.alternative)}</p>}
            {w.factors.length > 0 && (
              <details className="lab-fold">
                <summary>{t("ia.whyFactors")}</summary>
                <ul className="ia-factors">
                  {w.factors.map((f, j) => <li key={j} className={`f-${f.verdict}`}><span className="ia-fk">{t(`ia.f.${f.kind}` as Key)}</span> {auto(f.text)}</li>)}
                </ul>
              </details>
            )}
          </article>
        ))}
      </div>

      {a.plan.stages.length > 0 && (
        <div className="lab-card ia-stages">
          <span className="lab-kicker">{t("ia.path")}</span>
          <ol>
            {a.plan.stages.map((s, i) => (
              <li key={i}>
                <b>{auto(s.name)}</b> <span className="lab-muted">{s.weeks > 1.5 ? t("ia.weeks", { n: Math.round(s.weeks) }) : t("ia.week")}</span>
                <p>{auto(s.goal)}</p>
                <ul>{s.tasks.map((x) => <li key={x}>{auto(x)}</li>)}</ul>
              </li>
            ))}
          </ol>
        </div>
      )}

      <details className="lab-fold">
        <summary>{a.product.kind === "new" ? t("ia.product.new") : t("ia.product")}: {auto(a.product.name)}</summary>
        <p>{auto(a.product.how_it_works)}</p>
        {a.product.inside.length > 0 && <>
          <b>{t("ia.inside")}</b>
          <ul>{a.product.inside.map((x, i) => <li key={i}>{auto(x.name)}{x.purpose ? `: ${auto(x.purpose)}` : ""} <span className={`ia-conf c-${x.confidence}`}>{t(`ia.c.${x.confidence}` as Key)}</span></li>)}</ul>
        </>}
        <p><b>{t("ia.powerNow")}:</b> {auto(a.product.power_detail)}</p>
        {a.product.kind === "existing" && <p><b>{t("ia.space")}:</b> {auto(a.product.space)}</p>}
        {a.product.kind === "existing" && <p><b>{t("ia.open")}:</b> {auto(a.product.can_open)}</p>}
        {a.product.hazards.length > 0 && <p><b>{t("ia.hazards")}:</b> {a.product.hazards.map(auto).join(", ")}</p>}
      </details>

      {(a.plan.steps.length > 0 || a.plan.reuse) && (
        <details className="lab-fold">
          <summary>{t("ia.steps")}</summary>
          {a.plan.reuse && <p><b>{t("ia.reuse")}:</b> {auto(a.plan.reuse)}</p>}
          <ol>{a.plan.steps.map((s, i) => <li key={i}>{auto(s)}</li>)}</ol>
        </details>
      )}

      {a.plan.other_parts.length > 0 && (
        <details className="lab-fold">
          <summary>{t("ia.otherParts")}</summary>
          <ul>{a.plan.other_parts.map((x, i) => <li key={i}><b>{auto(x.name)}</b>{x.price_inr ? ` (~₹${x.price_inr.toLocaleString("en-IN")})` : ""}: {auto(x.why)}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
