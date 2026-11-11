/**
 * The run() pipeline: resolve, project, report, stamp (architecture Section 5).
 *
 * Given a RunRequest and its resolved PortfolioSpec, produce a RunResult with
 * every layer populated. The function is pure: it reads no clock and draws no
 * randomness. The only wall-clock in the result is the timestamps injected on
 * the request, and the headline grid run uses DeterministicRatePath, so the same
 * request produces byte-identical output.
 *
 * Static vs dynamic is one field, not two engines (architecture Section 4). EVE
 * and both gap ladders read the STATIC runoff of the existing book; NII reads the
 * scenario's own projection, which adds reinvestment when the scenario is
 * dynamic. For a static regulatory grid the two coincide, so every layer reads
 * one projection per scenario.
 *
 * Determinism discipline (risk register): every collection assembled here is an
 * ordered array in scenario input order or the COA's declared order. No Map
 * iteration feeds a serialized number; the assumption-set lookup below is keyed
 * get/set only. Float adds live inside the sibling engines, each with its own
 * fixed-order reduction.
 *
 * The fixed pipeline body is gone. This function resolves the seams,
 * derives or takes the plan, builds the StageRunEnv once, hands it to
 * executePlan, and assembles the envelope from what the walk left on the shelf.
 */
import type { Context } from "@alm/harness";
import type { AssumptionSet } from "../contracts/assumptions";
import type { LicensedBinding, RunPlan } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import type { KernelProvenanceRef } from "../contracts/provenance";
import type { GapBucketsOption, LiquidityFlowsOption, ModelConvention, NmdConvention, NmdWarmupRequest, RunRequest, RunResult } from "../contracts/run";
import { anyCorrection, modelConventionConfigError, modelCorrectionsOf } from "../corrections";
import { markCdBook } from "../cd/corrections";
import { tlpOfSnapshot } from "./stages/curve";
import type { RunLogEntry } from "../contracts/runLog";
import type { DiscountBasis, DurationMode } from "../eve";
import { planHash, registryProducers } from "../plan/compile";
import { canonicalPredicate, positionsMatchedBy } from "../plan/dimensions";
import { kindsByPlugin, licenseBindings } from "../plan/license";
import { stageExecutability } from "../plan/typeGate";
import { defaultHarness, defaultProfileHash, isDefaultHarness } from "../plugins/defaultHarness";
import { buildCellPlan } from "../portfolio/cells";
import { bindAssumptions } from "../scenario";
import { resolveAssumptions } from "../scenario/resolveAssumptions";
import { resolveRunRateIndices } from "../rateIndex/resolve";
import { macroTargetKey, resolveRunMacro } from "../macro/runMacro";
import { regulatoryBook, runBetaAtR0, shockedLevelBook } from "../nmd/runEntry";
import { resolveDepositShifts, setsBindFullForm } from "../nmd/fullBetaRun";
import { resolveComponentDecayShifts, setsBindComponentDecay } from "../nmd/componentDecayRun";
import { boundCreditForms, checkReplicatingPortfolioRun, setsBindReplicatingPortfolio } from "../ftp/replicatingPortfolioRun";
import { resolveNmdWarmup, type ResolvedNmdWarmup } from "../nmd/warmup";
import { liquidityStressConfigError } from "../liquidity/stressLadder";
import { segCprOverlayBookError, segSettingsConfigError, type SegSettings } from "../seg/settings";
import { gapBucketsConfigError, liquidityFlowsConfigError } from "../gap/bucketOptions";
import { DEFAULT_NII_WINDOW_MONTHS, reportHorizonsConfigError, windowMonthsConfigError } from "../nii/reportHorizons";
import type { LiquidityStressOptions } from "../contracts/results";
import { defaultPlanFor } from "./defaultPlan";
import { executePlan } from "./executor";
import { PlanGraphError, UnlicensedBindingError } from "./executorErrors";
import type { ShardsOption } from "./shard/staticPass";
import type { InstrumentEnvironment } from "./instrumentEnvironment";
import { assembleRunResult, type StageRunEnv } from "./stages";

/**
 * The four progress phases of the run pipeline, in emission order (the frozen
 * inter-module progress contract: the
 * engine emits, the server forwards as `{ t: "phase", phase }` JSON lines, the
 * workbench renders verbatim). "resolve" covers input validation and assumption
 * binding, "project" the static pass and per-scenario projection, "report" the
 * NII/EVE/gap/attribution assembly, "done" fires after the provenance stamp,
 * immediately before the result is returned.
 */
export type RunProgressPhase = "resolve" | "project" | "report" | "done";

/** Run-invariant context stamped into provenance (engine version + kernel ref). */
export interface RunPipelineContext {
  engineVersion: string;
  kernel: KernelProvenanceRef;
  /** Duration measurement policy; defaults to "per-scenario". */
  durationMode?: DurationMode;
  /** Static-pass shard policy; defaults to 1 (single-thread). */
  shards?: ShardsOption;
  /**
   * Optional progress seam. Called exactly once per
   * phase, in order, on the caller's thread. Purely observational: the pipeline
   * passes no data through it, reads nothing back, and computes nothing for it,
   * so its presence or absence cannot move a number. A throwing callback aborts
   * the run (the engine does not swallow caller errors into a green result).
   */
  onProgress?: (phase: RunProgressPhase) => void;
  /**
   * OPT-IN, off by default. COST LABEL: key-rate durations regenerate
   * the whole book twice per curve node plus twice for the parallel reference,
   * at TWO bump sizes (the convergence gate re-measures at the halved bump) —
   * roughly 4·(nodes + 1) full-book regenerations on top of the standard grid,
   * which is why the standard grid never computes this silently. `true` uses
   * the default 25bp working bump; pass `{ bumpBp }` to override.
   */
  keyRate?: boolean | { bumpBp?: number };
  /**
   * OPT-IN, off by default. COST LABEL: the channel decomposition adds
   * three full-book regenerations per shocked scenario plus one base leg.
   */
  eveChannels?: boolean;
  /**
   * EVE discount basis. Absent means "all-in", the basis every run
   * used before schema 1.9.0, and the EVE inputs then carry no basis key, so
   * such a run is byte-identical. "spread-consistent" discounts each position
   * at the all-in curve plus its own discountSpreadBp. The basis also reaches
   * the opt-in key-rate and channel blocks, so all three report one basis.
   */
  discountBasis?: DiscountBasis;
  /**
   * Deposit convention. Absent or "behavioral" runs the book as
   * authored. "regulatory" replaces every nmd-b and nmd position with a frozen
   * core ladder plus a non-core slice (nmd/regulatoryConvention.ts) at run
   * entry, before the cell plan, the licensing and the walk, so every block
   * runs on the transformed book. The result records the value whenever it is
   * given, and the child-to-parent map when the transform ran; a run without
   * the field is byte-identical.
   */
  nmdConvention?: NmdConvention;
  /**
   * OPT-IN, off by default. The deposit
   * moving-average warmup: every nmd and nmd-b position of the static
   * projection, the EVE duration legs, the SEG block and the per-position
   * results environment is built on a flat history at r0 re-levelled by the
   * scenario's shift (nmd/warmup.ts). The
   * result records the resolved option; absent, every deposit takes the
   * kernel's own warmup series and the run is byte-identical. A malformed
   * value, a dynamic scenario, or the eveChannels opt-in beside it is refused
   * before the walk.
   */
  nmdWarmup?: NmdWarmupRequest;
  /**
   * The model convention. Absent or "book" runs the original convention, byte-identical to a run made
   * before K1. "corrected-v1" applies the corrections (../corrections): the CD book reads the curve of the path it
   * is projected on plus the run's funding spread and walks at the documented $1 minimum live balance (marked on the
   * book at run entry, ../cd/corrections.ts), and an SEG replacement deposit vintage reads the run's deposit history.
   * The result records the value whenever it is given. A malformed value is refused before the walk.
   */
  modelConvention?: ModelConvention;
  /**
   * OPT-IN, off by default (E7). COST LABEL: the SEG block runs the
   * kernel static-balance projection seven times per position on the base
   * scenario (four at the 60-month SEG horizon, each building up to 60
   * replacement vintages, and three at the 12-month NII horizon), single
   * threaded after the walk. `true` writes RunResult.seg and NIIResult.nimPct;
   * absent or false writes neither, so such a run is byte-identical.
   */
  seg?: boolean;
  /**
   * OPT-IN, read only with `seg: true`. The SEG block's shock size, horizon, NII shock
   * and cohort-0 prepayment overlay (seg/settings.ts); a setting left out takes SEG_DEFAULTS, so a run that names
   * none is byte-identical. COST LABEL: the block's cost grows with the horizon, and a 720-month horizon builds up
   * to 720 replacement vintages per position and pair. A malformed value, an overlay family the book does not
   * declare as a mortgage family, or the settings without `seg` is refused before the walk.
   */
  segSettings?: SegSettings;
  /**
   * OPT-IN, off by default. The next-reset ALCO
   * repricing ladder (gap/nextResetLadder.ts, the ALCO convention),
   * computed once on the base scenario's book after the walk; it
   * generates no cash flow. `true` writes GapResult.nextReset; absent or false
   * writes nothing, so such a run is byte-identical.
   */
  nextResetGap?: boolean;
  /**
   * OPT-IN, off by default. The fixed-rate (rate-locked) gap ladder
   * (gap/fixedRateLadder.ts, the rate-locked half of the ALCO view). COST
   * LABEL: one cash-flow generation per rate-locked position on the base
   * scenario's deterministic path, single threaded after the walk. `true`
   * writes GapResult.fixedRate; absent or false writes nothing, so such a run
   * is byte-identical.
   */
  fixedRateGap?: boolean;
  /**
   * OPT-IN, off by default. The forecast gap arm: both gap ladders of every scenario
   * again, with the new volume its balance plan makes added from each tranche's origination month. COST LABEL: the
   * balance stage keeps every scenario's minted tranches, and each is generated once more after the walk. `true`
   * writes GapResult.forecast; absent or false writes nothing, so such a run is byte-identical.
   */
  forecastGap?: boolean;
  /**
   * OPT-IN, off by default. Going-concern EVE: each scenario's run-off EVE plus the net
   * value of the new volume its balance plan makes, every tranche over its full life, on the run's discount basis.
   * COST LABEL: as the forecast gap, every scenario's tranches are kept and generated once more after the walk. `true`
   * writes EVEResult.goingConcern; absent or false writes nothing, so such a run is byte-identical.
   * By default it counts the new volume made in the first 12 months, or the NII window when it is shorter (ruling
   * 2026-11-03: forecast errors compound further out).
   */
  goingConcernEve?: boolean;
  /**
   * Read only with `goingConcernEve: true`: the months of new volume going-concern EVE counts, a whole number from 1 to
   * the NII window (`windowMonths`, 60 when absent), never past it. Absent, the default above. Any other value, or the
   * span without the opt-in, is refused before the walk.
   */
  goingConcernSpan?: number;
  /**
   * OPT-IN, off by default. The liquidity stress ladder: the stress
   * table, the buffer and the undrawn face, in dollars and decimals. COST
   * LABEL: one cash-flow generation per inflow-asset and wholesale position on
   * the base scenario's deterministic path, single threaded after the walk.
   * Present writes RunResult.liquidityStress; absent writes nothing, so such a
   * run is byte-identical. A malformed value is refused before the walk.
   */
  liquidityStress?: LiquidityStressOptions;
  /**
   * OPT-IN, off by default (spec decisions 107 to
   * 111). The user bucket setting of the repricing ladder, handed to the gap
   * metric as its trailing argument. Absent, the ladder carries the nine
   * standard bands only and the run is byte-identical. Edges past the grid are
   * refused before the walk.
   */
  gapBuckets?: GapBucketsOption;
  /** The same setting for the liquidity ladder (principal only); absent, nothing is added. */
  liquidityBuckets?: GapBucketsOption;
  /**
   * OPT-IN, off by default. "principal-plus-interest"
   * adds GapLadder.withInterest to every liquidity ladder: the principal ladder
   * plus the contractual interest of the same static run-off pass on its
   * payment date (deposit interest monthly, CD interest with its principal,
   * swap net settlement in). COST LABEL: one more
   * Float64Array per cell in every chunk sink of the contractual pass, and one
   * more top-level fold per scenario. "principal" or absent is the run it
   * always was, byte for byte; any other value is refused before the walk.
   */
  liquidityFlows?: LiquidityFlowsOption;
  /**
   * The NII report horizons, months, strictly ascending, each at most the grid
   * horizon (spec decisions 115 and 116). Absent means the engine default
   * [12, 24]. A list that is empty, out of order or past the grid is refused
   * before the walk, because computeNII would clamp it without a word.
   */
  reportHorizons?: number[];
  /**
   * The NII window in months Results > NII opens on (spec decision 118), a positive whole number at most the
   * grid horizon. Written on the NII block as `windowMonths` only when it is not 60; absent, or 60, writes
   * nothing, so the run is byte-identical. It moves no number. A malformed value is refused before the walk.
   */
  windowMonths?: number;
  /**
   * Observational seam for the server's per-position results pass,
   * called once after the envelope is assembled with the effective books, rate
   * paths and curve legs the walk used. Like onProgress it passes no data back,
   * so its presence cannot move a number; a throwing observer aborts the run.
   * When the environment cannot be built (a scenario with no RatePath on the
   * shelf) the observer receives the Error value and the run still completes.
   */
  onInstrumentEnvironment?: (environment: InstrumentEnvironment | Error) => void;
  /**
   * The mounted plugin context. Absent means the process default,
   * built lazily on first use, so a caller that never touches plugins pays
   * nothing. Every seam is resolved once at the top of buildRunResult; no event
   * fires inside the projection or metric loops, which is the speed rule.
   */
  harness?: Context;
  /**
   * Entries the compiler produced before the run: the profile dump, the catalog
   * and the two gate reports. The run appends its own after them, so one log
   * reads compile-then-run in order.
   */
  planRunLog?: RunLogEntry[];
  /** Hash of the composed profile the harness was mounted from. */
  profileHash?: string;
  /**
   * The compiled plan this run walks. Absent means the pipeline
   * derives the default plan from the request, which replays the pre-1c call
   * order exactly. There is ONE code path: a plan-less run is a run on a derived
   * plan, not a second pipeline.
   */
  plan?: RunPlan;
}

/**
 * Serialized schema version of the RunResult envelope. Additive only:
 * nothing has been renamed or removed at any bump, and a pre-1.5.0
 * consumer keeps working.
 * 1.1.0: typed reinvestment shortfalls on ScenarioNII, the deltaEvePct unit pin,
 * the durationMode echo on EVEResult.
 * 1.2.0: the ftp block, NII byHorizon / netMonthly / totalNetByHorizon
 * and family walYears, the opt-in EVE keyRate / channels blocks.
 * 1.3.0: optional planId / planHash on provenance; optional plan on RunRequest.
 * 1.4.0: optional provenance.runLog and provenance.profileHash.
 * 1.5.0: the run log's `plan` and `stage` arms, and PlanRef.licensedBindings.
 * 1.6.0: the run log's license arm and the stage arm's bindings.
 * 1.7.0: the cell dictionary on the cashflow block, the byCell arms on
 * cashflows, NII, EVE and both gap ladders, and RunResult.views. All optional.
 * 1.8.0: the optional custom arm on RunResult.
 * 1.9.0: the optional seg, liquidityStress, instrumentsFile,
 * nmdConvention, parentOf and nmdWarmup blocks on RunResult, NIIResult.nimPct, and the
 * optional Position fields discountSpreadBp, parentPositionId and repricingTreatment.
 * 1.10.0 (curve default version 2): the optional provenance.curveDefault stamp, written on
 * every run; folded into inputsHash only for a market with no curveSetup and no marker.
 * 1.11.0: the optional GapLadder.userBuckets and NIIResult.windowMonths.
 * 1.12.0: the optional GapLadder.withInterest on the liquidity ladder.
 * 1.13.0: the optional GapResult.fixedRate ladder.
 */
export const RUN_RESULT_SCHEMA_VERSION = "1.13.0";

/**
 * Thrown when a RunRequest carries two AssumptionSets sharing an id. Left
 * unchecked, the second silently overwrites the first in the id lookup and a
 * scenario referencing that id would resolve to whichever set was registered
 * last, a silent wrong-assumptions run (discovery SDN-OBS-1). A collision is an
 * input error the caller must fix, not a number to invent.
 */
export class DuplicateAssumptionSetError extends Error {
  readonly assumptionSetId: string;
  constructor(assumptionSetId: string) {
    super(
      `run: duplicate assumption set id "${assumptionSetId}" in request.assumptionSets; ` +
        `ids must be unique so each scenario's assumptionSetId resolves unambiguously`,
    );
    this.name = "DuplicateAssumptionSetError";
    this.assumptionSetId = assumptionSetId;
  }
}

/** Execute the full pipeline for one request against its resolved portfolio. */
export function buildRunResult(
  request: RunRequest,
  rawPortfolio: PortfolioSpec,
  context: RunPipelineContext,
): RunResult {
  // Reassigned once, below, when the regulatory deposit convention runs.
  let portfolio = rawPortfolio;
  if (portfolio.id !== request.portfolioId) {
    throw new Error(
      `run: resolved portfolio "${portfolio.id}" does not match request portfolioId "${request.portfolioId}"`,
    );
  }
  const baseScenario = request.scenarios.find((s) => s.rateSpec.kind === "base");
  if (!baseScenario) {
    throw new Error('run: no base scenario (a rateSpec of kind "base") is present in the request');
  }
  // Spec E5: a malformed liquidity stress opt-in is refused before any number is computed.
  if (context.liquidityStress !== undefined) {
    const problem = liquidityStressConfigError(context.liquidityStress, "context.liquidityStress");
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  // The SEG knobs are refused here, before any number is computed, as the run route refuses them.
  if (context.segSettings !== undefined) {
    if (context.seg !== true) throw new Error("run: context.segSettings names SEG knobs, but the run does not opt in to seg");
    const problem =
      segSettingsConfigError(context.segSettings, "context.segSettings") ??
      segCprOverlayBookError(context.segSettings, portfolio.coa, "context.segSettings");
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  // Slice three (spec decisions 110, 111, 116 and 118): the bucket settings, the report horizons and the NII window are checked
  // against the grid here, before any number is computed, as the run route checks them.
  for (const [key, value] of [["gapBuckets", context.gapBuckets], ["liquidityBuckets", context.liquidityBuckets]] as const) {
    if (value === undefined) continue;
    const problem = gapBucketsConfigError(value, `context.${key}`, request.grid.horizonMonths);
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  // The liquidity flows setting is checked here as the run route checks it.
  if (context.liquidityFlows !== undefined) {
    const problem = liquidityFlowsConfigError(context.liquidityFlows, "context.liquidityFlows");
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  if (context.reportHorizons !== undefined) {
    const problem = reportHorizonsConfigError(context.reportHorizons, "context.reportHorizons", request.grid.horizonMonths);
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  // The going-concern span, beside the opt-in it tunes, within the NII window (ruling 2026-11-03).
  if (context.goingConcernSpan !== undefined) {
    if (context.goingConcernEve !== true) throw new Error("run: context.goingConcernSpan tunes going-concern EVE; send it with goingConcernEve: true");
    const window = Math.min(context.windowMonths ?? DEFAULT_NII_WINDOW_MONTHS, request.grid.horizonMonths);
    const span = context.goingConcernSpan as unknown;
    if (typeof span !== "number" || !Number.isInteger(span) || span < 1 || span > window) {
      throw new Error(`run: context.goingConcernSpan counts the new volume made in the first months of the earnings horizon: a whole number from 1 to ${window}, got ${JSON.stringify(span)}`);
    }
  }
  if (context.windowMonths !== undefined) {
    const problem = windowMonthsConfigError(context.windowMonths, "context.windowMonths", request.grid.horizonMonths);
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  // The model convention is checked here as the run route checks it; absent is the original convention.
  if (context.modelConvention !== undefined) {
    const problem = modelConventionConfigError(context.modelConvention, "context.modelConvention");
    if (problem !== undefined) throw new Error(`run: ${problem}`);
  }
  const corrections = modelCorrectionsOf(context.modelConvention);
  // Resolve every rate index a floater names, once, before
  // any number is computed. A name the market does not carry is a refusal here
  // (RateIndexRefusedError), never a fallback to the one-month benchmark. A book
  // that names no index never reads the market's block. It is given the index
  // histories a lag reads, and refuses a lag whose history is missing.
  const rateIndices = resolveRunRateIndices(portfolio, request.marketSnapshot, undefined, request.indexHistories ?? []);

  // Resolve every seam once, here, before the walk starts: five gets plus the
  // log, carried into the StageRunEnv below, so every stage function runs on
  // plain references and no seam lookup happens inside a per-position or
  // per-scenario loop. (positions and scenarios are resolved by the compiler
  // and the server, not here: the book and the slate are already on the request
  // by the time the pipeline runs.)
  const harness = context.harness ?? defaultHarness();
  const curves = harness.get("curves");
  const ratePaths = harness.get("ratePaths");
  const behavioral = harness.get("behavioral");
  const metrics = harness.get("metrics");
  const runLog = harness.get("runLog");
  // One buffer per run. A memoized context is reused across runs, so the log is
  // cleared before the compiler's entries are replayed into it.
  runLog.clear();
  for (const entry of context.planRunLog ?? []) runLog.append(entry);
  for (const key of ["curves", "ratePaths", "behavioral", "positions", "scenarios", "metrics", "runLog"] as const) {
    runLog.append({ t: "resolve", key, pluginId: harness.providerOf(key) ?? "<unprovided>", scope: {} });
  }
  // Stamped only when it is known: a compiled run carries the hash of the
  // profile the compiler composed, and a run on the process default derives it
  // from that profile. A caller-mounted context that supplies no hash gets no
  // stamp rather than a guessed one.
  const runProfileHash =
    context.profileHash ?? (isDefaultHarness(harness) ? defaultProfileHash() : undefined);

  // Resolve: bind every assumption set (validate + fill contentHash) and
  // validate it. The curves, the paths and the books are the walk's work.
  context.onProgress?.("resolve");
  const setById = new Map<string, AssumptionSet>();
  for (const set of request.assumptionSets) {
    if (setById.has(set.id)) throw new DuplicateAssumptionSetError(set.id);
    setById.set(set.id, bindAssumptions(set));
  }
  // The run's macro path, resolved once from the base scenario's
  // set; every scenario inherits it or is refused (MacroRefusedError). An
  // unmapped base returns NO_MACRO without reading the market's macro block.
  // Resolved after the bind loop, so a malformed mapping meets the bind's
  // MacroMappingError first, as at the stochastic entry.
  const macro = resolveRunMacro(request, request.marketSnapshot);
  // The ASSUMPTION-SET AXIS, defined once here and read by everything that
  // expands over assumption sets: the ids a scenario REFERENCES, deduplicated,
  // in scenario first-appearance order. A set the request carries but no
  // scenario reaches is not on the axis, so the walker opens no scope for it and
  // the behavioral stage computes no overlay for it. That is pre-1c behaviour:
  // before the walker existed, the per-set overlay call ran for exactly the
  // referenced sets. An id no assumption set defines is skipped rather than
  // refused here; it is the contractual stage's refusal, which names the
  // scenario.
  //
  // Ruling P11, as amended: each set ON THE AXIS is validated ONCE, here, by the
  // same resolver the overlay pass calls (unknown family, an overlay kind the
  // family's instrument type cannot consume, an unregistered behavioral kind, a
  // duplicate kind on one family). A plan with no behavioral stage runs no
  // overlay pass at all, so without this a defective referenced set would reach
  // the contractual pass unchecked; and because the axis is the same list the
  // overlay pass walks, no set is validated that would not have been. The
  // registered kinds are read once, outside the loop: no seam lookup repeats per
  // set.
  const registeredKinds = behavioral.kinds();
  const assumptionSetIds: string[] = [];
  const onAxis = new Set<string>();
  for (const scenario of request.scenarios) {
    const bound = setById.get(scenario.assumptionSetId);
    if (bound === undefined || onAxis.has(scenario.assumptionSetId)) continue;
    onAxis.add(scenario.assumptionSetId);
    assumptionSetIds.push(scenario.assumptionSetId);
    resolveAssumptions(bound, portfolio.coa.families, registeredKinds);
  }
  // Spec E2: the regulatory deposit convention, applied once here, after the
  // sets are bound (the beta at r0 reads the base set's deposit-beta overlay)
  // and before anything reads the book: the plan, the licensing counts, the
  // cell plan and every stage see the transformed book. r0 is the base
  // deterministic path's step-0 rate, built through the same seams the walk
  // uses. An absent or "behavioral" convention leaves `portfolio` untouched.
  // When any set on the axis binds a component decay form, each scenario's level shift is
  // resolved once here, before any convention reshapes the book, and the options that cannot run beside it refuse.
  // A run whose sets bind none resolves nothing and no stage sees a key.
  let componentShifts: ReadonlyMap<string, number> | undefined;
  if (setsBindComponentDecay(assumptionSetIds.map((id) => setById.get(id)!))) {
    componentShifts = resolveComponentDecayShifts(request.scenarios, {
      seg: context.seg,
      keyRate: context.keyRate !== undefined && context.keyRate !== false,
      eveChannels: context.eveChannels,
      ...(context.nmdConvention !== undefined ? { nmdConvention: context.nmdConvention } : {}),
    });
  }
  // When any set on the axis binds a replicating-portfolio credit, the options that cannot
  // run beside it refuse here, before any convention reshapes the book. A run whose sets bind none checks nothing.
  const replicatingPortfolio = setsBindReplicatingPortfolio(assumptionSetIds.map((id) => setById.get(id)!));
  if (replicatingPortfolio) {
    checkReplicatingPortfolioRun(request.scenarios, {
      seg: context.seg,
      keyRate: context.keyRate !== undefined && context.keyRate !== false,
      eveChannels: context.eveChannels,
      ...(context.nmdConvention !== undefined ? { nmdConvention: context.nmdConvention } : {}),
    }, boundCreditForms(assumptionSetIds.map((id) => setById.get(id)!)));
  }
  let parentOf: Record<string, string> | undefined;
  if (context.nmdConvention === "regulatory") {
    const transformed = regulatoryBook(portfolio, request, baseScenario, setById, curves, ratePaths);
    portfolio = transformed.book;
    // A book with no deposit positions splits nothing: the map is left out
    // rather than written empty.
    if (Object.keys(transformed.parentOf).length > 0) parentOf = transformed.parentOf;
  }
  // The shocked-level convention marks each full-form deposit for slotting at the scenario's
  // level. Every deposit without the form is split by the regulatory transform, as the
  // frozen arm splits it, and a book whose deposits carry no form at all is refused; a book of full-form deposits only
  // splits nothing and records no child map, as before. Below, when any set on the axis binds a full form, each
  // scenario's short-rate shift is resolved once; a run whose sets bind none resolves nothing and no stage sees a key.
  if (context.nmdConvention === "shocked-level") {
    const transformed = shockedLevelBook(portfolio, request, baseScenario, setById, curves, ratePaths);
    portfolio = transformed.book;
    if (Object.keys(transformed.parentOf).length > 0) parentOf = transformed.parentOf;
  }
  // The CD corrections ride on the book's terms, marked once here, so every block that builds a CD
  // book (the static pass, the EVE duration legs, the ladders, key rates, the per-position pass) walks one model. The
  // funding spread is the run's own all-in leg, the one the TLP stage builds. A book with no CD is left as it is.
  portfolio = markCdBook(portfolio, corrections, tlpOfSnapshot(request.marketSnapshot));
  let depositShiftByScenario: ReadonlyMap<string, number> | undefined;
  if (setsBindFullForm(assumptionSetIds.map((id) => setById.get(id)!))) {
    depositShiftByScenario = resolveDepositShifts(request.scenarios, {
      seg: context.seg,
      keyRate: context.keyRate !== undefined && context.keyRate !== false,
      eveChannels: context.eveChannels,
    });
  }
  // Both readers resolve the same shift (depositShiftPctOf), so one map serves a book that binds both forms.
  depositShiftByScenario ??= componentShifts;
  // The deposit warmup, resolved once here against the base path's
  // r0 (the same reader the regulatory transform uses) so every stage reads one
  // history per scenario. Absent, nothing is resolved and no stage sees a key.
  let nmdWarmup: ResolvedNmdWarmup | undefined;
  if (context.nmdWarmup !== undefined) {
    if (context.eveChannels === true) {
      throw new Error(
        "run: nmdWarmup cannot run beside eveChannels; the channel decomposition regenerates deposits on the kernel " +
          "warmup series, so drop one of the two options",
      );
    }
    const { r0 } = runBetaAtR0(portfolio, request, baseScenario, setById, curves, ratePaths);
    nmdWarmup = resolveNmdWarmup(context.nmdWarmup, request.scenarios, r0 * 100, request.grid.asOf);
  }
  // The graph this run walks. A compiled plan arrives on the context; a
  // plan-less request derives one from itself. One code path, one walker.
  const derived = context.plan === undefined;
  const fallback = derived ? defaultPlanFor(request, portfolio, behavioral) : undefined;
  const plan = context.plan ?? fallback!.plan;
  // The licensing belongs to the plan being walked, and to no other. A DERIVED
  // plan takes its own licensing, never the PlanRef's: a request compiled from
  // some other plan carries that plan's stage ids, and licensing the derived
  // graph with them would leave every behavioral stage unbound and silently
  // drop every overlay. A COMPILED plan takes the licensing the compiler
  // stamped on the PlanRef, and computes it from the same function the
  // compiler's L1 rule uses when the ref carries none. For the four built-in
  // kinds the computed and the stamped answers agree by construction, because a
  // derived stage's component is the plugin that registered its kind. The
  // exception is a third-party plugin registering TWO kinds: the derived graph
  // then has two stages on one component, and `licenseBindings` reports every
  // binding of either kind as `multi` rather than licensing it.
  // The stamped licensing is taken only when the PlanRef names the very plan
  // being walked: a request compiled from one plan and handed another carries
  // stage ids the graph does not have, and licensing this plan with them would
  // leave every behavioral stage unbound and silently drop every overlay. The
  // hash is compared too when both sides carry one, because a plan edited under
  // the same id is a different graph and its stamp is stale; a plan block with
  // no hash falls back to the id alone rather than recomputing needlessly.
  const stampedForThisPlan =
    request.plan?.planId === plan.planId &&
    (request.plan.planHash === undefined || request.plan.planHash === planHash(plan));
  // Where the licensing is COMPUTED here rather than derived or stamped, this
  // is the only place the L1 rule is asked of this plan, so it is also the only
  // place a gap can be caught. A binding with no licensee, or with two, used to
  // be dropped on the floor and the run answered anyway: a book whose decay
  // model never ran, reported as a result rather than as a refusal. It is now
  // the same refusal the compiler raises, built the same way, ambiguity first.
  let licensedBindings: readonly LicensedBinding[];
  const stamped = stampedForThisPlan ? request.plan!.licensedBindings : undefined;
  if (derived) {
    licensedBindings = fallback!.licensedBindings;
  } else if (stamped !== undefined) {
    licensedBindings = stamped;
  } else {
    const outcome = licenseBindings(plan, request.assumptionSets, portfolio, kindsByPlugin(behavioral));
    const gap = outcome.multi[0] ?? outcome.unlicensed[0];
    if (gap !== undefined) {
      const refusal = new UnlicensedBindingError(
        gap.assumptionSetId,
        gap.familyId,
        gap.kind,
        gap.bindingIndex,
        gap.candidateStageIds,
        gap.uncoveredPositionId,
        gap.licensingComponent,
      );
      runLog.append({
        t: "refuse",
        error: refusal.message,
        ids: {
          layer: "run/license",
          planId: plan.planId,
          assumptionSetId: gap.assumptionSetId,
          familyId: gap.familyId,
          kind: gap.kind,
          bindingIndex: String(gap.bindingIndex),
        },
      });
      refusal.runLog = runLog.entries();
      throw refusal;
    }
    licensedBindings = outcome.licensed;
  }
  // Stages the compile TOLERATED with no mounted plugin (ruling 13) are walked
  // as skipped rather than executed. The rule is the one the gate and the
  // compiler already share (Ruling P9): one definition of executability, asked
  // here of the same mounted profile. The derived default plan names only
  // mounted components, so its tolerated set is empty.
  const unexecutedStageIds = derived
    ? undefined
    : new Set(stageExecutability(plan, registryProducers(harness)).tolerated.map((t) => t.stageId));
  // One license entry per licensed binding, with the positions it
  // matched, computed once here so the walker's stage entry does no per-position
  // work. Whole-family bindings on an untagged book count the family.
  const positionsMatched = new Map<string, number>();
  for (const l of licensedBindings) {
    const set = setById.get(l.assumptionSetId);
    const binding = set?.bindings[l.bindingIndex];
    const n = positionsMatchedBy(portfolio, l.familyId, binding?.selector);
    positionsMatched.set(`${l.assumptionSetId}:${l.bindingIndex}`, n);
    const selector = canonicalPredicate(binding?.selector);
    runLog.append({
      t: "license",
      stageId: l.stageId,
      assumptionSetId: l.assumptionSetId,
      familyId: l.familyId,
      kind: l.kind,
      bindingIndex: l.bindingIndex,
      ...(selector !== "" ? { selector } : {}),
      positionsMatched: n,
    });
  }

  runLog.append({
    t: "plan",
    ...(derived ? {} : { planId: plan.planId }),
    derived,
    stageIds: plan.stages.map((s) => s.id),
  });
  // A mapped run logs one entry per mapped target through the existing
  // resolve arm, so an unmapped run's log is byte-identical.
  if (macro.kind === "path") {
    for (const t of macro.families) {
      runLog.append({ t: "resolve", key: `macro/prepay-housing/${macro.seriesId}/${macroTargetKey(t.familyId, t.selector)}`, pluginId: "engine.macro", scope: {} });
    }
  }

  // ONE cell plan per run, built before any scenario is projected.
  // It is built on the RAW book: applyLicensedOverlays maps positions in place
  // and returns either the same object or a terms-patched copy, so every
  // effective book has the same positions in the same order and one index
  // array serves them all. A view refusal (P1 to P3) is raised here for a
  // plan-less run, and at compile for a planned one.
  const cellPlan = buildCellPlan(portfolio, request.views);

  const env: StageRunEnv = {
    request,
    portfolio,
    cellPlan,
    grid: request.grid,
    horizonMonths: request.grid.horizonMonths,
    baseScenario,
    setById,
    assumptionSetIds,
    shards: context.shards,
    ...(context.durationMode !== undefined ? { durationMode: context.durationMode } : {}),
    ...(context.keyRate !== undefined ? { keyRate: context.keyRate } : {}),
    ...(context.eveChannels !== undefined ? { eveChannels: context.eveChannels } : {}),
    ...(context.discountBasis !== undefined ? { discountBasis: context.discountBasis } : {}),
    ...(context.nmdConvention !== undefined ? { nmdConvention: context.nmdConvention } : {}),
    ...(parentOf !== undefined ? { parentOf } : {}),
    ...(nmdWarmup !== undefined ? { nmdWarmup } : {}),
    ...(context.modelConvention !== undefined ? { modelConvention: context.modelConvention } : {}),
    ...(anyCorrection(corrections) ? { corrections } : {}),
    ...(depositShiftByScenario !== undefined ? { depositShiftByScenario } : {}),
    ...(componentShifts !== undefined ? { componentDecay: true } : {}),
    ...(replicatingPortfolio ? { replicatingPortfolio: true } : {}),
    ...(boundCreditForms(assumptionSetIds.map((id) => setById.get(id)!)).some((f) => f.life !== undefined) ? { creditByScenario: true } : {}),
    ...(context.seg === true ? { seg: true } : {}),
    ...(context.seg === true && context.segSettings !== undefined ? { segSettings: context.segSettings } : {}),
    ...(context.nextResetGap === true ? { nextResetGap: true } : {}),
    ...(context.fixedRateGap === true ? { fixedRateGap: true } : {}),
    ...(context.forecastGap === true ? { forecastGap: true } : {}),
    ...(context.goingConcernEve === true ? { goingConcernEve: true } : {}),
    ...(context.goingConcernEve === true && context.goingConcernSpan !== undefined ? { goingConcernSpan: context.goingConcernSpan } : {}),
    ...(context.liquidityStress !== undefined ? { liquidityStress: context.liquidityStress } : {}),
    ...(context.gapBuckets !== undefined ? { gapBuckets: context.gapBuckets } : {}),
    ...(context.liquidityBuckets !== undefined ? { liquidityBuckets: context.liquidityBuckets } : {}),
    ...(context.liquidityFlows !== undefined ? { liquidityFlows: context.liquidityFlows } : {}),
    ...(context.reportHorizons !== undefined ? { reportHorizons: context.reportHorizons } : {}),
    ...(context.windowMonths !== undefined ? { windowMonths: context.windowMonths } : {}),
    ...(rateIndices !== undefined ? { rateIndices } : {}),
    macro,
    curves,
    ratePaths,
    behavioral,
    metrics,
    licensedBindings,
    positionsMatched,
    shortfalls: new Map(),
    newBusiness: new Map(),
    notImplemented: [],
    log: (entry) => runLog.append(entry),
  };

  // Every CONTEXT_SUPPLIED_TYPES member the request actually supplies (Ruling
  // P8): the book and the snapshot. The third member, CapVolSurface, has
  // nothing to seed today, because neither RunRequest nor MarketSnapshot
  // carries one; when a request gains one it is seeded here, and the stage that
  // consumes it then needs no upstream producer.
  context.onProgress?.("project");
  const executed = executePlan(plan, env, {
    contextArtifacts: { Position: portfolio, MarketSnapshot: request.marketSnapshot },
    ...(unexecutedStageIds !== undefined ? { unexecutedStageIds } : {}),
  });
  // Unreachable on a compiled plan (T6 requires an NII stage and tightened T1
  // requires its Cashflow edge to resolve), and the alternative is an
  // ArtifactMissingError naming an empty producer id, which explains nothing.
  if (executed.primaryCashflowProducer === "") {
    throw new PlanGraphError(
      null,
      'run: no stage produced "NiiResult" from a resolved Cashflow edge, so the plan names no primary cash-flow series',
    );
  }

  context.onProgress?.("report");
  const result = assembleRunResult({
    env,
    shelf: executed.shelf,
    metricProducers: executed.metricProducers,
    customProducers: executed.customProducers,
    primaryCashflowProducer: executed.primaryCashflowProducer,
    resolution: executed.resolution,
    runLog: runLog.entries(),
    ...(runProfileHash !== undefined ? { profileHash: runProfileHash } : {}),
    engineVersion: context.engineVersion,
    kernel: context.kernel,
    schemaVersion: RUN_RESULT_SCHEMA_VERSION,
    ...(context.onInstrumentEnvironment !== undefined
      ? { onInstrumentEnvironment: context.onInstrumentEnvironment }
      : {}),
  });
  context.onProgress?.("done");
  return result;
}
