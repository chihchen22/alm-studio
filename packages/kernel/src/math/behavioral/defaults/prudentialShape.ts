/**
 * Prudential overnight size-surface SHAPE — the four management-judgment ramp
 * parameters of the judgment-dial convention, shared by the DDA and MMA books:
 *
 *   phi(b) = min(phiMax, max(0, (ln b - ln b0) * kappa'))-style ramp anchored
 *   at b0 with steepness kappa, capped at phiMax, with the concentration
 *   sleeve floor at sleeveFloor dollars (peak >= $10M books overnight).
 *
 * PROVENANCE: these four values are judgment constants (a design choice: where
 * the overnight ramp starts, how fast it saturates, the $10M sleeve threshold),
 * not fitted to data. They are split out so the routed tabs can consume the
 * ramp on its own.
 */

export interface PrudentialShape {
  /** Ramp anchor balance, dollars. */
  readonly b0: number;
  /** Ramp steepness. */
  readonly kappa: number;
  /** Ramp cap. */
  readonly phiMax: number;
  /** Concentration sleeve floor, dollars (peak >= $10M books overnight). */
  readonly sleeveFloor: number;
}

/** The judgment-dial ramp shape (identical for DDA and MMA). */
export const PRUDENTIAL_SHAPE: PrudentialShape = {
  b0: 9_000_000.0,
  kappa: 8.0,
  phiMax: 1.0,
  sleeveFloor: 10_000_000.0,
};
