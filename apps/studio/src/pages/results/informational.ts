/**
 * Compile notes that read Informational, not as a layer that failed to run: a flat-basis plan that left families
 * out, a run whose indices read a derived curve, whose spread reaches index resets only, and a run
 * that reads a constant-maturity-swap or formula index, listed with its formula text,
 * and a run whose lagged indices read an index history, with its coverage and the gap at the cut-off.
 */
export const INFORMATIONAL_LAYERS: ReadonlySet<string> = new Set([
  "plan.balance-basis.skipped",
  "plan.derived-curve.index-only",
  "plan.rate-index.formula",
  "plan.rate-index.history",
]);
