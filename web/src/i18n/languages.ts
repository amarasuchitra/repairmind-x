/**
 * The languages RepairMind speaks. English plus the major Indian languages first, then a few global ones.
 *
 * `speech` is the BCP-47 tag handed to the browser's dictation and to the voice agent. Numbers stay in
 * Western digits and units stay SI symbols in every language, so engineering values read the same everywhere.
 */
export interface Language {
  code: string;
  /** name in its own script, shown in the picker */
  name: string;
  english: string;
  speech: string;
  rtl?: boolean;
  /** Latin script: the uppercase, letter-spaced headings are safe. Other scripts get normal spacing. */
  latin?: boolean;
  /** Google Fonts family that draws this script well everywhere (system fonts often lack it) */
  font?: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", english: "English", speech: "en-IN", latin: true },
  { code: "hi", name: "हिन्दी", english: "Hindi", speech: "hi-IN", font: "Noto Sans Devanagari" },
  { code: "bn", name: "বাংলা", english: "Bengali", speech: "bn-IN", font: "Noto Sans Bengali" },
  { code: "te", name: "తెలుగు", english: "Telugu", speech: "te-IN", font: "Noto Sans Telugu" },
  { code: "mr", name: "मराठी", english: "Marathi", speech: "mr-IN", font: "Noto Sans Devanagari" },
  { code: "ta", name: "தமிழ்", english: "Tamil", speech: "ta-IN", font: "Noto Sans Tamil" },
  { code: "gu", name: "ગુજરાતી", english: "Gujarati", speech: "gu-IN", font: "Noto Sans Gujarati" },
  { code: "kn", name: "ಕನ್ನಡ", english: "Kannada", speech: "kn-IN", font: "Noto Sans Kannada" },
  { code: "ml", name: "മലയാളം", english: "Malayalam", speech: "ml-IN", font: "Noto Sans Malayalam" },
  { code: "pa", name: "ਪੰਜਾਬੀ", english: "Punjabi", speech: "pa-IN", font: "Noto Sans Gurmukhi" },
  { code: "es", name: "Español", english: "Spanish", speech: "es-ES", latin: true },
  { code: "fr", name: "Français", english: "French", speech: "fr-FR", latin: true },
  { code: "de", name: "Deutsch", english: "German", speech: "de-DE", latin: true },
  { code: "ar", name: "العربية", english: "Arabic", speech: "ar-SA", rtl: true, font: "Noto Sans Arabic" },
  { code: "zh", name: "中文", english: "Chinese", speech: "zh-CN", font: "Noto Sans SC" },
  { code: "ja", name: "日本語", english: "Japanese", speech: "ja-JP", font: "Noto Sans JP" },
];

export const BY_CODE: Record<string, Language> = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));

/** The first supported language in the browser's preference list, else English. */
export function detectLanguage(prefs: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): string {
  for (const p of prefs) {
    const base = (p || "").toLowerCase().split(/[-_]/)[0];
    if (BY_CODE[base]) return base;
  }
  return "en";
}

/** Dictation tag: for English keep the browser's own variant (en-IN, en-GB...) so accents are heard right. */
export function speechTag(code: string, prefs: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]): string {
  const lang = BY_CODE[code] ?? BY_CODE.en;
  const exact = prefs.find((p) => (p || "").toLowerCase().split(/[-_]/)[0] === lang.code && p.includes("-"));
  return exact ?? lang.speech;
}
