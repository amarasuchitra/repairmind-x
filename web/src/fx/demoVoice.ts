/**
 * A synthetic voice spectrum for places without a live call (the start page and the #demo preview):
 * phrases of syllables with pauses between them, shaped like speech (more energy in the low-mid bands).
 */
export function makeDemoVoice(bands = 12, phrase = 2.8, pause = 1.4): () => number[] {
  const start = performance.now();
  const seeds = Array.from({ length: 40 }, () => Math.random());
  return () => {
    const t = (performance.now() - start) / 1000;
    const cycle = phrase + pause;
    const k = t % cycle;
    const n = Math.floor(t / cycle);
    if (k > phrase) return new Array(bands).fill(0);
    const gate = Math.min(1, k / 0.15, (phrase - k) / 0.25);
    const syl = Math.max(0, Math.sin(k * (8 + seeds[n % 40] * 4) + n)) ** 0.6;
    const amp = gate * (0.35 + 0.65 * syl) * (0.7 + 0.3 * seeds[(n + 7) % 40]);
    return Array.from({ length: bands }, (_, i) => {
      const x = i / (bands - 1);
      const formant = Math.exp(-((x - 0.22) ** 2) / 0.04) + 0.55 * Math.exp(-((x - 0.55) ** 2) / 0.03);
      const jitter = 0.75 + 0.25 * Math.sin(t * 23 + i * 1.7);
      return Math.min(1, amp * formant * jitter * 0.42);
    });
  };
}
