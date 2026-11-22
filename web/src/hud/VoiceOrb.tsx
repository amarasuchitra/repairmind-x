import { useEffect, useRef } from "react";

export type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

/**
 * The mechanic's presence: a glowing core with a ring of bars driven by audio.
 * Speaking: bars follow the mechanic's voice. Listening: they follow your mic, softer.
 * Thinking: a rotating scan ring. Purely decorative; state is also given as text.
 */
export function VoiceOrb({ state, bands, size = 96 }: { state: OrbState; bands: number[]; size?: number }) {
  const smooth = useRef<number[]>([]);
  const N = 48;
  // Mirror the bands around the ring so it looks balanced, and smooth them so it doesn't flicker.
  const src = bands.length ? bands : [0];
  const target = Array.from({ length: N }, (_, i) => {
    const k = i < N / 2 ? i : N - 1 - i;
    return src[Math.floor((k / (N / 2)) * src.length) % src.length] ?? 0;
  });
  smooth.current = target.map((v, i) => (smooth.current[i] ?? 0) * 0.55 + v * 0.45);
  const level = smooth.current.reduce((a, b) => a + b, 0) / N;
  const gain = state === "speaking" ? 1 : state === "listening" ? 0.6 : 0.15;

  const svgRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    svgRef.current?.style.setProperty("--orb-level", String(Math.min(1, level * gain * 2.5)));
  });

  return (
    <svg ref={svgRef} className={`orb orb-${state}`} width={size} height={size} viewBox="-50 -50 100 100"
         role="img" aria-label={`Mechanic is ${state}`}>
      <defs>
        <radialGradient id="orb-core" r="0.5">
          <stop offset="0" stopColor="#e9fdff" />
          <stop offset="0.35" stopColor="var(--hud)" />
          <stop offset="1" stopColor="var(--hud)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="orb-halo" r="46" />
      <g className="orb-bars">
        {smooth.current.map((v, i) => {
          const a = (i / N) * Math.PI * 2 - Math.PI / 2;
          const len = 3 + Math.min(1, v * gain * 3) * 13;
          return (
            <line key={i} x1={Math.cos(a) * 27} y1={Math.sin(a) * 27} x2={Math.cos(a) * (27 + len)}
                  y2={Math.sin(a) * (27 + len)} />
          );
        })}
      </g>
      <circle className="orb-ring" r="24" />
      <circle className="orb-scan" r="20" />
      <circle className="orb-core" r="18" fill="url(#orb-core)" />
    </svg>
  );
}
