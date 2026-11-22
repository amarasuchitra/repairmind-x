/** Small line icons drawn for RepairMind (24px grid, currentColor). */
type P = { size?: number; className?: string };
const base = (size = 20, className?: string) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true,
});

export const Logo = ({ size = 28, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
    <defs>
      <linearGradient id="rmx-logo" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#7ff0ff" />
        <stop offset="1" stopColor="#2f7dff" />
      </linearGradient>
    </defs>
    <path d="M16 2 28 9v14l-12 7L4 23V9z" fill="none" stroke="url(#rmx-logo)" strokeWidth="1.6" />
    <path d="M16 7.5 23.5 12v8L16 24.5 8.5 20v-8z" fill="rgba(70,200,255,.12)" stroke="url(#rmx-logo)" strokeWidth="1" />
    <path d="M12 12.5 20 19.5M20 12.5 12 19.5" stroke="#bff6ff" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="16" cy="16" r="1.6" fill="#fff" />
  </svg>
);

export const Mic = ({ size, className }: P) => (
  <svg {...base(size, className)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
export const MicOff = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M15 9.5V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" /></svg>
);
export const Flip = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M4 8h12l-3-3M20 16H8l3 3" /><rect x="3" y="3" width="18" height="18" rx="4" opacity=".35" /></svg>
);
export const PhoneOff = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M3.5 14.5c4.7-4.2 12.3-4.2 17 0l-2.2 2.6-3.3-1.2-.6-2.6a10.6 10.6 0 0 0-4.8 0l-.6 2.6-3.3 1.2z" /></svg>
);
export const Camera = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="4" /></svg>
);
export const Wave = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2M21 12h0" /></svg>
);
export const Wrench = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L3 18l3 3 6.4-6.4a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.6-.6-.6-2.6z" /></svg>
);
export const Shield = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
);
export const Target = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4" /><circle cx="12" cy="12" r="3" /></svg>
);
export const Doc = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h4" /></svg>
);
export const Check2 = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="m4 12 4 4 8-8" /><path d="m12 16 8-8" opacity=".5" /></svg>
);
export const Alert = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17v.5" /></svg>
);
export const Grid = ({ size, className }: P) => (
  <svg {...base(size, className)}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
);
export const Arrow = ({ size, className }: P) => (
  <svg {...base(size, className)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
