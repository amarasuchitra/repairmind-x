import type { Key } from "../en";

/** Hand-written translations for one language. Keys left out are translated by the server. */
export type Table = Partial<Record<Key, string>>;
