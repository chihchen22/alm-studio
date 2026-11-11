// Derived curves, a tenor-dependent spread over the run's one curve
// (additive; no run path imports it yet). The types and PLATFORM_DEFAULT_CURVE ride the contracts barrel.
export {
  validateDerivedCurve,
  validateDerivedCurves,
  MAX_SPREAD_ROWS,
  MAX_ABS_SPREAD_BP,
  MAX_SPREAD_TENOR_MONTHS,
  DERIVED_CURVE_LABEL_MAX,
  type DerivedCurveValidation,
} from "./validate";
export { spreadAt } from "./spreadAt";
export { runCurveIdOf, estimatedOnDefaultOf } from "./runCurve";
export { indexRateAt0, estimateSpreads, swapRateAt0, fillTenorProblems, SWAP_FILL_ABOVE_MONTHS } from "./estimate";
