import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en, type Key } from "./en";
import { HAND } from "./locales";
import { BY_CODE, LANGUAGES, detectLanguage, speechTag, type Language } from "./languages";
import { lookup, request, subscribe } from "./machine";

export { LANGUAGES, BY_CODE, type Language };

const CHOICE_KEY = "rmx.lang";
type Vars = Record<string, string | number>;

function readChoice(): string {
  try {
    const c = localStorage.getItem(CHOICE_KEY) ?? "auto";
    return c === "auto" || BY_CODE[c] ? c : "auto";
  } catch {
    return "auto";
  }
}

function fill(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

interface I18n {
  /** "auto" or a language code: what the person picked */
  choice: string;
  setChoice: (c: string) => void;
  /** the language in use */
  lang: string;
  language: Language;
  /** BCP-47 tag for dictation and the voice agent */
  speech: string;
  t: (key: Key, vars?: Vars) => string;
  /** like t, but values can be elements (e.g. a bold name) placed where the language puts them */
  tn: (key: Key, vars: Record<string, ReactNode>) => ReactNode;
  /** translate text that arrived at run time in English; returns the English until a translation is ready */
  auto: (text: string) => string;
}

const Ctx = createContext<I18n | null>(null);

/** Re-render when machine translations arrive. */
function useMachineVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => subscribe(() => setV((x) => x + 1)), []);
  return v;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState(readChoice);
  const lang = choice === "auto" ? detectLanguage() : choice;
  const language = BY_CODE[lang] ?? BY_CODE.en;
  const version = useMachineVersion();

  const setChoice = useCallback((c: string) => {
    const next = c === "auto" || BY_CODE[c] ? c : "auto";
    setChoiceState(next);
    try { localStorage.setItem(CHOICE_KEY, next); } catch { /* remembered for this visit only */ }
  }, []);

  // the page's language and direction follow the choice (screen readers, fonts, right-to-left)
  useEffect(() => {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = language.rtl ? "rtl" : "ltr";
    html.dataset.script = language.latin ? "latin" : "other";
    // load a font that shapes this script properly (conjuncts, vowel signs), only when it is needed
    if (language.font) {
      const id = `rmx-font-${language.font.replace(/\W+/g, "-")}`;
      if (!document.getElementById(id)) {
        const link = document.createElement("link");
        link.id = id;
        link.rel = "stylesheet";
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(language.font)}:wght@400;500;600;700&display=swap`;
        document.head.appendChild(link);
      }
      html.style.setProperty("--script-font", `"${language.font}"`);
    } else html.style.removeProperty("--script-font");
  }, [lang, language]);

  // every key without a hand-written translation is translated once by the server and cached
  useEffect(() => {
    if (lang === "en") return;
    const hand = HAND[lang] ?? {};
    request(lang, (Object.keys(en) as Key[]).filter((k) => !hand[k]).map((k) => en[k]));
  }, [lang]);

  const value = useMemo<I18n>(() => {
    const hand = HAND[lang] ?? {};
    const raw = (key: Key) => hand[key] ?? (lang === "en" ? undefined : lookup(lang, en[key])) ?? en[key] ?? key;
    const t = (key: Key, vars?: Vars) => fill(raw(key), vars);
    const tn = (key: Key, vars: Record<string, ReactNode>) =>
      raw(key).split(/(\{\w+\})/g).map((part, i) => {
        const m = /^\{(\w+)\}$/.exec(part);
        return <Fragment key={i}>{m && m[1] in vars ? vars[m[1]] : part}</Fragment>;
      });
    const auto = (text: string) => {
      if (lang === "en" || !text) return text;
      const got = lookup(lang, text);
      if (got === undefined) request(lang, [text]);
      return got ?? text;
    };
    return { choice, setChoice, lang, language, speech: speechTag(lang), t, tn, auto };
    // version: new machine translations arrived
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, lang, language, setChoice, version]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const FALLBACK: I18n = {
  choice: "en", setChoice: () => undefined, lang: "en", language: BY_CODE.en, speech: "en-US",
  t: (k, v) => fill(en[k] ?? k, v), tn: (k) => en[k] ?? k, auto: (s) => s,
};

export function useI18n(): I18n {
  return useContext(Ctx) ?? FALLBACK;
}

/** Subscribe-free read of the current choice, for code outside React (e.g. building a request body). */
export function currentLanguage(): string {
  const c = readChoice();
  return c === "auto" ? "auto" : c;
}

/** Language picker: native names, with "Auto" following the browser. */
export function LanguagePicker({ className = "" }: { className?: string }) {
  const { choice, setChoice, t } = useI18n();
  const detected = BY_CODE[detectLanguage()] ?? BY_CODE.en;
  return (
    <label className={`lang-pick ${className}`}>
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
        <path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm6.9 6h-2.95a15.7 15.7 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.9 8ZM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96ZM4.26 14a8.2 8.2 0 0 1 0-4h3.38a16.5 16.5 0 0 0 0 4H4.26Zm.84 2h2.95c.32 1.25.78 2.45 1.38 3.56A8 8 0 0 1 5.1 16Zm2.95-8H5.1a8 8 0 0 1 4.33-3.56A15.7 15.7 0 0 0 8.05 8ZM12 19.96A14 14 0 0 1 10.09 16h3.82A14 14 0 0 1 12 19.96ZM14.34 14H9.66a14.7 14.7 0 0 1 0-4h4.68a14.7 14.7 0 0 1 0 4Zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56ZM16.36 14a16.5 16.5 0 0 0 0-4h3.38a8.2 8.2 0 0 1 0 4h-3.38Z" />
      </svg>
      <span className="sr-only">{t("lang.label")}</span>
      <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t("lang.label")}>
        <option value="auto">{t("lang.auto", { name: detected.name })}</option>
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>{l.code === "en" ? l.name : `${l.name} · ${l.english}`}</option>
        ))}
      </select>
    </label>
  );
}
