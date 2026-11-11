/**
 * The seven seams. Each is one Services key with a small
 * contract over code that exists today: the plugin holds a reference, the inner
 * function is not rewritten, so no number moves.
 *
 * The metric ids here ("nii", "eve", "gap", "ftp") name ENGINE FUNCTIONS, not
 * the plan's METRIC_IDS ("nii", "eve", "ir-gap", "liq-gap"), which name report
 * metrics. One call to the gap function produces both ladders, which is why
 * there is one "gap" seam entry and two plan metric ids.
 */
import type { Dispose } from "@alm/harness";
import type { MarketSnapshot, RatePath, ZeroCurve } from "@alm/kernel";
import type { BehavioralOverlay } from "../contracts/assumptions";
import type { CustomMetricResult } from "../contracts/customMetric";
import type { ScenarioCashflows } from "../contracts/results";
import type { PortfolioId } from "../contracts/ids";
import type { PortfolioHandle, PortfolioSpec, PositionTerms } from "../contracts/position";
import type { RunLog } from "../contracts/runLog";
import type { Scenario, ScenarioLibrary } from "../contracts/scenario";
import type { buildGapFromSeries } from "../gap";
import type { computeEve } from "../eve";
import type { computeFtpResult } from "../ftp";
import type { computeNII } from "../nii";

/** curves: bootstrap the base zero curve from the run's market snapshot. */
export interface CurveService {
  build(snapshot: MarketSnapshot): ZeroCurve;
}

/** ratePaths: a scenario's shocked path, by model id. */
export type RatePathFn = (curve: ZeroCurve, scenario: Scenario, horizonMonths: number) => RatePath;

export interface RatePathRegistry {
  /**
   * Returns the dispose that removes the model; a model plugin pushes it
   * through ctx.effect. `ownerPluginId` is the plugin the run log credits for
   * every path this model builds, which is why a third-party model is named by
   * its own id rather than by a built-in naming convention.
   */
  register(modelId: string, fn: RatePathFn, ownerPluginId?: string): Dispose;
  /** Throws naming the model id and every registered id. */
  get(modelId: string): RatePathFn;
  /** The plugin that registered a live model, or undefined. Read by the run log. */
  providerOf(modelId: string): string | undefined;
  has(modelId: string): boolean;
  ids(): string[];
}

/** behavioral: merge one overlay into one position's terms. */
export type BehavioralApplier = (
  terms: PositionTerms,
  overlay: BehavioralOverlay,
  positionId: string,
) => PositionTerms;

export interface BehavioralRegistry {
  register(kind: string, applier: BehavioralApplier, ownerPluginId?: string): Dispose;
  get(kind: string): BehavioralApplier;
  /** The plugin that registered a live kind, or undefined. Read by the run log. */
  providerOf(kind: string): string | undefined;
  has(kind: string): boolean;
  kinds(): string[];
}

/** positions: where a book comes from. */
export interface PositionSource {
  load(spec: PortfolioSpec): PortfolioHandle;
  get(id: PortfolioId): PortfolioSpec;
}

export interface PositionSourceRegistry {
  register(sourceId: string, source: PositionSource): Dispose;
  get(sourceId: string): PositionSource;
  has(sourceId: string): boolean;
  ids(): string[];
}

/** scenarios: named libraries of scenario definitions. */
export interface ScenarioLibraryRegistry {
  register(libraryId: string, library: ScenarioLibrary): Dispose;
  get(libraryId: string): ScenarioLibrary;
  list(): ScenarioLibrary[];
}

/** metrics: the four result-producing functions, keyed by engine metric id. */
export interface MetricFns {
  nii: typeof computeNII;
  eve: typeof computeEve;
  gap: typeof buildGapFromSeries;
  ftp: typeof computeFtpResult;
}

export type EngineMetricId = keyof MetricFns;

/**
 * What a custom metric function receives: exactly
 * `Cashflow` and `Position`, plus the run's horizon and base scenario id. It
 * sees no NII and no EVE result; a metric that needs one is a later contract
 * change to this interface and a registered gap until then.
 */
export interface CustomMetricInput {
  horizonMonths: number;
  baseScenarioId: string;
  /** Request scenario order. `cashflows` is the stage's resolved Cashflow edge for that scenario. */
  scenarios: Array<{ scenarioId: string; assumptionSetId: string; cashflows: ScenarioCashflows }>;
  /**
   * The book the stage's own `Position` edge resolved to: the overlaid book
   * when a behavioral stage is upstream, the raw context book when none is. It
   * is the book the EVE arm measures, so a custom metric and the EVE block
   * cannot disagree about which book the run ran on.
   */
  book: PortfolioSpec;
}

export type CustomMetricFn = (input: CustomMetricInput) => CustomMetricResult;

export interface MetricRegistry {
  register<K extends EngineMetricId>(metricId: K, fn: MetricFns[K], ownerPluginId?: string): Dispose;
  get<K extends EngineMetricId>(metricId: K): MetricFns[K];
  /** The plugin that registered a live metric, or undefined. Read by the run log. */
  providerOf(metricId: string): string | undefined;
  has(metricId: string): boolean;
  /** The four built-in engine metric ids alone. A custom metric is never listed here. */
  ids(): string[];
  /**
   * Piece 3b, the SECOND DOOR. Throws CustomMetricRegistrationError when
   * metricId fails CUSTOM_METRIC_ID_PATTERN, equals a built-in EngineMetricId,
   * is already registered, or when ownerPluginId already owns a custom metric
   * (one per plugin).
   */
  registerCustom(metricId: string, fn: CustomMetricFn, ownerPluginId: string): Dispose;
  /** The custom metric a plugin registered, or undefined. Read by the metric stage. */
  customByPlugin(pluginId: string): { metricId: string; fn: CustomMetricFn } | undefined;
  /** Registered custom metric ids, in registration order. */
  customIds(): string[];
}

declare module "@alm/harness" {
  interface Services {
    curves: CurveService;
    ratePaths: RatePathRegistry;
    behavioral: BehavioralRegistry;
    positions: PositionSourceRegistry;
    scenarios: ScenarioLibraryRegistry;
    metrics: MetricRegistry;
    runLog: RunLog;
  }
}
