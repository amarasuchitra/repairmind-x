/**
 * Think first: the engineer's understanding of an idea before any design (agent/repairmind/lab/schema.py `Brief`).
 * Facts are separated from guesses, feasibility is decided by rough numbers, and the riskiest assumption comes with
 * the cheapest test that could prove it wrong.
 */
export type Source = "you_said" | "photo" | "file" | "typical" | "assumed";
export type FeasibilityVerdict = "build_now" | "build_with_changes" | "needs_research" | "beyond_known_physics";
export interface PathStage { name: string; kind: "build" | "research" | "invent"; what: string; needs: string; time: string }

export interface Brief {
  restated: string;
  kind: "new" | "improve";
  real_goal: string;
  known: { fact: string; source: Source; ref: string }[];
  feasibility: { verdict: FeasibilityVerdict; why: string; deciding_numbers: string[]; closest_alternative: string; path: PathStage[] };
  riskiest: { statement: string; why_it_matters: string; cheapest_test: string; pass_if: string; test_cost_inr: number; test_time: string };
  concepts: { name: string; how_it_works: string; pros: string[]; cons: string[] }[];
  recommended_concept: string;
  recommended_why: string;
  questions: { q: string; why: string; options: string[] }[];
}

export interface QA { q: string; a: string }

/** Answers to send: the user's picks, plus the concept they chose when it differs from the recommendation. */
export function collectAnswers(b: Brief, picked: Record<string, string>, concept: string, earlier: QA[]): QA[] {
  const out = new Map(earlier.map((x) => [x.q, x.a]));
  for (const q of b.questions) {
    const a = (picked[q.q] ?? "").trim();
    if (a) out.set(q.q, a.slice(0, 600));
  }
  if (concept && concept !== b.recommended_concept) out.set("Which approach should the design use?", concept);
  return [...out].map(([q, a]) => ({ q, a }));
}
