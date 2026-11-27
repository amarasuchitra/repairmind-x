import { useEffect, useRef } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useLocalParticipant,
  useRoomContext,
  useTranscriptions,
  useVoiceAssistant,
} from "@livekit/components-react";
import type { ToolCall } from "./tools.ts";

export const TOPIC_CONTEXT = "rmx.guide.ctx";
export const RPC_TOOL = "rmx.guide.tool";
const MAX = { result: 6000, state: 8000 }; // an RPC answer must stay under LiveKit's 15 KB

export type LiveState = "connecting" | "listening" | "thinking" | "speaking" | "idle";

export interface LiveHooks {
  /** the project as the guide reads it, sent when it joins */
  context: () => { state: string; catalog: string };
  /** run one app tool, as the typed guide would, and say what happened */
  onTool: (call: ToolCall) => Promise<{ result: string; state: string }>;
  /** a finished line from either side, for the chat log */
  onLine: (who: "user" | "guide", text: string) => void;
  onState: (s: LiveState) => void;
  /** lets the page send typed messages into the live conversation */
  onReady: (send: ((text: string) => void) | null) => void;
  onEnd: (problem?: string) => void;
}

/**
 * The assistant's live voice: a Gemini Live conversation over LiveKit, always listening and interruptible, with the
 * same voice as the repair call. Audio only; it drives the app through the same tools as the typed guide.
 */
export function GuideLive({ serverUrl, token, ...hooks }: { serverUrl: string; token: string } & LiveHooks) {
  return (
    <LiveKitRoom serverUrl={serverUrl} token={token} connect audio video={false}
      onDisconnected={() => hooks.onEnd()} onError={(e) => hooks.onEnd(e.message)} style={{ display: "contents" }}>
      <Inner {...hooks} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function Inner(hooks: LiveHooks) {
  const room = useRoomContext();
  const { state, agent } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();
  const h = useRef(hooks);
  h.current = hooks;

  // the page runs the tools the voice asks for
  useEffect(() => {
    const lp = room.localParticipant;
    lp.registerRpcMethod(RPC_TOOL, async (data) => {
      let call: ToolCall;
      try { call = JSON.parse(data.payload) as ToolCall; } catch { return JSON.stringify({ result: "unreadable request", state: "" }); }
      try {
        const out = await h.current.onTool({ tool: call.tool, args: call.args ?? [], why: call.why ?? "" });
        return JSON.stringify({ result: out.result.slice(0, MAX.result), state: out.state.slice(-MAX.state) });
      } catch (e) {
        return JSON.stringify({ result: `failed: ${e instanceof Error ? e.message : String(e)}`, state: "" });
      }
    });
    return () => { try { lp.unregisterRpcMethod(RPC_TOOL); } catch { /* gone */ } };
  }, [room]);

  // the guide gets the project as soon as it joins
  const sentTo = useRef("");
  useEffect(() => {
    const id = agent?.identity;
    if (!id || sentTo.current === id) return;
    sentTo.current = id;
    const c = h.current.context();
    localParticipant.sendText(JSON.stringify({ state: c.state.slice(-14000), catalog: c.catalog.slice(0, 12000) }), { topic: TOPIC_CONTEXT })
      .catch(() => { sentTo.current = ""; });
  }, [agent?.identity, localParticipant]);

  useEffect(() => {
    if (!agent) { h.current.onReady(null); return; }
    h.current.onReady((text) => { void localParticipant.sendText(text, { topic: "lk.chat" }).catch(() => undefined); });
    return () => h.current.onReady(null);
  }, [agent, localParticipant]);

  useEffect(() => {
    h.current.onState(!agent ? "connecting" : (["listening", "thinking", "speaking"] as const).find((s) => s === state) ?? "idle");
  }, [agent, state]);

  // finished lines from both sides go into the chat log, once each
  const lines = useTranscriptions();
  const logged = useRef(new Set<string>());
  useEffect(() => {
    for (const x of lines) {
      const id = x.streamInfo.id;
      if (logged.current.has(id) || x.streamInfo.attributes?.["lk.transcription_final"] !== "true" || !x.text.trim()) continue;
      logged.current.add(id);
      h.current.onLine(x.participantInfo.identity === localParticipant.identity ? "user" : "guide", x.text.trim());
    }
  }, [lines, localParticipant.identity]);

  return null;
}
