import type { Table } from "./types";
import ar from "./ar";
import bn from "./bn";
import de from "./de";
import es from "./es";
import fr from "./fr";
import gu from "./gu";
import hi from "./hi";
import ja from "./ja";
import kn from "./kn";
import ml from "./ml";
import mr from "./mr";
import pa from "./pa";
import ta from "./ta";
import te from "./te";
import zh from "./zh";

/** Hand-written translations: the safety notice, safety alerts, precautions and the main controls. */
export const HAND: Record<string, Table> = { hi, bn, te, mr, ta, gu, kn, ml, pa, es, fr, de, ar, zh, ja };
