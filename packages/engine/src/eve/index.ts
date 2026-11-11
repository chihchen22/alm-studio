/**
 * EVE engine public surface.
 *
 * PV of assets and liabilities per scenario on the all-in funding curve,
 * EVE with Δ and % versus base, per-family PV, and effective duration
 * of equity via the kernel effective-duration machinery with per-shock
 * regeneration and behavioral re-leveling, every duration passed
 * through the sanity gate.
 */
export { discountFunction, type DiscountBasis } from "./discount";
export { pvBucketedSeries } from "./pv";
export {
  checkDurationSanity,
  applyDurationGate,
  DEFAULT_DURATION_BOUNDS,
  type DurationBounds,
  type DurationSanity,
  type GatedDurations,
  type RawFamilyDuration,
} from "./sanityGate";
export {
  computeEnvironmentDurations,
  type EnvironmentDurations,
  type EnvironmentDurationOptions,
  type FamilyPositions,
} from "./effectiveDuration";
export { computeEve, type EveInputs, type DurationMode } from "./computeEve";
// Opt-in key-rate decomposition and channel decomposition (additive).
export {
  computeKeyRateDurations,
  DEFAULT_KEY_RATE_BUMP_BP,
  KEY_RATE_CONVERGENCE_RATIO_MIN,
  KEY_RATE_CONVERGENCE_RATIO_MAX,
  KEY_RATE_RESIDUAL_FLOOR_YEARS,
  type KeyRateInputs,
} from "./keyRate";
export { computeEveChannels, type EveChannelsInputs } from "./channels";
