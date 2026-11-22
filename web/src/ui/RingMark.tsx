/**
 * The RepairMind X ring mark: a thin instrument ring with two heavy arc segments and fine ticks, and the
 * letters R·M·X set wide across it. The ring breaks where the lettering crosses it, so the type reads as
 * passing through the ring rather than sitting on top of it.
 */
export function RingMark({ size = 160, text = "R.M.X", className }: { size?: number; text?: string; className?: string }) {
  const R = 74; // thin ring radius in a 240 x 180 box centred at (120, 90)
  const gap = 13; // degrees of ring left out either side of the horizontal, where the letters cross
  const arc = (r: number, a0: number, a1: number) => {
    const p = (a: number) => [120 + r * Math.cos((a * Math.PI) / 180), 90 + r * Math.sin((a * Math.PI) / 180)].map((v) => v.toFixed(2)).join(" ");
    return `M${p(a0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
  };
  const ticks = Array.from({ length: 48 }, (_, i) => i * 7.5).filter((a) => Math.abs(((a + 90) % 180) - 90) > gap + 6);
  return (
    <svg className={`ring-mark${className ? ` ${className}` : ""}`} width={size} height={(size * 180) / 240} viewBox="0 0 240 180" aria-hidden>
      {/* thin ring, broken at left and right */}
      <path d={arc(R, gap, 180 - gap)} className="rm-thin" />
      <path d={arc(R, 180 + gap, 360 - gap)} className="rm-thin" />
      {/* heavy segments, offset so the mark is not symmetric */}
      <path d={arc(R - 8, 200, 262)} className="rm-heavy" />
      <path d={arc(R - 8, 22, 70)} className="rm-heavy" />
      <path d={arc(R + 9, 284, 330)} className="rm-mid" />
      {ticks.map((a) => {
        const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
        const r0 = R + 3, r1 = R + (a % 45 === 0 ? 9 : 5);
        return <line key={a} x1={120 + c * r0} y1={90 + s * r0} x2={120 + c * r1} y2={90 + s * r1} className="rm-tick" />;
      })}
      <text x="120" y="90" className="rm-text" textAnchor="middle" dominantBaseline="central">{text}</text>
    </svg>
  );
}

/** Small header lockup: a compact ring with an X at its centre, and the wordmark set wide. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="wm">
      <svg className="wm-ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden>
        <path d="M15 3.5a11.5 11.5 0 0 1 11.2 9M26.2 17.5A11.5 11.5 0 0 1 3.8 17.5M3.8 12.5A11.5 11.5 0 0 1 15 3.5" className="wm-thin" />
        <path d="M6.8 7.5A11 11 0 0 1 12 4.3" className="wm-heavy" />
        <path d="M11 11l8 8M19 11l-8 8" className="wm-x" />
      </svg>
      {!compact && <span className="wm-text">REPAIRMIND<i>·</i><b>X</b></span>}
    </span>
  );
}
