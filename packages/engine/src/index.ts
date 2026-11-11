/**
 * @alm/engine public surface.
 *
 * The frozen contract layer, plus the run-orchestrator's public runtime surface
 * (the EngineTools factory). The intermediate engines (portfolio aggregation,
 * scenario execution, NII/EVE/gap, attribution, provenance) are consumed through
 * the orchestrator and imported from their own modules where needed directly.
 */
export * from "./contracts";
export {
  createEngine,
  EngineRuntime,
  resolveDefaultContext,
  type EngineContext,
} from "./run";
// The run pipeline surface the platform layer calls directly (design
// Section 3.3 barrel note): the pipeline itself, the two read functions, the
// pipeline context carrying the optional onProgress seam, and the frozen
// progress-phase union. Until this landed, apps/server deep-imported
// `@alm/engine/src/run`; that import site flips to this barrel.
export {
  buildRunResult,
  sliceResult,
  explainResult,
  type RunPipelineContext,
} from "./run";
export type { RunProgressPhase } from "./run/orchestrate";
export type { InstrumentEnvironment } from "./run/instrumentEnvironment";
// Harness Plane 4: the walker's typed refusals. The platform layer
// catches the family to answer a run submission with 422 rather than a 500, so
// the base class is on the barrel beside the pipeline it is raised from.
export { ExecutorError } from "./run";
// Deterministic FTP: the three-leg par-match block the run pipeline
// emits for the base scenario (ADR-018 pins shocked series to a typed refusal).
export {
  computeFtpResult,
  FTP_BRIDGE_HORIZON_MONTHS,
  FTP_SHOCKED_SERIES_LAYER,
  type FtpComputeInput,
} from "./ftp";
// The replicating-portfolio credit, its pricer and its run checks.
export {
  OVERNIGHT_MONTHS,
  ReplicatingPortfolioCredit,
  RpPricer,
  bulletCashflows,
  lifeTargetBlend,
  runoffCashflows,
  setsBindReplicatingPortfolio,
  steepenedSnapshot,
  type RpDeposit,
} from "./ftp";
// Stochastic run mode v0: the separate Hull-White Monte Carlo entry
// point and its own envelope (distribution semantics never touch the
// deterministic RunResult schema). The envelope contract lives
// in contracts/stochastic.ts and is exported here directly so the frozen
// contracts barrel stays untouched this wave.
export * from "./contracts/stochastic";
export {
  runStochastic,
  StochasticCapVolsError,
  StochasticPathCountError,
  StochasticSeedError,
  STOCHASTIC_SHOCKED_SCENARIOS_LAYER,
  type StochasticRunOptions,
} from "./run/stochastic";
// The stochastic gap's typed refusals, which the server maps to 422s.
export {
  StochasticGapError,
  StochasticGapHorizonError,
  StochasticGapModelError,
  StochasticGapOptionError,
  StochasticGapSizeCapError,
  // Slice 4b T3: the engine's own refusal sequence, so the route refuses in the same order and the same words.
  refuseGapBeforeSimulation,
} from "./run/stochasticGap";
export {
  buildStochasticEnvironment,
  StochasticVolShockOverrideError,
  type StochasticEnvironment,
  type StochasticEnvironmentOptions,
  type StochasticModelOverride,
} from "./scenario/stochasticEnvironment";
// The BGM sibling of the HW environment, its rate path and
// its four typed refusals. runStochastic dispatches on StochasticRunOptions.model.
export {
  buildBgmEnvironment,
  BgmShockUnreadError,
  BGM_SHOCK_SENTENCE,
  BgmSubsetError,
  StochasticLongYieldVolsError,
  BGM_SIMULATION_MONTHS,
  type BgmEnvironment,
  type BgmEnvironmentOptions,
} from "./scenario/bgmEnvironment";
export { BgmRatePath, BgmTenorError } from "./scenario/bgmRatePath";
// Harness Plane 4: the plan front door. Gates and compiler; no compute.
// ALM Studio Piece 6b adds deriveBalancePlan, derivedBalancePlanId,
// BalancePlanDerivationError and BALANCE_DERIVED_ID_PREFIX here through the plan
// barrel (additive; no run path imports them).
export * from "./plan";
// Harness Plane 4: the dimension bag's reader and its intake checks.
// The portfolio module is not re-exported wholesale, so these three are named.
export {
  dimensionsOf,
  validateDimensions,
  UNAUTHORABLE_DIMENSION_IDS,
  type DimensionProblem,
} from "./portfolio/dimensions";
// Harness Plane 4: the cell plan and the read-side pivot. The
// platform layer serves the pivot straight off a stored result, so both the
// function and its typed refusal are on the barrel.
export {
  buildCellPlan,
  cellIdOf,
  toViewResults,
  type CellPlan,
  type ViewMembership,
} from "./portfolio/cells";
export * from "./report";
// Harness Plane 5: the band labels a lens constraint names. The gap
// module is not re-exported wholesale, so this one is named.
export { GAP_BAND_LABELS } from "./gap/bands";
// The next-reset ALCO repricing ladder.
export { computeNextResetLadder } from "./gap/nextResetLadder";
// The fixed-rate (rate-locked) gap ladder.
export { computeFixedRateLadder, rateLockOf } from "./gap/fixedRateLadder";
// The checks the run route shares with the pipeline for the
// bucket settings, the NII report horizons and the NII window.
export {
  gapBucketsConfigError,
  liquidityFlowsConfigError,
  wantsLiquidityInterest,
  type GapLadderBuckets,
} from "./gap/bucketOptions";
export {
  DEFAULT_NII_WINDOW_MONTHS,
  isEngineReportHorizons,
  reportHorizonsConfigError,
  windowMonthsConfigError,
} from "./nii/reportHorizons";
export { SHIPPED_LIBRARIES } from "./scenario/library";
// Harness Plane 4: the seams and the built-in plugins.
export * from "./plugins";
export type { RunLog, RunLogEntry, PluginSource } from "./contracts/runLog";
// Harness Plane 5: the single-instrument drill. One position, one or
// more deterministic scenarios, the monthly schedule and its valuation,
// computed on demand and never stored. The platform layer calls it directly.
export {
  projectInstrument,
  ProjectInstrumentError,
  DRILL_DEFAULT_HORIZON_MONTHS,
  DRILL_DEFAULT_DURATION_BUMP_BP,
  type ProjectInstrumentInput,
  type ProjectInstrumentResult,
  type InstrumentScenarioProjection,
  type InstrumentScheduleRow,
} from "./instrument/projectInstrument";
// The per-position half of the run's own overlay gate, which the drill's apply
// path does not run: the platform's drill route runs the gate itself on the
// pick path, so a set the run would refuse is refused there too.
export { checkBindingOverlap } from "./projection/static/applyOverlays";
// The rate document, what a run ran on, kept beside its result. Pure
// builder over the request; the platform's runner child calls it after the
// envelope lands and writes the document as its own file.
export * from "./contracts/rateDocument";
export {
  buildRateDocument,
  buildStochasticRateFan,
  buildBgmRateFan,
  curveNodesOf,
  RateDocumentError,
  ClientRateBenchmarkError,
  type RateDocumentInput,
} from "./rates/rateDocument";
// The client-rate spread refusal, a request error beside the rate-document errors.
export { ClientRateSpreadMismatchError } from "./scenario/resolveAssumptions";
// The pure behavioral-shock derivation (additive; no run path imports it).
export {
  deriveAssumptionSet,
  derivedSetId,
  AssumptionDerivationError,
  MAX_DERIVATION_OPS,
  DERIVED_ID_PREFIX,
  DEMONSTRATION_SUFFIX,
  type DerivedSetResult,
  type DeriveOptions,
} from "./scenario/deriveAssumptionSet";
// The pure funding spread shock derivation (additive; no run path imports it).
export * from "./market";
// The curve setup builder (additive; no run path imports it yet).
export * from "./curveBuilder";
// Rate indices as a static basis over the run's one curve.
export * from "./rateIndex";
// Derived curves (validator, spread read, run curve id; additive, no run path imports it yet).
export * from "./derivedCurve";
// The index history document (validator, id, month reads).
export * from "./indexHistory";
// The regulatory deposit convention as a book transform.
export * from "./nmd";
export * from "./seg";
// The liquidity stress ladder and survival horizon.
export * from "./liquidity";
// Calibration as its own action and the saved fit a stochastic run can use.
export {
  bgmSolverOptionsOf,
  BGM_SOLVER_KEYS,
  CalibrationFitError,
  curveFingerprintOf,
  fitCalibration,
  gateText,
  savedCalibrationArmOf,
  savedCalibrationMismatch,
  savedCalibrationUseOf,
  SAVED_CALIBRATION_SCHEMA_VERSION,
  type BgmSolverOptions,
  type CalibrationFit,
  type CalibrationParameters,
  type CalibrationPins,
  type CalibrationQuote,
  type SavedCalibration,
  type SavedCalibrationArm,
  type SavedCalibrationUse,
} from "./calibration/savedCalibration";
// The model convention, its switches and its check.
export * from "./corrections";
