import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { boundsOf, cropRect, strokeOk, toFrame, type NBox, type Pt } from "./geometry";

export interface CircleAskPayload {
  box: NBox;
  question: string;
  image: string; // close-up crop at full camera resolution, as a JPEG data URL ("" if the frame wasn't ready)
}

interface Props {
  host: HTMLElement | null; // the camera section that holds the live <video>
  mirrored: boolean;
  onAsk: (p: CircleAskPayload) => void;
  onCancel: () => void;
}

/** Draw a loop around a part on the live video, then ask about it. The video keeps running underneath. */
export function CircleAsk({ host, mirrored, onAsk, onCancel }: Props) {
  const { t } = useI18n();
  const [stroke, setStroke] = useState<Pt[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [picked, setPicked] = useState<{ box: NBox; image: string } | null>(null);
  const [retry, setRetry] = useState(false);
  const [text, setText] = useState("");
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function local(e: React.PointerEvent): Pt {
    const r = layer.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function finish() {
    setDrawing(false);
    // the live <video>, or the design preview's camera canvas
    const video = host?.querySelector<HTMLVideoElement | HTMLCanvasElement>("video, canvas.demo-cam");
    const vw = video instanceof HTMLVideoElement ? video.videoWidth : video?.width ?? 0;
    const vh = video instanceof HTMLVideoElement ? video.videoHeight : video?.height ?? 0;
    const el = layer.current;
    if (!video || !vw || !vh || !el || !strokeOk(stroke)) {
      setRetry(true);
      setStroke([]);
      return;
    }
    const { width, height } = el.getBoundingClientRect();
    const box = boundsOf(stroke.map((p) => toFrame(p, width, height, vw, vh, mirrored)));
    if (!box) {
      setRetry(true);
      setStroke([]);
      return;
    }
    // Crop now, at full camera resolution, so the close look sees exactly the moment the user circled.
    let image = "";
    try {
      const r = cropRect(box, vw, vh);
      const c = document.createElement("canvas");
      const s = Math.min(1, 1280 / Math.max(r.sw, r.sh));
      c.width = Math.max(1, Math.round(r.sw * s));
      c.height = Math.max(1, Math.round(r.sh * s));
      c.getContext("2d")?.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
      image = c.toDataURL("image/jpeg", 0.88);
    } catch {
      image = ""; // the mechanic crops its own frame instead
    }
    setPicked({ box, image });
  }

  function send(question: string) {
    if (!picked) return;
    onAsk({ box: picked.box, question: question.trim(), image: picked.image });
  }

  const d = stroke.length ? "M " + stroke.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ") + (drawing ? "" : " Z") : "";
  return (
    <div className="circle-ask" ref={layer}
         onPointerDown={(e) => {
           if (picked) return;
           (e.target as Element).setPointerCapture?.(e.pointerId);
           setRetry(false);
           setDrawing(true);
           setStroke([local(e)]);
         }}
         onPointerMove={(e) => drawing && setStroke((s) => [...s, local(e)])}
         onPointerUp={() => drawing && finish()}
         onPointerCancel={() => { setDrawing(false); setStroke([]); }}>
      <svg className="circle-stroke" aria-hidden><path d={d} /></svg>
      {!picked && (
        <div className="circle-hint" role="status">
          <span>{retry ? t("call.circle.again") : t("call.circle.hint")}</span>
          <button className="ghost" onPointerDown={(e) => e.stopPropagation()} onClick={onCancel}>{t("call.circle.cancel")}</button>
        </div>
      )}
      {picked && (
        <form className="circle-sheet" onPointerDown={(e) => e.stopPropagation()}
              onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <b>{t("call.circle.ask")}</b>
          <div className="circle-chips">
            {(["call.circle.what", "call.circle.damaged", "call.circle.how"] as const).map((k) => (
              <button type="button" key={k} className="chip" onClick={() => send(t(k))}>{t(k)}</button>
            ))}
          </div>
          <div className="circle-row">
            <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
                   placeholder={t("call.circle.placeholder")} aria-label={t("call.circle.placeholder")} />
            <button type="submit" className="primary" disabled={!text.trim()}>{t("call.circle.send")}</button>
          </div>
          <div className="circle-row">
            <button type="button" className="ghost" onClick={() => send("")}>{t("call.circle.voice")}</button>
            <button type="button" className="ghost" onClick={onCancel}>{t("call.circle.cancel")}</button>
          </div>
        </form>
      )}
    </div>
  );
}
