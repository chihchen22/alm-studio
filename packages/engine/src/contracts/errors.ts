/**
 * Error and not-implemented conventions.
 *
 * The anti-fabrication rule: nothing that appears computed may
 * be a literal, and a layer that is unfinished throws or returns an explicit
 * tag, never a plausible number. A layer has two honest ways to signal it did
 * not run:
 *   - throw, for a hard precondition failure the caller must handle; or
 *   - return a NotImplemented tag, for a result slot a run can carry while the
 *     rest of the run proceeds (it surfaces in RunResult.notImplemented).
 */

/** Discriminant for the not-implemented tag. */
export const NOT_IMPLEMENTED = "not-implemented" as const;

/**
 * Returned by a layer that has not been built, in place of a number. The engine
 * never substitutes a plausible value for a missing computation.
 */
export interface NotImplemented {
  readonly _tag: typeof NOT_IMPLEMENTED;
  /** Which layer is missing, e.g. "attribution.new-business". */
  readonly layer: string;
  readonly reason: string;
}

/**
 * Frozen signatures for the convention helpers. The engine runtime implements
 * them; the contract layer only fixes their shape so every caller calls
 * the same names.
 */
export type MakeNotImplemented = (layer: string, reason: string) => NotImplemented;
export type IsNotImplemented = (x: unknown) => x is NotImplemented;
