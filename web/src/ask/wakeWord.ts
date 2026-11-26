// "Hey RepairMind": a hands-free wake word, heard ON THE DEVICE only.
//
// It uses the browser's on-device speech recognition (SpeechRecognition with processLocally), so the audio
// for the wake word never leaves the phone. Where the browser can't recognise on the device, the feature is
// simply not offered: it never falls back to cloud recognition.

export const WAKE_PHRASES = ["hey repairmind", "hi repairmind", "ok repairmind", "okay repairmind"];

/** Does this (possibly misheard) transcript contain the wake phrase? */
export function matchesWake(text: string): boolean {
  const t = " " + text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim() + " ";
  // recognisers split or mishear the made-up word: "repair mind", "repairmind", "repair mine", "repair minds"
  const squashed = t.replace(/repair\s+(mind|mine|minds|mined)\b/g, "repairmind").replace(/repairminds|repairmine/g, "repairmind");
  return WAKE_PHRASES.some((p) => squashed.includes(" " + p + " "));
}

type Availability = "available" | "downloadable" | "downloading" | "unavailable";

// The on-device API is newer than the DOM typings, so it is described here.
interface LocalRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
interface LocalRecognitionCtor {
  new (): LocalRecognition;
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<Availability>;
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
}

function ctor(): LocalRecognitionCtor | null {
  const w = globalThis as unknown as { SpeechRecognition?: LocalRecognitionCtor; webkitSpeechRecognition?: LocalRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Can this browser hear the wake word on the device? "downloadable" means after a one-time language pack. */
export async function wakeAvailability(lang: string): Promise<Availability> {
  const C = ctor();
  if (!C?.available) return "unavailable"; // no on-device API: we never use cloud recognition for this
  try {
    return await C.available({ langs: [lang], processLocally: true });
  } catch {
    return "unavailable";
  }
}

export async function installWake(lang: string): Promise<boolean> {
  try {
    return Boolean(await ctor()?.install?.({ langs: [lang], processLocally: true }));
  } catch {
    return false;
  }
}

/**
 * Listen for the wake phrase. onWake fires once per phrase; onSpeech fires on any later speech so the caller
 * can keep the mic open while the user is still talking. Returns a stop function.
 */
export function listenForWake(lang: string, onWake: () => void, onSpeech: () => void): () => void {
  const C = ctor();
  if (!C) return () => undefined;
  let stopped = false;
  let rec: LocalRecognition | null = null;
  let woke = false;
  const begin = () => {
    if (stopped) return;
    rec = new C();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.processLocally = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (!woke && matchesWake(text)) {
          woke = true;
          onWake();
        } else if (woke) {
          onSpeech();
        }
        if (r.isFinal) woke = false;
      }
    };
    // Recognisers stop by themselves after a while: start again until told to stop.
    rec.onend = () => { if (!stopped) window.setTimeout(begin, 250); };
    rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "language-not-supported") stopped = true; };
    try { rec.start(); } catch { /* already started */ }
  };
  begin();
  return () => {
    stopped = true;
    try { rec?.stop(); } catch { /* not running */ }
  };
}
