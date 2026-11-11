/**
 * @alm/engine portfolio module.
 *
 * The portfolio registry (loadPortfolio side effect) and the cash-flow
 * aggregation hot loop that reduces every position into per-family and
 * COA-rolled-up bucketed cash flows.
 */
export { loadPortfolio, getPortfolio, hasPortfolio, clearPortfolios } from "./registry";
export {
  aggregateScenario,
  aggregatePortfolio,
  assembleScenarioCashflows,
  familyWalYears,
  stampFamilyWal,
  type ScenarioRatePath,
} from "./aggregate";
// Studio blank path D4: the book-level seasoning refusal intake and setup validation share.
export { seasoningRefusals, type SeasoningRefusal } from "./seasoning";
export {
  dimensionsOf,
  validateDimensions,
  UNAUTHORABLE_DIMENSION_IDS,
  type DimensionProblem,
} from "./dimensions";
export {
  buildCellPlan,
  canonicalTags,
  cellIdOf,
  checkViewShapes,
  toViewResults,
  type CellGroup,
  type CellPlan,
  type ViewMembership,
} from "./cells";
