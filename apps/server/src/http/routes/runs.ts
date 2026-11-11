/**
 * Run routes (design Sections 3.1-3.4): submission composes the full RunRequest
 * server-side from stored artifacts; compute happens only in the spawned child;
 * reads are verbatim slices of the stored result through the engine's own
 * readers. The platform never re-derives a result number and never
 * serves a cached result for a "same" request.
 */
import { statSync } from "node:fs";
import type {
  AssumptionSet,
  GapBucketsOption,
  IndexHistory,
  IndexHistoryEntry,
  InstrumentsFile,
  LensDefinition,
  LensReading,
  ModelConvention,
  NmdWarmupRequest,
  NotImplemented,
  PivotMetric,
  PlanRef,
  PortfolioSpec,
  RunLogEntry,
  RunPlan,
  RunRequest,
  RunResult,
  Scenario,
  SegSettings,
} from "@alm/engine";
import type { Profile } from "@alm/harness";
import {
  DEFAULT_STOCHASTIC_PATHS,
  gapBucketsConfigError,
  liquidityFlowsConfigError,
  indexHistoryIdsRead,
  isEngineReportHorizons,
  LensUnavailableError,
  liquidityStressConfigError,
  liquidityStressOptionsOf,
  MIN_STOCHASTIC_PATHS,
  namedHistoryIdsOf,
  modelConventionConfigError,
  nmdWarmupConfigError,
  nmdWarmupOf,
  niiMonthly,
  niiMonthlyChart,
  NiiMonthlyUnavailableError,
  rollUpRun,
  RollUpOptionsError,
  PATHS_PER_PAIR,
  pivot,
  PivotUnavailableError,
  readLens,
  reportHorizonsConfigError,
  segSettingsConfigError,
  segSettingsOf,
  validateLens,
  windowMonthsConfigError,
  DEFAULT_NII_WINDOW_MONTHS,
  BGM_OVERRIDE_BOUNDS,
  BGM_SHOCK_SENTENCE,
  BgmSubsetError,
  BGM_SUBSET_MIN_POINTS,
  StochasticLongYieldVolsError,
  StochasticGapError,
  STOCHASTIC_GAP_HORIZON_MONTHS,
  refuseGapBeforeSimulation,
  curveFingerprintOf,
  savedCalibrationMismatch,
  savedCalibrationUseOf,
  type SavedCalibration,
  type SavedCalibrationUse,
  type BgmModelOverride,
  type StochasticGapOption,
  type StochasticModel,
  type StochasticModelOverride,
} from "@alm/engine";
import { isDefaultCalibrationSwaption, type MarketSnapshot } from "@alm/kernel";
import { sliceResult, explainResult } from "@alm/engine/src/run";
import { composeAnswer } from "@alm/ai";
import type { PlatformContext } from "../../context";
import type { ResultQuery, ExplainQuery } from "@alm/engine";
import { sha256Hex } from "../../store/store";
import { serveRunEvents } from "../sse";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import { validated, type RouteResult, type Router } from "../router";
import type {
  RunStatus,
  RunWorkspaceStamp,
  StoredEngineContext,
  StoredInstrumentResults,
  StoredRunRequest,
} from "../../jobs/types";
import { instrumentsCsv } from "../../export/instrumentsCsv";
import { rollUpQuery } from "./exportCsv";
import { curveLineOf, stampOfStoredResult, type RunCurveLine } from "../../export/curveLine";
import type { Collection } from "../../store/paths";
import type { ConsumedRole } from "../../workspaces/types";
import { shortRateVolShockLineage, type ShortRateVolShockLineage } from "../../derivedSets/derivedMarkets";
import type { ScenarioSlate } from "./scenarioSlates";

/** Platform seed default: fixed so identical submissions hash identically
 * (numerically inert on the deterministic grid). */
const DEFAULT_SEED = "platform-0";
const DEFAULT_HORIZON_MONTHS = 360;

/**
 * Fixed default seed for STOCHASTIC submissions. The deterministic default
 * ("platform-0") does not parse as an integer, and the kernel PCG32 needs one;
 * a fixed value keeps identical submissions hashing identically. The
 * seed is load-bearing on the stochastic path: it moves every number in the
 * envelope, and an explicit `seed` in the body always wins.
 */
const DEFAULT_STOCHASTIC_SEED = "20260331";

const RESULT_SECTIONS = [
  "nii",
  "eve",
  "gap",
  "ftp",
  "seg",
  "liquidityStress",
  "attribution",
  "cashflows",
  "provenance",
  "notImplemented",
] as const;
type ResultSection = (typeof RESULT_SECTIONS)[number];

/** Run execution modes. "deterministic" is the wave-1 grid; "stochastic" is
 * the W2-A4 Hull-White Monte Carlo emitting the SEPARATE envelope. */
const RUN_MODES = ["deterministic", "stochastic"] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Stochastic options persisted verbatim into request.json for the child. */
export interface StoredStochasticSpec {
  /** Monte Carlo path count — a REQUEST field, never silently reduced. */
  nPaths: number;
  /**
   * The rate model, stored verbatim when
   * the submission named one. Absent means "hull-white-1f": an HW post with no
   * `model` writes no key, so its request.json is the one it always was.
   */
  model?: StochasticModel;
  /** Explicit model parameters instead of a market calibration (verification seam;
   * the envelope records source "override", it can never read as a market fit):
   * {a, sigma, reason} for Hull-White, the Rebonato six and a reason for BGM. */
  modelParams?: StochasticModelOverride | BgmModelOverride;
  /**
   * The gap distributions option, stored verbatim ({ enabled: true }) when the submission named it and
   * the engine's refusals passed. Absent writes no key, so a run without it stores the request.json it always did.
   */
  gap?: StochasticGapOption;
  /** The saved calibration the run uses, by id, written only when the submission named one. */
  calibrationId?: string;
  /** What the run reads of it (parameters, diagnostics, acceptance, pins), verbatim, so the child never reads the store. */
  savedCalibration?: SavedCalibrationUse;
}

/** The two rate models a stochastic submission may name. */
const STOCHASTIC_MODELS: readonly StochasticModel[] = ["hull-white-1f", "bgm-lmm-2f"];

/** The BGM override's numeric fields, in stored order. */
const BGM_OVERRIDE_FIELDS = ["a", "b", "c", "d", "beta", "volScalar"] as const;

/**
 * The measured cost of a 256-path stochastic run on this Mac (every figure below was measured: the slice-two Task 0 baseline on a quiet machine
 * and the bench and demo-book runs under load, both on 17 October 2026).
 * Named in the 202 cost note so the caller sees what each model has cost on two
 * books of known size. Reported, not a promise: wall clock moves with the machine
 * and its load, which is why the figures are ranges.
 */
const MEASURED_STOCHASTIC_COST: Record<StochasticModel, string> = {
  "hull-white-1f":
    "measured on this Mac at 256 paths: about 19 s to 33 s on the 471-position bench book and about 80 s to " +
    "125 s on the 2,351-position demo book (the spread is machine load)",
  "bgm-lmm-2f":
    "measured on this Mac at 256 paths: about 5 s to 10 s on the 471-position bench book (Hull-White about " +
    "19 s to 33 s) and about 20 s on the 2,351-position demo book (Hull-White about 80 s to 125 s); of that, " +
    "a fixed cost of about 3.4 s to 6.6 s (the upper end under load) for the calibration, the 360-month " +
    "simulation and the discount factors, and each path projects in about a tenth to an eighth of the " +
    "Hull-White time",
};

const MODEL_WORDS: Record<StochasticModel, string> = {
  "hull-white-1f": "the Hull-White one-factor model (hull-white-1f)",
  "bgm-lmm-2f": "the BGM model (bgm-lmm-2f)",
};

/**
 * The stored request.json shape including the run mode. Extends the wave-1
 * StoredRunRequest additively: request.json files written before this field
 * existed read back as deterministic. The canonical home for `mode` is
 * jobs/types.ts (unowned this wave — see the report NOTE); until it
 * absorbs the field, this intersection type is duplicated in
 * jobs/runnerEntry.ts and the two must stay in sync.
 */
type StoredRunRequestV2 = StoredRunRequest & {
  mode?: RunMode;
  stochastic?: StoredStochasticSpec;
};

export interface SubmitBody {
  portfolioId?: string;
  marketId?: string;
  scenarioSlateId?: string;
  assumptionSetIds?: string[];
  /** Single-value convenience shape; normalized into assumptionSetIds. */
  assumptionSetId?: string;
  gridHorizonMonths?: number;
  seed?: string;
  engineOptions?: {
    durationMode?: string;
    shards?: number | string;
    keyRate?: boolean;
    eveChannels?: boolean;
    discountBasis?: string;
    nmdConvention?: string;
    nmdWarmup?: unknown;
    /** "corrected-v1" or "book"; absent is the original convention. */
    modelConvention?: unknown;
    seg?: boolean;
    /** The SEG block's shock, horizon, NII shock and cohort-0 CPR overlay; needs `seg: true`. */
    segSettings?: unknown;
    nextResetGap?: boolean;
    /** The fixed-rate (rate-locked) gap ladder. */
    fixedRateGap?: boolean;
    /** The forecast gap arm and going-concern EVE. */
    forecastGap?: boolean;
    goingConcernEve?: boolean;
    /** The months of new volume going-concern EVE counts, 1 to the NII window; needs `goingConcernEve: true`. */
    goingConcernSpan?: number;
    liquidityStress?: unknown;
    /** Each ladder's user bucket setting, and the NII report horizons (checked against the grid). */
    gapBuckets?: unknown;
    liquidityBuckets?: unknown;
    /** "principal" (the default, not stored) or "principal-plus-interest". */
    liquidityFlows?: unknown;
    reportHorizons?: unknown;
    /** The NII window in months Results > NII opens on (checked against the grid). */
    windowMonths?: unknown;
  };
  /**
   * Per-position results: `save: true` makes the child write
   * instruments.json after result.json. `coaNodeIds` limits it to the positions
   * under those chart-of-accounts nodes; absent means every position.
   */
  instrumentResults?: { save?: boolean; coaNodeIds?: string[] };
  label?: string;
  /** Run mode; omitted means "deterministic" (backward compatible). */
  mode?: string;
  /** Stochastic options; admissible only with mode "stochastic". */
  stochastic?: { nPaths?: unknown; model?: unknown; modelParams?: unknown; gap?: unknown; calibrationId?: unknown };
  /**
   * Plan identity when submitted through /api/plans/run; stamped into the
   * RunRequest and provenance. The compiler's own PlanRef, whose two ruling-14
   * hashes are optional, so a body carrying only { planId, planHash } still
   * submits while a compiled one carries the policy hash through to the wire.
   */
  plan?: PlanRef;
  /** Compile-time NotImplemented tags from a plan submission; stored for the
   * child to merge into the result envelope (never recomputed here). */
  planTags?: NotImplemented[];
  /** Compile-time run-log entries from a plan submission; the child replays them. */
  planRunLog?: RunLogEntry[];
  /** Hash of the composed profile the plan compiled against. */
  profileHash?: string;
  /**
   * The composed profile itself (the plan's rows after the request's patch
   * layers). Persisted because the run executes in a CHILD process: without the
   * rows, the child would fall back to the built-in default and could compute
   * numbers under a different tree than the one the gates ran on.
   */
  profile?: Profile;
  /** The compiled plan document, persisted so the child walks the same graph. */
  planDocument?: RunPlan;
  /**
   * Studio A+E contracts 1 and 2: set only by the workspace launch route. When present,
   * every document this submission reads is hashed as read and refused 409 when it does
   * not match the pin the setup compile consumed, before request.json is written.
   */
  workspace?: RunWorkspaceStamp;
}

/**
 * Accept both submission shapes for the assumption-set reference: the canonical
 * `assumptionSetIds` (non-empty array of stored ids) and the natural
 * single-value `assumptionSetId` (one id). Anything else is refused with a
 * message that names the expected field and shape — a practitioner hitting this
 * API should not have to read the source to learn the payload.
 */
function resolveAssumptionSetIds(body: SubmitBody): string[] {
  const { assumptionSetIds, assumptionSetId } = body;
  if (assumptionSetIds !== undefined && assumptionSetId !== undefined) {
    if (
      !Array.isArray(assumptionSetIds) ||
      typeof assumptionSetId !== "string" ||
      !assumptionSetIds.includes(assumptionSetId)
    ) {
      throw badRequest(
        `run submission carries both "assumptionSetIds" and "assumptionSetId" and they disagree; ` +
          `send one of them (assumptionSetIds: non-empty array of stored assumption-set ids, ` +
          `or assumptionSetId: one stored id)`,
      );
    }
    return assumptionSetIds;
  }
  if (assumptionSetId !== undefined) {
    if (typeof assumptionSetId !== "string" || assumptionSetId.length === 0) {
      throw badRequest(
        `"assumptionSetId" must be one stored assumption-set id (a non-empty string); ` +
          `got ${JSON.stringify(assumptionSetId)}. To run several sets, send ` +
          `"assumptionSetIds" as a non-empty string array instead.`,
      );
    }
    return [assumptionSetId];
  }
  if (!Array.isArray(assumptionSetIds) || assumptionSetIds.length === 0 ||
      assumptionSetIds.some((x) => typeof x !== "string" || x.length === 0)) {
    throw badRequest(
      `run submission requires "assumptionSetIds" (a non-empty array of stored assumption-set ids, ` +
        `e.g. ["demo-behavioral-v1"]) or "assumptionSetId" (a single stored id); ` +
        `got ${assumptionSetIds === undefined ? "neither field" : JSON.stringify(assumptionSetIds)}`,
    );
  }
  return assumptionSetIds;
}

/** Resolve and validate the run mode field. Typed 422 on anything unknown. */
function resolveMode(body: SubmitBody): RunMode {
  const mode = body.mode ?? "deterministic";
  if (!(RUN_MODES as readonly string[]).includes(mode)) {
    throw unprocessable(
      `mode must be one of ${RUN_MODES.map((m) => `"${m}"`).join(", ")}, got "${String(body.mode)}"`,
    );
  }
  return mode as RunMode;
}

/**
 * Validate a stochastic submission at the route, so every refusal the engine
 * would make in the child surfaces as a typed 422 at submission time — never a
 * 500, never a run that queues only to die (the refusal set carried to the
 * platform arm):
 *
 *   - path count: even integer >= MIN_STOCHASTIC_PATHS, NEVER silently reduced;
 *     counts above the default sit behind RUN_PERF with an honest cost label;
 *   - seed must parse as an integer for the kernel PCG32;
 *   - Hull-White: no at-the-money column on the short-rate volatility surface
 *     and no explicit override -> refusal (no guessed vol);
 *   - BGM: the model value in words;
 *     an override of the BGM shape inside its bounds; a shocked or broken
 *     lineage refused with or without an override; with no override, an empty
 *     long-yield volatility surface or a thin default subset refused;
 *   - the slate must carry a base scenario (base only), and that
 *     scenario must be static runoff (dynamic new business refuses);
 *   - a modelParams override on a market whose derivedFrom lineage holds a
 *     short-rate volatility shock refuses, because the override
 *     skips the calibration that reads those volatilities and the shock would
 *     be silently ignored; a lineage that cannot be followed refuses too;
 *   - slice 4b, `stochastic.gap`: the engine's own refusal sequence, in its
 *     order and words (option shape and unknown keys, BGM, a grid under 121
 *     months, more than 100,000 position-paths), right after the path count,
 *     the seed and the model value, as the engine runs it.
 */
function resolveStochasticSpec(
  body: SubmitBody,
  market: MarketSnapshot,
  slate: ScenarioSlate,
  seed: string,
  volLineage: ShortRateVolShockLineage,
  gridHorizonMonths: number,
  bookPositions: () => number,
  saved?: SavedCalibrationUse,
): StoredStochasticSpec {
  const raw = body.stochastic ?? {};
  const nPathsRaw = raw.nPaths ?? DEFAULT_STOCHASTIC_PATHS;
  if (typeof nPathsRaw !== "number" || !Number.isInteger(nPathsRaw)) {
    throw unprocessable(
      `stochastic.nPaths must be an integer, got ${JSON.stringify(nPathsRaw)}. ` +
        `Path count must be an even integer >= ${MIN_STOCHASTIC_PATHS} ` +
        `(antithetic pairs; p5/p95 quantile support).`,
    );
  }
  if (nPathsRaw % PATHS_PER_PAIR !== 0 || nPathsRaw < MIN_STOCHASTIC_PATHS) {
    throw unprocessable(
      `stochastic.nPaths=${nPathsRaw} is inadmissible: path count must be an even ` +
        `integer >= ${MIN_STOCHASTIC_PATHS} (antithetic pairs; p5/p95 quantile ` +
        `support — a finer tail than the sample supports is refused, not extrapolated). ` +
        `The platform never silently adjusts a requested path count.`,
    );
  }
  if (nPathsRaw > DEFAULT_STOCHASTIC_PATHS && process.env.RUN_PERF === undefined) {
    throw unprocessable(
      `stochastic.nPaths=${nPathsRaw} exceeds the default ${DEFAULT_STOCHASTIC_PATHS} and ` +
        `RUN_PERF is not set in the server environment. Heavier path counts are ` +
        `cost-gated: each path re-projects the full book once, so cost ` +
        `scales linearly in positions x paths. At ${DEFAULT_STOCHASTIC_PATHS} paths this Mac ` +
        `measured about 19 s to 33 s (Hull-White) and 5 s to 10 s (BGM) on a 471-position ` +
        `book, and about 80 s to 125 s (Hull-White) and 20 s (BGM) on a 2,351-position ` +
        `book. Start the platform with RUN_PERF=1 to authorize, or lower ` +
        `nPaths. The requested count is never silently reduced.`,
    );
  }

  try {
    BigInt(seed);
  } catch {
    throw unprocessable(
      `stochastic runs require an integer seed for the kernel PCG32; seed "${seed}" ` +
        `does not parse and the platform does not substitute one. Omit the seed to use ` +
        `the fixed default "${DEFAULT_STOCHASTIC_SEED}", or supply an integer string.`,
    );
  }

  const model = resolveStochasticModel(raw.model);
  const gap = resolveGapOption(raw.gap, model ?? "hull-white-1f", nPathsRaw, gridHorizonMonths, bookPositions);
  // A saved fit is checked by the caller (its model, its snapshot, its curve) and stands in for a calibration.
  const savedArm = saved !== undefined ? { calibrationId: saved.calibrationId, savedCalibration: saved } : {};
  if (model === "bgm-lmm-2f") {
    const bgmParams = raw.modelParams !== undefined ? resolveBgmOverride(raw.modelParams) : undefined;
    refuseBgmLineage(body.marketId!, volLineage);
    if (bgmParams === undefined && saved === undefined) refuseBgmSurface(market);
    refuseStaticBase(slate);
    return { nPaths: nPathsRaw, model, ...(bgmParams !== undefined ? { modelParams: bgmParams } : {}), ...savedArm };
  }

  let modelParams: StochasticModelOverride | undefined;
  if (raw.modelParams !== undefined) {
    // A null or non-object override reads as an empty one, so it meets the shape refusal below, never a TypeError.
    const mp = (typeof raw.modelParams === "object" && raw.modelParams !== null ? raw.modelParams : {}) as Record<string, unknown>;
    const a = mp.a;
    const sigma = mp.sigma;
    const reason = mp.reason;
    if (
      typeof a !== "number" || !Number.isFinite(a) ||
      typeof sigma !== "number" || !Number.isFinite(sigma) || sigma < 0 ||
      typeof reason !== "string" || reason.length === 0
    ) {
      throw unprocessable(
        `stochastic.modelParams must be { a: finite number, sigma: finite number >= 0, ` +
          `reason: non-empty string } (an explicit Hull-White override, recorded verbatim ` +
          `in the envelope as source "override"); got ${JSON.stringify(raw.modelParams)}`,
      );
    }
    if (volLineage.kind === "shocked") {
      throw unprocessable(
        `stochastic run refused: market "${body.marketId}" carries a short-rate volatility shock ` +
          `(applied in market "${volLineage.linkId}" on base "${volLineage.baseId}"); ` +
          `stochastic.modelParams skips the Hull-White calibration on those volatilities, so the ` +
          `shock would be silently ignored. Drop modelParams to calibrate on the shocked ` +
          `volatilities, or run the override on a market without a volatility shock.`,
      );
    }
    if (volLineage.kind === "broken") {
      throw unprocessable(
        `stochastic run refused: market "${body.marketId}" is derived, and its lineage cannot be ` +
          `followed past "${volLineage.linkId}" (base "${volLineage.missingBaseId}" is not in the store), ` +
          `so the platform cannot confirm it carries no short-rate volatility shock that ` +
          `stochastic.modelParams would silently ignore. Drop modelParams, or run the override on a ` +
          `market whose lineage is stored.`,
      );
    }
    modelParams = { a, sigma, reason };
  } else if (saved === undefined && !market.capQuotes.some((q) => q.isAtm)) {
    throw unprocessable(
      `stochastic run refused: the referenced market snapshot carries no at-the-money column ` +
        `on its short-rate volatility surface, so the Hull-White calibration has no volatility ` +
        `target and the engine does not guess one. Reference a snapshot whose short-rate ` +
        `volatility surface carries an at-the-money column, or supply an explicit ` +
        `stochastic.modelParams override.`,
    );
  }

  refuseStaticBase(slate);
  return {
    nPaths: nPathsRaw,
    ...(model !== undefined ? { model } : {}),
    ...(modelParams !== undefined ? { modelParams } : {}),
    ...(gap !== undefined ? { gap } : {}),
    ...savedArm,
  };
}

/**
 * The gap option through the engine's own refusal sequence (refuseGapBeforeSimulation), so the route
 * refuses what the child would, in the same order and the same words, as a typed 422 before request.json is
 * written. The size cap counts the positions of the stored book the child is handed; the book is read only when
 * the option is present. Absent (JSON carries no undefined) is no gap.
 */
function resolveGapOption(
  raw: unknown,
  model: StochasticModel,
  nPaths: number,
  gridHorizonMonths: number,
  bookPositions: () => number,
): StochasticGapOption | undefined {
  if (raw === undefined) return undefined;
  try {
    // The option's shape first, so a malformed option never reads the book.
    refuseGapBeforeSimulation(raw, model, 0, nPaths, gridHorizonMonths);
    return refuseGapBeforeSimulation(raw, model, bookPositions(), nPaths, gridHorizonMonths);
  } catch (err) {
    if (err instanceof StochasticGapError) throw unprocessable(err.message, { error: err.name });
    throw err;
  }
}

/**
 * The model a submission names: undefined when absent (Hull-White, and no key is
 * written), else one of the two values verbatim; anything else is a 422 in words.
 */
function resolveStochasticModel(raw: unknown): StochasticModel | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(STOCHASTIC_MODELS as readonly string[]).includes(raw)) {
    throw unprocessable(
      `stochastic.model must be one of ${STOCHASTIC_MODELS.map((m) => `"${m}"`).join(", ")} ` +
        `(absent means "hull-white-1f"); got ${JSON.stringify(raw)}. The platform does not ` +
        `substitute a model for one it does not know.`,
    );
  }
  return raw as StochasticModel;
}

/**
 * A BGM override: exactly the six Rebonato values and a
 * reason, each value finite and inside BGM_OVERRIDE_BOUNDS; displacement and CEV
 * stay at the engine of record and cannot be supplied. Any other shape, the
 * Hull-White {a, sigma, reason} included, is a 422 naming the field.
 */
function resolveBgmOverride(raw: unknown): BgmModelOverride {
  const shape =
    `{ a, b, c, d, beta, volScalar, reason } (the Rebonato parameters of the BGM model ` +
    `(bgm-lmm-2f) and a non-empty reason, recorded verbatim in the envelope as source "override"; ` +
    `displacement and CEV stay at the default engine)`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw unprocessable(`stochastic.modelParams for a BGM run must be ${shape}; got ${JSON.stringify(raw)}`);
  }
  const mp = raw as Record<string, unknown>;
  const allowed = new Set<string>([...BGM_OVERRIDE_FIELDS, "reason"]);
  const unknown = Object.keys(mp).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw unprocessable(
      `stochastic.modelParams for a BGM run must be ${shape}; it carries ` +
        `${unknown.map((k) => `"${k}"`).join(", ")}, which the BGM override does not take ` +
        `(a, sigma and reason is the Hull-White override shape); got ${JSON.stringify(raw)}`,
    );
  }
  const values = {} as Record<(typeof BGM_OVERRIDE_FIELDS)[number], number>;
  for (const field of BGM_OVERRIDE_FIELDS) {
    const [lo, hi] = BGM_OVERRIDE_BOUNDS[field];
    const v = mp[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      throw unprocessable(
        `stochastic.modelParams.${field} must be a finite number in [${lo}, ${hi}] (the BGM override ` +
          `bounds); got ${JSON.stringify(v ?? null)}`,
      );
    }
    values[field] = v;
  }
  const reason = mp.reason;
  if (typeof reason !== "string" || reason.length === 0) {
    throw unprocessable(
      `stochastic.modelParams.reason must be a non-empty string stating why the BGM parameters are ` +
        `supplied; got ${JSON.stringify(reason ?? null)}`,
    );
  }
  return { ...values, reason };
}

/**
 * BGM on a market whose lineage carries a short-rate volatility op at any link is
 * refused, with or without an override (decision 84 c): BGM reads the long-yield
 * surface, so the shock would go unread. A lineage that cannot be followed is
 * refused in the HW sentence, naming the model.
 */
function refuseBgmLineage(marketId: string, volLineage: ShortRateVolShockLineage): void {
  if (volLineage.kind === "shocked") {
    throw unprocessable(
      `stochastic run refused for market "${marketId}" (the shock was applied in market ` +
        `"${volLineage.linkId}" on base "${volLineage.baseId}"): ${BGM_SHOCK_SENTENCE}`,
    );
  }
  if (volLineage.kind === "broken") {
    throw unprocessable(
      `stochastic run refused: market "${marketId}" is derived, and its lineage cannot be ` +
        `followed past "${volLineage.linkId}" (base "${volLineage.missingBaseId}" is not in the store), ` +
        `so the platform cannot confirm it carries no short-rate volatility shock that ` +
        `${MODEL_WORDS["bgm-lmm-2f"]} would silently ignore. Run the BGM model on a market whose ` +
        `lineage is stored.`,
    );
  }
}

/**
 * BGM with no override calibrates on the default subset of the long-yield
 * volatility surface: an empty surface and a subset below BGM_SUBSET_MIN_POINTS
 * are refused before queueing, in the engine's own words (decision 84 a and b).
 */
function refuseBgmSurface(market: MarketSnapshot): void {
  const quotes = market.swaptionATMQuotes ?? [];
  const words = (err: Error): string => err.message.replace(/^stochastic\.calibration: /, "");
  if (quotes.length === 0) {
    throw unprocessable(`stochastic run refused: ${words(new StochasticLongYieldVolsError())}`);
  }
  const found = quotes.filter(isDefaultCalibrationSwaption).length;
  if (found < BGM_SUBSET_MIN_POINTS) {
    throw unprocessable(`stochastic run refused: ${words(new BgmSubsetError(found))}`);
  }
}

/** Base scenario only, static runoff only, for either model. */
function refuseStaticBase(slate: ScenarioSlate): void {
  const base = slate.scenarios.find((s: Scenario) => s.rateSpec.kind === "base");
  if (!base) {
    throw unprocessable(
      `stochastic run refused: the scenario slate carries no base scenario (a rateSpec ` +
        `of kind "base"). Stochastic distributions are computed for the base scenario ` +
        `only this window; shocked-scenario distributions await the ` +
        `shocked-NII convention migration.`,
    );
  }
  if (base.newBusiness.mode !== "static") {
    throw unprocessable(
      `stochastic run refused: base scenario "${base.id}" requests dynamic new ` +
        `business; the stochastic mode projects static runoff only this window ` +
        ` and refuses rather than silently dropping the reinvestment rules.`,
    );
  }
}

let runSeq = 0;

/** Wall-clock run id: sortable, filename-safe, unique per process. */
function newRunId(): string {
  const now = new Date();
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  runSeq += 1;
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return (
    `run-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1, 2)}${p(now.getUTCDate(), 2)}-` +
    `${p(now.getUTCHours(), 2)}${p(now.getUTCMinutes(), 2)}${p(now.getUTCSeconds(), 2)}-` +
    `${p(runSeq % 1000, 3)}${rand}`
  );
}

/**
 * The stored copy of a validated liquidity stress opt-in: the known
 * fields only, in a fixed order, so an extra key in the body never reaches
 * request.json and two equal submissions store equal bytes.
 */
function liquidityStressOf(raw: unknown): NonNullable<StoredEngineContext["liquidityStress"]> {
  // The engine's stored copy, which keeps a 1.9.0 opt-in's keys and order.
  return liquidityStressOptionsOf(raw);
}

/**
 * The stored copy of a validated bucket setting: the known fields only, so an extra key in the body
 * never reaches request.json.
 */
function gapBucketsOf(raw: unknown): GapBucketsOption {
  const v = raw as GapBucketsOption;
  return v.kind === "custom" ? { kind: "custom", edgesMonths: [...v.edgesMonths] } : { kind: "monthly" };
}

/**
 * Validate and normalize a submission's engine options into the stored context. `gridHorizonMonths` is the
 * submission's grid, which the bucket edges and the report horizons are held to.
 */
export function resolveEngineOptions(raw: SubmitBody["engineOptions"], gridHorizonMonths: number): StoredEngineContext {
  const durationMode = raw?.durationMode ?? "base-only";
  if (durationMode !== "base-only" && durationMode !== "per-scenario") {
    throw unprocessable(
      `engineOptions.durationMode must be "base-only" or "per-scenario", got "${String(raw?.durationMode)}"`,
    );
  }
  const shards = raw?.shards ?? "auto";
  if (shards !== "auto" && (!Number.isInteger(shards) || (shards as number) < 1)) {
    throw unprocessable(
      `engineOptions.shards must be a positive integer or "auto", got "${String(raw?.shards)}"`,
    );
  }
  for (const key of ["keyRate", "eveChannels", "seg", "nextResetGap", "fixedRateGap", "forecastGap", "goingConcernEve"] as const) {
    if (raw?.[key] !== undefined && typeof raw[key] !== "boolean") {
      throw unprocessable(`engineOptions.${key} must be a boolean, got "${String(raw[key])}"`);
    }
  }
  // The going-concern span, beside the opt-in it tunes, within the NII window (ruling 2026-11-03).
  if (raw?.goingConcernSpan !== undefined) {
    if (raw.goingConcernEve !== true) throw unprocessable("engineOptions.goingConcernSpan tunes going-concern EVE; send it with engineOptions.goingConcernEve: true");
    const window = Math.min(typeof raw.windowMonths === "number" ? raw.windowMonths : DEFAULT_NII_WINDOW_MONTHS, gridHorizonMonths);
    const span = raw.goingConcernSpan as unknown;
    if (typeof span !== "number" || !Number.isInteger(span) || span < 1 || span > window) {
      throw unprocessable(`engineOptions.goingConcernSpan counts the new volume made in the first months of the earnings horizon: a whole number from 1 to ${window}, got ${JSON.stringify(span)}`);
    }
  }
  const discountBasis = raw?.discountBasis ?? "all-in";
  if (discountBasis !== "all-in" && discountBasis !== "risk-free" && discountBasis !== "spread-consistent") {
    throw unprocessable(
      `engineOptions.discountBasis must be "all-in", "risk-free" or "spread-consistent", got "${String(raw?.discountBasis)}"`,
    );
  }
  const nmdConvention = raw?.nmdConvention ?? "behavioral";
  if (nmdConvention !== "behavioral" && nmdConvention !== "regulatory" && nmdConvention !== "shocked-level") {
    throw unprocessable(
      `engineOptions.nmdConvention must be "behavioral", "regulatory" or "shocked-level", got "${String(raw?.nmdConvention)}"`,
    );
  }
  if (raw?.liquidityStress !== undefined) {
    const problem = liquidityStressConfigError(raw.liquidityStress, "engineOptions.liquidityStress");
    if (problem !== undefined) throw unprocessable(problem);
  }
  if (raw?.nmdWarmup !== undefined) {
    const problem = nmdWarmupConfigError(raw.nmdWarmup, "engineOptions.nmdWarmup");
    if (problem !== undefined) throw unprocessable(problem);
  }
  if (raw?.modelConvention !== undefined) {
    const problem = modelConventionConfigError(raw.modelConvention, "engineOptions.modelConvention");
    if (problem !== undefined) throw unprocessable(problem);
  }
  // The engine's own check, and the knobs only beside the opt-in they tune.
  if (raw?.segSettings !== undefined) {
    if (raw.seg !== true) throw unprocessable("engineOptions.segSettings tunes the SEG block; send it with engineOptions.seg: true");
    const problem = segSettingsConfigError(raw.segSettings, "engineOptions.segSettings");
    if (problem !== undefined) throw unprocessable(problem);
  }
  for (const key of ["gapBuckets", "liquidityBuckets"] as const) {
    if (raw?.[key] === undefined) continue;
    const problem = gapBucketsConfigError(raw[key], `engineOptions.${key}`, gridHorizonMonths);
    if (problem !== undefined) throw unprocessable(problem);
  }
  // "principal" is what a run gets without asking, so only "principal-plus-interest" is stored.
  let liquidityFlows: "principal-plus-interest" | undefined;
  if (raw?.liquidityFlows !== undefined) {
    const problem = liquidityFlowsConfigError(raw.liquidityFlows, "engineOptions.liquidityFlows");
    if (problem !== undefined) throw unprocessable(problem);
    if (raw.liquidityFlows === "principal-plus-interest") liquidityFlows = "principal-plus-interest";
  }
  let reportHorizons: number[] | undefined;
  if (raw?.reportHorizons !== undefined) {
    const problem = reportHorizonsConfigError(raw.reportHorizons, "engineOptions.reportHorizons", gridHorizonMonths);
    if (problem !== undefined) throw unprocessable(problem);
    // The engine's own list [12, 24] is what a run gets without asking, so it is not stored.
    const rh = raw.reportHorizons as number[];
    if (!isEngineReportHorizons(rh)) reportHorizons = [...rh];
  }
  let windowMonths: number | undefined;
  if (raw?.windowMonths !== undefined) {
    const problem = windowMonthsConfigError(raw.windowMonths, "engineOptions.windowMonths", gridHorizonMonths);
    if (problem !== undefined) throw unprocessable(problem);
    // 60 is the window a run opens on without asking, so it is not stored.
    if (raw.windowMonths !== DEFAULT_NII_WINDOW_MONTHS) windowMonths = raw.windowMonths as number;
  }
  return {
    durationMode,
    shards: shards as number | "auto",
    ...(raw?.keyRate === true ? { keyRate: true as const } : {}),
    ...(raw?.eveChannels === true ? { eveChannels: true as const } : {}),
    ...(discountBasis !== "all-in" ? { discountBasis } : {}),
    ...(nmdConvention === "regulatory" || nmdConvention === "shocked-level" ? { nmdConvention } : {}),
    ...(raw?.nmdWarmup !== undefined ? { nmdWarmup: nmdWarmupOf(raw.nmdWarmup as NmdWarmupRequest) } : {}),
    ...(raw?.modelConvention !== undefined ? { modelConvention: raw.modelConvention as ModelConvention } : {}),
    ...(raw?.seg === true ? { seg: true as const } : {}),
    ...(raw?.segSettings !== undefined ? { segSettings: segSettingsOf(raw.segSettings as SegSettings) } : {}),
    ...(raw?.nextResetGap === true ? { nextResetGap: true as const } : {}),
    ...(raw?.fixedRateGap === true ? { fixedRateGap: true as const } : {}),
    ...(raw?.forecastGap === true ? { forecastGap: true as const } : {}),
    ...(raw?.goingConcernEve === true ? { goingConcernEve: true as const } : {}),
    ...(raw?.goingConcernEve === true && raw.goingConcernSpan !== undefined ? { goingConcernSpan: raw.goingConcernSpan } : {}),
    ...(raw?.liquidityStress !== undefined ? { liquidityStress: liquidityStressOf(raw.liquidityStress) } : {}),
    ...(raw?.gapBuckets !== undefined ? { gapBuckets: gapBucketsOf(raw.gapBuckets) } : {}),
    ...(raw?.liquidityBuckets !== undefined ? { liquidityBuckets: gapBucketsOf(raw.liquidityBuckets) } : {}),
    ...(liquidityFlows !== undefined ? { liquidityFlows } : {}),
    ...(reportHorizons !== undefined ? { reportHorizons } : {}),
    ...(windowMonths !== undefined ? { windowMonths } : {}),
  };
}

/**
 * The stored copy of a validated per-position results opt-in: the
 * known fields only, written only when `save` is true, so a submission that did
 * not ask stores the request it always did and `save: false` is the same as
 * leaving the block out. An empty `coaNodeIds` is the same as leaving it out.
 */
function resolveInstrumentResults(raw: SubmitBody["instrumentResults"]): StoredInstrumentResults | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw unprocessable("instrumentResults must be an object { save, coaNodeIds? }, got " + JSON.stringify(raw));
  }
  if (typeof raw.save !== "boolean") {
    throw unprocessable("instrumentResults.save must be a boolean, got \"" + String(raw.save) + "\"");
  }
  const ids = raw.coaNodeIds;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || x.length === 0)) {
      throw unprocessable("instrumentResults.coaNodeIds must be an array of chart-of-accounts node ids (non-empty strings)");
    }
  }
  if (!raw.save) return undefined;
  return { save: true, ...(ids !== undefined && ids.length > 0 ? { coaNodeIds: [...ids] } : {}) };
}

/**
 * Compose and enqueue one run from stored artifact ids. Extracted from the
 * POST /api/runs handler so a plan run (POST /api/plans/run) goes through the
 * SAME submission path: the child, the store layout and the catalog see
 * nothing new, and a plan-submitted run differs only by the `plan` stamp.
 *
 * `views` is the compiled plan's views. Only POST /api/plans/run passes them,
 * after compile has checked them (rules P1 to P3 and the cell budget).
 * POST /api/runs never does, so a views key in a raw run body is ignored.
 */
export function submitRun(
  ctx: PlatformContext,
  body: SubmitBody,
  views?: RunRequest["views"],
): RouteResult {
  const { store, queue } = ctx;
  const missing = (["portfolioId", "marketId", "scenarioSlateId"] as const).filter(
    (k) => typeof body[k] !== "string",
  );
  if (missing.length > 0) {
    throw badRequest(
      `run submission requires string fields: ${missing.join(", ")} ` +
        `(each the id of a stored artifact)`,
    );
  }
  const assumptionSetIds = resolveAssumptionSetIds(body);
  const mode = resolveMode(body);
  if (mode === "deterministic" && body.stochastic !== undefined) {
    throw unprocessable(
      `a "stochastic" options block was supplied on a deterministic submission; ` +
        `set mode: "stochastic" or drop the block — the platform does not silently ` +
        `ignore options it will not honor`,
    );
  }
  const horizon = body.gridHorizonMonths ?? DEFAULT_HORIZON_MONTHS;
  if (!Number.isInteger(horizon) || horizon < 1) {
    throw unprocessable(`gridHorizonMonths must be a positive integer, got ${String(body.gridHorizonMonths)}`);
  }
  const engineContext = resolveEngineOptions(body.engineOptions, horizon);
  if (mode === "stochastic" && engineContext.discountBasis !== undefined) {
    throw unprocessable(
      `engineOptions.discountBasis "${engineContext.discountBasis}" applies to a deterministic run only; ` +
        `the stochastic run discounts every path on the all-in basis, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.seg === true) {
    throw unprocessable(
      `engineOptions.seg applies to a deterministic run only; the SEG block runs on the base ` +
        `scenario's deterministic path, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.nmdWarmup !== undefined) {
    throw unprocessable(
      `engineOptions.nmdWarmup applies to a deterministic run only; the stochastic route builds its deposits on ` +
        `the kernel warmup series, so drop the option or run deterministic`,
    );
  }
  // The stochastic route walks its CD book and SEG on the original convention only.
  if (mode === "stochastic" && engineContext.modelConvention === "corrected-v1") {
    throw unprocessable(
      `engineOptions.modelConvention "corrected-v1" applies to a deterministic run only; the stochastic route keeps the ` +
        `original convention, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.nextResetGap === true) {
    throw unprocessable(
      `engineOptions.nextResetGap applies to a deterministic run only; the next-reset ladder reads the base ` +
        `scenario's book and beta at r0 in the deterministic pipeline, so drop the option or run deterministic`,
    );
  }
  // Both read the deterministic run's new volume, which a stochastic run does not make.
  for (const key of ["forecastGap", "goingConcernEve"] as const) {
    if (mode === "stochastic" && engineContext[key] === true) {
      throw unprocessable(
        `engineOptions.${key} applies to a deterministic run only; it values the new volume of the deterministic ` +
          `scenarios' balance plans, and a stochastic run makes none, so drop the option or run deterministic`,
      );
    }
  }
  if (mode === "stochastic" && engineContext.fixedRateGap === true) {
    throw unprocessable(
      `engineOptions.fixedRateGap applies to a deterministic run only; the fixed-rate ladder reads the base ` +
        `scenario's deterministic path, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.liquidityStress !== undefined) {
    throw unprocessable(
      `engineOptions.liquidityStress applies to a deterministic run only; the stress ladder reads the base ` +
        `scenario's deterministic path, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.gapBuckets !== undefined) {
    throw unprocessable(
      `engineOptions.gapBuckets applies to a deterministic run only; the stochastic envelope carries no gap ladder, ` +
        `so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.liquidityBuckets !== undefined) {
    throw unprocessable(
      `engineOptions.liquidityBuckets applies to a deterministic run only; the stochastic envelope carries no gap ladder, ` +
        `so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.liquidityFlows !== undefined) {
    throw unprocessable(
      `engineOptions.liquidityFlows "principal-plus-interest" applies to a deterministic run only; the stochastic ` +
        `envelope carries no gap ladder, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.reportHorizons !== undefined) {
    throw unprocessable(
      `engineOptions.reportHorizons applies to a deterministic run only; the stochastic envelope reports NII on its ` +
        `own horizons, so drop the option or run deterministic`,
    );
  }
  if (mode === "stochastic" && engineContext.windowMonths !== undefined) {
    throw unprocessable(
      `engineOptions.windowMonths applies to a deterministic run only; the stochastic envelope reports NII on its ` +
        `own horizons and carries no window, so drop the option or run deterministic`,
    );
  }
  const instrumentResults = resolveInstrumentResults(body.instrumentResults);
  if (mode === "stochastic" && instrumentResults !== undefined) {
    throw unprocessable(
      "instrumentResults.save applies to a deterministic run only; the stochastic envelope is a distribution " +
        "with no per-position rows, so drop the option or run deterministic",
    );
  }
  if (mode === "stochastic" && engineContext.nmdConvention !== undefined) {
    throw unprocessable(
      `engineOptions.nmdConvention "${engineContext.nmdConvention}" applies to a deterministic run only; ` +
        `the stochastic run does not apply the deposit-convention transform yet, so drop the option or run deterministic`,
    );
  }

  // Resolve every referenced artifact; a missing reference is a 422 with the
  // offending id named (404 is reserved for path ids).
  const require = <T>(fn: () => T, what: string, id: string): T => {
    try {
      return fn();
    } catch {
      throw unprocessable(`run submission references unknown ${what} "${id}"`);
    }
  };
  // Studio A+E contract 2. On a workspace launch each document is read ONCE as stored
  // bytes, hashed, compared with the pin the setup compile consumed in that role, and
  // parsed from those same bytes, so the hash proves the bytes the request inlines.
  const pins = body.workspace?.consumed;
  const checked = new Set<string>();
  const checkPin = (role: ConsumedRole, collection: Collection, id: string, bytes: Buffer): void => {
    const ref = pins![role];
    if (ref === undefined || ref.collection !== collection || ref.id !== id) {
      throw conflict(
        `pin ${role}: this workspace launch reads ${collection} "${id}" but consumed ` +
          `${ref === undefined ? "no pin in that role" : `${ref.collection} "${ref.id}"`}; nothing was submitted`,
      );
    }
    const actual = sha256Hex(bytes);
    if (actual !== ref.contentHash) {
      throw conflict(
        `pin ${role} "${id}" moved between the setup compile and submission: consumed ${ref.contentHash}, ` +
          `stored bytes hash ${actual}; nothing was submitted, validate the setup again`,
      );
    }
    checked.add(role);
  };
  const readDoc = <T>(collection: Collection, id: string, what: string, role: ConsumedRole): T => {
    if (pins === undefined) return require(() => store.getDocument<T>(collection, id).doc, what, id);
    const bytes = require(() => store.getDocumentBytes(collection, id), what, id);
    checkPin(role, collection, id, bytes);
    return JSON.parse(bytes.toString("utf8")) as T;
  };

  const portfolioMeta = require(
    () => store.getMeta("portfolios", body.portfolioId!),
    "portfolio",
    body.portfolioId!,
  );
  if (pins !== undefined) {
    // The child re-hashes the book's bytes against portfolioRef (the meta hash) before it
    // computes, so the meta hash must equal the consumed pin as well as the bytes here.
    const bookId = body.portfolioId!;
    checkPin("book", "portfolios", bookId, require(() => store.getDocumentBytes("portfolios", bookId), "portfolio", bookId));
    if (portfolioMeta.contentHash !== pins.book!.contentHash) {
      throw conflict(
        `pin book "${bookId}": its meta records ${portfolioMeta.contentHash}, the launch consumed ${pins.book!.contentHash}; nothing was submitted`,
      );
    }
  }
  if (instrumentResults?.coaNodeIds !== undefined) {
    // A node the book's chart does not carry is refused here, before a run is queued, rather than by the pass after it.
    const coa = require(() => store.getDocument<PortfolioSpec>("portfolios", body.portfolioId!).doc, "portfolio", body.portfolioId!).coa;
    const nodeIds = new Set(coa.nodes.map((n) => n.id));
    const unknown = instrumentResults.coaNodeIds.filter((id) => !nodeIds.has(id));
    if (unknown.length > 0) {
      throw unprocessable(
        "instrumentResults.coaNodeIds names " + unknown.map((id) => "\"" + id + "\"").join(", ") +
          ", not in the chart of accounts of portfolio \"" + body.portfolioId + "\"",
      );
    }
  }
  const market = readDoc<MarketSnapshot>("market", body.marketId!, "market snapshot", "market");
  const slate = readDoc<ScenarioSlate>("scenario-slates", body.scenarioSlateId!, "scenario slate", "slate");
  const sets: AssumptionSet[] = assumptionSetIds.map((id) =>
    readDoc<AssumptionSet>("assumption-sets", id, "assumption set", `set:${id}`),
  );
  // The index histories a lagged index of this market reads, sorted by id and distinct (the
  // engine's indexHistoryIdsRead), so the request and inputsHash do not depend on the order the market names them.
  // Read only when the market names a history, so a market without one reads no portfolio document here. Under a
  // workspace launch each is checked against its `indexHistory:<id>` pin; a plain submission reads it from the store,
  // and the engine re-checks the hash.
  const indexHistories: IndexHistoryEntry[] = [];
  if (namedHistoryIdsOf(market).length > 0) {
    const book = require(() => store.getDocument<PortfolioSpec>("portfolios", body.portfolioId!).doc, "portfolio", body.portfolioId!);
    for (const id of indexHistoryIdsRead(book, market)) {
      indexHistories.push({ id, history: readDoc<IndexHistory>("index-histories", id, "index history", `indexHistory:${id}`) });
    }
  }
  if (pins !== undefined) {
    // Every other consumed role (the routing policy, the setup document, balance plans) is
    // not inlined here; it is read for the purpose and must still hash to its pin.
    for (const [role, ref] of Object.entries(pins) as Array<[ConsumedRole, NonNullable<(typeof pins)[ConsumedRole]>]>) {
      if (checked.has(role)) continue;
      checkPin(role, ref.collection, ref.id, require(() => store.getDocumentBytes(ref.collection, ref.id), ref.collection, ref.id));
    }
  }

  const setIds = new Set(assumptionSetIds);
  const unresolved = slate.scenarios.filter((s: Scenario) => !setIds.has(s.assumptionSetId));
  if (unresolved.length > 0) {
    throw unprocessable(
      `scenario(s) ${unresolved.map((s) => `"${s.id}"`).join(", ")} reference assumption set ids ` +
        `not in the submission: ${[...new Set(unresolved.map((s) => s.assumptionSetId))].join(", ")}; ` +
        `include them in assumptionSetIds`,
    );
  }

  const asOf = portfolioMeta.asOf;
  if (typeof asOf !== "string" || asOf.length === 0) {
    throw unprocessable(
      `portfolio "${body.portfolioId}" meta carries no asOf date; re-import the book (the grid ` +
        `anchors to the portfolio's as-of and the platform never invents a date)`,
    );
  }

  const seed = body.seed ?? (mode === "stochastic" ? DEFAULT_STOCHASTIC_SEED : DEFAULT_SEED);
  // A saved calibration, read (and under a workspace launch, pin-checked) and refused in
  // one plain sentence on another snapshot or curve, beside explicit parameters, or for another model.
  let saved: SavedCalibrationUse | undefined;
  const calibrationId = body.stochastic?.calibrationId;
  if (calibrationId !== undefined) {
    if (typeof calibrationId !== "string" || calibrationId === "") throw unprocessable("stochastic.calibrationId must be the id of a saved calibration");
    if (body.stochastic?.modelParams !== undefined) throw unprocessable("A run uses a saved calibration or explicit parameters, not both: drop stochastic.modelParams or stochastic.calibrationId.");
    const doc = readDoc<SavedCalibration>("calibrations", calibrationId, "saved calibration", "calibration");
    const wanted = (body.stochastic?.model ?? "hull-white-1f") as string;
    if (doc.fit.model !== wanted) throw unprocessable(`The saved calibration ${calibrationId} is a fit of ${MODEL_WORDS[doc.fit.model]}, and this run names ${wanted}: choose a fit of the run's model.`);
    const why = savedCalibrationMismatch(savedCalibrationUseOf(doc), body.marketId!, store.getMeta("market", body.marketId!).contentHash, curveFingerprintOf(market));
    if (why !== null) throw unprocessable(why, { field: "stochastic.calibrationId" });
    saved = savedCalibrationUseOf(doc);
  }
  const stochastic =
    mode === "stochastic"
      ? resolveStochasticSpec(
          body,
          market,
          slate,
          seed,
          shortRateVolShockLineage(store, body.marketId!, market),
          horizon,
          () => require(() => store.getDocument<PortfolioSpec>("portfolios", body.portfolioId!).doc, "portfolio", body.portfolioId!).positions.length,
          saved,
        )
      : undefined;

  const runId = newRunId();
  const request: RunRequest = {
    runId,
    portfolioId: body.portfolioId!,
    marketSnapshot: market,
    scenarios: slate.scenarios,
    assumptionSets: sets,
    grid: { horizonMonths: horizon, asOf },
    ...(views !== undefined && views.length > 0 ? { views } : {}),
    ...(indexHistories.length > 0 ? { indexHistories } : {}),
    seed,
    // Placeholders; the child injects the wall clock at its boundary.
    timestamps: { startedAt: "", finishedAt: "" },
    ...(body.plan !== undefined ? { plan: body.plan } : {}),
  };
  const stored: StoredRunRequestV2 = {
    engineContext,
    ...(instrumentResults !== undefined ? { instrumentResults } : {}),
    request,
    portfolioRef: { id: portfolioMeta.id, contentHash: portfolioMeta.contentHash },
    ...(body.planTags !== undefined && body.planTags.length > 0 ? { planTags: body.planTags } : {}),
    ...(body.planRunLog !== undefined && body.planRunLog.length > 0 ? { planRunLog: body.planRunLog } : {}),
    ...(body.profileHash !== undefined ? { profileHash: body.profileHash } : {}),
    ...(body.profile !== undefined ? { profile: body.profile } : {}),
    ...(body.planDocument !== undefined ? { planDocument: body.planDocument } : {}),
    ...(body.workspace !== undefined ? { workspace: body.workspace } : {}),
    mode,
    ...(stochastic !== undefined ? { stochastic } : {}),
    submission: {
      portfolioId: body.portfolioId!,
      marketId: body.marketId!,
      scenarioSlateId: body.scenarioSlateId!,
      assumptionSetIds,
      scenarios: slate.scenarios.map((s) => ({ id: s.id, label: s.label, rateSpec: s.rateSpec })),
    },
  };
  store.writeRunJson(runId, "request.json", stored);
  const platformRequestHash = requestHash(store, runId);

  const status: RunStatus = {
    runId,
    state: "queued",
    ...(body.label !== undefined ? { label: String(body.label) } : {}),
    submittedAt: new Date().toISOString(),
    platformRequestHash,
    summary: {
      portfolioId: body.portfolioId!,
      marketId: body.marketId!,
      scenarioSlateId: body.scenarioSlateId!,
      scenarioCount: slate.scenarios.length,
      ...(body.workspace !== undefined ? { workspaceId: body.workspace.workspaceId } : {}),
    },
  };
  store.writeRunJson(runId, "status.json", status);
  store.appendRunLog(runId, { t: "status", state: "queued", at: status.submittedAt });

  const queuePosition = queue.enqueue(runId);
  // Honest cost label on the stochastic arm: the count is echoed
  // back exactly as it will run, with what it costs — never adjusted.
  const positionCount = portfolioMeta.positionCount;
  const stochasticEcho =
    stochastic !== undefined
      ? {
          stochastic: {
            nPaths: stochastic.nPaths,
            costNote:
              `each of the ${stochastic.nPaths} paths re-projects the full ` +
              `${typeof positionCount === "number" ? `${positionCount}-position ` : ""}book ` +
              `once under ${MODEL_WORDS[stochastic.model ?? "hull-white-1f"]}; cost scales linearly ` +
              `in positions x paths; ` +
              MEASURED_STOCHASTIC_COST[stochastic.model ?? "hull-white-1f"] +
              // The gap arm's own cost (spec ruling 3); absent, the note is the one it was.
              (stochastic.gap !== undefined
                ? `; the gap distributions add a ${STOCHASTIC_GAP_HORIZON_MONTHS}-month SEG block per path, about ` +
                  `2.8 ms (granular, estimated) to 4.3 ms (measured on a test book) per position per path`
                : ""),
          },
        }
      : {};
  return {
    kind: "json",
    status: 202,
    value: { runId, queuePosition, platformRequestHash, mode, ...stochasticEcho },
  };
}

export function registerRunRoutes(router: Router, ctx: PlatformContext): void {
  const { store, queue } = ctx;

  const readStatusOr404 = (runId: string): RunStatus => {
    if (!store.runFileExists(runId, "status.json")) throw notFound(`run "${runId}" not found`);
    return store.readRunJson<RunStatus>(runId, "status.json");
  };

  /** The run's stored mode; request.json files predating the field are deterministic. */
  const modeOf = (runId: string): RunMode => {
    if (!store.runFileExists(runId, "request.json")) return "deterministic";
    return store.readRunJson<StoredRunRequestV2>(runId, "request.json").mode ?? "deterministic";
  };

  const requireDone = (runId: string): void => {
    const status = readStatusOr404(runId);
    if (status.state !== "done") {
      throw conflict(
        `run "${runId}" is ${status.state}; results exist only for state "done" ` +
          `(the platform serves no partial or unsupervised result)`,
      );
    }
  };

  /**
   * Deterministic-result gate: a stochastic run's stored envelope is
   * a SEPARATE distribution result — refusing here is what keeps a Monte Carlo
   * mean from ever being read as an EVE through a deterministic route.
   */
  const requireDeterministic = (runId: string): void => {
    if (modeOf(runId) === "stochastic") {
      throw badRequest(
        `run "${runId}" is a stochastic run; its result is a distribution envelope ` +
          `(separate from the deterministic RunResult — a distribution mean ` +
          `is a statistic, not an EVE) served at /api/runs/${runId}/stochastic. ` +
          `Deterministic result sections do not exist for it.`,
      );
    }
  };

  const readDoneResult = (runId: string): RunResult => {
    requireDeterministic(runId);
    requireDone(runId);
    return store.readRunJson<RunResult>(runId, "result.json");
  };

  // --- submission ------------------------------------------------------------

  router.add("POST", "/api/runs", (req) => {
    const body = req.json<SubmitBody>();
    if (typeof body === "object" && body !== null && "workspace" in body) {
      throw unprocessable(
        `"workspace" is stamped by POST /api/workspaces/:id/setups/:lineageId/launch only; a direct run submission ` +
          `may not claim a workspace (drop the field, or launch the setup from its workspace)`,
        { field: "workspace" },
      );
    }
    return submitRun(ctx, body);
  });

  // --- listings and detail ---------------------------------------------------

  /**
   * Submission references and scenario display metadata for a run, read from
   * the stored request.json (the W1-P3 NOTE: without `refs` the cockpit's
   * baseline rule — "the assumption set of the portfolio's most recent
   * completed run" — is unimplementable from the UI). A run whose request.json
   * is missing (half-written store) lists without refs rather than failing the
   * whole listing.
   */
  const submissionInfo = (
    runId: string,
  ): {
    mode?: RunMode;
    scenarios?: StoredRunRequest["submission"]["scenarios"];
    refs?: {
      portfolioId: string;
      marketId: string;
      scenarioSlateId: string;
      assumptionSetIds: string[];
    };
  } => {
    if (!store.runFileExists(runId, "request.json")) return {};
    const stored = store.readRunJson<StoredRunRequestV2>(runId, "request.json");
    const { portfolioId, marketId, scenarioSlateId, assumptionSetIds, scenarios } = stored.submission;
    return {
      mode: stored.mode ?? "deterministic",
      scenarios,
      refs: { portfolioId, marketId, scenarioSlateId, assumptionSetIds },
    };
  };

  router.add("GET", "/api/runs", () => {
    const runs = store
      .listRunIds()
      .filter((id) => store.runFileExists(id, "status.json"))
      .map((id) => ({ ...queue.statusWithPosition(id), ...submissionInfo(id) }));
    return { kind: "json", value: runs };
  });

  /**
   * The curve line of a done run, from the stamp its stored
   * result carries, else the setup its stored request pinned, else version 1 (export/curveLine.ts).
   * Undefined until the run is done: before then there is no stored result to read. A stored result
   * never changes, so the line is kept per run and per result file (size and modified time), and the
   * result is parsed once, not on every poll of the detail. The detail never depends on result.json being
   * readable (Task 8 fix round 1): a file that cannot be read or parsed reads as the unknown line, a 200,
   * and the result routes keep reporting the damage themselves.
   */
  const curveLines = new Map<string, { key: string; curve: RunCurveLine }>();
  const curveOfDoneRun = (runId: string, state: string, stored: StoredRunRequestV2): RunCurveLine | undefined => {
    if (state !== "done" || !store.runFileExists(runId, "result.json")) return undefined;
    try {
      const file = statSync(store.paths.runFile(runId, "result.json"));
      const key = `${file.size}:${file.mtimeMs}`;
      const hit = curveLines.get(runId);
      if (hit !== undefined && hit.key === key) return hit.curve;
      const curve = curveLineOf(stampOfStoredResult(store.readRunJson<unknown>(runId, "result.json")), stored.request?.marketSnapshot);
      curveLines.set(runId, { key, curve });
      return curve;
    } catch {
      return curveLineOf(null, undefined);
    }
  };

  router.add("GET", "/api/runs/:id", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    const status = queue.statusWithPosition(runId);
    const stored = store.readRunJson<StoredRunRequestV2>(runId, "request.json");
    const { portfolioId, marketId, scenarioSlateId, assumptionSetIds } = stored.submission;
    const curve = curveOfDoneRun(runId, status.state, stored);
    return {
      kind: "json",
      value: {
        ...status,
        mode: stored.mode ?? "deterministic",
        ...(curve !== undefined ? { curve } : {}),
        ...(stored.stochastic !== undefined ? { stochastic: stored.stochastic } : {}),
        scenarios: stored.submission.scenarios,
        refs: { portfolioId, marketId, scenarioSlateId, assumptionSetIds },
        assumptionSetIds,
        engineContext: stored.engineContext,
        portfolioRef: stored.portfolioRef,
        grid: stored.request.grid,
        seed: stored.request.seed,
      },
    };
  });

  // --- progress, cancel, label ----------------------------------------------

  router.add("GET", "/api/runs/:id/events", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    return { kind: "stream", handle: (res) => serveRunEvents(res, store, queue, runId) };
  });

  router.add("POST", "/api/runs/:id/cancel", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    const status = queue.cancel(runId); // ConflictError -> 409
    return { kind: "json", value: status };
  });

  router.add("POST", "/api/runs/:id/label", (req) => {
    const runId = req.params.id;
    const status = readStatusOr404(runId);
    const body = req.json<{ label?: string }>();
    if (typeof body.label !== "string" || body.label.length === 0 || body.label.length > 200) {
      throw badRequest("label must be a non-empty string of at most 200 characters");
    }
    // Platform metadata only; the result envelope is never touched.
    status.label = body.label;
    store.writeRunJson(runId, "status.json", status);
    return { kind: "json", value: status };
  });

  // --- results (verbatim reads) ----------------------------------------------

  router.add("GET", "/api/runs/:id/result", (req) => {
    const runId = req.params.id;
    readDoneResult(runId); // state gate; parse also proves integrity
    return {
      kind: "bytes",
      contentType: "application/json; charset=utf-8",
      value: store.readRunBytes(runId, "result.json"),
    };
  });

  /**
   * Studio A+E contract 7: income, expense and net per month per family, read
   * off the stored cash flow block and the family side. Registered before the
   * section route so the literal path wins. A stochastic run is refused (409):
   * its envelope is a distribution and carries no monthly NII. A cash flow
   * family the pinned portfolio's chart does not carry is a 422 naming it.
   */
  router.add("GET", "/api/runs/:id/result/nii/monthly", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    if (modeOf(runId) === "stochastic") {
      throw conflict(
        `run "${runId}" is stochastic; monthly NII is not part of the stochastic envelope`,
      );
    }
    const stored = store.readRunJson<StoredRunRequestV2>(runId, "request.json");
    const result = readDoneResult(runId);
    const portfolio = store.getDocument<PortfolioSpec>("portfolios", stored.submission.portfolioId).doc;
    try {
      // A monthly reply also carries the chart the card needs (node tree, family side and instrument
      // type), added last so every reader field keeps its bytes; an absent reply is unchanged.
      const reply = niiMonthly(result, portfolio.coa);
      return { kind: "json", value: reply.kind === "monthly" ? { ...reply, coa: niiMonthlyChart(portfolio.coa) } : reply };
    } catch (err) {
      if (err instanceof NiiMonthlyUnavailableError) {
        throw unprocessable(err.message, { error: err.name, familyId: err.familyId });
      }
      throw err;
    }
  });

  /**
   * GET /api/runs/:id/result/rollup?period=quarter|year&align=cutoff|calendar&months=N.
   * The engine's one roll-up reader over the stored monthly series (flows sum, balances end of period with the
   * average, rates a ratio of sums annualised, the gap from the stored monthly buckets). No roll-up of a stochastic
   * run or of EVE; a run without monthly NII answers the typed absent reply.
   */
  router.add("GET", "/api/runs/:id/result/rollup", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    if (modeOf(runId) === "stochastic") {
      throw conflict(`run "${runId}" is stochastic; a roll-up reads stored monthly series, and a stochastic envelope stores distributions only`);
    }
    const period = req.query.get("period");
    if (period !== "quarter" && period !== "year") throw badRequest(`period must be "quarter" or "year", got ${period === null ? "nothing" : `"${period}"`}`);
    const { alignment, months } = rollUpQuery(req.query);
    const stored = store.readRunJson<StoredRunRequestV2>(runId, "request.json");
    const result = readDoneResult(runId);
    const portfolio = store.getDocument<PortfolioSpec>("portfolios", stored.submission.portfolioId).doc;
    try {
      return { kind: "json", value: rollUpRun(result, portfolio.coa, { period, alignment, ...(months !== undefined ? { months } : {}) }) };
    } catch (err) {
      if (err instanceof RollUpOptionsError) throw unprocessable(err.message);
      if (err instanceof NiiMonthlyUnavailableError) throw unprocessable(err.message, { error: err.name, familyId: err.familyId });
      throw err;
    }
  });

  router.add("GET", "/api/runs/:id/result/:section", (req) => {
    const runId = req.params.id;
    const section = req.params.section;
    if (!(RESULT_SECTIONS as readonly string[]).includes(section)) {
      throw badRequest(
        `unknown result section "${section}"; sections: ${RESULT_SECTIONS.join(", ")}`,
      );
    }
    const result = readDoneResult(runId);
    const value = result[section as ResultSection];
    if (value === undefined && section === "seg") {
      // An opt-in block: absent because the run did not ask for it.
      throw notFound(`run "${runId}" result carries no "seg" block (the run did not opt in to engineOptions.seg)`);
    }
    if (value === undefined && section === "liquidityStress") {
      throw notFound(
        `run "${runId}" result carries no "liquidityStress" block (the run did not opt in to engineOptions.liquidityStress)`,
      );
    }
    if (value === undefined && section === "ftp") {
      // Slice three (spec decision 123): a plan with no FTP stage (the setup turned FTP off), a seasoned book, or an
      // envelope stored before the block existed; the route cannot tell which, so it names all three.
      throw notFound(
        `the run carries no ftp block: its plan had no FTP stage, its book is seasoned, or it predates the block (run "${runId}")`,
      );
    }
    if (value === undefined) {
      // Additive schema evolution: a run stored before a block
      // existed simply does not carry it; say so rather than serving a
      // non-JSON hole.
      throw notFound(
        `run "${runId}" result carries no "${section}" block (schemaVersion ` +
          `${result.schemaVersion}; the block was added in a later schema and stored ` +
          `results are never recomputed)`,
      );
    }
    return { kind: "json", value };
  });

  /**
   * The stochastic envelope: the stored StochasticRunResult served
   * verbatim, byte for byte. Its own route because it is its own result kind
   * — deterministic reads refuse stochastic runs and vice versa.
   */
  router.add("GET", "/api/runs/:id/stochastic", (req) => {
    const runId = req.params.id;
    readStatusOr404(runId);
    const mode = modeOf(runId);
    if (mode !== "stochastic") {
      throw badRequest(
        `run "${runId}" is a ${mode} run and has no stochastic envelope; its result ` +
          `is served at /api/runs/${runId}/result. Stochastic distributions exist only ` +
          `for runs submitted with mode: "stochastic".`,
      );
    }
    requireDone(runId);
    return {
      kind: "bytes",
      contentType: "application/json; charset=utf-8",
      value: store.readRunBytes(runId, "result.json"),
    };
  });

  /**
   * The rate document: what the run ran on, served verbatim. One
   * route for both modes; a client reads `mode` off the document. A run that
   * finished before the document existed has none, and says so. A builder
   * failure is a different case: it lands the run in state `error`, which the
   * state gate below answers as the ordinary 409, never as this 404.
   */
  router.add("GET", "/api/runs/:id/rates", (req) => {
    const runId = req.params.id;
    requireDone(runId);
    if (!store.runFileExists(runId, "rates.json")) {
      throw notFound(
        `run "${runId}" has no rate document: it finished before runs wrote rate documents; ` +
          `re-run to produce one`,
      );
    }
    return {
      kind: "bytes",
      contentType: "application/json; charset=utf-8",
      value: store.readRunBytes(runId, "rates.json"),
    };
  });

  /**
   * The per-position results file (schema 1.9.0), served verbatim from
   * instruments.json. Only a run submitted with instrumentResults.save has one;
   * every other done run, and a run whose pass failed (its log carries an
   * instruments-pass-failed line), answers 404 with a sentence saying so.
   */
  const requireInstruments = (runId: string): void => {
    requireDone(runId);
    requireDeterministic(runId);
    if (!store.runFileExists(runId, "instruments.json")) {
      throw notFound(
        `run "${runId}" has no per-position results file: it was not submitted with ` +
          `instrumentResults.save, or its instruments pass failed (see the run log for an ` +
          `"instruments-pass-failed" line); re-run with instrumentResults.save to produce one`,
      );
    }
  };

  router.add("GET", "/api/runs/:id/instruments", (req) => {
    const runId = req.params.id;
    requireInstruments(runId);
    return {
      kind: "bytes",
      contentType: "application/json; charset=utf-8",
      value: store.readRunBytes(runId, "instruments.json"),
    };
  });

  router.add("GET", "/api/runs/:id/instruments.csv", (req) => {
    const runId = req.params.id;
    requireInstruments(runId);
    const file = store.readRunJson<InstrumentsFile>(runId, "instruments.json");
    return {
      kind: "bytes",
      contentType: "text/csv; charset=utf-8",
      headers: { "content-disposition": `attachment; filename="${runId}-instruments.csv"` },
      value: Buffer.from(instrumentsCsv(file), "utf8"),
    };
  });

  router.add("GET", "/api/runs/:id/query", (req) => {
    const runId = req.params.id;
    const result = readDoneResult(runId);
    const metric = req.query.get("metric");
    if (metric === null) throw badRequest("query requires a metric parameter");
    const query = {
      runId,
      metric,
      ...(req.query.get("scenarioId") !== null ? { scenarioId: req.query.get("scenarioId")! } : {}),
      ...(req.query.get("familyId") !== null ? { familyId: req.query.get("familyId")! } : {}),
    } as ResultQuery;
    return { kind: "json", value: validated(() => sliceResult(result, query)) };
  });

  /**
   * The pivot: one row per group of a declared view, rolled up from
   * the stored cells. Reads result.json and re-derives nothing: the roll-up is
   * the engine's pure `pivot` over the stored envelope, and the platform never
   * recomputes a result number of its own. A refusal the engine raises
   * (an unknown view, an unknown scenario, or a metric with no cell arm) is a
   * 422 carrying the engine's message verbatim, never a softened answer off the
   * family rows.
   */
  router.add("GET", "/api/runs/:id/pivot", (req) => {
    const runId = req.params.id;
    const result = readDoneResult(runId);
    const view = req.query.get("view");
    const metric = req.query.get("metric");
    const scenarioId = req.query.get("scenarioId");
    if (view === null) throw badRequest("pivot requires a view parameter");
    if (metric === null) throw badRequest("pivot requires a metric parameter");
    if (scenarioId === null) throw badRequest("pivot requires a scenarioId parameter");
    try {
      return {
        kind: "json",
        value: pivot(result, { viewId: view, metric: metric as PivotMetric, scenarioId }),
      };
    } catch (err) {
      if (err instanceof PivotUnavailableError) {
        throw unprocessable(err.message, { error: err.name, viewId: view, metric, scenarioId });
      }
      throw err;
    }
  });

  /**
   * The base scenario a lens reading anchors its delta readers to:
   * the ONE scenario of the run's own request whose rateSpec.kind is "base".
   * The stored envelope carries no base id, and the platform never infers one
   * from a zero delta, so zero or several base scenarios is a refusal naming
   * the count rather than a guess.
   */
  const deriveBaseScenarioId = (runId: string, lensId?: string): string => {
    const stored = store.readRunJson<StoredRunRequestV2>(runId, "request.json");
    const bases = (stored.request?.scenarios ?? []).filter((s) => s.rateSpec?.kind === "base");
    if (bases.length !== 1) {
      throw unprocessable(
        `run "${runId}" carries ${bases.length} scenario(s) whose rateSpec.kind is "base" in its ` +
          `stored request; a lens reading anchors its delta readers to exactly one base scenario, ` +
          `and the platform never infers one from a zero delta`,
        { error: "BaseScenarioUndetermined", ...(lensId !== undefined ? { lensId } : {}) },
      );
    }
    return bases[0]!.id;
  };

  /**
   * Validate the STORED definition and read it. The route validates first so a
   * hand-edited store document answers 422 with the rule it broke rather than
   * reaching the engine; readLens validates again, so a caller bypassing the
   * route cannot read an invalid lens either.
   */
  const readOneLens = (
    result: RunResult,
    def: LensDefinition,
    lensId: string,
    baseScenarioId: string,
    scenarioIds: string[],
  ): LensReading => {
    const problems = validateLens(def);
    if (problems.length > 0) {
      throw unprocessable(
        `stored lens "${lensId}" is not valid: ` +
          problems.map((p) => `${p.rule} ${p.field}: ${p.message}`).join("; "),
        { error: "LensDefinitionInvalid", lensId, baseScenarioId },
      );
    }
    try {
      return readLens(result, def, {
        baseScenarioId,
        ...(scenarioIds.length > 0 ? { scenarioIds } : {}),
      });
    } catch (err) {
      if (err instanceof LensUnavailableError) {
        throw unprocessable(err.message, { error: err.name, lensId, baseScenarioId });
      }
      throw err;
    }
  };

  /**
   * One lens over one finished run. Reads result.json and re-derives
   * nothing: the scoring is the engine's pure `readLens` over the stored
   * envelope, and every value in the reading is a field the envelope already
   * carries. A constraint whose number does not exist for this run, or
   * in this build, reports status "unobservable" with a reason, never a zero.
   *
   *   400 lens parameter missing
   *   404 the store holds no lens of that id
   *   422 the stored definition fails validateLens, the base scenario cannot be
   *       derived, or the engine raises LensUnavailableError (message verbatim)
   */
  router.add("GET", "/api/runs/:id/lens", (req) => {
    const runId = req.params.id;
    const result = readDoneResult(runId);
    const lensId = req.query.get("lens");
    if (lensId === null) throw badRequest("lens requires a lens parameter");
    const scenarioIds = req.query.getAll("scenarioId");
    const def = store.getDocument<LensDefinition>("lens", lensId).doc;
    const baseScenarioId = deriveBaseScenarioId(runId, lensId);
    return {
      kind: "json",
      value: readOneLens(result, def, lensId, baseScenarioId, scenarioIds),
    };
  });

  /**
   * Every stored lens over one finished run, ascending id. ONE bad
   * definition or one refusal fails the WHOLE call as a 422 naming the lens: a
   * four-lens reading with one lens silently dropped is exactly the partial
   * view this plane exists to prevent. An empty collection answers 200 with an
   * empty `lenses` array.
   */
  router.add("GET", "/api/runs/:id/lenses", (req) => {
    const runId = req.params.id;
    const result = readDoneResult(runId);
    const scenarioIds = req.query.getAll("scenarioId");
    const baseScenarioId = deriveBaseScenarioId(runId);
    const lenses = store
      .listMeta("lens")
      .map((meta) =>
        readOneLens(
          result,
          store.getDocument<LensDefinition>("lens", meta.id).doc,
          meta.id,
          baseScenarioId,
          scenarioIds,
        ),
      );
    return { kind: "json", value: { baseScenarioId, lenses } };
  });

  router.add("POST", "/api/runs/:id/explain", (req) => {
    const runId = req.params.id;
    const result = readDoneResult(runId);
    const body = req.json<{ metric?: string; scenarioId?: string }>();
    if (typeof body.metric !== "string" || typeof body.scenarioId !== "string") {
      throw badRequest("explain requires { metric, scenarioId }");
    }
    const query = { runId, metric: body.metric, scenarioId: body.scenarioId } as ExplainQuery;
    const explanation = validated(() => explainResult(result, query));
    const prose = validated(() => composeAnswer(explanation));
    return { kind: "json", value: { explanation, prose } };
  });
}

/** SHA-256 over the stored request.json bytes (identity badge). */
function requestHash(store: PlatformContext["store"], runId: string): string {
  return sha256Hex(store.readRunBytes(runId, "request.json"));
}
