import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoTrack,
  useConnectionState,
  useLocalParticipant,
  useMultibandTrackVolume,
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
  Step3D,
  TOPIC_3D,
  TOPIC_AR,
  TOPIC_ALERT,
  TOPIC_MARKER,
  TOPIC_STATE,
} from "./types";

import { ARLayer } from "./ar/ARLayer";
import { CallHud } from "./hud/CallHud";
import { useI18n } from "./i18n";
import type { OrbState } from "./hud/VoiceOrb";

// three.js is large, so the 3D viewer loads only when an expert procedure step arrives.
const Viewer3D = lazy(() => import("./Viewer3D").then((m) => ({ default: m.Viewer3D })));

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
  const { t } = useI18n();
  const connection = useConnectionState();
  const { state: agentState, agent, audioTrack } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const camTracks = useTracks([Track.Source.Camera]).filter((t) => t.participant.isLocal);
  const camRef = useRef<HTMLElement | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

  const { textStreams: stateStreams } = useTextStream(TOPIC_STATE);
  const { textStreams: markerStreams } = useTextStream(TOPIC_MARKER);
  const { textStreams: alertStreams } = useTextStream(TOPIC_ALERT);
  const { textStreams: step3dStreams } = useTextStream(TOPIC_3D);
  const step3d = useMemo(() => lastJson<Step3D>(step3dStreams), [step3dStreams]);
  const view = useMemo(() => lastJson<SessionView>(stateStreams), [stateStreams]);
  const marker = useMemo(() => lastJson<Marker>(markerStreams), [markerStreams]);
  const alert = useMemo(() => lastJson<Alert>(alertStreams), [alertStreams]);

  const transcripts = useTranscriptions();
  const captions = transcripts.slice(-3).map((t) => ({
    who: (t.participantInfo.identity === localParticipant.identity ? "You" : "Mechanic") as "You" | "Mechanic",
    text: t.text,
  }));

  // When the mechanic points at something, the live AR layer tracks it on the moving video. If it
  // can't (approximate marker, part not found again), we freeze that frame and draw on the still.
  const [frozen, setFrozen] = useState<{ src: string; marker: Marker } | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const activeMarker = marker && !marker.clear ? marker : null;
  function freeze(m: Marker) {
    if (m.image) {
      setFrozen({ src: m.image, marker: m });
      return;
    }
    const video = camRef.current?.querySelector("video");
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    setFrozen({ src: canvas.toDataURL("image/jpeg", 0.85), marker: m });
  }
  useEffect(() => {
    setFrozen(null); // a new marker replaces any still from the last one
  }, [markerStreams.length]);
  // Motion arrows belong to one step: drop them once that step isn't active any more.
  const markerStepActive =
    !activeMarker?.step_id || Boolean(view?.steps.some((s) => s.id === activeMarker.step_id && s.status === "active"));
  const arMarker = activeMarker && (markerStepActive ? activeMarker : { ...activeMarker, action: "" as const });

  const [dismissedAlert, setDismissedAlert] = useState(0);
  const showAlert = alert && alertStreams.length > dismissedAlert;
  const arSuppressed = Boolean(view?.hazard) || Boolean(showAlert);

  async function switchCamera() {
    const next = facing === "environment" ? "user" : "environment";
    const pub = localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.videoTrack as LocalVideoTrack | undefined;
    await track?.restartTrack({ facingMode: next });
    setFacing(next);
  }

  const status =
    connection !== ConnectionState.Connected
      ? t("call.connecting")
      : !agent
        ? t("call.waiting")
        : ({ listening: t("call.listening"), thinking: t("call.thinking"), speaking: t("call.speaking") } as Record<string, string>)[
            agentState
          ] ?? t("call.online");
  const orbState: OrbState =
    connection !== ConnectionState.Connected || !agent
      ? "connecting"
      : (["listening", "thinking", "speaking"] as const).find((s) => s === agentState) ?? "idle";

  // The orb follows the mechanic's voice while it speaks, and your mic while it listens.
  const micRef = useTracks([Track.Source.Microphone]).find((t) => t.participant.isLocal);
  const agentBands = useMultibandTrackVolume(audioTrack, { bands: 12, loPass: 2, hiPass: 120 });
  const micBands = useMultibandTrackVolume(micRef, { bands: 12, loPass: 2, hiPass: 120 });
  const bands = orbState === "speaking" ? agentBands : orbState === "listening" ? micBands : [];

  return (
    <CallHud
      status={status}
      orbState={orbState}
      bands={bands}
      view={view}
      captions={captions}
      hostRef={(el) => {
        camRef.current = el;
        setHost(el);
      }}
      camera={
        camTracks[0] ? (
          <VideoTrack trackRef={camTracks[0]} className={facing === "user" ? "mirror" : ""} />
        ) : (
          <div className="placeholder">{t("call.allowCamera")}</div>
        )
      }
      overlay={
        <ARLayer
          host={host}
          marker={arMarker}
          mirrored={facing === "user"}
          suppressed={arSuppressed}
          onFallback={freeze}
          onLost={(m) => {
            localParticipant
              .sendText(JSON.stringify({ event: "lost", id: m.id ?? 0 }), { topic: TOPIC_AR })
              .catch(() => undefined);
          }}
          onShowStill={() => activeMarker && freeze(activeMarker)}
        />
      }
      side={
        step3d && (
          <Suspense fallback={<div className="viewer3d-msg">{t("call.loading3d")}</div>}>
            <Viewer3D step={step3d} />
          </Suspense>
        )
      }
      tools={<ManualUpload room={room} />}
      frozen={frozen}
      onCloseFrozen={() => setFrozen(null)}
      micOn={isMicrophoneEnabled}
      onToggleMic={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
      onSwitchCamera={switchCamera}
      onEnd={() => onEnd(Boolean(view?.steps.length && view.steps.every((s) => s.status === "done")))}
      alert={showAlert && alert ? alert : null}
      onDismissAlert={() => setDismissedAlert(alertStreams.length)}
    />
  );
}

function ManualUpload({ room }: { room: string }) {
  const { t } = useI18n();
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
      if (!res.ok) throw new Error(body.detail ?? t("call.manual.failed", { n: res.status }));
      setStatus(t("call.manual.added", { title: body.title, pages: body.pages }));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="manual">
      <label className={`secondary file-btn ${busy ? "busy" : ""}`}>
        {busy ? t("call.manual.reading") : t("call.manual.add")}
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
