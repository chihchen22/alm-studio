/**
 * The built-in plugins. Every seam the run pipeline reaches
 * through is here, and every one wraps code that already ran.
 */
export { BUILTIN_CATALOG, DEFAULT_PROFILE } from "./catalog";
export { defaultHarness, resetDefaultHarness } from "./defaultHarness";
export { curveBootstrapPlugin } from "./curves";
export { deterministicRatePathPlugin, ratePathRegistryPlugin } from "./ratePaths";
export {
  behavioralRegistryPlugin,
  cdRolloverPlugin,
  commitmentDrawPlugin,
  depositBetaPlugin,
  loanClientRatePlugin,
  nmdDecayPlugin,
  prepayPlugin,
} from "./behavioral";
export { balancePlanPlugin, contractualPlugin, tlpOverlayPlugin } from "./pipelineStages";
export { positionsRegistryPlugin } from "./positions";
export { scenarioRegistryPlugin, shippedScenariosPlugin } from "./scenarios";
export {
  balanceSummaryMetricPlugin,
  eveMetricPlugin,
  ftpMetricPlugin,
  gapMetricPlugin,
  lcrRegulatoryMetricPlugin,
  lcrScenarioMetricPlugin,
  metricRegistryPlugin,
  niiMetricPlugin,
  survivalHorizonMetricPlugin,
  walGapMetricPlugin,
} from "./metrics";
export { makeRunLog, runLogPlugin } from "./runLog";
export { routingGatePlugin, typeGatePlugin, type RoutePayload, type TypeCheckPayload } from "./gates";
export {
  CustomMetricRegistrationError,
  DuplicateRegistrationError,
  RegistryError,
  UnknownRegistrationError,
} from "./errors";
export { makeKeyedRegistry, type KeyedRegistry } from "./registry";
export type {
  BehavioralApplier,
  BehavioralRegistry,
  CurveService,
  CustomMetricFn,
  CustomMetricInput,
  EngineMetricId,
  MetricFns,
  MetricRegistry,
  PositionSource,
  PositionSourceRegistry,
  RatePathFn,
  RatePathRegistry,
  ScenarioLibraryRegistry,
} from "./services";
