/**
 * @alm/engine attribution module.
 *
 * Decomposes each headline delta versus base (nii-12m, nii-24m, eve) into
 * per-family, per-driver contributions via a single fixed-order cumulative peel,
 * carrying the unexplained residual explicitly (never folded into a driver). The
 * AttributionResult it emits is the sole input the explain layer narrates.
 */
export {
  computeAttribution,
  PEEL_ORDER,
  type AttributionInput,
  type FamilyMetricEvaluator,
  type HeadlineMetric,
  type HeadlineTarget,
} from "./computeAttribution";
