/**
 * The one assumption-set hash (F2).
 * bindAssumptions and assembleProvenance both call it, so the hash a set is
 * bound with and the per-set hash a run's provenance records are one value.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import { contentHash } from "./contentHash";
/** The set's hash: bindings alone when no mapping, so no stored hash moves; bindings and mapping when mapped. */
export const assumptionSetHash = (set: AssumptionSet): string =>
  set.macroBindings === undefined ? contentHash(set.bindings) : contentHash({ bindings: set.bindings, macroBindings: set.macroBindings });
