/**
 * MMA repricing surface beta(r, ln b) — TypeScript port of a Python reference
 * forecasting core (a rung-6 continuous surface).
 * Ported operation-for-operation; parity tests pin the spec's point-value table
 * and the published forward-shock book path bit-tight.
 *
 * !! UNITS: all rates are in PERCENT p.a. inside this module — r = 4.0 means
 * 4%, and the deposit-rate outputs are percent as well. Feeding decimal rates
 * (r = 0.04) lands beta on the bottom asymptote of the S-curve and silently
 * kills the rate sensitivity. This is the opposite of the Lab's usual
 * decimal-rate convention; convert at the boundary.
 *
 * Model (z = ln(balance$) − lnBRef, monthly step):
 *   beta_max(z) = sigmoid(c0 + c1·z)                   (≤ 1 by construction)
 *   beta_min(z) = s · beta_max(z)
 *   beta(r, z)  = beta_min + (beta_max − beta_min) · sigmoid(k·(r − m))
 *   lambda(z)   = sigmoid(l0 + l1·z)                   (in (0, 1))
 *   D_target    = alpha + beta(r, z)·r
 *   D_t         = D_{t−1} + lambda(z)·(D_target(r_t, z) − D_{t−1}), floored at 0
 *
 * Identification register (from the source project): the two size loadings
 * (c1 on beta_max, l1 on lambda) are identified and positive; the rate S-curve
 * shape (k, ceiling, asymmetry) is weakly identified / prior-driven, so
 * deposit betas at market rates above ~5.5% are extrapolation.
 */

import type {
  RepricingSurfaceBins,
  RepricingSurfaceParams,
} from "./repricingSurfaceTypes";

// No surface is a default argument anywhere in this module: every function
// takes its surface EXPLICITLY (routed callers pass the illustrative surface).

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Pass-through ceiling beta_max(z) = sigmoid(c0 + c1·z), ≤ 1 by construction. */
export function betaMax(z: number, p: RepricingSurfaceParams): number {
  return sigmoid(p.c0 + p.c1 * z);
}

/** Pass-through floor beta_min(z) = s · beta_max(z) (shared floor ratio). */
export function betaMin(z: number, p: RepricingSurfaceParams): number {
  return p.s * betaMax(z, p);
}

/** Equilibrium pass-through beta on the (rate, ln balance) surface; r in PERCENT. */
export function beta(r: number, z: number, p: RepricingSurfaceParams): number {
  const bmax = betaMax(z, p);
  const bmin = p.s * bmax;
  return bmin + (bmax - bmin) * sigmoid(p.k * (r - p.m));
}

/** Nerlove partial-adjustment speed lambda(z) = sigmoid(l0 + l1·z), in (0, 1). */
export function lambda(z: number, p: RepricingSurfaceParams): number {
  return sigmoid(p.l0 + p.l1 * z);
}

/** Equilibrium deposit-rate target alpha + beta(r, z)·r, in PERCENT. */
export function dTarget(r: number, z: number, p: RepricingSurfaceParams): number {
  return p.alpha + beta(r, z, p) * r;
}

/**
 * Recursive Nerlove deposit-rate path for one frozen position (percent p.a.),
 * the port of `sim_surface` (scalar-lnb case; the lnb-path variant exists only
 * to replicate the historical backtest and is not needed here).
 *
 * Two D(0) conventions, matching the two Python exhibits:
 *   - `d0` omitted → D(0) snapped to the equilibrium target at the FIRST RATE
 *     OF THE PATH GIVEN. Note the EVE exhibit snaps at the BASE rate even when
 *     simulating a shocked path (so base PVs are identical across models); a
 *     caller reproducing shocked EVE cells must pass
 *     `d0 = dTarget(baseR0, z)` explicitly rather than omitting d0.
 *   - `d0` given → explicit anchor at an observed deposit rate (the forward
 *     exhibit's convention, anchoring per-bin at `anchorsLast`).
 *
 * The recursion propagates unfloored values and the whole path is floored at 0
 * at the end, exactly as the Python `np.clip(D, 0.0, None)` after the loop.
 */
export function simulateDepositRate(
  ratePathPct: ArrayLike<number>,
  z: number,
  d0: number | undefined,
  p: RepricingSurfaceParams,
): Float64Array {
  const n = ratePathPct.length;
  const lam = lambda(z, p);
  const D = new Float64Array(n);
  D[0] = d0 === undefined ? dTarget(ratePathPct[0], z, p) : d0;
  for (let t = 1; t < n; t++) {
    D[t] = D[t - 1] + lam * (dTarget(ratePathPct[t], z, p) - D[t - 1]);
  }
  for (let t = 0; t < n; t++) if (D[t] < 0) D[t] = 0;
  return D;
}

/**
 * Book-level deposit-rate path: per-bin surface recursions at the frozen
 * last-observed bin positions (`lnbLast`), anchored at the last-observed bin
 * rates (`anchorsLast`), aggregated with the frozen balance shares
 * (`weightsLast`). Same convention (and same bin accumulation order) as the
 * forward exhibit of the Python reference.
 */
export function simulateBookRate(
  ratePathPct: ArrayLike<number>,
  bins: RepricingSurfaceBins,
  p: RepricingSurfaceParams,
): Float64Array {
  const n = ratePathPct.length;
  const book = new Float64Array(n);
  for (let b = 0; b < bins.lnbLast.length; b++) {
    const z = bins.lnbLast[b] - p.lnBRef;
    const Db = simulateDepositRate(ratePathPct, z, bins.anchorsLast[b], p);
    const w = bins.weightsLast[b];
    for (let t = 0; t < n; t++) book[t] += w * Db[t];
  }
  return book;
}

/**
 * Effective book beta from a ±100bp parallel shock of the base rate path:
 * central difference (D^{+100} − D^{−100}) / 2, averaged over the first
 * `windowMonths` (default: the whole path). Shocked paths are floored at 0
 * before simulation, as in the forward exhibit. Covers the exhibit's
 * short-run (windowMonths = 12) and path-average (full window) figures; the
 * exhibit's long-run TERMINAL-month beta is a point value at the last month,
 * not a window average, and is not produced by this function.
 */
export function effectiveBetaBook(
  ratePathPct: ArrayLike<number>,
  windowMonths: number,
  bins: RepricingSurfaceBins,
  p: RepricingSurfaceParams,
): number {
  const n = ratePathPct.length;
  const up = new Float64Array(n);
  const dn = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    up[t] = Math.max(0, ratePathPct[t] + 1.0);
    dn[t] = Math.max(0, ratePathPct[t] - 1.0);
  }
  const Dup = simulateBookRate(up, bins, p);
  const Ddn = simulateBookRate(dn, bins, p);
  const w = Math.min(windowMonths, n);
  let sum = 0;
  for (let t = 0; t < w; t++) sum += (Dup[t] - Ddn[t]) / 2;
  return sum / w;
}

/**
 * Static comparator: constant repricing beta on rate changes, anchored at the
 * last observed deposit rate — D(t) = clip(D0 + beta_static·(r_t − r0), 0).
 * Memoryless; the port of `sim_static`.
 */
export function simulateStaticRate(
  ratePathPct: ArrayLike<number>,
  d0: number,
  r0: number,
  betaStatic: number,
): Float64Array {
  const n = ratePathPct.length;
  const D = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    D[t] = Math.max(0, d0 + betaStatic * (ratePathPct[t] - r0));
  }
  return D;
}
