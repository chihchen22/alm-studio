/**
 * @alm/engine dynamic new-business and reinvestment projection module.
 *
 * Dynamic balance sheet: the existing book runs off exactly as the static engine
 * projects it, and each ruled family reinvests that runoff into new fixed-rate
 * tranches priced at the reinvestment index plus a spread, feeding the same
 * per-family and COA accumulators. Drives projected NII. An unreachable target
 * (a declining balance the book cannot run off to without disposals) is reported
 * as a shortfall, never silently missed. A rule may carry a product template:
 * its tranches read the path from their own origination month.
 */
export {
  DEFAULT_NEW_BUSINESS_TERM_MONTHS,
  reinvestmentCoupon,
  sweepFamilyReinvestment,
  projectDynamicScenario,
  projectDynamicAll,
  newVolumeProductOf,
  reinvestmentTarget,
  type SeriesDelta,
  type FamilyShortfall,
  type FamilyReinvestment,
  type DynamicScenarioLeg,
  type DynamicScenarioResult,
  type DynamicProjectionOptions,
  type SweptTranche,
  type SweepRecording,
} from "./dynamicNewBusiness";
export { ForwardStartPath, forwardStartCurve } from "./forwardStart";
export { BEHAVIOR_MODEL_LABEL, behaviorGap, behaviorNoteOf, familyBehavior, largestPosition, type FamilyBehavior } from "./familyBehavior";
export { MAX_TEMPLATE_TERM_MONTHS, newVolumeTemplateProblem } from "../../plan/newVolumeTemplate";
export {
  cohortWarmup,
  cprByMonth,
  matchedFixedRate,
  previewTemplate,
  suggestedTemplate,
  templateTranche,
  type SuggestedTemplate,
  type TemplatePreview,
  type TemplateTranche,
} from "./templateTranche";
