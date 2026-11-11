/**
 * Stochastic run entry point: Hull-White 1F Monte Carlo (and, since
 * piece B slice two, the BGM LIBOR market model by request) over the BASE
 * scenario, emitting the separate StochasticRunResult envelope. Deliberately its OWN entry: orchestrate.ts and the deterministic
 * RunResult are untouched, so the deterministic path cannot be perturbed by
 * this mode's existence and a distribution can never be read as an EVE.
 *
 * Pipeline: validate → bind the base scenario's assumption set → calibrate
 * HW on the snapshot's ATM cap vols (or accept an explicit override; refuse
 * when neither exists) → simulate nPaths antithetic short-rate paths on the
 * run's monthly grid → project the SAME effective book through the SAME
 * aggregation hot loop once per path (aggregateScenario with a kernel
 * StochasticRatePath; no stochastic-specific projection code exists to
 * diverge) → discount each path's bucketed cash flows on its own
 * terminally-corrected money-market DFs with the static TLP overlay → EVE and
 * NII-12m per path → distribution summaries with N, standard error, and the
 * pinned quantile set.
 *
 * Anchors (asserted in the tests):
 *   - zero-vol degeneracy: at sigma = 0 the per-path EVE collapses to the
 *     deterministic base EVE (1e-6 relative): the plumbing proof;
 *   - engine-level martingale: corrected E_p[D_p(t)] = P^M(0,t) at every step
 *     (max residual surfaced in the envelope), and a path-invariant fixed
 *     bullet's path-mean PV equals its deterministic PV as an identity;
 *   - calibration RMSE surfaced with the 5 bp gate, breach flagged;
 *   - same seed → byte-identical envelope; different seed → different content;
 *   - no cap vols → typed refusal, never a guessed volatility.
 *
 * Cost honesty: the default 256 paths run the full aggregation loop
 * 256 times. Measured at 256 paths: Hull-White about
 * 19 s to 33 s on a 471-position book and about 80 s to 125 s on a 2,351-position
 * book, BGM about 5 s to 10 s and about 20 s. CI runs small books, and heavier
 * counts belong behind RUN_PERF. The path count is a request field and is never
 * silently reduced.
 *
 * Determinism: no clock, no RNG outside the seeded kernel PCG32. Paths reduce
 * in index order; families in declared COA order.
 */
import {
  DEFAULT_TLP_CURVE,
  buildTLPCurve,
  type TLPCurve,
} from "@alm/kernel";
import { commitmentFamilyIds } from "../commitment/offBalanceSheet";
import { isNonRateFamily } from "../nonRate";
import type { AssumptionSet } from "../contracts/assumptions";
import type { BalanceSheetSide } from "../contracts/ids";
import type { PortfolioSpec } from "../contracts/position";
import type { RunRequest } from "../contracts/run";
import type { Scenario } from "../contracts/scenario";
import {
  DEFAULT_STOCHASTIC_PATHS,
  MIN_STOCHASTIC_PATHS,
  PATHS_PER_PAIR,
  STOCHASTIC_GAP_SCHEMA_VERSION,
  STOCHASTIC_NII_HORIZON_MONTHS,
  STOCHASTIC_RESULT_SCHEMA_VERSION,
  STOCHASTIC_SAVED_CALIBRATION_SCHEMA_VERSION,
  type BgmModelOverride,
  type StochasticGapBlock,
  type StochasticGapOption,
  type StochasticModel,
  type StochasticRunResult,
} from "../contracts/stochastic";
import type { DiscountBasis } from "../eve/discount";
import { buildTlpFactors, pvBucketedSeriesOnPath } from "../eve/pathDiscount";
import { computeNII } from "../nii";
import { aggregateScenario } from "../portfolio";
import { stripCdMarks } from "../cd/corrections";
import { indexHistoryReadings, indicesRead, resolveRunRateIndices } from "../rateIndex/resolve";
import { rateIndexFormulaNote } from "../rateIndex/formulaNote";
import { rateIndexHistoryNote } from "../rateIndex/historyNote";
import { macroTargetsOf, resolveRunMacro } from "../macro/runMacro";
import type { BehavioralRegistry } from "../plugins/services";
import { applyStaticOverlays } from "../projection/static";
import { bindAssumptions, buildBaseCurve, curveDefaultStampOf } from "../scenario";
import { setsBindFullForm } from "../nmd/fullBetaRun";
import { setsBindComponentDecay } from "../nmd/componentDecayRun";
import { setsBindReplicatingPortfolio } from "../ftp/replicatingPortfolioRun";
import { derivativeFamilyIds, hasDerivativeFamily } from "../swap/derivatives";
import {
  buildStochasticEnvironment,
  type StochasticEnvironment,
  type StochasticModelOverride,
} from "../scenario/stochasticEnvironment";
import { buildBgmEnvironment, type BgmEnvironment } from "../scenario/bgmEnvironment";
import { makeNotImplemented, NotImplementedError } from "../runtime/notImplemented";
import { makeInstrument } from "../runtime/instrumentFactory";
import { summarise } from "./distribution";
import { computeStochasticGap, refuseGapBeforeSimulation } from "./stochasticGap";
import { DuplicateAssumptionSetError } from "./orchestrate";
import { bgmFixedValuesHold, curveFingerprintOf, savedCalibrationArmOf, type SavedCalibrationUse } from "../calibration/savedCalibration";

export { StochasticCapVolsError } from "../scenario/stochasticEnvironment";

/** The in-envelope refusal layer for shocked-scenario distributions. */
export const STOCHASTIC_SHOCKED_SCENARIOS_LAYER = "stochastic.shocked-scenarios";

/**
 * Thrown for an inadmissible Monte Carlo path count. The count must be an even
 * integer (antithetic pairs) of at least MIN_STOCHASTIC_PATHS (the support
 * bound of the pinned p5/p95 quantiles: a finer tail than the sample supports
 * is refused, never extrapolated).
 */
export class StochasticPathCountError extends Error {
  readonly nPaths: number;
  constructor(nPaths: number, why: string) {
    super(
      `stochastic.paths: nPaths=${nPaths} is inadmissible: ${why}. ` +
        `Path count must be an even integer >= ${MIN_STOCHASTIC_PATHS} ` +
        `(antithetic pairs; p5/p95 quantile support).`,
    );
    this.name = "StochasticPathCountError";
    this.nPaths = nPaths;
  }
}

/** Thrown when the request seed does not parse as an integer for the PCG32 RNG. */
export class StochasticSeedError extends Error {
  readonly seed: string;
  constructor(seed: string) {
    super(
      `stochastic.seed: request seed "${seed}" is not an integer; the kernel ` +
        `PCG32 requires an integer seed and the engine does not substitute one`,
    );
    this.name = "StochasticSeedError";
    this.seed = seed;
  }
}

export interface StochasticRunOptions {
  /** Monte Carlo path count. Default DEFAULT_STOCHASTIC_PATHS (256). */
  nPaths?: number;
  /**
   * The rate model. Absent means
   * "hull-white-1f", whose branch is byte for byte the run before the slice.
   */
  model?: StochasticModel;
  /**
   * Explicit model parameters instead of a market calibration (verification seam
   * and stress lever). Recorded verbatim in the envelope as source "override".
   * Its shape must match the model: {a, sigma, reason} for Hull-White, the
   * Rebonato {a, b, c, d, beta, volScalar, reason} for BGM.
   */
  modelParams?: StochasticModelOverride | BgmModelOverride;
  /**
   * Per-path PV discount basis; defaults to "all-in" like the deterministic EVE.
   * The deterministic "spread-consistent" basis is not offered here: the
   * per-path PV prices family series on static TLP factors with no per-position
   * spread, and the stochastic envelope's basis field names two values only.
   */
  discountBasis?: Exclude<DiscountBasis, "spread-consistent">;
  /**
   * The mounted behavioral registry. Supplied, a registered overlay
   * kind is applied by the plugin that registered it; omitted, the built-in
   * switch applies every overlay exactly as before.
   */
  behavioral?: BehavioralRegistry;
  /**
   * Called once with the built environment and the base scenario,
   * after simulation and before the per-path projection, so a caller can
   * summarise the paths it ran on. Observation only: the envelope is the same
   * whether or not this is supplied.
   */
  onEnvironment?: (env: StochasticEnvironment, baseScenario: Scenario) => void;
  /**
   * The BGM twin of onEnvironment, called once on the BGM branch only (the HW
   * hand-out stays HW-typed and is never called on a BGM run). Observation only.
   */
  onBgmEnvironment?: (env: BgmEnvironment, baseScenario: Scenario) => void;
  /**
   * The SEG repricing and EBP liquidity distributions, `{ enabled: true }` only. Absent (or undefined)
   * means no gap and the envelope of before the slice, byte for byte. Present, the run is Hull-White only, at most
   * STOCHASTIC_GAP_SIZE_CAP position-paths, on a grid of at least 121 months, each refused typed before any path is
   * simulated; the envelope gains `gap` and stamps STOCHASTIC_GAP_SCHEMA_VERSION.
   */
  gap?: StochasticGapOption;
  /**
   * A saved fit, verbatim from the request. Its parameters reach the model through the
   * override seam; the envelope records the `saved-calibration` arm (and stamps 0.5.0), never the override arm. The
   * run refuses it beside `modelParams`, for another model, and on a curve other than the one it was fitted on.
   */
  savedCalibration?: SavedCalibrationUse;
}

/** True when an override carries the BGM (Rebonato) shape rather than the HW one. */
function isBgmOverride(o: StochasticModelOverride | BgmModelOverride): o is BgmModelOverride {
  return "volScalar" in o;
}

/** Refuse an override whose shape is the other model's, in words. */
function overrideFor(
  model: StochasticModel,
  o: StochasticModelOverride | BgmModelOverride | undefined,
): StochasticModelOverride | BgmModelOverride | undefined {
  // A null override is no override (a hand-built request), never a TypeError from the `in` test.
  if (o == null) return undefined;
  const bgm = isBgmOverride(o);
  if (bgm !== (model === "bgm-lmm-2f")) {
    throw new Error(
      `stochastic.calibration: a ${bgm ? "BGM (Rebonato)" : "Hull-White (a, sigma)"} parameter override was ` +
        `supplied for a ${model} run; the override must carry the parameters of the model the run names.`,
    );
  }
  return o;
}

/**
 * The override a saved fit becomes, after its refusals: never beside `modelParams`, only for the model it was
 * fitted for, only on the curve it was fitted on (the fingerprint of the base curve this request builds; the snapshot is
 * the run route's check), and for BGM
 * only with the fixed displacement and CEV exponent the override seam holds.
 */
function savedOverride(model: StochasticModel, saved: SavedCalibrationUse, request: RunRequest, modelParams: unknown): StochasticModelOverride | BgmModelOverride {
  if (modelParams != null) {
    throw new Error("stochastic.calibration: a run uses a saved calibration or explicit parameters, not both; drop one.");
  }
  if (saved.model !== model || saved.parameters.model !== model) {
    throw new Error(`stochastic.calibration: the saved calibration ${saved.calibrationId} is a ${saved.model} fit and this run names ${model}; choose a fit of the run's model.`);
  }
  // The engine checks the curve this request builds. The snapshot itself (its id and stored bytes) is checked by the run
  // route, which reads the store; a request carries no stored hash for the engine to compare (fix round L1).
  if (curveFingerprintOf(request.marketSnapshot).curveFingerprint !== saved.pins.curveFingerprint) {
    throw new Error(`stochastic.calibration: The saved calibration ${saved.calibrationId} was fitted on a different curve from the one this run builds: fit the model again, or run on the curve it was fitted on.`);
  }
  if (!bgmFixedValuesHold(saved.parameters)) {
    throw new Error(`stochastic.calibration: the saved calibration ${saved.calibrationId} holds a displacement or CEV exponent other than the engine's fixed values; fit it again.`);
  }
  const reason = `saved calibration ${saved.calibrationId}`;
  const p = saved.parameters;
  return p.model === "hull-white-1f" ? { a: p.a, sigma: p.sigma, reason } : { a: p.a, b: p.b, c: p.c, d: p.d, beta: p.beta, volScalar: p.volScalar, reason };
}

/** Validate the path count; returns it or throws typed. */
function validateNPaths(nPaths: number): number {
  if (!Number.isInteger(nPaths)) {
    throw new StochasticPathCountError(nPaths, "not an integer");
  }
  if (nPaths % PATHS_PER_PAIR !== 0) {
    throw new StochasticPathCountError(nPaths, "odd (antithetic pairing needs pairs)");
  }
  if (nPaths < MIN_STOCHASTIC_PATHS) {
    throw new StochasticPathCountError(
      nPaths,
      `below the p5/p95 quantile support bound ${MIN_STOCHASTIC_PATHS}`,
    );
  }
  return nPaths;
}

/** Parse the request seed for the kernel PCG32; typed refusal on garbage. */
function parseSeed(seed: string): bigint {
  try {
    return BigInt(seed);
  } catch {
    throw new StochasticSeedError(seed);
  }
}

export { quantileSorted } from "./distribution";

/** Build the TLP overlay from the snapshot, or the kernel default (as orchestrate does). */
function tlpFromSnapshot(request: RunRequest): TLPCurve {
  const nodes = request.marketSnapshot.tlpNodes;
  return nodes.length > 0 ? buildTLPCurve(nodes) : DEFAULT_TLP_CURVE;
}

/**
 * Execute the stochastic run for one request against its resolved portfolio.
 * Base scenario only; the deterministic RunResult is not produced or
 * consumed here; callers wanting both run both entry points.
 */
export function runStochastic(
  request: RunRequest,
  portfolio: PortfolioSpec,
  options: StochasticRunOptions = {},
): StochasticRunResult {
  if (portfolio.id !== request.portfolioId) {
    throw new Error(
      `stochastic: resolved portfolio "${portfolio.id}" does not match request ` +
        `portfolioId "${request.portfolioId}"`,
    );
  }
  // The stochastic route keeps the original convention, so a `walk` a CD book file carries is
  // dropped here and never read.
  portfolio = stripCdMarks(portfolio);
  const baseScenario: Scenario | undefined = request.scenarios.find(
    (s) => s.rateSpec.kind === "base",
  );
  if (!baseScenario) {
    throw new Error(
      'stochastic: no base scenario (a rateSpec of kind "base") is present in the request',
    );
  }
  if (baseScenario.newBusiness.mode !== "static") {
    throw new NotImplementedError(
      "stochastic.dynamic-new-business",
      `base scenario "${baseScenario.id}" requests dynamic new business; the ` +
        `stochastic mode projects static runoff only this window and ` +
        `refuses rather than silently dropping the reinvestment rules`,
    );
  }

  const nPaths = validateNPaths(options.nPaths ?? DEFAULT_STOCHASTIC_PATHS);
  const seed = parseSeed(request.seed);
  // Every gap refusal (option shape, model, grid, size cap) before the book is bound or a path simulated.
  const gapOption =
    options.gap === undefined
      ? undefined
      : refuseGapBeforeSimulation(options.gap, options.model ?? "hull-white-1f", portfolio.positions.length, nPaths, request.grid.horizonMonths);
  const basis: Exclude<DiscountBasis, "spread-consistent"> = options.discountBasis ?? "all-in";
  const horizon = request.grid.horizonMonths;

  // Bind assumption sets (duplicate ids are the same input error orchestrate
  // rejects); resolve the base scenario's effective (overlay-applied) book.
  const setById = new Map<string, AssumptionSet>();
  for (const set of request.assumptionSets) {
    if (setById.has(set.id)) throw new DuplicateAssumptionSetError(set.id);
    setById.set(set.id, bindAssumptions(set));
  }
  const baseSet = setById.get(baseScenario.assumptionSetId);
  if (!baseSet) {
    throw new Error(
      `stochastic: scenario "${baseScenario.id}" references unknown assumption ` +
        `set "${baseScenario.assumptionSetId}"`,
    );
  }
  // The full beta form reads a scenario's level, never a simulated path, so a Monte Carlo
  // run over it would price one deterministic deposit on every path. Refused rather than reported as a distribution.
  if (setsBindFullForm([baseSet])) {
    throw new Error(
      `stochastic: assumption set "${baseSet.id}" binds the full beta form, which reads the scenario's level and ` +
        "not a simulated path; run it deterministically",
    );
  }
  // The component decay form reads its dated path, never a simulated one. Refused likewise.
  if (setsBindComponentDecay([baseSet])) {
    throw new Error(
      `stochastic: assumption set "${baseSet.id}" binds the component decay form, which reads its dated rate path and ` +
        "not a simulated path; run it deterministically",
    );
  }
  // The replicating-portfolio credit is a deterministic transfer rate on the base curve; the
  // stochastic FTP is not built. Refused likewise.
  if (setsBindReplicatingPortfolio([baseSet])) {
    throw new Error(
      `stochastic: assumption set "${baseSet.id}" binds the replicating-portfolio credit, a deterministic transfer rate on ` +
        "the base curve; stochastic FTP is not built, so run it deterministically",
    );
  }
  // The same mapping the deterministic entry resolves, held fixed
  // across every Monte Carlo path (no house-price volatility).
  const macro = resolveRunMacro(request, request.marketSnapshot);
  const effective =
    baseSet.bindings.length > 0
      ? applyStaticOverlays(portfolio, baseSet, options.behavioral, macroTargetsOf(macro))
      : portfolio;

  // Resolve the named rate indices once, at the entry, and
  // refuse a floater whose index the market does not carry before any path is
  // simulated. Each path's index reset compounds that path's own one-month
  // resets over the tenor (in arrears); there is no analytic forward. It is given
  // the index histories a lag reads, which every path reads unshocked.
  const rateIndices = resolveRunRateIndices(portfolio, request.marketSnapshot, undefined, request.indexHistories ?? []);
  // Piece B, step B3a (decision 43): when the run reads a swap or formula index, every index it reads with its
  // formula text, after the run's own note.
  const formulaNote = rateIndexFormulaNote(indicesRead(portfolio, request.marketSnapshot), "stochastic");
  // Step B3b (decisions 49 and 52): the index histories the lags read, after the formula note.
  const historyNote = rateIndexHistoryNote(indexHistoryReadings(portfolio, request.marketSnapshot, request.indexHistories ?? []));

  const baseCurve = buildBaseCurve(request.marketSnapshot);
  const tlp = tlpFromSnapshot(request);

  // The one model dispatch. The HW branch calls the
  // frozen HW module exactly as before the slice; BGM is its sibling.
  const model: StochasticModel = options.model ?? "hull-white-1f";
  const saved = options.savedCalibration;
  const modelParams = saved === undefined ? overrideFor(model, options.modelParams) : savedOverride(model, saved, request, options.modelParams);
  let env: StochasticEnvironment | BgmEnvironment;
  if (model === "bgm-lmm-2f") {
    const bgmEnv = buildBgmEnvironment(request.marketSnapshot, baseCurve, {
      horizonMonths: horizon,
      nPaths,
      seed,
      modelParams: modelParams as BgmModelOverride | undefined,
    });
    options.onBgmEnvironment?.(bgmEnv, baseScenario);
    env = bgmEnv;
  } else {
    const hwEnv = buildStochasticEnvironment(request.marketSnapshot, baseCurve, {
      horizonMonths: horizon,
      nPaths,
      seed,
      modelParams: modelParams as StochasticModelOverride | undefined,
    });
    options.onEnvironment?.(hwEnv, baseScenario);
    env = hwEnv;
  }

  const tlpFactors = buildTlpFactors(horizon, tlp, basis);
  const coa = effective.coa;
  const sideByFamily = new Map<string, BalanceSheetSide>();
  for (const f of coa.families) sideByFamily.set(f.id, f.side);
  // Off balance sheet: the same exclusion the deterministic EVE fold
  // makes (eve/computeEve.ts). Without it a commitment family's drawdown stream
  // would enter pvAssets on every path, so the whole EVE distribution, not one
  // number, would shift. Deliberately NOT applied to the NII arm below: that
  // call is computeNII verbatim, and a commitment carries no interest at all,
  // so it contributes a structurally zero row there.
  const commitments = commitmentFamilyIds(coa);
  const nonRate = new Set(coa.families.filter((f) => isNonRateFamily(f)).map((f) => f.id));
  // Swap legs discount on each path's risk-free factors with no TLP
  // factor, summed apart and added once, last, as in the
  // deterministic fold (eve/computeEve.ts). The gate is the family side
  // (hasDerivativeFamily): a book with no derivative family folds exactly as
  // before.
  const hedged = hasDerivativeFamily(coa);
  const derivatives = derivativeFamilyIds(coa);
  const riskFreeFactors = hedged ? buildTlpFactors(horizon, tlp, "risk-free") : tlpFactors;

  // One projection of the SAME effective book per path, through the SAME
  // aggregation hot loop the deterministic run uses. Paths reduce in index
  // order; per-path values land in typed arrays for the summaries.
  const evePerPath = new Float64Array(nPaths);
  const niiPerPath = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const cf = aggregateScenario(
      effective,
      { scenarioId: baseScenario.id, path: env.paths[p] },
      request.grid,
      rateIndices,
      macro,
    );

    let pvAssets = 0;
    let pvLiabilities = 0;
    let pvDerivatives = 0;
    for (const fam of cf.byFamily) {
      if (commitments.has(fam.familyId)) continue;
      if (derivatives.has(fam.familyId)) {
        pvDerivatives += pvBucketedSeriesOnPath(fam.series, env.discount.Dcorr[p], riskFreeFactors);
        continue;
      }
      const side = sideByFamily.get(fam.familyId);
      if (side === undefined) {
        throw new Error(
          `stochastic: family "${fam.familyId}" is not in the chart of accounts`,
        );
      }
      // S3a-1 follow-up: a non-rate-sensitive balance is valued at book on every path, as in the deterministic fold.
      const pv = nonRate.has(fam.familyId) ? (fam.series.balance[0] ?? 0) : pvBucketedSeriesOnPath(fam.series, env.discount.Dcorr[p], tlpFactors);
      if (side === "liability") pvLiabilities += pv;
      else if (side === "asset") pvAssets += pv;
    }
    evePerPath[p] = hedged ? pvAssets - pvLiabilities + pvDerivatives : pvAssets - pvLiabilities;

    // NII through computeNII VERBATIM (same side flip, same horizon window),
    // so the stochastic NII semantics cannot drift from the deterministic ones.
    niiPerPath[p] = computeNII([cf], coa).byScenario[0].totalNet12;
  }

  // The gap arm, its own loop after the EVE and NII arm so that arm is untouched. The refusal above
  // admits Hull-White only, so env.paths are the HW paths; the factory options are the projection's own.
  let gap: StochasticGapBlock | undefined;
  if (gapOption !== undefined) {
    gap = computeStochasticGap({
      book: effective,
      paths: env.paths,
      scenarioId: baseScenario.id,
      makeInstrument: (pos) => makeInstrument(pos.terms, { rateIndices, macro }),
    });
  }

  return {
    // Slice 4b (ruling 9): 0.4.0 only when the envelope carries gap. S2b-3: 0.5.0 only when it used a saved fit.
    schemaVersion: saved !== undefined ? STOCHASTIC_SAVED_CALIBRATION_SCHEMA_VERSION : gap !== undefined ? STOCHASTIC_GAP_SCHEMA_VERSION : STOCHASTIC_RESULT_SCHEMA_VERSION,
    kind: "stochastic-distribution",
    model,
    runId: request.runId,
    scenarioId: baseScenario.id,
    assumptionSetId: baseScenario.assumptionSetId,
    seed: request.seed,
    nPaths,
    horizonMonths: horizon,
    discountBasis: basis,
    // Schema 0.2.0: which curve the base curve built on; not hashed.
    curveDefault: curveDefaultStampOf(request.marketSnapshot),
    calibration: saved !== undefined ? savedCalibrationArmOf(saved) : env.calibration,
    martingale: env.martingale,
    // Schema 0.3.0: the simulation block, on BGM runs only.
    ...("simulation" in env ? { simulation: env.simulation } : {}),
    eveDistribution: summarise(evePerPath),
    nii12mDistribution: summarise(niiPerPath),
    ...(gap !== undefined ? { gap } : {}),
    notImplemented: [
      makeNotImplemented(
        STOCHASTIC_SHOCKED_SCENARIOS_LAYER,
        `stochastic distributions are computed for the base scenario only this ` +
          `window; shocked-scenario distributions await the ` +
          `shocked-NII convention migration and are refused, not ` +
          `approximated. NII horizon distributed: ${STOCHASTIC_NII_HORIZON_MONTHS} months.`,
      ),
      ...(formulaNote !== undefined ? [formulaNote] : []),
      ...(historyNote !== undefined ? [historyNote] : []),
    ],
  };
}
