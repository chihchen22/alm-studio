/**
 * The shape every stage function shares.
 *
 * A stage function is WHOLE-BOOK and pure over its inputs: it takes the
 * artifacts it consumes, for every scope they exist at, and returns the
 * artifacts it produces, for every scope it produces them at. It never reads the
 * shelf, never writes the shelf, and never calls another stage function. The
 * walker owns the shelf and the ordering.
 *
 * SPEED RULE (from 1b): every seam is resolved ONCE, into this env, before the
 * walk starts. No stage function performs a seam lookup inside a per-position or
 * per-scenario loop, and no event fires inside one.
 */
import type { RatePath } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { NotImplemented } from "../../contracts/errors";
import type {
  ArtifactScope,
  ContractTypeName,
  LicensedBinding,
  PlanStage,
  StageKind,
} from "../../contracts/plan";
import type { PortfolioSpec } from "../../contracts/position";
import type {
  BucketGrid,
  FamilyNewBusiness,
  LiquidityStressOptions,
  ReinvestmentShortfall,
  ScenarioNII,
} from "../../contracts/results";
import type { RunLogEntry } from "../../contracts/runLog";
import type { GapBucketsOption, LiquidityFlowsOption, ModelConvention, NmdConvention, RunRequest } from "../../contracts/run";
import type { ModelCorrections } from "../../corrections";
import type { Scenario } from "../../contracts/scenario";
import type { RateIndexTable } from "../../contracts/rateIndex";
import type { RunMacro } from "../../macro/runMacro";
import type { ResolvedNmdWarmup } from "../../nmd/warmup";
import type { SegSettings } from "../../seg/settings";
import type { DiscountBasis, DurationMode } from "../../eve";
import type { CellPlan } from "../../portfolio/cells";
import type {
  BehavioralRegistry,
  CurveService,
  MetricRegistry,
  RatePathRegistry,
} from "../../plugins/services";
import { ArtifactMissingError } from "../executorErrors";
import type { ShardsOption } from "../shard/staticPass";
import type { SweptTranche } from "../../projection/dynamic";
import type { FamilySeries } from "../../gap";

/**
 * ARTIFACT PAYLOADS, for the types whose payload is not obvious from the name:
 *   ZeroCurve      the kernel ZeroCurve, the risk-free leg
 *   FundingCurve   the kernel TLPCurve, the all-in funding leg
 *   Position       a PortfolioSpec, the whole book
 *   Cashflow       a ScenarioCashflows
 *   RepricingSchedule  a FamilySeries, which is what buildGapFromSeries reads
 *   RatePath and DiscountFactorPath  the same kernel RatePath object
 *
 * The two curve legs are two TYPES rather than one artifact carrying both,
 * because EVE and FTP need both and an edge names one producer per consumed
 * type. A plan whose EVE stage has no FundingCurve producer in its direct
 * dependsOn is refused at compile by T1 naming FundingCurve.
 */

/** Run-scope artifacts, by contract type. */
export type ArtifactBag = Partial<Record<ContractTypeName, unknown>>;

/** Scoped artifacts: contract type to (scenario id or assumption set id) to value. */
export type ScopedBag = Partial<Record<ContractTypeName, ReadonlyMap<string, unknown>>>;

/** What a stage function receives: the resolved artifacts, bucketed by scope. */
export interface StageInput {
  run: ArtifactBag;
  scenario: ScopedBag;
  assumptionSet: ScopedBag;
}

/**
 * What a stage function returns. A key that is PRESENT with the value
 * `undefined` satisfies the stage's declaration and is not put on the shelf:
 * that is how an optional metric states its own absence, and the refusal that
 * caused it is already a `refuse` entry in the log.
 */
export interface StageResult {
  run?: ArtifactBag;
  scenario?: ScopedBag;
  assumptionSet?: ScopedBag;
}

export type StageFn = (env: StageRunEnv, stage: PlanStage, input: StageInput) => StageResult;

/**
 * Which scope a stage kind writes at (spec Section 2.1's scope column). One
 * scope per kind: the walker reads this to put a stage's output and the run-log
 * coverage test reads it to check a `stage` entry against the shelf.
 */
export const STAGE_OUTPUT_SCOPE = {
  "market-data": "run",
  curve: "run",
  "term-structure": "scenario",
  "contractual-cashflow": "scenario",
  behavioral: "assumptionSet",
  "panel-intake": "run",
  calibration: "run",
  "balance-new-business": "scenario",
  metric: "run",
  // `as const satisfies` rather than an annotation: every kind is still checked
  // against StageKind and against the three scopes, and each entry keeps its
  // LITERAL type, so a caller naming one kind (the compiler's metric-conflict
  // refusal) gets a usable ArtifactScope rather than the widened union.
} as const satisfies Readonly<Record<StageKind, "run" | "scenario" | "assumptionSet">>;

/** Everything a stage function may read that is not an artifact. */
export interface StageRunEnv {
  request: RunRequest;
  /** The RAW book the context supplies, before any overlay. */
  portfolio: PortfolioSpec;
  /**
   * The run's cell plan, built ONCE in buildRunResult before any
   * scenario is projected. With no view declared this is the identity plan, in
   * which a cell IS a family and every downstream fold is the pre-2b code.
   */
  cellPlan: CellPlan;
  grid: BucketGrid;
  horizonMonths: number;
  baseScenario: Scenario;
  /** Bound assumption sets by id, in request order. */
  setById: ReadonlyMap<string, AssumptionSet>;
  /**
   * The ASSUMPTION-SET AXIS: the set ids a scenario references, deduplicated, in
   * scenario first-appearance order. Everything that expands over assumption
   * sets reads this, not `setById.keys()`: the walker opens one scope per entry
   * and the behavioral stage overlays one book per entry. A set the request
   * carries but no scenario reaches is absent, so it is neither validated nor
   * overlaid, which is what the pre-walker pipeline did. Every id on the axis is
   * a key of `setById`.
   */
  assumptionSetIds: readonly string[];
  shards: ShardsOption;
  durationMode?: DurationMode;
  keyRate?: boolean | { bumpBp?: number };
  eveChannels?: boolean;
  /** EVE discount basis; absent means "all-in" and no EVE input carries a basis key. */
  discountBasis?: DiscountBasis;
  /** Deposit convention the run named; absent when it named none. */
  nmdConvention?: NmdConvention;
  /**
   * Child position id to parent id, written by the regulatory deposit-convention
   * transform at run entry. Absent unless that transform ran; `portfolio` is
   * then the transformed book.
   */
  parentOf?: Record<string, string>;
  /**
   * The deposit warmup, resolved at run entry: one history per
   * scenario plus the unshifted one. Absent unless the run asked for it, and
   * then every deposit takes the kernel's own warmup series.
   */
  nmdWarmup?: ResolvedNmdWarmup;
  /** The model convention the run named; absent when it named none (the original convention). */
  modelConvention?: ModelConvention;
  /**
   * The corrections the convention applies, present only when at least one is on. The CD ones are
   * already marked on the book; the stages read `segVintageHistory`.
   */
  corrections?: ModelCorrections;
  /**
   * Each scenario's short-rate shift in percent, resolved at run entry. Present only when
   * an assumption set on the run's axis binds a full beta form; the static pass hands it to the full-form deposits.
   */
  depositShiftByScenario?: ReadonlyMap<string, number>;
  /**
   * True when an assumption set on the run's axis binds a component decay form. The metric
   * stage then leaves out NII, EVE and FTP with their tags, and the assembly restamps the family WAL on full runoff.
   */
  componentDecay?: boolean;
  /**
   * True when an assumption set on the run's axis binds a replicating-portfolio credit. The
   * metric stage then leaves out NII and EVE with their tags and hands the FTP block the NII base row it computed for
   * the bridge (`ftpNiiBase`).
   */
  replicatingPortfolio?: boolean;
  /** The NII base row a replicating-portfolio run computes for the FTP bridge and does not publish. */
  ftpNiiBase?: ScenarioNII;
  /**
   * True when a credit on the axis reads the balance path or a capped life, at every scenario.
   * The FTP block then runs beside a component decay or full beta form for the positions that carry the credit, and
   * the refusal tags read the E3 wording.
   */
  creditByScenario?: boolean;
  /** The SEG block opt-in; absent unless the run asked for it. */
  seg?: boolean;
  /** The SEG block's knobs; absent unless the run named one, and read only with `seg`. */
  segSettings?: SegSettings;
  /** The next-reset ALCO ladder opt-in; absent unless the run asked for it. */
  nextResetGap?: boolean;
  /** The fixed-rate gap ladder opt-in; absent unless the run asked for it. */
  fixedRateGap?: boolean;
  /** The forecast gap arm opt-in; absent unless the run asked for it. */
  forecastGap?: boolean;
  /** The going-concern EVE opt-in; absent unless the run asked for it. */
  goingConcernEve?: boolean;
  /** The months of new volume going-concern EVE counts; absent, 12 or the NII window when shorter (ruling 2026-11-03). */
  goingConcernSpan?: number;
  /** The liquidity stress opt-in; absent unless the run asked for it. */
  liquidityStress?: LiquidityStressOptions;
  /** The repricing ladder's user bucket setting; absent unless the run asked for it. */
  gapBuckets?: GapBucketsOption;
  /** The liquidity ladder's user bucket setting; absent unless the run asked for it. */
  liquidityBuckets?: GapBucketsOption;
  /**
   * The liquidity ladder's flows setting; absent unless the run named
   * one. "principal-plus-interest" makes the contractual pass fold the gap
   * interest carrier and the gap metric write GapLadder.withInterest.
   */
  liquidityFlows?: LiquidityFlowsOption;
  /** The NII report horizons the run asked for; absent means the engine default [12, 24]. */
  reportHorizons?: number[];
  /** The NII window the run asked for; written on the NII block only when it is not 60. */
  windowMonths?: number;
  /**
   * The rate indices this run resolves, set once in
   * buildRunResult. Absent when no position names an index; the stages that
   * build instruments pass it through, and the factory throws for a floater
   * that names an index it does not hold.
   */
  rateIndices?: RateIndexTable;
  /**
   * The run's resolved macro value, threaded beside rateIndices to every
   * makeInstrument call. A mortgage carrying a housing group without it throws
   * MacroUnresolvedError. Absent outside a run.
   */
  macro?: RunMacro;
  curves: CurveService;
  ratePaths: RatePathRegistry;
  behavioral: BehavioralRegistry;
  metrics: MetricRegistry;
  /** Which behavioral stage owns which binding. */
  licensedBindings: readonly LicensedBinding[];
  /** Positions matched per licensed binding, keyed "<assumptionSetId>:<bindingIndex>". */
  positionsMatched: ReadonlyMap<string, number>;
  /**
   * Typed reinvestment shortfalls the balance stage reports, read by the NII
   * stage. NOT an artifact: a shortfall is a diagnostic the envelope carries on
   * an NII row, not a contract type any stage consumes, so it rides here rather
   * than on the shelf.
   */
  shortfalls: Map<string, ReinvestmentShortfall[]>;
  /**
   * Origination notional per ruled family the balance stage reports for each
   * dynamic scenario, read by the NII stage and attached to ScenarioNII.newBusiness
   * (Studio A+E contract 24). Absent for a scenario that ran static.
   */
  newBusiness: Map<string, FamilyNewBusiness[]>;
  /**
   * The base scenario's minted tranches, kept by the balance stage when the base
   * scenario's rules carry a product template, read by the FTP stage to transfer-price new volume at origination.
   * Absent otherwise.
   */
  newVolumeTranches?: SweptTranche[];
  /**
   * Every dynamic scenario's minted tranches, template or not, kept by the balance stage
   * only when the run opted in to the forecast gap or going-concern EVE, which the post-walk assembly values. Absent
   * otherwise.
   */
  allNewVolumeTranches?: Map<string, SweptTranche[]>;
  /**
   * Each scenario's contractual gap series and the book the gap metric banded it on, kept by the gap arm only
   * when the run opted in to the forecast gap, for the assembly to add the new volume to. Absent otherwise.
   */
  forecastGapInputs?: Map<string, { series: FamilySeries; book: PortfolioSpec }>;
  /** Register tags a stage raises, appended in the order they are raised. */
  notImplemented: NotImplemented[];
  /**
   * Register tags a stage raises that the POST-WALK ASSEMBLY must order (Ruling
   * P5). `result.notImplemented` is a compared field of the golden and the
   * pre-1c pipeline wrote eve.key-rate.regime-amplifier before ftp.seasoned-book
   * before the attribution tags; only the assembly knows the key-rate outcome,
   * so the FTP arm defers its tag here and `assembleRunResult` drains this list
   * into `notImplemented` at the right point. Created lazily by the first
   * deferring stage, so a caller that builds an env by hand need not supply it.
   */
  deferredNotImplemented?: NotImplemented[];
  log(entry: RunLogEntry): void;
}

const RUN_SCOPE: ArtifactScope = { kind: "run" };

/** Read a run-scope input, or refuse naming the stage and the type. */
export function requireRun<T>(
  _env: StageRunEnv,
  stage: PlanStage,
  input: StageInput,
  type: ContractTypeName,
): T {
  if (!(type in input.run)) {
    throw new ArtifactMissingError(stage.id, type, RUN_SCOPE, "consumer");
  }
  return input.run[type] as T;
}

/** Read one scenario's slice of a scenario-scope input, or refuse naming it. */
export function requireScenario<T>(
  _env: StageRunEnv,
  stage: PlanStage,
  input: StageInput,
  type: ContractTypeName,
  scenarioId: string,
): T {
  const bag = input.scenario[type];
  if (bag === undefined || !bag.has(scenarioId)) {
    throw new ArtifactMissingError(stage.id, type, { kind: "scenario", scenarioId }, "consumer");
  }
  return bag.get(scenarioId) as T;
}

/**
 * The book a stage should run on for one assumption set: the effective book the
 * behavioral chain produced when a behavioral stage is upstream, and the raw
 * context book when none is. A plan with no behavioral stage runs the
 * contractual book, which is exactly what a request with no bindings does today.
 */
export function positionsFor(
  env: StageRunEnv,
  stage: PlanStage,
  input: StageInput,
  assumptionSetId: string,
): PortfolioSpec {
  const scoped = input.assumptionSet.Position;
  if (scoped !== undefined) {
    if (!scoped.has(assumptionSetId)) {
      throw new ArtifactMissingError(
        stage.id,
        "Position",
        { kind: "assumptionSet", assumptionSetId },
        "consumer",
      );
    }
    return scoped.get(assumptionSetId) as PortfolioSpec;
  }
  if ("Position" in input.run) return input.run.Position as PortfolioSpec;
  return env.portfolio;
}

export type { RatePath };
