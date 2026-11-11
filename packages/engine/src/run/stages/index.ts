/**
 * The stage functions. One per stage kind the engine
 * executes, each wrapping by reference the code the pre-1c pipeline ran inline.
 *
 * | Stage kind (plan)      | Function                | Wraps                                  | Consumes                   | Produces                | Scope         |
 * |------------------------|-------------------------|----------------------------------------|----------------------------|-------------------------|---------------|
 * | curve (bootstrap)      | runCurveStage           | curves.build                           | MarketSnapshot             | ZeroCurve               | run           |
 * | curve (tlp)            | runTlpStage             | tlpFromSnapshot                        | ZeroCurve, MarketSnapshot  | FundingCurve            | run           |
 * | term-structure         | runTermStructureStage   | ratePaths.get(model) per scenario      | ZeroCurve                  | RatePath, DiscountFactorPath | scenario |
 * | behavioral             | runBehavioralStage      | applyLicensedOverlays                  | Position, RatePath         | Position                | assumptionSet |
 * | contractual-cashflow   | runContractualStage     | runStaticPass, assembleScenarioCashflows | Position, RatePath       | Cashflow, RepricingSchedule | scenario  |
 * | balance-new-business   | runBalanceStage         | projectDynamicScenario                 | Position, RatePath, Cashflow | Cashflow              | scenario      |
 * | metric                 | runMetricStage          | metrics.get(id)                        | per metric                 | Nii/Eve/Gap/FtpResult   | run           |
 * | metric (custom)        | runCustomMetricStage    | metrics.customByPlugin(pluginId)        | Cashflow, Position         | CustomMetricResult      | run           |
 *
 * Attribution, the family WAL stamp and the two opt-in EVE blocks are NOT
 * stages: they are post-metric assembly and live in assemble.ts.
 */
export { runCurveStage, runTlpStage, tlpFromSnapshot } from "./curve";
export { runTermStructureStage } from "./termStructure";
export { runBehavioralStage } from "./behavioral";
export { runContractualStage } from "./contractual";
export { runBalanceStage } from "./balance";
export { runMetricStage, RESULT_TYPES } from "./metric";
export { runCustomMetricStage } from "./customMetric";
export { assembleRunResult, type AssembleInput } from "./assemble";
export {
  positionsFor,
  requireRun,
  requireScenario,
  STAGE_OUTPUT_SCOPE,
  type ArtifactBag,
  type ScopedBag,
  type StageFn,
  type StageInput,
  type StageResult,
  type StageRunEnv,
} from "./types";
