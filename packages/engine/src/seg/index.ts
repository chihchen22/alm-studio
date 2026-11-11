/**
 * The SEG block: sensitivity equivalent gap,
 * the equivalent balance profile and constant-balance NII on the book's
 * earnings convention. The kernel SEG machinery is called, never copied.
 */
export { SEG_DEFAULTS, computeSegBlock, type PositionSegRow, type SegInput } from "./computeSeg";
// The block's knobs and the cohort-0 prepayment overlay.
export {
  SEG_MAX_HORIZON_MONTHS,
  SEG_MAX_NII_SHOCK_BP,
  SEG_MAX_SHOCK_BP,
  segConstants,
  segCprOverlayBookError,
  segSettingsConfigError,
  segSettingsOf,
  type SegCprOverlay,
  type SegSettings,
} from "./settings";
export { FLAT_CPR_MIDPOINT_BP, flatCprParams, mortgageAtFlatCpr, runStaticBalanceSplit } from "./cprOverlay";
