/**
 * Stochastic rate environment: calibrate Hull-White 1F on the run's
 * market snapshot, simulate the short-rate factor, and wrap each Monte Carlo
 * realisation as a kernel StochasticRatePath the existing projection machinery
 * consumes unchanged.
 *
 * Division of labor, deliberately narrow (mirroring the FTP module's stance):
 * the MODEL lives in the frozen kernel: calibrateHW (least-squares on the ATM
 * cap normal-vol column), simulateHW (exact transition, antithetic pairing,
 * multiplicative martingale correction), hwBondPrice (analytic HW bond price
 * P(t, t+dt) per path/step, from which the 1M accrual rate is read), and
 * reconstructPathDF (per-path money-market discount factors
 * with terminal correction so E_p[D_p(t_k)] = P^M(0,t_k)). This module only
 * ASSEMBLES: it aligns the simulator's step grid (time (k+1)·dt at index k)
 * with the RatePath convention (rateAt(step) is the 1M rate at time step·dt),
 * and it refuses instead of guessing where an input is missing.
 *
 * Path alignment (the seam most likely to be wired wrong, so it is pinned
 * here and tested by the zero-vol degeneracy anchor):
 *   - path1M[0]   = curve.forwardRate(0, dt), the simple forward: the
 *     month-1 rate is locked at origination before any path move, matching
 *     DeterministicRatePath.rateAt(0) since Lab fix A.
 *   - path1M[s]   = (1/P(t, t+dt) - 1)/dt for s >= 1, the simple forward from
 *     the HW bond price hwBondPrice at the simulator's index s-1 (t =
 *     sim.times[s-1] = s·dt, X = sim.XPaths[p][s-1]): the simulator's index k
 *     carries time (k+1)·dt, so the 1M rate at RatePath time s·dt is the
 *     simulator's index s-1.
 *   - Why the simple forward: the 1M rate is an ACCRUAL rate, and accrual over
 *     dt is simple interest on the discount-factor ratio. projectHWToTenor
 *     returns the QUOTED basis of the curve's convention (bond-equivalent under
 *     the Treasury CMT pack, a few bp above the simple forward); under
 *     annual_act360 the quoted sub-1Y basis is already simple and the two agree.
 *   - forwardRateAt term forwards come analytically from the latent factor via
 *     HWForwardState (xPath aligned the same way inside the kernel class).
 * At sigma = 0 every formula collapses to the deterministic curve forward, so
 * a StochasticRatePath built here degenerates to DeterministicRatePath, the
 * plumbing proof the zero-vol anchor asserts end to end.
 *
 * Convexity shift (phi-corrected convention, brought in by the 2026-09-24
 * kernel re-vendor): the kernel
 * simulator's short rate is r = f^M(0,t) + phi(t) + X(t), with the
 * deterministic shift phi(t) = (sigma^2/2)·B(t)^2 (hwPhi), and the analytic
 * bond price (hwBondPrice, and HWForwardState) carries the B·phi(t)
 * term in V(t,T). The multiplicative martingale correction is still applied
 * (in simulateHW and again, terminally, in reconstructPathDF), so the
 * DISCOUNTING identity E_p[D_p(t)] = P^M(0,t) holds exactly, which is what
 * per-path PV relies on; rawTerminalErrBp still reports the uncorrected DF's
 * residual drift, now Monte Carlo and accrual-discretization error rather than
 * a missing drift term. Before the re-vendor the kernel omitted phi(t).
 *
 * Determinism: no clock; all randomness flows from the caller's seed through
 * the kernel PCG32. Same seed, same environment, byte for byte.
 */
import {
  calibrateHW,
  hwBondPrice,
  reconstructPathDF,
  simulateHW,
  StochasticRatePath,
  type HWCalibrationResult,
  type HWSimulationResult,
  type MarketSnapshot,
  type PathDFResult,
  type ZeroCurve,
} from "@alm/kernel";
import {
  BP_PER_UNIT,
  HW_RMSE_GATE_BP,
  MONTHS_PER_YEAR,
  STOCHASTIC_DT_YEARS,
  TRAPEZOID_WEIGHT,
  type StochasticCalibrationSummary,
  type StochasticMartingaleCheck,
} from "../contracts/stochastic";
import { shortRateVolOpCount } from "../market/shortRateVolOps";

/**
 * Thrown when a stochastic run is requested against a market snapshot with no
 * ATM cap quotes and no explicit parameter override. The engine refuses to
 * invent a volatility (a stochastic
 * request without cap vols refuses rather than defaulting).
 */
export class StochasticCapVolsError extends Error {
  readonly layer = "stochastic.calibration";
  constructor() {
    super(
      "stochastic.calibration: market snapshot carries no ATM cap quotes; " +
        "Hull-White calibration has no volatility target and the engine does not " +
        "guess one. Supply a snapshot with an ATM cap surface, or an explicit " +
        "modelParams override.",
    );
    this.name = "StochasticCapVolsError";
  }
}

/**
 * Thrown when a modelParams override is supplied on a market snapshot whose own
 * derivedFrom names a short-rate volatility shock. The
 * override skips the Hull-White calibration that reads those volatilities, so
 * the shock would be silently ignored; the engine refuses instead of letting a
 * run read as shocked when it is not. This checks the snapshot's immediate
 * record only; the server also walks the stored lineage.
 */
export class StochasticVolShockOverrideError extends Error {
  readonly layer = "stochastic.calibration";
  constructor(opCount: number, baseId: string) {
    super(
      "stochastic.calibration: the market snapshot carries a short-rate volatility shock " +
        `(derivedFrom names ${opCount} short-rate volatility op(s) on base ${JSON.stringify(baseId)}), ` +
        "and a modelParams override skips the Hull-White calibration that reads those volatilities, " +
        "so the shock would be silently ignored. Drop the override to calibrate on the shocked " +
        "volatilities, or run the override on the unshocked base.",
    );
    this.name = "StochasticVolShockOverrideError";
  }
}

/** Explicit HW parameters supplied by the caller instead of a market calibration. */
export interface StochasticModelOverride {
  /** Mean-reversion speed, 1/year. */
  a: number;
  /** Instantaneous normal vol, decimal annualised (0 is the degeneracy probe). */
  sigma: number;
  /** Why the caller is overriding the market fit (recorded verbatim). */
  reason: string;
}

export interface StochasticEnvironmentOptions {
  /** Projection horizon, months. Simulation covers exactly this grid. */
  horizonMonths: number;
  /** Total path count; must be even (antithetic pairs). Validated by the caller. */
  nPaths: number;
  /** RNG seed for the kernel PCG32. */
  seed: bigint;
  /**
   * Skip market calibration and use these parameters. The envelope records the
   * override verbatim (source: "override"); it can never read as a market fit.
   */
  modelParams?: StochasticModelOverride;
}

/** The assembled stochastic environment one run consumes. */
export interface StochasticEnvironment {
  calibration: StochasticCalibrationSummary;
  sim: HWSimulationResult;
  /** One RatePath per Monte Carlo path, index-aligned with `discount.Dcorr`. */
  paths: StochasticRatePath[];
  /** Per-path terminally-corrected money-market DFs (kernel reconstructPathDF). */
  discount: PathDFResult;
  martingale: StochasticMartingaleCheck;
}

/** Summarise a kernel calibration result into the envelope's calibrated arm. */
function summariseCalibration(fit: HWCalibrationResult): StochasticCalibrationSummary {
  return {
    source: "cap-atm-calibration",
    a: fit.a,
    sigma: fit.sigma,
    rmseBp: fit.rmseBp,
    rmseGateBp: HW_RMSE_GATE_BP,
    rmseGateBreached: fit.rmseBp > HW_RMSE_GATE_BP,
    nQuotes: fit.expiries.length,
    underlyingTau: fit.underlyingTau,
    iterations: fit.iterations,
  };
}

/**
 * Uncorrected terminal money-market DF drift: the same trapezoidal accrual the
 * kernel's reconstructPathDF compounds, WITHOUT the terminal correction, at the
 * final step only. Reported (bp) so the martingale correction's workload is
 * visible; the corrected identity is what discounting actually uses.
 */
function rawTerminalDrift(sim: HWSimulationResult, curve: ZeroCurve): number {
  const nSteps = sim.times.length;
  const dt = sim.dtYears;
  const f0 = -Math.log(curve.discountFactor(dt)) / dt;
  let mean = 0;
  for (let p = 0; p < sim.nPaths; p++) {
    let cum = 1;
    let rPrev = f0;
    for (let k = 0; k < nSteps; k++) {
      const rk = sim.rPaths[p][k];
      cum *= Math.exp(-(TRAPEZOID_WEIGHT * (rPrev + rk)) * dt);
      rPrev = rk;
    }
    mean += cum;
  }
  mean /= sim.nPaths;
  return (mean - curve.discountFactor(sim.times[nSteps - 1])) * BP_PER_UNIT;
}

/** Antithetic-pair standard error of the corrected terminal DF across paths. */
function terminalDfPairSE(discount: PathDFResult): number {
  const nPaths = discount.Dcorr.length;
  const last = discount.Dcorr[0].length - 1;
  const nPairs = nPaths / 2;
  let mean = 0;
  for (let p = 0; p < nPaths; p++) mean += discount.Dcorr[p][last];
  mean /= nPaths;
  if (nPairs <= 1) return 0;
  let ss = 0;
  for (let j = 0; j < nPairs; j++) {
    const pm =
      (discount.Dcorr[2 * j][last] + discount.Dcorr[2 * j + 1][last]) / 2;
    const d = pm - mean;
    ss += d * d;
  }
  return Math.sqrt(ss / (nPairs - 1)) / Math.sqrt(nPairs);
}

/**
 * Calibrate (or accept the override), simulate, and wrap every path.
 *
 * The simulation grid is exactly the run's monthly bucket grid: nSteps =
 * horizonMonths at dt = 1/12, so discount index k aligns with cash-flow bucket
 * k (both carry month k+1) with no interpolation anywhere.
 */
export function buildStochasticEnvironment(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  options: StochasticEnvironmentOptions,
): StochasticEnvironment {
  const { horizonMonths, nPaths, seed } = options;

  let calibration: StochasticCalibrationSummary;
  let a: number;
  let sigma: number;
  if (options.modelParams) {
    const volOps = shortRateVolOpCount(snapshot);
    if (volOps > 0) {
      throw new StochasticVolShockOverrideError(volOps, String((snapshot as { derivedFrom?: { baseId?: unknown } }).derivedFrom?.baseId));
    }
    const { a: aOv, sigma: sigmaOv, reason } = options.modelParams;
    calibration = { source: "override", a: aOv, sigma: sigmaOv, reason };
    a = aOv;
    sigma = sigmaOv;
  } else {
    if (!snapshot.capQuotes.some((q) => q.isAtm)) {
      throw new StochasticCapVolsError();
    }
    const fit = calibrateHW(snapshot, curve);
    calibration = summariseCalibration(fit);
    a = fit.a;
    sigma = fit.sigma;
  }

  const sim = simulateHW(curve, a, sigma, {
    horizonYears: horizonMonths / MONTHS_PER_YEAR,
    dtYears: STOCHASTIC_DT_YEARS,
    nPairs: nPaths / 2,
    seed,
  });

  // The 1M accrual rate per path/step: the simple forward (1/P - 1)/dt from
  // the analytic HW bond price P(t, t+dt) (simulator index k = time (k+1)·dt),
  // realigned to the RatePath step convention. One code path for every sigma
  // including zero: at sigma = 0 the same formula collapses to the curve's
  // simple forward, which is the degeneracy the zero-vol anchor asserts, with
  // no special-casing anywhere.
  const dt = STOCHASTIC_DT_YEARS;
  const rate0 = curve.forwardRate(0, dt);
  const nSim = sim.times.length;
  const dfT = new Float64Array(nSim);
  const dfTdt = new Float64Array(nSim);
  for (let k = 0; k < nSim; k++) {
    dfT[k] = curve.discountFactor(sim.times[k]);
    dfTdt[k] = curve.discountFactor(sim.times[k] + dt);
  }
  const paths: StochasticRatePath[] = new Array(sim.nPaths);
  for (let p = 0; p < sim.nPaths; p++) {
    const arr = new Array<number>(horizonMonths);
    arr[0] = rate0;
    const xp = sim.XPaths[p];
    for (let s = 1; s < horizonMonths; s++) {
      const k = s - 1;
      const bond = hwBondPrice(dfT[k], dfTdt[k], sim.a, sim.sigma, sim.times[k], dt, xp[k]);
      arr[s] = (1 / bond - 1) / dt;
    }
    paths[p] = new StochasticRatePath(arr, STOCHASTIC_DT_YEARS, {
      xPath: sim.XPaths[p],
      a: sim.a,
      sigma: sim.sigma,
      curve,
    });
  }

  const discount = reconstructPathDF(sim, curve);
  const martingale: StochasticMartingaleCheck = {
    correctedMaxAbsErrBp: discount.meanErrBp,
    rawTerminalErrBp: rawTerminalDrift(sim, curve),
    terminalDfStandardError: terminalDfPairSE(discount),
    terminalYears: sim.times[sim.times.length - 1],
  };

  return { calibration, sim, paths, discount, martingale };
}
