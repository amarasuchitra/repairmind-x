import { useEffect, useMemo, useState } from "react";
import "./lab.css";
import type { Design } from "./design.ts";
import { analyze, type Finding } from "./analysis.ts";
import { EXAMPLES } from "./examples.ts";
import { SimView, runHeadless } from "./SimView.tsx";
import { fmt } from "./units.ts";
import { Attachments, MicButton, fetchAttachments, type AttachmentInfo } from "./inputs.tsx";
import { LanguagePicker, useI18n } from "../i18n";
import type { Key } from "../i18n/en";

const STORE = "rmx.lab.design";
/**
 * Hand-off from other pages (e.g. a repair call's design brief): put {idea, context, attachment_ids?} here as
 * JSON in sessionStorage, then open #lab. The lab prefills the form once and removes the key.
 */
export const BRIEF_KEY = "rmx.lab.brief";

function takeBrief(): { idea: string; context: string; attachment_ids: string[] } | null {
  try {
    const raw = sessionStorage.getItem(BRIEF_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw);
    const ids = Array.isArray(b.attachment_ids) ? b.attachment_ids.filter((x: unknown) => typeof x === "string").slice(0, 20) : [];
    return { idea: String(b.idea ?? "").slice(0, 4000), context: String(b.context ?? "").slice(0, 4000), attachment_ids: ids };
  } catch {
    return null;
  }
}
const MAX_AUTO_ROUNDS = 3;
const TABS = ["Overview", "Requirements", "Analysis", "Trade study", "Risks", "Research", "Reviews"] as const;
type Tab = (typeof TABS)[number];

function readStored(): Design | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Design) : null;
  } catch {
    return null;
  }
}
function store(d: Design | null) {
  try {
    if (d) localStorage.setItem(STORE, JSON.stringify(d));
    else localStorage.removeItem(STORE);
  } catch {
    /* not remembered; fine */
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))).detail;
    throw new Error(typeof detail === "string" ? detail : res.status >= 500 && res.status !== 503 && res.status !== 502 ? "server" : `Error ${res.status}`);
  }
  return res.json();
}

interface Status { ready: boolean; model: string | null; lessons: number; media?: boolean }

function Health({ findings, simFindings, checking }: { findings: Finding[]; simFindings: Finding[] | null; checking: boolean }) {
  const { t } = useI18n();
  const all = [...findings, ...(simFindings ?? [])];
  const errors = all.filter((f) => f.severity === "error").length;
  const warns = all.filter((f) => f.severity === "warning").length;
  const state = errors ? "bad" : warns ? "warn" : "ok";
  return (
    <div className={`lab-health ${state}`} role="status">
      <b>{errors ? t("lab.health.failing", { n: errors }) : warns ? t("lab.health.warn") : t("lab.health.ok")}</b>
      <span>{t("lab.health.counts", { e: errors, w: warns })}{checking ? t("lab.health.running") : simFindings ? t("lab.health.simDone") : ""}</span>
    </div>
  );
}

export function Lab({ onBack }: { onBack: () => void }) {
  const { t, auto, lang, language } = useI18n();
  const say = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); return m === "server" ? t("common.serverDown") : m; };
  const [design, setDesign] = useState<Design>(() => readStored() ?? EXAMPLES[0]);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<Tab>("Overview");
  const [brief] = useState(takeBrief);
  // forget the hand-off once read (in an effect, so StrictMode's double initialiser still sees it)
  useEffect(() => {
    try { sessionStorage.removeItem(BRIEF_KEY); } catch { /* nothing to forget */ }
  }, []);
  const [idea, setIdea] = useState(brief?.idea ?? "");
  const [context, setContext] = useState(brief?.context ?? "");
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [interim, setInterim] = useState("");
  useEffect(() => {
    if (brief?.attachment_ids.length) fetchAttachments(brief.attachment_ids).then(setFiles);
  }, [brief]);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [simF, setSimF] = useState<Finding[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api<Status>("/api/lab/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  const analysis = useMemo(() => analyze(design, overrides), [design, overrides]);

  // re-run the simulation check whenever the design or its inputs change
  useEffect(() => {
    let live = true;
    setChecking(true);
    setSimF(null);
    const timer = window.setTimeout(() => {
      runHeadless(design, analysis)
        .then((r) => live && setSimF(r.findings))
        // kept in English: findings go back to the engineer as text; the page shows them translated
        .catch(() => live && setSimF([{ severity: "warning", where: "simulation", text: "the physics engine couldn't run this assembly" }]))
        .finally(() => live && setChecking(false));
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [design, analysis]);

  function load(d: Design) {
    setDesign(d);
    setOverrides({});
    store(d);
    setError("");
  }

  async function create() {
    setError("");
    setBusy(t("lab.designing"));
    try {
      // the engineer writes the design in the app's language; symbols, units and equations stay as they are
      const d = await api<Design>("/api/lab/design", { idea, context, attachment_ids: files.map((f) => f.id), language: lang });
      load(d);
      setTab("Overview");
    } catch (e) {
      setError(say(e));
    } finally {
      setBusy("");
    }
  }

  /** The self-correction loop: check, send the failures back, check the answer, until it holds. */
  async function rethink(auto: boolean) {
    setError("");
    let current = design;
    // carry edited inputs into the design so the agent reasons about the numbers the engineer chose
    if (Object.keys(overrides).length) {
      current = { ...current, variables: current.variables.map((v) => (v.symbol in overrides ? { ...v, value: overrides[v.symbol], source: `${v.source} (edited by engineer)` } : v)) };
    }
    try {
      for (let round = 0; round < (auto ? MAX_AUTO_ROUNDS : 1); round++) {
        const a = analyze(current);
        const s = await runHeadless(current, a);
        const findings = [...a.findings, ...s.findings].filter((f) => f.severity !== "info");
        const failing = findings.filter((f) => f.severity === "error").length;
        if (auto && failing === 0 && round > 0) break;
        setBusy(t("lab.round", { round: current.revisions.length + 1, fail: failing, warn: findings.length - failing }));
        current = await api<Design>("/api/lab/revise", {
          design: current, findings: findings.map((f) => `[${f.severity}] ${f.where}: ${f.text}`), note: round === 0 ? note : "", language: lang,
        });
        load(current);
        if (auto) {
          const again = analyze(current);
          const sim = await runHeadless(current, again);
          if (![...again.findings, ...sim.findings].some((f) => f.severity === "error")) break;
        }
      }
      setNote("");
      setTab("Reviews");
      api<Status>("/api/lab/status").then(setStatus).catch(() => undefined);
    } catch (e) {
      setError(say(e));
    } finally {
      setBusy("");
    }
  }

  const reqById = new Map(design.requirements.map((r) => [r.id, r]));
  const riskById = new Map(analysis.risks.map((r) => [r.id, r]));
  const allFindings = [...analysis.findings, ...(simF ?? [])];

  return (
    <main className="lab">
      <header className="lab-top">
        <button className="lab-btn ghost" onClick={onBack}>← {t("common.back")}</button>
        <div className="lab-brand"><span className="lab-mark" aria-hidden>◆</span> RepairMind X <i>/</i> <b>{t("lab.title")}</b></div>
        <span className={`lab-model ${status?.ready ? "on" : ""}`}>
          {status === null ? t("lab.offline") : status.ready ? t("lab.engineer", { model: status.model === "anthropic" ? "Claude" : "Gemini", n: status.lessons }) : t("lab.noModel")}
        </span>
        <LanguagePicker className="lab-lang" />
      </header>

      <div className="lab-grid">
        <aside className="lab-side">
          <section className="lab-card">
            <span className="lab-kicker">{t("lab.newIdea")}</span>
            <div className="lab-idea">
              <textarea value={interim ? `${idea}${idea && !idea.endsWith(" ") ? " " : ""}${interim}` : idea} onChange={(e) => setIdea(e.target.value)} rows={5}
                aria-label={t("lab.ideaAria")}
                placeholder={t("lab.ideaPh")} />
              <MicButton onInterim={setInterim} onText={(t) => setIdea((v) => (v ? `${v.trimEnd()} ${t}` : t).slice(0, 4000))} />
            </div>
            <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2}
              placeholder={t("lab.contextPh")} />
            <Attachments items={files} onChange={setFiles} canHearMedia={!!status?.media} />
            <button className="lab-btn solid" disabled={idea.trim().length < 8 || !!busy || !status?.ready} onClick={create}>{t("lab.designIt")}</button>
            {status && !status.ready && <p className="lab-muted">{t("lab.needKey")}</p>}
          </section>

          <section className="lab-card">
            <span className="lab-kicker">{t("lab.examples")}</span>
            {lang !== "en" && <p className="lab-muted">{t("lab.examplesNote", { name: language.name })}</p>}
            <div className="lab-examples">
              {EXAMPLES.map((d) => (
                <button key={d.title} className={`lab-chip${d.title === design.title && !design.revisions.length ? " on" : ""}`} onClick={() => load(d)}>{d.title}</button>
              ))}
            </div>
          </section>

          <section className="lab-card">
            <span className="lab-kicker">{t("lab.review")}</span>
            <p className="lab-muted">{t("lab.reviewP")}</p>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("lab.notePh")} />
            <div className="lab-row">
              <button className="lab-btn" disabled={!!busy || !status?.ready} onClick={() => rethink(false)}>{t("lab.rethinkOnce")}</button>
              <button className="lab-btn solid" disabled={!!busy || !status?.ready} onClick={() => rethink(true)}>{t("lab.rethinkAll")}</button>
            </div>
          </section>
        </aside>

        <div className="lab-main">
          {busy && <div className="lab-busy" role="status"><span className="lab-spin" aria-hidden />{busy}</div>}
          {error && <p className="lab-err" role="alert">{auto(error)}</p>}

          <div className="lab-title">
            <div>
              <span className="lab-kicker">TRL {design.trl} · {design.revisions.length ? t("lab.revision", { n: design.revisions.length }) : t("lab.firstPass")} · {t("lab.massListed", { kg: fmt(analysis.totalMassKg) })}</span>
              <h1>{design.title}</h1>
            </div>
            <Health findings={analysis.findings} simFindings={simF} checking={checking} />
          </div>

          <SimView design={design} analysis={analysis} />

          <nav className="lab-tabs" role="tablist">
            {TABS.map((x) => (
              <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
                {t(`lab.tab.${x}` as Key)}{x === "Reviews" && design.revisions.length ? ` (${design.revisions.length})` : ""}
              </button>
            ))}
          </nav>

          <section className="lab-panel" role="tabpanel">
            {tab === "Overview" && (
              <>
                <p className="lab-lede">{design.summary}</p>
                <dl className="lab-facts">
                  <div><dt>{t("lab.objective")}</dt><dd>{design.objective}</dd></div>
                  <div><dt>{t("lab.context")}</dt><dd>{design.operating_context}</dd></div>
                </dl>
                <h4>{t("lab.constraints")}</h4>
                <ul>{design.constraints.map((c) => <li key={c}>{c}</li>)}</ul>
                <h4>{t("lab.components")}</h4>
                <table className="lab-table">
                  <thead><tr><th>{t("lab.part")}</th><th>{t("lab.function")}</th><th>{t("lab.material")}</th><th className="num">{t("lab.mass")}</th></tr></thead>
                  <tbody>{design.components.map((c) => <tr key={c.name}><td>{c.name}{c.notes && <small>{c.notes}</small>}</td><td>{c.function}</td><td>{c.material}</td><td className="num">{fmt(c.mass_kg)} kg</td></tr>)}</tbody>
                </table>
                <h4>{t("lab.findings")}</h4>
                {allFindings.length ? (
                  <ul className="lab-findings">{allFindings.map((f, i) => <li key={i} className={f.severity}><b>{f.where}</b> {auto(f.text)}</li>)}</ul>
                ) : <p className="lab-muted">{t("lab.noFindings")}</p>}
                {(design.inputs_used?.length ?? 0) > 0 && (
                  <>
                    <h4>{t("lab.fromAttachments")}</h4>
                    <ul>{design.inputs_used!.map((a) => <li key={a}>{a}</li>)}</ul>
                  </>
                )}
                <h4>{t("lab.assumptions")}</h4>
                <ul>{design.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                <h4>{t("lab.openQuestions")}</h4>
                <ul>{design.open_questions.map((a) => <li key={a}>{a}</li>)}</ul>
                <h4>{t("lab.nextSteps")}</h4>
                <ol>{design.next_steps.map((a) => <li key={a}>{a}</li>)}</ol>
              </>
            )}

            {tab === "Requirements" && (
              <table className="lab-table">
                <thead><tr><th>ID</th><th>{t("lab.req")}</th><th>{t("lab.kind")}</th><th>{t("lab.verifiedBy")}</th><th>{t("lab.status")}</th></tr></thead>
                <tbody>
                  {design.requirements.map((r) => {
                    const eqs = analysis.equations.filter((e) => e.eq.requirement_id === r.id && e.pass !== null);
                    const st = eqs.length ? (eqs.every((e) => e.pass) ? "ok" : "bad") : "open";
                    return (
                      <tr key={r.id}>
                        <td className="mono">{r.id}</td>
                        <td>{r.text}<small>{r.rationale}</small></td>
                        <td>{r.kind}</td>
                        <td>{r.verification}{eqs.length ? <small>{eqs.map((e) => e.eq.id).join(", ")}</small> : null}</td>
                        <td><span className={`lab-pill ${st}`}>{st === "ok" ? t("lab.req.met") : st === "bad" ? t("lab.req.notMet") : r.verification === "analysis" ? t("lab.req.unchecked") : t("lab.req.needs", { what: r.verification })}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {tab === "Analysis" && (
              <>
                <p className="lab-muted">{t("lab.analysisP")}</p>
                <h4>{t("lab.inputs")}</h4>
                <div className="lab-inputs">
                  {design.variables.map((v) => (
                    <label key={v.symbol} className={v.symbol in overrides ? "edited" : ""}>
                      <span className="mono">{v.symbol}</span>
                      <input type="number" step="any" value={overrides[v.symbol] ?? v.value}
                        onChange={(e) => {
                          const n = e.target.valueAsNumber;
                          setOverrides((o) => {
                            const next = { ...o };
                            if (Number.isFinite(n) && n !== v.value) next[v.symbol] = n; else delete next[v.symbol];
                            return next;
                          });
                        }} />
                      <em>{v.unit}</em>
                      <small>{v.name} · {v.source}</small>
                    </label>
                  ))}
                </div>
                {Object.keys(overrides).length > 0 && <button className="lab-btn ghost" onClick={() => setOverrides({})}>{t("lab.resetInputs")}</button>}
                <h4>{t("lab.equations")}</h4>
                <div className="lab-eqs">
                  {analysis.equations.map((r) => (
                    <article key={r.eq.id} className={`lab-eq ${r.error ? "bad" : r.pass === false ? "bad" : r.pass ? "ok" : ""}`}>
                      <header>
                        <span className="mono">{r.eq.id}</span> <b>{r.eq.name}</b>
                        {r.eq.requirement_id && <span className="lab-tag" title={reqById.get(r.eq.requirement_id)?.text}>{r.eq.requirement_id}</span>}
                      </header>
                      <div className="lab-math">
                        <span className="mono">{r.eq.symbol} = {r.eq.expression}</span>
                        <span className="res">{r.value !== null ? <>= <b>{fmt(r.value)}</b> {r.eq.unit !== "1" ? r.eq.unit : ""}</> : "= ?"}</span>
                      </div>
                      {r.error && <p className="lab-err">{r.error}</p>}
                      {r.margin !== null && (
                        <p className={`lab-margin ${r.pass ? "ok" : "bad"}`}>
                          {r.eq.check.label}: {r.eq.check.kind === "max" ? "≤" : "≥"} {fmt(r.eq.check.limit)} {r.eq.check.limit_unit !== "1" ? r.eq.check.limit_unit : ""}, FS {r.eq.check.factor_of_safety} · {t("lab.marginOfSafety")} <b>{(r.margin * 100).toFixed(1)}%</b>
                        </p>
                      )}
                      <p>{r.eq.explanation}</p>
                      {r.eq.assumptions && <small>{t("lab.assumes", { what: r.eq.assumptions })}</small>}
                    </article>
                  ))}
                </div>
              </>
            )}

            {tab === "Trade study" && (
              <>
                <h4>{design.trade_study.question}</h4>
                <table className="lab-table">
                  <thead>
                    <tr><th>{t("lab.option")}</th>{design.trade_study.criteria.map((c) => <th key={c.name} className="num">{c.name}<small>{t("lab.weight", { w: c.weight })}</small></th>)}<th className="num">{t("lab.weighted")}</th></tr>
                  </thead>
                  <tbody>
                    {design.trade_study.options.map((o) => {
                      const tr = analysis.trade.find((x) => x.name === o.name);
                      return (
                        <tr key={o.name} className={tr?.rank === 1 ? "win" : ""}>
                          <td>{o.name}<small>{o.description}</small></td>
                          {design.trade_study.criteria.map((c, i) => <td key={c.name} className="num">{o.scores[i] ?? "–"}</td>)}
                          <td className="num"><b>{tr ? tr.total.toFixed(2) : "–"}</b>{tr?.rank === 1 && <span className="lab-pill ok">{t("lab.best")}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="lab-lede">{design.trade_study.recommendation}</p>
              </>
            )}

            {tab === "Risks" && (
              <table className="lab-table">
                <thead><tr><th>{t("lab.failureMode")}</th><th>{t("lab.causeEffect")}</th><th className="num">S</th><th className="num">O</th><th className="num">D</th><th className="num">RPN</th><th>{t("lab.mitigation")}</th></tr></thead>
                <tbody>
                  {design.risks.map((k) => {
                    const r = riskById.get(k.id);
                    return (
                      <tr key={k.id}>
                        <td><span className="mono">{k.id}</span> {k.failure_mode}</td>
                        <td>{k.cause} → {k.effect}</td>
                        <td className="num">{k.severity}</td><td className="num">{k.occurrence}</td><td className="num">{k.detection}</td>
                        <td className="num"><span className={`lab-pill ${r?.level === "high" ? "bad" : r?.level === "medium" ? "warn" : "ok"}`}>{r?.rpn}</span></td>
                        <td>{k.mitigation || <span className="lab-err">{t("lab.none")}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {tab === "Research" && (
              <div className="lab-research">
                {design.research.map((n) => (
                  <article key={n.topic}>
                    <h4>{n.topic}</h4>
                    <p>{n.explanation}</p>
                    {n.key_equations.length > 0 && <div className="lab-keyeq">{n.key_equations.map((e) => <code key={e}>{e}</code>)}</div>}
                    {n.further_reading.length > 0 && <p className="lab-muted">{t("lab.read", { what: n.further_reading.join(" · ") })}</p>}
                  </article>
                ))}
                <article>
                  <h4>{t("lab.eqsInDesign")}</h4>
                  {analysis.equations.map((r) => <p key={r.eq.id}><b>{r.eq.name}.</b> {r.eq.explanation}</p>)}
                </article>
              </div>
            )}

            {tab === "Reviews" && (
              design.revisions.length ? (
                <ol className="lab-reviews">
                  {design.revisions.map((r) => (
                    <li key={r.round}>
                      <h4>{t("lab.roundN", { n: r.round })}</h4>
                      <p>{r.critique}</p>
                      <ul>{r.changes.map((c) => <li key={c}>{c}</li>)}</ul>
                      {r.lessons.length > 0 && <p className="lab-lesson">{t("lab.lessonsKept", { what: r.lessons.join(" ") })}</p>}
                    </li>
                  ))}
                </ol>
              ) : <p className="lab-muted">{t("lab.noReviews")}</p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
