/**
 * The results label for the B3a index kinds. One Informational note beside the B2
 * derived-curve note: each index the run reads (each position's index, then its parents) with its formula text, and
 * only the caveats that apply. Undefined when no index read is a constant-maturity swap or a formula, so a run on
 * compounded windows only carries the notes it carried before B3a.
 */
import type { NotImplemented } from "../contracts/errors";
import type { RateIndex } from "../contracts/rateIndex";
import { makeNotImplemented } from "../runtime/notImplemented";
import { indexFormulaText } from "./describe";

export const FORMULA_NOTE_LAYER = "plan.rate-index.formula";

export function rateIndexFormulaNote(read: readonly RateIndex[], arm: "deterministic" | "stochastic"): NotImplemented | undefined {
  if (!read.some((r) => r.kind === "constant-maturity-swap" || r.kind === "formula")) return undefined;
  // The list ends with a period and each caveat is its own sentence, so a caveat never reads as one more index.
  const sentences = [`the run reads these rate indices: ${read.map(indexFormulaText).join("; ")}.`];
  if (arm === "deterministic" && read.some((r) => r.kind === "constant-maturity-swap")) {
    sentences.push("A constant-maturity swap index reads the path's forward par swap rate with no convexity adjustment.");
  }
  // A lag whose parent carries a history reads it; its flat months are the history note's.
  if (read.some((r) => r.kind === "formula" && r.lagMonths !== undefined && read.find((p) => p.id === r.parent)?.historyId === undefined)) {
    sentences.push("Until its lag has run, a lagged index reads its parent's cut-off value on the run's unshocked curve.");
  }
  return makeNotImplemented(FORMULA_NOTE_LAYER, sentences.join(" "));
}
