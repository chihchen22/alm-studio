/**
 * One BGM Monte Carlo realisation as a kernel RatePath.
 *
 * The kernel simulateBGM saves, per path and per step, the curve-convention QUOTED yield at each saved
 * tenor; its row k holds time (k+1)·dt (one more evolution than the row before it, the same alignment
 * the HW seam uses). This class reads that tensor and nothing else:
 *
 *   - rateAt(0) is curve.forwardRate(0, dt), the simple forward: the month-1 rate is locked at
 *     origination before any path move, as DeterministicRatePath.rateAt(0).
 *   - rateAt(s), s >= 1, inverts saved row s-1 of the 1M tenor from the curve's quoted basis to the simple
 *     forward the 1M accrual needs: under semiannual_bond 1/P = (1 + y/2)^(2 tau) and the simple forward
 *     is (1/P - 1)/tau; under annual_act360 the quoted sub-1Y yield is already simple.
 *   - forwardRateAt(step <= 0, tau) is curve.forwardSwapRate(0, tau); forwardRateAt(s, tau) reads saved
 *     row min(s - 1, nRows - 1) at tenor tau, nRows the run horizon. A term forward is never built by
 *     averaging spot rates: a tenor off the saved grid (within 1e-9) is a typed BgmTenorError, at any step.
 *   - The clamp rules copy the kernel StochasticRatePath exactly: rateAt clamps the step to
 *     [0, nSteps - 1] through the same precomputed 1M series.
 *
 * At volScalar 0 the path equals DeterministicRatePath on every rateAt and on every saved tenor of one
 * month or longer, on the 360-month grid the BGM environment always simulates (decision 97). The 1D
 * tenor is the kernel's own sub-month projection and is read verbatim.
 */
import type { BGMSimulationResult, RatePath, ZeroCurve } from "@alm/kernel";
import { STOCHASTIC_DT_YEARS } from "../contracts/stochastic";

/** Saved-tenor match tolerance, years (the kernel bgmTenorIndex tolerance). */
const TENOR_TOLERANCE_YEARS = 1e-9;

/** Thrown when a BGM path is asked for a term forward at a tenor its simulation did not save. */
export class BgmTenorError extends Error {
  readonly layer = "stochastic.bgm-path";
  readonly tenorYears: number;
  constructor(tenorYears: number, savedTenors: ArrayLike<number>) {
    super(
      `stochastic.bgm-path: a term forward at ${tenorYears} years was read, and the BGM simulation saved ` +
        `only the tenors [${Array.from(savedTenors).join(", ")}] years; the BGM path reads saved tenors ` +
        "only and never builds a term forward by averaging spot rates. Read a saved tenor, or run Hull-White.",
    );
    this.name = "BgmTenorError";
    this.tenorYears = tenorYears;
  }
}

/** The simple 1M accrual forward from a quoted 1M yield, by the curve's convention. */
function simpleFromQuoted1M(y: number, convention: ZeroCurve["convention"], tau: number): number {
  if (convention === "annual_act360") return y;
  if (convention === "semiannual_bond") return (Math.pow(1 + y / 2, 2 * tau) - 1) / tau;
  throw new Error(`stochastic.bgm-path: curve convention ${JSON.stringify(convention)} has no 1M inversion`);
}

export class BgmRatePath implements RatePath {
  readonly nSteps: number;
  readonly times: ReadonlyArray<number>;
  private readonly path: ReadonlyArray<number>;
  private readonly curve: ZeroCurve;
  private readonly rates: Float64Array;
  private readonly tenors: Float64Array;
  /** Flat-tensor offset of this path's row 0. */
  private readonly base: number;
  private readonly nTenors: number;

  /**
   * @param sim The kernel BGM simulation (any grid at least `nSteps` rows long).
   * @param pathIndex Which Monte Carlo path this object reads.
   * @param curve The base curve the simulation started from.
   * @param nSteps The run horizon, months: the path exposes rows 0 .. nSteps - 1.
   */
  constructor(sim: BGMSimulationResult, pathIndex: number, curve: ZeroCurve, nSteps: number) {
    const simSteps = sim.times.length;
    if (!Number.isInteger(nSteps) || nSteps < 1 || nSteps > simSteps) {
      throw new Error(
        `stochastic.bgm-path: a horizon of ${nSteps} months does not fit the ${simSteps}-month BGM simulation grid`,
      );
    }
    const dt = STOCHASTIC_DT_YEARS;
    this.nSteps = nSteps;
    this.curve = curve;
    this.rates = sim.rates;
    this.tenors = sim.tenors;
    this.nTenors = sim.tenors.length;
    this.base = pathIndex * simSteps * this.nTenors;

    const i1M = this.tenorIndex(dt);
    const series = new Array<number>(nSteps);
    series[0] = curve.forwardRate(0, dt);
    for (let s = 1; s < nSteps; s++) {
      series[s] = simpleFromQuoted1M(this.rates[this.base + (s - 1) * this.nTenors + i1M], curve.convention, dt);
    }
    this.path = series;

    const times = new Array<number>(nSteps + 1);
    for (let k = 0; k <= nSteps; k++) times[k] = k * dt;
    this.times = times;
  }

  /** Index of a saved tenor, or a typed refusal. */
  private tenorIndex(tenorYears: number): number {
    for (let i = 0; i < this.nTenors; i++) {
      if (Math.abs(this.tenors[i] - tenorYears) < TENOR_TOLERANCE_YEARS) return i;
    }
    throw new BgmTenorError(tenorYears, this.tenors);
  }

  rateAt(step: number): number {
    if (step < 0) return this.path[0];
    if (step >= this.path.length) return this.path[this.path.length - 1];
    return this.path[step];
  }

  forwardRateAt(step: number, tenorYears: number): number {
    const ti = this.tenorIndex(tenorYears);
    if (step <= 0) return this.curve.forwardSwapRate(0, tenorYears);
    const row = Math.min(step - 1, this.nSteps - 1);
    return this.rates[this.base + row * this.nTenors + ti];
  }
}
