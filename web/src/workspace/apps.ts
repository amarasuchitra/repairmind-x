/** The tools that open as panels inside the one assistant screen, and the old page addresses that lead to them. */
export const APPS = ["repair_call", "design_lab", "builder", "redesign", "inspection", "library"] as const;
export type AppId = (typeof APPS)[number] | "demo";

export const isApp = (s: string): s is AppId => (APPS as readonly string[]).includes(s) || s === "demo";

/** Old addresses (#lab, #build...) still work: they open the assistant with that tool beside it. */
export function appFromHash(hash: string): AppId | null {
  const h = hash.replace(/^#/, "");
  const map: Record<string, AppId> = {
    lab: "design_lab", build: "builder", redesign: "redesign", inspect: "inspection", library: "library",
    call: "repair_call", "repair-call": "repair_call",
  };
  if (h.startsWith("demo")) return "demo";
  return map[h] ?? null;
}

/** Hashes that belong to the assistant screen rather than the start page. */
export function isWorkspaceHash(hash: string): boolean {
  const h = hash.replace(/^#/, "");
  return h === "assistant" || h === "make" || appFromHash(hash) !== null;
}
