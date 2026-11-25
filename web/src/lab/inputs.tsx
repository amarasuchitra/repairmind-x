/**
 * Ways to describe an idea besides typing: voice dictation and attachments of any kind.
 * Used by the design lab and the "Redesign a broken part" page.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useI18n } from "../i18n";

export interface AttachmentInfo {
  id: string;
  name: string;
  kind: "image" | "document" | "spreadsheet" | "cad" | "audio" | "video" | "text" | "other";
  size: number;
  summary: string;
  facts: string[];
  warning: string;
  thumb: string;
  excerpt: string;
}

const KIND_LABEL: Record<AttachmentInfo["kind"], string> = {
  image: "IMG", document: "DOC", spreadsheet: "XLS", cad: "CAD", audio: "AUD", video: "VID", text: "TXT", other: "FILE",
};

async function errorOf(res: Response): Promise<string> {
  const detail = (await res.json().catch(() => ({}))).detail;
  return typeof detail === "string" ? detail : res.status >= 500 ? "Can't reach the RepairMind server." : `Error ${res.status}`;
}

export async function uploadFiles(files: File[]): Promise<AttachmentInfo[]> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f, f.name));
  const res = await fetch("/api/lab/attachments", { method: "POST", body: form });
  if (!res.ok) throw new Error(await errorOf(res));
  return res.json();
}

export async function fetchAttachments(ids: string[]): Promise<AttachmentInfo[]> {
  const out = await Promise.all(ids.map((id) => fetch(`/api/lab/attachments/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  return out.filter(Boolean) as AttachmentInfo[];
}

/** Still frames from a video, captured in the browser so any model can look at them. */
export async function videoFrames(file: File, count = 4, maxSide = 1280): Promise<File[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const wait = (ev: string) => new Promise<void>((ok, fail) => {
    const t = window.setTimeout(() => fail(new Error("timeout")), 8000);
    video.addEventListener(ev, () => { window.clearTimeout(t); ok(); }, { once: true });
    video.addEventListener("error", () => { window.clearTimeout(t); fail(new Error("decode")); }, { once: true });
  });
  try {
    await wait("loadedmetadata");
    const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth || 1, video.videoHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((video.videoWidth || 640) * scale);
    canvas.height = Math.round((video.videoHeight || 360) * scale);
    const ctx = canvas.getContext("2d")!;
    const base = file.name.replace(/\.[^.]+$/, "");
    const frames: File[] = [];
    for (let i = 0; i < count; i++) {
      video.currentTime = Math.min(d - 0.05, (d * (i + 0.5)) / count);
      await wait("seeked");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
      if (blob) frames.push(new File([blob], `${base} frame ${i + 1} at ${video.currentTime.toFixed(1)}s.jpg`, { type: "image/jpeg" }));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const MEDIA_LIMIT = 19 * 1024 * 1024;

/**
 * Drop zone, file picker, camera and paste. Every file is read by the server straight away, so the person
 * sees what the engineer will get from it before designing.
 */
export function Attachments({ items, onChange, canHearMedia, compact }: {
  items: AttachmentInfo[];
  onChange: (next: AttachmentInfo[]) => void;
  /** true when the server can transcribe audio and describe video (Gemini key set) */
  canHearMedia: boolean;
  compact?: boolean;
}) {
  const { t, auto } = useI18n();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const cam = useRef<HTMLInputElement>(null);
  const latest = useRef(items);
  latest.current = items;

  async function add(files: File[]) {
    if (!files.length) return;
    setError("");
    const room = 20 - latest.current.length;
    if (room <= 0) { setError(t("in.max")); return; }
    const toSend: File[] = [];
    const notes: string[] = [];
    for (const f of files.slice(0, room)) {
      const isVideo = f.type.startsWith("video/") || /\.(mp4|mov|m4v|avi|mkv)$/i.test(f.name);
      if (isVideo) {
        setBusy(t("in.frames", { name: f.name }));
        try {
          toSend.push(...(await videoFrames(f)));
        } catch {
          notes.push(t("in.noFrames", { name: f.name }));
        }
        if (canHearMedia && f.size <= MEDIA_LIMIT) toSend.push(f); // speech and motion too
        else if (!canHearMedia) notes.push(t("in.noSound", { name: f.name }));
      } else {
        toSend.push(f);
      }
    }
    if (files.length > room) notes.push(t("in.firstOnly", { n: room }));
    if (!toSend.length) { setBusy(""); setError(notes.join(" ")); return; }
    setBusy(t("in.reading", { n: toSend.length }));
    try {
      const got = await uploadFiles(toSend.slice(0, room));
      onChange([...latest.current, ...got]);
      if (notes.length) setError(notes.join(" "));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }

  function remove(id: string) {
    onChange(latest.current.filter((a) => a.id !== id));
    fetch(`/api/lab/attachments/${id}`, { method: "DELETE" }).catch(() => undefined);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void add(Array.from(e.dataTransfer.files));
  }

  return (
    <div className={`lab-att${compact ? " compact" : ""}`}>
      <div
        className={`lab-drop${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) { e.preventDefault(); void add(files); }
        }}
        tabIndex={0}
        aria-label={t("in.dropAria")}
      >
        <span className="lab-drop-t">{t("in.drop")}</span>
        <div className="lab-row">
          <button type="button" className="lab-btn" onClick={() => pick.current?.click()} disabled={!!busy}>{t("in.addFiles")}</button>
          <button type="button" className="lab-btn" onClick={() => cam.current?.click()} disabled={!!busy}>{t("in.photo")}</button>
        </div>
        <input ref={pick} type="file" multiple hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <input ref={cam} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      </div>
      {busy && <p className="lab-muted" role="status"><span className="lab-spin" aria-hidden /> {busy}</p>}
      {error && <p className="lab-warn-t" role="alert">{auto(error)}</p>}
      {items.length > 0 && (
        <ul className="lab-att-list">
          {items.map((a, i) => (
            <li key={a.id} className={a.warning ? "warn" : ""}>
              {a.thumb ? <img src={a.thumb} alt="" /> : <span className={`lab-att-k k-${a.kind}`}>{KIND_LABEL[a.kind]}</span>}
              <div className="lab-att-b">
                <b title={a.name}><span className="mono">A{i + 1}</span> {a.name}</b>
                <small>{auto(a.summary)}</small>
                {a.warning && <small className="lab-warn-t">{auto(a.warning)}</small>}
                {(a.facts.length > 0 || a.excerpt) && (
                  <button type="button" className="lab-link" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                    {open === a.id ? "Hide what was read" : "Show what was read"}
                  </button>
                )}
                {open === a.id && (
                  <div className="lab-att-more">
                    {a.facts.length > 0 && <ul>{a.facts.map((f) => <li key={f}>{f}</li>)}</ul>}
                    {a.excerpt && <pre>{a.excerpt}{a.excerpt.length >= 600 ? "…" : ""}</pre>}
                  </div>
                )}
              </div>
              <button type="button" className="lab-x" onClick={() => remove(a.id)} aria-label={t("in.remove", { name: a.name })}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- voice -----------------------------------------------------------------------------------------

export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Mic button. Uses the browser's own live dictation where there is one (Chrome, Edge, Safari); otherwise it
 * records and the server transcribes (needs GOOGLE_API_KEY). Final text is handed to `onText`.
 */
export function MicButton({ onText, onInterim, label }: { onText: (t: string) => void; onInterim?: (t: string) => void; label?: string }) {
  const { t, auto, speech, language } = useI18n();
  const [state, setState] = useState<"idle" | "listening" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");
  const rec = useRef<Recognition | null>(null);
  const media = useRef<MediaRecorder | null>(null);
  const live = recognitionCtor() !== null;
  // the recogniser lives across renders; always call the latest handlers
  const cb = useRef({ onText, onInterim });
  cb.current = { onText, onInterim };

  useEffect(() => () => { rec.current?.stop(); media.current?.stop(); }, []);

  function startLive() {
    const Ctor = recognitionCtor()!;
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = speech; // dictate in the language picked for the app
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) cb.current.onText(res[0].transcript.trim());
        else interim += res[0].transcript;
      }
      cb.current.onInterim?.(interim);
    };
    r.onerror = (e) => {
      setError(e.error === "not-allowed" ? t("in.micBlocked") : e.error === "no-speech" ? "" : t("in.dictStopped", { why: e.error }));
    };
    r.onend = () => { setState("idle"); cb.current.onInterim?.(""); };
    rec.current = r;
    r.start();
    setState("listening");
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const m = new MediaRecorder(stream);
      m.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      m.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("transcribing");
        const blob = new Blob(chunks, { type: m.mimeType || "audio/webm" });
        const ext = (m.mimeType || "audio/webm").includes("mp4") ? "m4a" : "webm";
        const form = new FormData();
        form.append("file", blob, `voice note.${ext}`);
        form.append("language", speech);
        try {
          const res = await fetch("/api/lab/transcribe", { method: "POST", body: form });
          if (!res.ok) throw new Error(await errorOf(res));
          const { text } = await res.json();
          if (text) cb.current.onText(text);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setState("idle");
        }
      };
      media.current = m;
      m.start();
      setState("recording");
    } catch {
      setError(t("in.micMissing"));
    }
  }

  function toggle() {
    setError("");
    if (state === "listening") rec.current?.stop();
    else if (state === "recording") media.current?.stop();
    else if (state === "idle") (live ? startLive() : void startRecording());
  }

  const on = state === "listening" || state === "recording";
  return (
    <span className="lab-mic-wrap">
      <button type="button" className={`lab-mic${on ? " on" : ""}`} onClick={toggle} disabled={state === "transcribing"}
        aria-pressed={on} title={live ? t("in.dictTitle", { name: language.name }) : t("in.recTitle", { name: language.name })}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" /></svg>
        {state === "listening" ? t("in.listening") : state === "recording" ? t("in.recording") : state === "transcribing" ? t("in.transcribing") : label ?? t("in.speak")}
      </button>
      {error && <small className="lab-warn-t" role="alert">{auto(error)}</small>}
    </span>
  );
}
