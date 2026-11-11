/**
 * BGM stochastic rate environment: calibrate
 * the kernel's shifted-CEV LIBOR market model (Rebonato two-factor volatility, displacement 0.05, CEV
 * 0.5, the engine of record) on the default subset of the run's long-yield volatility surface, simulate
 * it, and wrap each realisation as a BgmRatePath the projection consumes unchanged.
 *
 * A sibling of the Hull-White module, which stays byte for byte as it is. The MODEL lives in the frozen
 * kernel (calibrateBGM, simulateBGM, reconstructPathDFBgm); this module only assembles and refuses:
 *
 *   - Refusals, in this order: a market whose own derivedFrom names a short-rate volatility op is
 *     BgmShockUnreadError, with or without an override (BGM reads the long-yield surface, so the shock
 *     would be silently unread); without an override, an empty long-yield block is
 *     StochasticLongYieldVolsError and fewer than BGM_SUBSET_MIN_POINTS of the kernel's 28-point default
 *     subset is BgmSubsetError. The 10 bp gate is reported, never refused.
 *   - The simulation is ALWAYS 360 months, whatever the run horizon (decision 97): the kernel's forward
 *     grid is nSteps + 1 long and its tenor projection extrapolates past the grid edge with the last
 *     simulated forward, so a grid cut at the run horizon puts the zero-vol long tenors off the curve
 *     (44 bp on the 30Y at 120 months). The paths, the discount factors and the martingale block read
 *     the first horizonMonths rows.
 *   - Discounting: kernel reconstructPathDFBgm on the 1D saved row, terminally corrected per step so
 *     E_p[D_p(t_k)] = P^M(0, t_k); the per-step correction makes the first horizonMonths rows of the
 *     360-month reconstruction exactly the reconstruction a horizon-length grid of the same draws gives.
 *   - The martingale helpers are restated here on the 1D saved row (the HW file's read rPaths and are
 *     private): the uncorrected trapezoid drift at the run horizon, and the antithetic-pair standard
 *     error of the corrected terminal DF.
 *   - Calibration plus simulation plus reconstruction is timed into simulation.fixedCostMs (decision 96).
 *     That one field is a wall-clock measurement; every other output is a pure function of the inputs and
 *     the seed (kernel PCG32), byte for byte.
 */
import {
  calibrateBGM,
  isDefaultCalibrationSwaption,
  reconstructPathDFBgm,
  simulateBGM,
  BGM_CEV_BETA_OF_RECORD,
  BGM_DISPLACEMENT_OF_RECORD,
  DEFAULT_SWAPTION_CALIB_EXPIRIES,
  DEFAULT_SWAPTION_CALIB_TENORS,
  type BGMSimulationResult,
  type MarketSnapshot,
  type PathDFResult,
  type ZeroCurve,
} from "@alm/kernel";
import {
  BGM_RMSE_GATE_BP,
  BGM_SAVED_TENORS_YEARS,
  BGM_SUBSET_MIN_POINTS,
  BP_PER_UNIT,
  MONTHS_PER_YEAR,
  STOCHASTIC_DT_YEARS,
  TRAPEZOID_WEIGHT,
  type BgmLongYieldCalibration,
  type BgmModelOverride,
  type BgmOverrideCalibration,
  type StochasticMartingaleCheck,
  type StochasticSimulationSummary,
} from "../contracts/stochastic";
import { shortRateVolOpCount } from "../market/shortRateVolOps";
import { BgmRatePath } from "./bgmRatePath";

/** The BGM simulation grid, months: always 30 years (decision 97). */
export const BGM_SIMULATION_MONTHS = 360;

/** The default subset, in words, for the refusal sentences (kernel DEFAULT_SWAPTION_CALIB_*). */
const SUBSET_WORDS = "expiries 1M, 3M, 6M, 1Y, 2Y, 5Y and 10Y by tenors 1Y, 2Y, 5Y and 10Y";
const SUBSET_SIZE = DEFAULT_SWAPTION_CALIB_EXPIRIES.length * DEFAULT_SWAPTION_CALIB_TENORS.length;

/**
 * The decision 84 c sentence, verbatim: the engine's BgmShockUnreadError and the route's pre-queue
 * refusal both read this one constant, so the two texts cannot drift.
 */
export const BGM_SHOCK_SENTENCE =
  "the market carries a short-rate volatility shock, which the BGM model does not read (it calibrates to " +
  "the long-yield surface), so the shock would be silently ignored; run Hull-White on this market, or BGM " +
  "on the unshocked base.";

/** Thrown when a BGM run is requested on a market carrying a short-rate volatility shock (decision 84 c). */
export class BgmShockUnreadError extends Error {
  readonly layer = "stochastic.calibration";
  readonly opCount: number;
  constructor(opCount: number, baseId: string) {
    super(
      `stochastic.calibration: ${BGM_SHOCK_SENTENCE} (derivedFrom names ${opCount} short-rate volatility ` +
        `op(s) on base ${JSON.stringify(baseId)}.)`,
    );
    this.name = "BgmShockUnreadError";
    this.opCount = opCount;
  }
}

/** Thrown when a BGM run without an override meets a market with no long-yield volatility surface. */
export class StochasticLongYieldVolsError extends Error {
  readonly layer = "stochastic.calibration";
  constructor() {
    super(
      "stochastic.calibration: the market carries no long-yield volatility surface; the BGM calibration " +
        "has no volatility target and the engine does not guess one. Supply a market with a long-yield " +
        "volatility surface, or an explicit BGM parameter override.",
    );
    this.name = "StochasticLongYieldVolsError";
  }
}

/** Thrown when the long-yield volatility surface holds too few points of the default calibration subset. */
export class BgmSubsetError extends Error {
  readonly layer = "stochastic.calibration";
  readonly found: number;
  constructor(found: number) {
    super(
      `stochastic.calibration: the long-yield volatility surface holds ${found} of the ${SUBSET_SIZE} points ` +
        `of the BGM default calibration subset (${SUBSET_WORDS}); the six-parameter Rebonato fit needs at ` +
        `least ${BGM_SUBSET_MIN_POINTS}. Supply a market with more of the subset, or an explicit BGM ` +
        "parameter override.",
    );
    this.name = "BgmSubsetError";
    this.found = found;
  }
}

export interface BgmEnvironmentOptions {
  /** Run horizon, months, at most BGM_SIMULATION_MONTHS. The simulation is always 360 months. */
  horizonMonths: number;
  /** Total path count; even (antithetic pairs). Validated by the caller. */
  nPaths: number;
  /** RNG seed for the kernel PCG32. */
  seed: bigint;
  /** Skip the calibration and use these Rebonato parameters, recorded verbatim (source "override"). */
  modelParams?: BgmModelOverride;
}

/** The assembled BGM environment one run consumes. */
export interface BgmEnvironment {
  calibration: BgmLongYieldCalibration | BgmOverrideCalibration;
  /** The full 360-month kernel simulation. */
  sim: BGMSimulationResult;
  /** One path per Monte Carlo realisation, horizonMonths steps, index-aligned with `discount.Dcorr`. */
  paths: BgmRatePath[];
  /** Per-path corrected money-market DFs, the first horizonMonths rows; meanErrBp over those rows. */
  discount: PathDFResult;
  martingale: StochasticMartingaleCheck;
  simulation: StochasticSimulationSummary;
}

/** The 1D saved row of path p at sim index k. */
function oneDayRate(sim: BGMSimulationResult, oneDayIndex: number, p: number, k: number): number {
  return sim.rates[(p * sim.times.length + k) * sim.tenors.length + oneDayIndex];
}

/**
 * Uncorrected terminal money-market DF drift at the run horizon, bp: the trapezoidal accrual
 * reconstructPathDFBgm compounds on the 1D row, seeded at the t = 0 forward, WITHOUT its correction.
 */
function rawTerminalDrift(sim: BGMSimulationResult, curve: ZeroCurve, horizonMonths: number, oneDayIndex: number): number {
  const dt = sim.dtYears;
  const f0 = -Math.log(curve.discountFactor(dt)) / dt;
  let mean = 0;
  for (let p = 0; p < sim.nPaths; p++) {
    let cum = 1;
    let rPrev = f0;
    for (let k = 0; k < horizonMonths; k++) {
      const rk = oneDayRate(sim, oneDayIndex, p, k);
      cum *= Math.exp(-(TRAPEZOID_WEIGHT * (rPrev + rk)) * dt);
      rPrev = rk;
    }
    mean += cum;
  }
  mean /= sim.nPaths;
  return (mean - curve.discountFactor(sim.times[horizonMonths - 1])) * BP_PER_UNIT;
}

/** Antithetic-pair standard error of the corrected terminal DF across paths. */
function terminalDfPairSE(Dcorr: Float64Array[]): number {
  const nPaths = Dcorr.length;
  const last = Dcorr[0].length - 1;
  const nPairs = nPaths / 2;
  let mean = 0;
  for (let p = 0; p < nPaths; p++) mean += Dcorr[p][last];
  mean /= nPaths;
  if (nPairs <= 1) return 0;
  let ss = 0;
  for (let j = 0; j < nPairs; j++) {
    const d = (Dcorr[2 * j][last] + Dcorr[2 * j + 1][last]) / 2 - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (nPairs - 1)) / Math.sqrt(nPairs);
}

/** max_k |E_p[D_p(t_k)] - P^M(0, t_k)| over the run horizon, bp. */
function correctedMaxErrBp(Dcorr: Float64Array[], sim: BGMSimulationResult, curve: ZeroCurve, horizonMonths: number): number {
  let maxErr = 0;
  for (let k = 0; k < horizonMonths; k++) {
    let mean = 0;
    for (let p = 0; p < Dcorr.length; p++) mean += Dcorr[p][k];
    mean /= Dcorr.length;
    maxErr = Math.max(maxErr, Math.abs(mean - curve.discountFactor(sim.times[k])) * BP_PER_UNIT);
  }
  return maxErr;
}

/**
 * Refuse, calibrate (or accept the override), simulate 360 months, reconstruct the discount factors,
 * and wrap every path at the run horizon.
 */
export function buildBgmEnvironment(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  options: BgmEnvironmentOptions,
): BgmEnvironment {
  const { horizonMonths, nPaths, seed } = options;

  const volOps = shortRateVolOpCount(snapshot);
  if (volOps > 0) {
    throw new BgmShockUnreadError(volOps, String((snapshot as { derivedFrom?: { baseId?: unknown } }).derivedFrom?.baseId));
  }
  if (!Number.isInteger(horizonMonths) || horizonMonths < 1 || horizonMonths > BGM_SIMULATION_MONTHS) {
    throw new Error(
      `stochastic.bgm: a horizon of ${horizonMonths} months does not fit the ${BGM_SIMULATION_MONTHS}-month BGM simulation grid`,
    );
  }

  const started = performance.now();
  let calibration: BgmLongYieldCalibration | BgmOverrideCalibration;
  let params: { a: number; b: number; c: number; d: number; beta: number; volScalar: number; displacement: number; cevBeta: number };
  if (options.modelParams) {
    const { a, b, c, d, beta, volScalar, reason } = options.modelParams;
    calibration = { source: "override", model: "bgm-lmm-2f", a, b, c, d, beta, volScalar, reason };
    params = { a, b, c, d, beta, volScalar, displacement: BGM_DISPLACEMENT_OF_RECORD, cevBeta: BGM_CEV_BETA_OF_RECORD };
  } else {
    if (snapshot.swaptionATMQuotes.length === 0) throw new StochasticLongYieldVolsError();
    const subset = snapshot.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
    if (subset.length < BGM_SUBSET_MIN_POINTS) throw new BgmSubsetError(subset.length);
    const fit = calibrateBGM({ ...snapshot, swaptionATMQuotes: subset }, curve);
    calibration = {
      source: "long-yield-atm-calibration",
      a: fit.a,
      b: fit.b,
      c: fit.c,
      d: fit.d,
      beta: fit.beta,
      volScalar: fit.volScalar,
      displacement: fit.displacement,
      cevBeta: fit.cevBeta,
      rmseBp: fit.rmseBp,
      rmseGateBp: BGM_RMSE_GATE_BP,
      rmseGateBreached: fit.rmseBp > BGM_RMSE_GATE_BP,
      nQuotes: fit.expiries.length,
      subset: fit.expiries.map((expiryYears, i) => ({ expiryYears, tenorYears: fit.tenors[i] })),
      iterations: fit.iterations,
    };
    params = {
      a: fit.a, b: fit.b, c: fit.c, d: fit.d, beta: fit.beta, volScalar: fit.volScalar,
      displacement: fit.displacement, cevBeta: fit.cevBeta,
    };
  }

  const sim = simulateBGM(curve, params, {
    horizonYears: BGM_SIMULATION_MONTHS / MONTHS_PER_YEAR,
    dtYears: STOCHASTIC_DT_YEARS,
    nPairs: nPaths / 2,
    seed,
    savedTenors: BGM_SAVED_TENORS_YEARS,
  });
  const full = reconstructPathDFBgm(sim, curve);
  const fixedCostMs = performance.now() - started;

  const Dcorr = full.Dcorr.map((d) => d.slice(0, horizonMonths));
  const correctedMaxAbsErrBp = correctedMaxErrBp(Dcorr, sim, curve, horizonMonths);
  const discount: PathDFResult = { Dcorr, meanErrBp: correctedMaxAbsErrBp };

  const paths: BgmRatePath[] = new Array(sim.nPaths);
  for (let p = 0; p < sim.nPaths; p++) paths[p] = new BgmRatePath(sim, p, curve, horizonMonths);

  const oneDayIndex = 0; // BGM_SAVED_TENORS_YEARS[0] is 1/360
  const martingale: StochasticMartingaleCheck = {
    correctedMaxAbsErrBp,
    rawTerminalErrBp: rawTerminalDrift(sim, curve, horizonMonths, oneDayIndex),
    terminalDfStandardError: terminalDfPairSE(Dcorr),
    terminalYears: sim.times[horizonMonths - 1],
  };

  const simulation: StochasticSimulationSummary = {
    nCapFires: sim.nCapFires,
    nFloorFires: sim.nFloorFires,
    nTotalEvolutions: sim.nTotalEvolutions,
    savedTenors: [...BGM_SAVED_TENORS_YEARS],
    fixedCostMs,
  };

  return { calibration, sim, paths, discount, martingale, simulation };
}
