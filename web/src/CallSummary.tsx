import { useEffect, useState } from "react";
import { useI18n } from "./i18n";

export interface RepairSummary {
  session_id: string;
  started: string;
  minutes: number;
  device: string;
  outcome: "stopped" | "escalated" | "fixed" | "needs_attention" | "in_progress" | "diagnosed" | "started";
  outcome_text: string;
  symptoms: string[];
  diagnosis: string;
  confidence: number;
  precautions: { text: string; done: boolean }[];
  steps: { n: number; text: string; status: string; checked: string; source: string }[];
  next_time: string[];
  parts?: { part: string; number: string; links: { shop: string; url: string }[] }[];
  notes: { at: string; text: string }[];
}

interface Props {
  room: string;
  /** Sample data for the design preview; skips the network. */
  data?: RepairSummary;
  onResume?: () => void;
  onDone: () => void;
}

/** After the call: what happened, what's left, and the notes, written from what the session recorded. */
export function CallSummary({ room, data, onResume, onDone }: Props) {
  const { t, auto } = useI18n();
  const [s, setS] = useState<RepairSummary | null>(data ?? null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (data) return;
    let stop = false;
    // The agent writes the final summary as the call closes, so allow it a few seconds.
    (async () => {
      for (let i = 0; i < 4 && !stop; i++) {
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(room)}/summary`);
          if (r.ok) {
            if (!stop) setS(await r.json());
            return;
          }
        } catch { /* try again */ }
        await new Promise((res) => setTimeout(res, 1500));
      }
      if (!stop) setMissing(true);
    })();
    return () => { stop = true; };
  }, [room, data]);

  const good = s?.outcome === "fixed";
  const bad = s?.outcome === "stopped" || s?.outcome === "needs_attention";
  return (
    <main className="summary">
      <header className="summary-head">
        <span className="hud-h">{t("sum.title")}</span>
        {s ? (
          <>
            <h1>{auto(s.device) || "—"}</h1>
            <p className={`sum-outcome ${good ? "ok" : bad ? "bad" : ""}`}>{auto(s.outcome_text)}</p>
            <p className="dim small">{t("sum.when", { when: s.started, min: s.minutes })}</p>
          </>
        ) : (
          <p className="dim">{missing ? t("sum.missing") : t("sum.loading")}</p>
        )}
      </header>

      {s && (
        <div className="summary-grid">
          {(s.diagnosis || s.symptoms.length > 0) && (
            <section className="hud-card">
              {s.symptoms.length > 0 && (<><h2 className="hud-h">{t("sum.wrong")}</h2><ul>{s.symptoms.map((x, i) => <li key={i}>{auto(x)}</li>)}</ul></>)}
              {s.diagnosis && (
                <>
                  <h2 className="hud-h">{t("sum.diagnosis")}</h2>
                  <p><b>{auto(s.diagnosis)}</b> <span className="dim">{t("sum.sure", { pct: Math.round(s.confidence * 100) })}</span></p>
                </>
              )}
            </section>
          )}
          {s.next_time.length > 0 && (
            <section className="hud-card sum-next">
              <h2 className="hud-h">{t("sum.next")}</h2>
              <ul>{s.next_time.map((x, i) => <li key={i}>{auto(x)}</li>)}</ul>
            </section>
          )}
          {s.parts && s.parts.length > 0 && (
            <section className="hud-card parts">
              <h2 className="hud-h">{t("sum.parts")}</h2>
              {s.parts.map((p, i) => (
                <div key={i} className="part">
                  <b>{auto(p.part)}</b>{p.number && <span className="dim small"> {p.number}</span>}
                  <div className="part-links">
                    {p.links.map((l) => <a key={l.shop} href={l.url} target="_blank" rel="noopener noreferrer">{l.shop}</a>)}
                  </div>
                </div>
              ))}
              <p className="dim small">{t("call.parts.note")}</p>
            </section>
          )}
          {s.steps.length > 0 && (
            <section className="hud-card">
              <h2 className="hud-h">{t("sum.steps")}</h2>
              <ol className="timeline">
                {s.steps.map((st) => (
                  <li key={st.n} className={`st-${st.status}`}>
                    <span className="node" aria-hidden>{st.status === "done" ? "✓" : st.n}</span>
                    <div><p>{auto(st.text)}</p>{st.checked && <p className="checked">{auto(st.checked)}</p>}</div>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {s.precautions.length > 0 && (
            <section className="hud-card">
              <h2 className="hud-h">{t("sum.safety")}</h2>
              <ul className="checklist">
                {s.precautions.map((p, i) => <li key={i} className={p.done ? "done" : ""}><i aria-hidden>{p.done ? "✓" : ""}</i>{auto(p.text)}</li>)}
              </ul>
            </section>
          )}
          {s.notes.length > 0 && (
            <section className="hud-card sum-notes">
              <h2 className="hud-h">{t("sum.notes")}</h2>
              <ul className="notes">{s.notes.map((n, i) => <li key={i}><time>{n.at}</time>{auto(n.text)}</li>)}</ul>
            </section>
          )}
        </div>
      )}

      <footer className="summary-actions">
        {s && !data && (
          <a className="secondary btn" href={`/api/sessions/${encodeURIComponent(room)}/summary?format=md`} download>{t("sum.download")}</a>
        )}
        {s && s.outcome !== "fixed" && onResume && <button className="secondary" onClick={onResume}>{t("sum.resume")}</button>}
        <button className="primary" onClick={onDone}>{t("sum.done")}</button>
      </footer>
      <p className="dim small summary-auto">{t("sum.auto")}</p>
    </main>
  );
}
