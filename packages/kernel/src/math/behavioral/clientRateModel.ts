/**
 * SFR client rate: the PUBLIC total-spread model.
 *
 *   client rate = benchmark (10Y CMT) + total spread
 *
 * There is only one spread here, and that is the point: the total spread over
 * the benchmark. Nothing in this module decomposes the spread, and nothing
 * downstream should try.
 *
 * THE MODEL is a logged error-correction form, written here in its structural
 * reading because that is what the reader tweaks:
 *
 *   d ln S(t) = alpha * (mu0 + gamma * QE(t-1) - ln S(t-1))
 *               + rho * d ln S(t-1) + sigma * eps(t)
 *
 * alpha is the speed the spread returns to its long-run mean, mu0 is that mean
 * on the log scale, gamma shifts it with the Federal Reserve's agency-MBS share,
 * rho carries one month of momentum, and sigma is the residual scale. The
 * regression form is the same equation with a = alpha*mu0, b = -alpha and
 * c = alpha*gamma; `structuralToRegression` is that map.
 *
 * THE COMPARATOR is flat carry: the spread sixty months out equals the spread
 * today. It has no parameters; it is the default, and the reverting form
 * above is the challenger the reader is invited to try.
 *
 * Working in logs keeps the simulated spread positive by construction and makes
 * the error variance roughly proportional to the level.
 *
 * Units are PERCENT throughout. Callers holding decimal rates (the HW/BGM
 * simulators) convert before entry.
 */

import { PCG32 } from "../rates/random";
import { fanPercentile } from "./fanStats";

/** The structural parameters, which are what the tab's sliders move. */
export interface SpreadParams {
  /** Adjustment speed per month, in (0, 1). The regression's -b. */
  readonly alpha: number;
  /** Long-run mean of the LOG spread. The regression's a / alpha. */
  readonly mu0: number;
  /** Momentum on last month's change. The regression's rho. */
  readonly rho: number;
  /** Shift in the long-run log mean per point of QE_SHARE. The regression's c / alpha. */
  readonly gamma: number;
  /** Residual standard deviation of the monthly log change. */
  readonly sigmaLog: number;
}

/** The regression form of the model. */
export interface RegressionParams {
  readonly a: number;
  readonly b: number;
  readonly rho: number;
  readonly c: number;
}

/** Structural to regression. */
export function structuralToRegression(p: SpreadParams): RegressionParams {
  return { a: p.alpha * p.mu0, b: -p.alpha, rho: p.rho, c: p.alpha * p.gamma };
}

/** Regression to structural, for reading a regression table into slider space. */
export function regressionToStructural(r: RegressionParams, sigmaLog: number): SpreadParams {
  const alpha = -r.b;
  return { alpha, mu0: r.a / alpha, rho: r.rho, gamma: r.c / alpha, sigmaLog };
}

/**
 * Months for a deviation from the long-run mean to halve. Returns Infinity at
 * alpha <= 0, where the process no longer reverts.
 */
export function halfLifeMonths(alpha: number): number {
  if (alpha <= 0) return Number.POSITIVE_INFINITY;
  if (alpha >= 1) return 0;
  return Math.log(0.5) / Math.log(1 - alpha);
}

/** One step of the recursion, in log space. `shock` is already scaled by sigma. */
function step(
  lnSLag: number,
  dLnSLag: number,
  qeLag: number,
  p: SpreadParams,
  shock: number,
): number {
  const dLnS =
    p.alpha * (p.mu0 + p.gamma * qeLag - lnSLag) + p.rho * dLnSLag + shock;
  return lnSLag + dLnS;
}

/**
 * One-step in-sample fit on the ACTUAL lags, which is what the fit chart draws.
 * The first two entries are null: the recursion needs both a lagged level and a
 * lagged change, and neither exists at t = 0 or t = 1.
 *
 * Returns the model SPREAD LEVEL in percent, not the log change, so the chart
 * can plot it directly against the realized spread.
 */
export function fitOneStep(
  spreadPct: readonly number[],
  qeShare: readonly number[],
  p: SpreadParams,
): (number | null)[] {
  const lnS = spreadPct.map((s) => Math.log(s));
  return spreadPct.map((_, t) => {
    if (t < 2) return null;
    const dLnSLag = lnS[t - 1] - lnS[t - 2];
    return Math.exp(step(lnS[t - 1], dLnSLag, qeShare[t - 1], p, 0));
  });
}

/** The state the forecast starts from: the last observed level and change. */
export interface SpreadSeed {
  readonly spreadPct: number;
  readonly dLnSLast: number;
}

/** Read the seed off the tail of a realized spread series. */
export function seedFrom(spreadPct: readonly number[]): SpreadSeed {
  const n = spreadPct.length;
  if (n < 2) throw new Error("seedFrom: need at least two observations");
  return {
    spreadPct: spreadPct[n - 1],
    dLnSLast: Math.log(spreadPct[n - 1]) - Math.log(spreadPct[n - 2]),
  };
}

/**
 * Dynamic forecast: each month's output becomes the next month's lag. A one-step
 * forecast would carry the realized lag and flatter an autoregressive model.
 * `qeAhead` supplies one driver value per forecast month. The convention
 * freezes every driver at its origin value, because that is the only
 * construction an ALM user can actually run.
 */
export function forecastSpread(
  seed: SpreadSeed,
  qeAhead: readonly number[],
  p: SpreadParams,
): number[] {
  const out: number[] = [];
  let lnS = Math.log(seed.spreadPct);
  let dLnS = seed.dLnSLast;
  for (const qe of qeAhead) {
    const next = step(lnS, dLnS, qe, p, 0);
    dLnS = next - lnS;
    lnS = next;
    out.push(Math.exp(lnS));
  }
  return out;
}

/** The comparator: the spread never moves. No parameters, no estimation error. */
export function flatCarry(spreadPct: number, horizon: number): number[] {
  return new Array<number>(horizon).fill(spreadPct);
}

/**
 * Simulated spread paths with the model's residual shock.
 *
 * This is the rung the earlier fan did not have. Without a residual the spread
 * path is common to every path, so every basis point of width in the client-rate
 * band belongs to the benchmark and the picture says nothing about spread risk.
 * With sigma the band is a joint statement, and the caption can say so honestly.
 *
 * Returns `nPaths` paths of `qeAhead.length` months, spread level in percent.
 */
export function simulateSpreadPaths(
  seed: SpreadSeed,
  qeAhead: readonly number[],
  p: SpreadParams,
  nPaths: number,
  rngSeed: number,
): Float64Array[] {
  const rng = new PCG32(rngSeed);
  const horizon = qeAhead.length;
  const paths: Float64Array[] = [];
  for (let i = 0; i < nPaths; i++) {
    const path = new Float64Array(horizon);
    let lnS = Math.log(seed.spreadPct);
    let dLnS = seed.dLnSLast;
    for (let t = 0; t < horizon; t++) {
      const next = step(lnS, dLnS, qeAhead[t], p, p.sigmaLog * rng.nextNormal());
      dLnS = next - lnS;
      lnS = next;
      path[t] = Math.exp(lnS);
    }
    paths.push(path);
  }
  return paths;
}

/** Benchmark plus spread, propagating nulls where either side is missing. */
export function assembleClientRate(
  benchmark: readonly (number | null)[],
  spread: readonly (number | null)[],
): (number | null)[] {
  return benchmark.map((b, t) => {
    const s = spread[t];
    return b === null || s === null ? null : b + s;
  });
}

/** Per-month p5 / median / p95 across paths. */
export interface ClientRateFan {
  readonly p5: number[];
  readonly median: number[];
  readonly p95: number[];
}

/**
 * Client-rate fan across simulated benchmark paths and simulated spread paths.
 *
 * `spreadPaths` of length 1 is broadcast to every benchmark path, which is the
 * flat-carry case and the deterministic-spread case; there the band is the
 * benchmark band shifted, and the caption owes the reader that sentence. With
 * one spread path per benchmark path the band is a joint statement about both.
 *
 * `benchPathsPct` are benchmark paths in PERCENT, at least `horizon` long.
 */
export function clientRateFan(
  benchPathsPct: ReadonlyArray<ArrayLike<number>>,
  spreadPaths: ReadonlyArray<ArrayLike<number>>,
): ClientRateFan {
  if (benchPathsPct.length === 0) {
    throw new Error("clientRateFan: benchPathsPct must be non-empty");
  }
  if (spreadPaths.length === 0) {
    throw new Error("clientRateFan: spreadPaths must be non-empty");
  }
  if (spreadPaths.length !== 1 && spreadPaths.length !== benchPathsPct.length) {
    throw new Error(
      "clientRateFan: spreadPaths must hold one path or one per benchmark path",
    );
  }
  const horizon = spreadPaths[0].length;
  const p5: number[] = [];
  const median: number[] = [];
  const p95: number[] = [];
  for (let k = 0; k < horizon; k++) {
    const atK = benchPathsPct
      .map((path, i) => {
        const spread = spreadPaths.length === 1 ? spreadPaths[0] : spreadPaths[i];
        return path[Math.min(k, path.length - 1)] + spread[k];
      })
      .sort((a, b) => a - b);
    p5.push(fanPercentile(atK, 0.05));
    median.push(fanPercentile(atK, 0.5));
    p95.push(fanPercentile(atK, 0.95));
  }
  return { p5, median, p95 };
}

/**
 * Mean absolute error of a projected path against a realized path, in basis
 * points, so the tab can score a reader's own tweak against a realized window.
 */
export function pathMaeBp(projected: readonly number[], realized: readonly number[]): number {
  const n = Math.min(projected.length, realized.length);
  if (n === 0) throw new Error("pathMaeBp: empty path");
  let sum = 0;
  for (let t = 0; t < n; t++) sum += Math.abs(projected[t] - realized[t]);
  return (sum / n) * 100;
}
