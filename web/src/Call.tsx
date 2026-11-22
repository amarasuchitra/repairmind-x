import { useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useConnectionState,
  useLocalParticipant,
  useTextStream,
  useTracks,
  useTranscriptions,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, LocalVideoTrack, Track } from "livekit-client";
import {
  Alert,
  Marker,
  SessionView,
  TOPIC_ALERT,
  TOPIC_MARKER,
  TOPIC_STATE,
} from "./types";

interface Props {
  serverUrl: string;
  token: string;
  room: string;
  onEnd: (finished: boolean) => void;
}

export function Call({ serverUrl, token, room, onEnd }: Props) {
  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect
      audio
      video={{ facingMode: "environment", resolution: { width: 1280, height: 720 } }}
      onDisconnected={() => onEnd(false)}
      className="call"
    >
      <CallView room={room} onEnd={onEnd} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function lastJson<T>(streams: { text: string }[]): T | null {
  for (let i = streams.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(streams[i].text) as T;
    } catch {
      /* partial stream; try the previous one */
    }
  }
  return null;
}

function CallView({ room, onEnd }: { room: string; onEnd: (finished: boolean) => void }) {
  const connection = useConnectionState();
  const { state: agentState, agent } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const camTracks = useTracks([Track.Source.Camera]).filter((t) => t.participant.isLocal);
  const camRef = useRef<HTMLDivElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  const { textStreams: stateStreams } = useTextStream(TOPIC_STATE);
  const { textStreams: markerStreams } = useTextStream(TOPIC_MARKER);
  const { textStreams: alertStreams } = useTextStream(TOPIC_ALERT);
  const view = useMemo(() => lastJson<SessionView>(stateStreams), [stateStreams]);
  const marker = useMemo(() => lastJson<Marker>(markerStreams), [markerStreams]);
  const alert = useMemo(() => lastJson<Alert>(alertStreams), [alertStreams]);

  const transcripts = useTranscriptions();
  const captions = transcripts.slice(-3).map((t) => ({
    who: t.participantInfo.identity === localParticipant.identity ? "You" : "Mechanic",
    text: t.text,
  }));

  // Freeze the current camera frame when the mechanic points at something.
  const [frozen, setFrozen] = useState<{ src: string; marker: Marker } | null>(null);
  useEffect(() => {
    if (!marker) return;
    if (marker.image) {
      setFrozen({ src: marker.image, marker });
      return;
    }
    const video = camRef.current?.querySelector("video");
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    setFrozen({ src: canvas.toDataURL("image/jpeg", 0.85), marker });
  }, [markerStreams.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dismissedAlert, setDismissedAlert] = useState(0);
  const showAlert = alert && alertStreams.length > dismissedAlert;

  async function switchCamera() {
    const next = facing === "environment" ? "user" : "environment";
    const pub = localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.videoTrack as LocalVideoTrack | undefined;
    await track?.restartTrack({ facingMode: next });
    setFacing(next);
  }

  const status =
    connection !== ConnectionState.Connected
      ? "Connecting…"
      : !agent
        ? "Waiting for the mechanic…"
        : ({ listening: "Listening", thinking: "Thinking", speaking: "Speaking" } as Record<string, string>)[
            agentState
          ] ?? "Connected";

  return (
    <div className="call-grid">
      <header className="call-top">
        <div className="brand small">
          <div className="logo" aria-hidden>RM</div>
          <span>Live repair</span>
        </div>
        <span className={`pill state-${agentState}`}>{status}</span>
      </header>

      <section className="camera" ref={camRef}>
        {camTracks[0] ? (
          <VideoTrack trackRef={camTracks[0]} className={facing === "user" ? "mirror" : ""} />
        ) : (
          <div className="placeholder">Allow camera access to show the mechanic your device.</div>
        )}
        {view && view.risk_level !== "green" && (
          <div className={`risk-banner risk-${view.risk_level}`}>
            {view.risk_level === "red" ? "Professional repair only" : "Safety precautions required"}
          </div>
        )}
        <div className="captions" aria-live="polite">
          {captions.map((c, i) => (
            <p key={i} className={c.who === "You" ? "me" : "ai"}>
              <b>{c.who}:</b> {c.text}
            </p>
          ))}
        </div>
      </section>

      {frozen && (
        <section className="frozen" aria-label="The mechanic is pointing at this">
          <div className="frozen-img">
            <img src={frozen.src} alt="Still frame from your camera" />
            <MarkerOverlay m={frozen.marker} />
          </div>
          <div className="frozen-bar">
            <span>
              Look here: {frozen.marker.label}
              {frozen.marker.precise === false && <em className="approx"> (approximate)</em>}
            </span>
            <button className="ghost" onClick={() => setFrozen(null)}>Back to live</button>
          </div>
        </section>
      )}

      <aside className="panel">
        <RepairPanel view={view} />
        <ManualUpload room={room} />
      </aside>

      <footer className="controls">
        <button
          className={isMicrophoneEnabled ? "ctl" : "ctl off"}
          onClick={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
        >
          {isMicrophoneEnabled ? "Mute" : "Unmute"}
        </button>
        <button className="ctl" onClick={switchCamera}>Switch camera</button>
        <button className="ctl danger" onClick={() => onEnd(Boolean(view?.steps.length && view.steps.every((s) => s.status === "done")))}>
          End call
        </button>
      </footer>

      {showAlert && alert && (
        <div className="modal" role="alertdialog" aria-modal>
          <div className={`modal-card ${alert.kind === "hazard_stop" ? "hazard" : "red"}`}>
            <h2>{alert.kind === "hazard_stop" ? "Stop now" : "This needs a professional"}</h2>
            <p>{alert.message}</p>
            <button className="primary" onClick={() => setDismissedAlert(alertStreams.length)}>I understand</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MarkerOverlay({ m }: { m: Marker }) {
  const hasBox = m.w > 0.01 && m.h > 0.01;
  return (
    <svg className="marker" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {hasBox ? (
        <rect x={(m.x - m.w / 2) * 100} y={(m.y - m.h / 2) * 100} width={m.w * 100} height={m.h * 100}
              rx="1.5" className="mk-box" />
      ) : (
        <circle cx={m.x * 100} cy={m.y * 100} r="5" className="mk-box" />
      )}
      <line x1={Math.min(95, m.x * 100 + 18)} y1={Math.max(5, m.y * 100 - 18)} x2={m.x * 100 + 4}
            y2={m.y * 100 - 4} className="mk-arrow" />
    </svg>
  );
}

const STATUS_ICON: Record<string, string> = {
  pending: "○",
  awaiting_confirmation: "!",
  active: "▶",
  done: "✓",
  failed: "✕",
  blocked: "■",
};

function RepairPanel({ view }: { view: SessionView | null }) {
  if (!view) {
    return (
      <div className="panel-empty">
        <h2>Repair</h2>
        <p>The mechanic will fill this in as it identifies the device and diagnoses the problem.</p>
      </div>
    );
  }
  return (
    <div className="panel-body">
      <div className="kv">
        <span>Device</span>
        <b>{view.device || "Not identified yet"}</b>
        {view.device && !view.model_confirmed && <em>Model not confirmed: show the label</em>}
      </div>

      {view.diagnosis ? (
        <div className="kv">
          <span>Diagnosis</span>
          <b>{view.diagnosis}</b>
          <Confidence value={view.confidence} />
        </div>
      ) : view.hypotheses.length > 0 ? (
        <div className="kv">
          <span>Possible causes</span>
          <ul className="hyp">
            {view.hypotheses.map((h) => (
              <li key={h.cause}>{h.cause} <Confidence value={h.confidence} /></li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.precautions.length > 0 && (
        <div className="kv">
          <span>Safety first</span>
          <ul className="checklist">
            {view.precautions.map((p) => (
              <li key={p.id} className={p.done ? "done" : ""}>{p.done ? "✓" : "○"} {p.text}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="kv">
        <span>Steps</span>
        {view.steps.length === 0 ? (
          <em>No steps yet. Diagnosis comes first.</em>
        ) : (
          <ol className="steps">
            {view.steps.map((s) => (
              <li key={s.id} className={`st-${s.status}`}>
                <span className="ico">{STATUS_ICON[s.status]}</span>
                <div>
                  <p>{s.text}</p>
                  {s.irreversible.length > 0 && <p className="warn">Can't be undone: {s.irreversible.join(", ")}</p>}
                  {s.source && <p className="src">Source: {s.source}</p>}
                  {s.cross_checked && <p className="checked">Double-checked by a second AI</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {view.escalated && <p className="note">Handed to a human expert with the full repair history.</p>}
    </div>
  );
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const cls = pct >= 85 ? "hi" : pct >= 75 ? "mid" : "lo";
  return <span className={`conf conf-${cls}`}>{pct}% sure</span>;
}

function ManualUpload({ room }: { room: string }) {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setStatus(null);
    const form = new FormData();
    form.append("room", room);
    form.append("file", file);
    try {
      const res = await fetch("/api/manual", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail ?? `Upload failed (${res.status})`);
      setStatus(`Added "${body.title}" (${body.pages} pages). The mechanic will cite it.`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual">
      <label className={`secondary file-btn ${busy ? "busy" : ""}`}>
        {busy ? "Reading manual…" : "Add manual (PDF)"}
        <input
          type="file"
          accept="application/pdf"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
            e.target.value = "";
          }}
        />
      </label>
      {status && <p className="manual-status">{status}</p>}
    </div>
  );
}
