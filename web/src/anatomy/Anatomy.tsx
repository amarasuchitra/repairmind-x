import { useMemo, useState } from "react";
import type { SessionView } from "../types";
import "../../vendor/anatomy/iso.css";
import { DECK_H, DECK_PINS, DECK_SVG, DECK_W } from "./turntable.gen";

/**
 * The diagnosis view: an isometric anatomy figure of the identified device (drawn with the Anatomy kit),
 * with the part the mechanic is talking about lit, and the platter lifted off when the current step needs
 * it out of the way. One figure exists so far (belt-drive record player); other devices show nothing.
 */

export const NAMES: Record<string, string> = {
  plinth: "Plinth",
  power: "Power switch",
  pulley: "Motor pulley",
  "sub-platter": "Sub-platter",
  belt: "Drive belt",
  platter: "Platter",
  record: "Record and mat",
  tonearm: "Tonearm",
  cartridge: "Cartridge",
  speed: "Speed buttons",
  pitch: "Pitch slider",
};

const MATCH: [RegExp, string][] = [
  [/\bbelt\b/i, "belt"],
  [/pulley|motor/i, "pulley"],
  [/sub-?platter|bearing|spindle/i, "sub-platter"],
  [/platter|strobe/i, "platter"],
  [/record|vinyl|\bmat\b|groove/i, "record"],
  [/cartridge|stylus|needle|headshell/i, "cartridge"],
  [/tone ?arm|counterweight|anti-?skate|cue/i, "tonearm"],
  [/speed|33|45\b|rpm/i, "speed"],
  [/pitch/i, "pitch"],
  [/power|switch/i, "power"],
  [/plinth|feet|foot|base|cabinet/i, "plinth"],
];
export const partFor = (text: string | undefined) => (text ? MATCH.find(([re]) => re.test(text))?.[1] : undefined);

/** Parts that are only reachable with the platter off. */
const UNDER_PLATTER = new Set(["belt", "pulley", "sub-platter"]);

export function hasAnatomy(view: SessionView | null): boolean {
  return !!view && /turntable|record player|record deck|gramophone/i.test(`${view.device_type} ${view.device}`);
}

interface Focus { part?: string; why: string; apart: boolean }

/** What to light: the active step's part, else the leading cause's part. */
export function focusOf(view: SessionView): Focus {
  const active = view.steps.find((s) => s.status === "active" || s.status === "awaiting_confirmation");
  const platterOff = view.steps.some((s) => s.status === "done" && /platter/i.test(s.text) && /lift|remove|take/i.test(s.text));
  const stepPart = partFor(active?.text);
  if (stepPart) return { part: stepPart, why: "Current step", apart: platterOff || UNDER_PLATTER.has(stepPart) };
  const cause = view.diagnosis || view.hypotheses[0]?.cause;
  const causePart = partFor(cause);
  return { part: causePart, why: view.diagnosis ? "Diagnosis" : "Leading cause", apart: platterOff };
}

export function AnatomyFigure({ view, compact = false }: { view: SessionView; compact?: boolean }) {
  const auto = useMemo(() => focusOf(view), [view]);
  const [picked, setPicked] = useState<string | null>(null);
  const part = picked ?? auto.part;
  const apart = picked ? UNDER_PLATTER.has(picked) : auto.apart;
  const pin = part ? DECK_PINS[part] : undefined;
  const px = pin ? (apart ? pin.ax : pin.x) : 0;
  const py = pin ? (apart ? pin.ay : pin.y) : 0;

  const onClick = (e: React.MouseEvent) => {
    const hit = (e.target as Element).closest("[data-part]");
    const name = hit?.getAttribute("data-part");
    if (name) setPicked(name === picked ? null : name);
  };

  return (
    <figure className={`anat-card${compact ? " compact" : ""}`}>
      <div className="anat-corners" aria-hidden>
        <span className="tl">Fig 1 · Anatomy</span>
        <span className="tr">{view.device || "Record player"}</span>
      </div>
      <div
        className="iso anat"
        data-lit={part}
        data-apart={apart ? "" : undefined}
        onClick={onClick}
        role="img"
        aria-label={`Anatomy of the ${view.device || "record player"}${part ? `, ${NAMES[part]} highlighted` : ""}${apart ? ", platter lifted off" : ""}`}
      >
        <div dangerouslySetInnerHTML={{ __html: DECK_SVG }} />
        {pin && (
          <svg className="anat-pin" viewBox={`0 0 ${DECK_W} ${DECK_H}`} aria-hidden>
            <g style={{ transform: `translate(${px}px, ${py}px)` }}>
              <circle r="9" className="halo" />
              <circle r="3" className="core" />
            </g>
          </svg>
        )}
      </div>
      <div className="anat-corners bottom">
        <span className="bl">{picked ? "Tap again to follow the call" : "Tap a part"}</span>
        <span className="br" aria-live="polite">{part ? <><b>{NAMES[part]}</b> · {picked ? "Selected" : auto.why}</> : "Waiting for a diagnosis"}</span>
      </div>
    </figure>
  );
}
