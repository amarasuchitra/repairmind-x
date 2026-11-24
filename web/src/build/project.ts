/** A hardware project: what it is, the parts on the canvas, and what it should do. Plain data, saved as JSON. */

export type Trigger =
  | "start" | "timer" | "touch" | "button" | "sound" | "motion" | "dark" | "dry" | "near" | "shake" | "open" | "hot";
export type Action = "say" | "light" | "beep" | "move" | "pump" | "vibrate" | "show" | "switch";

export interface Rule {
  id: string;
  when: Trigger;
  then: Action;
  /** words to say (robot voice), a voice-file label (MP3 player), or text for the screen */
  text?: string;
  /** light colour as #rrggbb */
  color?: string;
}

export interface Placed {
  uid: string;
  id: string;
  /** position on the canvas, 0–1 of its width and height */
  x: number;
  y: number;
}

export interface Product {
  /** what the thing is: "a plush owl night light" */
  what: string;
  /** what it does today: "glows when switched on" */
  does: string;
  forKids: boolean;
  /** how the existing thing is powered */
  power: "battery" | "usb" | "wall" | "none";
  /** inside space in mm, if measured */
  inner: [number, number, number] | null;
  /** a small photo as a data URL, shown behind the canvas */
  photo?: string;
}

export interface Project {
  v: 1;
  name: string;
  /** "upgrade" makes an existing thing smarter; "new" is built from scratch in a project box */
  mode: "new" | "upgrade";
  goal: string;
  product: Product;
  parts: Placed[];
  rules: Rule[];
  template?: string;
}

export const TRIGGERS: { id: Trigger; label: string; needs: string[] }[] = [
  { id: "start", label: "When it's switched on", needs: [] },
  { id: "timer", label: "Every few minutes", needs: [] },
  { id: "touch", label: "When touched", needs: ["touch"] },
  { id: "button", label: "When the button is pressed", needs: ["button"] },
  { id: "sound", label: "When it hears a voice or clap", needs: ["mic", "soundsensor"] },
  { id: "motion", label: "When someone moves nearby", needs: ["pir"] },
  { id: "dark", label: "When the room gets dark", needs: ["light"] },
  { id: "dry", label: "When the soil is dry", needs: ["soil"] },
  { id: "near", label: "When something comes close", needs: ["distance"] },
  { id: "shake", label: "When it's shaken or tipped", needs: ["motion6"] },
  { id: "open", label: "When the door or lid opens", needs: ["reed"] },
  { id: "hot", label: "When it gets hot (over 32 °C)", needs: ["temp"] },
];

export const ACTIONS: { id: Action; label: string; needs: string[] }[] = [
  { id: "say", label: "Say something", needs: ["player", "amp"] },
  { id: "light", label: "Light up", needs: ["ring", "strip", "led"] },
  { id: "beep", label: "Beep", needs: ["buzzer"] },
  { id: "move", label: "Move the arm", needs: ["servo"] },
  { id: "pump", label: "Water for 3 seconds", needs: ["pump"] },
  { id: "vibrate", label: "Vibrate", needs: ["vibe"] },
  { id: "show", label: "Show on the screen", needs: ["oled"] },
  { id: "switch", label: "Switch the relay on for 5 s", needs: ["relay"] },
];

let seq = 0;
export const uid = (p = "p") => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function emptyProject(mode: Project["mode"]): Project {
  return {
    v: 1, name: "", mode, goal: "",
    product: { what: "", does: "", forKids: false, power: mode === "upgrade" ? "battery" : "none", inner: null },
    parts: [], rules: [],
  };
}

/** Accept a saved or dropped project file; anything malformed is refused rather than half-loaded. */
export function parseProject(text: string): Project | null {
  try {
    const p = JSON.parse(text);
    if (!p || p.v !== 1 || !Array.isArray(p.parts) || !Array.isArray(p.rules) || typeof p.product !== "object") return null;
    return {
      v: 1,
      name: String(p.name ?? "").slice(0, 80),
      mode: p.mode === "upgrade" ? "upgrade" : "new",
      goal: String(p.goal ?? "").slice(0, 400),
      product: {
        what: String(p.product.what ?? "").slice(0, 120),
        does: String(p.product.does ?? "").slice(0, 200),
        forKids: !!p.product.forKids,
        power: ["battery", "usb", "wall", "none"].includes(p.product.power) ? p.product.power : "none",
        inner: Array.isArray(p.product.inner) && p.product.inner.length === 3 && p.product.inner.every((n: unknown) => typeof n === "number" && n > 0)
          ? p.product.inner : null,
        photo: typeof p.product.photo === "string" && p.product.photo.startsWith("data:image/") ? p.product.photo : undefined,
      },
      parts: p.parts.filter((x: Placed) => x && typeof x.id === "string").slice(0, 40).map((x: Placed) => ({
        uid: typeof x.uid === "string" ? x.uid : uid(), id: x.id,
        x: clamp01(Number(x.x)), y: clamp01(Number(x.y)),
      })),
      rules: p.rules.filter((r: Rule) => r && TRIGGERS.some((t) => t.id === r.when) && ACTIONS.some((a) => a.id === r.then)).slice(0, 30)
        .map((r: Rule) => ({ id: typeof r.id === "string" ? r.id : uid("r"), when: r.when, then: r.then,
          text: typeof r.text === "string" ? r.text.slice(0, 120) : undefined,
          color: typeof r.color === "string" && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : undefined })),
      template: typeof p.template === "string" ? p.template : undefined,
    };
  } catch {
    return null;
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(0.97, Math.max(0.03, n)) : 0.5);
