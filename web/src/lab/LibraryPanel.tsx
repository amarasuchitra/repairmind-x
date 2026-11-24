import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";

interface Doc { id: string; title: string; file: string; pages: number }
interface Hit { ref: string; title: string; source: string; kind: "core" | "yours" }

/**
 * The engineering library the engineer looks things up in: built-in handbook entries plus the user's own
 * datasheets and handbooks. Shows what would be looked up for the idea as it is typed.
 */
export function LibraryPanel({ query }: { query: string }) {
  const { t } = useI18n();
  const [core, setCore] = useState<number | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);

  const refresh = () => fetch("/api/library").then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j) { setCore(j.core); setDocs(j.yours ?? []); }
  }).catch(() => undefined);
  useEffect(() => { void refresh(); }, []);

  // what the engineer would look up for this idea (only while the panel is open)
  useEffect(() => {
    if (!open || query.trim().length < 8) { setHits([]); return; }
    const id = window.setTimeout(() => {
      fetch(`/api/library/search?k=6&q=${encodeURIComponent(query.slice(0, 1000))}`).then((r) => (r.ok ? r.json() : [])).then(setHits).catch(() => setHits([]));
    }, 400);
    return () => window.clearTimeout(id);
  }, [query, open]);

  async function add(files: File[]) {
    setMsg("");
    setBusy(true);
    for (const f of files) {
      const body = new FormData();
      body.append("file", f);
      body.append("title", f.name.replace(/\.[^.]+$/, ""));
      const r = await fetch("/api/library/docs", { method: "POST", body }).catch(() => null);
      if (!r || !r.ok) {
        const d = r ? (await r.json().catch(() => ({}))).detail : "";
        setMsg(typeof d === "string" && d ? `${f.name}: ${d}` : t("lib.addFail", { name: f.name }));
      }
    }
    setBusy(false);
    void refresh();
  }

  if (core === null) return null;
  return (
    <details className="lab-fold lib" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{t("lib.title", { core, yours: docs.length })}</summary>
      <p className="lab-muted">{t("lib.what")}</p>
      {hits.length > 0 && (
        <>
          <p className="lib-h">{t("lib.forIdea")}</p>
          <ul className="lib-hits">{hits.map((h) => <li key={h.ref}><span className={`tf-src ${h.kind === "yours" ? "you_said" : "typical"}`}>{h.ref}</span> {h.title} <small className="lab-muted">{h.source}</small></li>)}</ul>
        </>
      )}
      {docs.length > 0 && (
        <>
          <p className="lib-h">{t("lib.yours")}</p>
          <ul className="lib-hits">
            {docs.map((d) => (
              <li key={d.id}>{d.title} <small className="lab-muted">{t("lib.pages", { n: d.pages })}</small>{" "}
                <button className="tf-link" onClick={() => fetch(`/api/library/docs/${d.id}`, { method: "DELETE" }).then(refresh)}>{t("lib.remove")}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button className="lab-btn" disabled={busy} onClick={() => fileIn.current?.click()}>{busy ? t("lib.adding") : t("lib.add")}</button>
      <input ref={fileIn} type="file" hidden multiple accept=".pdf,.txt,.md,application/pdf,text/plain"
        onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      {msg && <p className="lab-err">{msg}</p>}
    </details>
  );
}
