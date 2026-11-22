/// <reference lib="webworker" />
// Runs the tracker off the main thread so the call UI stays smooth on phones.
import { BoxTracker, catchUp, grayFromRGBA, type Box, type Gray } from "./tracker";

type In =
  | { type: "frame"; w: number; h: number; rgba: ArrayBuffer }
  | { type: "marker"; id: number; w: number; h: number; rgba: ArrayBuffer; box: Box }
  | { type: "clear" };

const BUFFER = 48; // ~4 s at 12 fps: covers the time the server takes to locate a part
const recent: Gray[] = [];
let tracker: BoxTracker | null = null;
let id = 0;

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "clear") {
    tracker = null;
    return;
  }
  if (m.type === "marker") {
    const anchor = grayFromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
    id = m.id;
    tracker = catchUp(anchor, m.box, recent);
    self.postMessage(tracker ? { type: "box", id, box: tracker.box, state: "tracking" } : { type: "failed", id });
    return;
  }
  const g = grayFromRGBA(new Uint8ClampedArray(m.rgba), m.w, m.h);
  recent.push(g);
  if (recent.length > BUFFER) recent.shift();
  if (tracker && tracker.state === "tracking") {
    const s = tracker.push(g);
    self.postMessage({ type: "box", id, box: s.box, state: s.state });
  }
  self.postMessage({ type: "ready" });
};
