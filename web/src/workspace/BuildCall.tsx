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
import { ConnectionState, Track } from "livekit-client";
import { ARLayer } from "../ar/ARLayer";
import { useI18n } from "../i18n";
import { TOPIC_MARKER, type Marker } from "../types";
import { TOPIC_APP, TOPIC_BRIEF, TOPIC_BUILD, readAction, type AppAction, type Brief, type BuildView } from "./coach.ts";

/**
 * The live build call, in the camera card: the person builds with their hands while the coach circles where each
 * wire goes on the live camera, checks it, and runs the screen and the board on request.
 */
export function BuildCall({ serverUrl, token, brief, big, onBig, onAction, onEnd }: {
  serverUrl: string; token: string; brief: Brief; big: boolean;
  onBig: () => void; onAction: (a: AppAction) => void; onEnd: (problem?: string) => void;
}) {
  return (
    <LiveKitRoom serverUrl={serverUrl} token={token} connect audio
      video={{ facingMode: "environment", resolution: { width: 1280, height: 720 } }}
      onDisconnected={() => onEnd()} onError={(e) => onEnd(e.message)} className={`bc${big ? " big" : ""}`}>
      <Inner brief={brief} big={big} onBig={onBig} onAction={onAction} onEnd={() => onEnd()} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function last<T>(streams: { text: string }[], read: (s: string) => T | null): T | null {
  for (let i = streams.length - 1; i >= 0; i--) {
    const v = read(streams[i].text);
    if (v) return v;
  }
  return null;
}
const json = <T,>(s: string): T | null => { try { return JSON.parse(s) as T; } catch { return null; } };

function Inner({ brief, big, onBig, onAction, onEnd }: {
  brief: Brief; big: boolean; onBig: () => void; onAction: (a: AppAction) => void; onEnd: () => void;
}) {
  const { t } = useI18n();
  const connection = useConnectionState();
  const { state, agent } = useVoiceAssistant();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const cam = useTracks([Track.Source.Camera]).filter((x) => x.participant.isLocal)[0];
  const [host, setHost] = useState<HTMLElement | null>(null);

  // the coach needs the project as soon as it joins (and again if it rejoins)
  const sentTo = useRef("");
  useEffect(() => {
    const id = agent?.identity;
    if (!id || sentTo.current === id) return;
    sentTo.current = id;
    localParticipant.sendText(JSON.stringify(brief), { topic: TOPIC_BRIEF }).catch(() => { sentTo.current = ""; });
  }, [agent?.identity, brief, localParticipant]);

  const { textStreams: buildS } = useTextStream(TOPIC_BUILD);
  const { textStreams: markerS } = useTextStream(TOPIC_MARKER);
  const { textStreams: appS } = useTextStream(TOPIC_APP);
  const view = useMemo(() => last(buildS, (s) => json<BuildView>(s)), [buildS]);
  const marker = useMemo(() => last(markerS, (s) => json<Marker>(s)), [markerS]);
  const [still, setStill] = useState<Marker | null>(null);
  useEffect(() => setStill(null), [markerS.length]);

  // each action from the coach runs once
  const ran = useRef(0);
  useEffect(() => {
    for (; ran.current < appS.length; ran.current++) {
      const a = readAction(appS[ran.current].text);
      if (a) onAction(a);
    }
  }, [appS, onAction]);

  const said = useTranscriptions().filter((x) => x.participantInfo.identity !== localParticipant.identity).slice(-1)[0]?.text ?? "";
  const total = view?.total ?? brief.wires.length;
  const done = view?.done.length ?? 0;
  const wire = brief.wires.find((w) => w.n === (view?.current || brief.wires.find((x) => !view?.done.includes(x.n))?.n));
  const status = connection !== ConnectionState.Connected ? t("bc.connecting") : !agent ? t("bc.waiting")
    : view?.busy === "upload" ? t("bc.uploading") : view?.busy === "serial" ? t("bc.listening")
    : ({ listening: t("call.listening"), thinking: t("call.thinking"), speaking: t("call.speaking") } as Record<string, string>)[state] ?? t("call.online");

  return (
    <section className="ws-card ws-camcard bc-card" aria-label={t("bc.title")}>
      <div className="ws-card-head">
        <span className="ws-card-title"><i className="bc-live" aria-hidden />{t("bc.title")}</span>
        <span className="ws-pill">{status}</span>
        <span className="ws-grow" />
        <button className="ws-icon" onClick={onBig} aria-label={big ? t("ws.shrink") : t("ws.expand")} title={big ? t("ws.shrink") : t("ws.expand")}>
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d={big ? "M10 4v6H4M14 20v-6h6M4 10l6-6M20 14l-6 6" : "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"} />
          </svg>
        </button>
      </div>
      <div className="bc-view" ref={setHost}>
        {cam ? <VideoTrack trackRef={cam} /> : <div className="bc-wait">{t("bc.camera")}</div>}
        <ARLayer host={host} marker={marker && !marker.clear ? marker : null} mirrored={false} suppressed={false}
          onFallback={(m) => setStill(m)} onLost={() => undefined} onShowStill={() => marker && setStill(marker)} />
        {still?.image && (
          <button className="bc-still" onClick={() => setStill(null)} aria-label={t("bc.closeStill")}>
            <img src={still.image} alt="" />
            <span className="bc-ring" style={{ left: `${still.x * 100}%`, top: `${still.y * 100}%`, width: `${Math.max(0.08, still.w) * 100}%`, height: `${Math.max(0.08, still.h) * 100}%` }} />
            <b className="bc-ring-label" style={{ left: `${still.x * 100}%`, top: `${(still.y + Math.max(0.08, still.h) / 2) * 100}%` }}>{still.label}</b>
          </button>
        )}
        {wire && (
          <div className="bc-wire" aria-live="polite">
            <span className="bc-dot" style={{ background: wire.colour }} aria-hidden />
            <span><b>{t("bc.wire", { n: wire.n, total })}</b> {wire.text}</span>
          </div>
        )}
      </div>
      <div className="bc-progress" aria-label={t("bc.progress", { done, total })}>
        {brief.wires.map((w) => (
          <i key={w.n} className={view?.checked.includes(w.n) ? "seen" : view?.done.includes(w.n) ? "done" : w.n === wire?.n ? "now" : ""} title={w.text} />
        ))}
      </div>
      {said && <p className="bc-said">{said}</p>}
      {view?.log && <pre className="bc-log">{view.log}</pre>}
      <div className="bc-actions">
        <button className={`lab-btn ${isMicrophoneEnabled ? "" : "solid"}`} onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}>
          {isMicrophoneEnabled ? t("bc.mute") : t("bc.unmute")}
        </button>
        <span className="bc-count">{t("bc.progress", { done, total })}{view?.uploaded ? ` · ${t("bc.uploaded")}` : ""}</span>
        <button className="lab-btn bc-end" onClick={onEnd}>{t("bc.end")}</button>
      </div>
    </section>
  );
}
