/**
 * Server-side translation for text that has no hand-written translation: the rest of the interface, and
 * text that arrives at run time in English (the call's diagnosis and steps, the lab's check findings).
 *
 * The server checks that numbers, units and {placeholders} survive, caches every result, and returns the
 * English unchanged when it can't translate. Here results are kept per language in memory and localStorage,
 * requests are batched, and when the server can't translate, the English simply stays.
 */

type Listener = () => void;

const mem = new Map<string, Map<string, string>>();
const pending = new Map<string, Set<string>>();
const inflight = new Set<string>();
const listeners = new Set<Listener>();
let timer = 0;
let offUntil = 0;

const storeKey = (lang: string) => `rmx.i18n.${lang}`;
const MAX_STORED = 3000;
const BATCH = 80;

function table(lang: string): Map<string, string> {
  let t = mem.get(lang);
  if (!t) {
    t = new Map();
    try {
      const raw = localStorage.getItem(storeKey(lang));
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) t.set(k, v);
    } catch {
      /* nothing cached */
    }
    mem.set(lang, t);
  }
  return t;
}

function persist(lang: string) {
  const t = table(lang);
  try {
    const entries = [...t.entries()].slice(-MAX_STORED);
    localStorage.setItem(storeKey(lang), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* storage full or blocked: kept for this visit only */
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The translation if there is one yet; never blocks. */
export function lookup(lang: string, text: string): string | undefined {
  return table(lang).get(text);
}

/** Ask for translations of these texts (deduplicated, batched, fire and forget). */
export function request(lang: string, texts: Iterable<string>) {
  if (lang === "en" || Date.now() < offUntil) return;
  const t = table(lang);
  let q = pending.get(lang);
  for (const s of texts) {
    if (!s || !/[A-Za-z]/.test(s) || t.has(s) || inflight.has(`${lang}\u0000${s}`)) continue;
    if (!q) pending.set(lang, (q = new Set()));
    q.add(s);
  }
  if (q?.size && !timer) timer = window.setTimeout(flush, 40);
}

async function flush() {
  timer = 0;
  const jobs = [...pending.entries()];
  pending.clear();
  for (const [lang, set] of jobs) {
    const all = [...set];
    for (let i = 0; i < all.length; i += BATCH) void send(lang, all.slice(i, i + BATCH));
  }
}

async function send(lang: string, texts: string[]) {
  texts.forEach((s) => inflight.add(`${lang}\u0000${s}`));
  try {
    const res = await fetch("/api/i18n/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang, texts }),
    });
    if (!res.ok) {
      offUntil = Date.now() + 60_000; // no translator on the server: stay in English for a minute
      return;
    }
    const body = (await res.json()) as { translations: string[]; translated: boolean[] };
    const t = table(lang);
    texts.forEach((s, i) => {
      // only keep real translations, so an English fallback is asked again next visit
      if (body.translated?.[i] && body.translations?.[i]) t.set(s, body.translations[i]);
    });
    persist(lang);
    listeners.forEach((fn) => fn());
  } catch {
    offUntil = Date.now() + 60_000;
  } finally {
    texts.forEach((s) => inflight.delete(`${lang}\u0000${s}`));
  }
}
