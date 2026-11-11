/**
 * MMA switching-spread path construction, shared by the decay tab's repricing-
 * basis toggle. Both bases build the switching spread s(t) = r(t) - D(t) that
 * drives the IB granular decay (granularRetention reads d_inc = s - baseSp):
 *
 *   s(h) = baseSp + (r(h) - sofr3m) + inc(h)
 *   inc(h) = sum_b w_b * (D_base_b(h) - D_live_b(h))
 *
 * where D_base_b / D_live_b are the repricing-surface Nerlove deposit-rate paths
 * for balance position b, held flat at the reference snapshot rate (base) vs.
 * along the live path (live). The differential (D_base - D_live) is the same
 * artifact-cancelling construction runMmaChampionOnPaths uses inline (see that
 * module's header): the shared cross-model drift cancels, leaving only the
 * surface's incremental repricing response to the rate path.
 *
 * The two bases differ ONLY in the balance profile summed over:
 *   - STATIC (default): the single granular-core sleeve position,
 *     anchored at the observed sleeve deposit rate. Low pass-through (small
 *     accounts), so D barely follows and the switching spread tracks the market
 *     rate almost one-for-one. This reproduces the runner's inline construction
 *     bit-for-bit (see the granular-profile reduction test).
 *   - DYNAMIC (what-if): the full book balance profile (every log-balance bin,
 *     dollar-weighted), each bin anchored at its own base-rate equilibrium. Large
 *     accounts carry a materially higher beta(r, ln b), so the book deposit rate
 *     follows further and the switching spread widens more slowly as rates rise.
 *
 * !! UNITS: rates and spreads are PERCENT p.a. (repricingSurface convention).
 */

import { dTarget, simulateDepositRate } from "./repricingSurface";
import type { RepricingSurfaceParams } from "./repricingSurfaceTypes";
import type { MmaRunnerCalib } from "./mmaGranularPaths";
import { MMA_H_PROJ } from "./mmaTwoSleeve";

/** One balance position in a switching-spread profile: log-balance offset z, dollar weight w, anchor deposit rate d0 (percent). */
export interface SpreadProfilePosition {
  /** z = ln(balance$) - lnBRef, the surface centering offset. */
  readonly z: number;
  /** Dollar weight of this position in the book (profile weights sum to 1). */
  readonly w: number;
  /** Anchor deposit rate D(0) in percent for the Nerlove recursion. */
  readonly d0: number;
}

/** Switching-spread construction inputs shared across positions. */
export interface SwitchingSpreadOpts {
  /** Base 3M switching spread at the snapshot (percent). */
  readonly baseSp: number;
  /** Reference-snapshot 3M rate the fixed reference trajectory is anchored at (percent). */
  readonly sofr3m: number;
  /** Repricing beta(r, ln b) surface parameters the deposit rate reprices through. */
  readonly surface: RepricingSurfaceParams;
}

/**
 * Switching-spread path s(h) = baseSp + (r(h) - sofr3m) + inc(h) over months
 * 0..hProj, with inc the dollar-weighted differential deposit-rate response of
 * the profile positions. Pure; `path3mPct` in percent, length >= hProj + 1.
 */
export function switchingSpreadFromProfile(
  path3mPct: ArrayLike<number>,
  profile: readonly SpreadProfilePosition[],
  opts: SwitchingSpreadOpts,
  hProj: number = MMA_H_PROJ,
): Float64Array {
  const H = hProj;
  const rBase = new Float64Array(H + 1).fill(opts.sofr3m);
  const inc = new Float64Array(H + 1);
  for (const pos of profile) {
    const dBase = simulateDepositRate(rBase, pos.z, pos.d0, opts.surface);
    const dLive = simulateDepositRate(path3mPct, pos.z, pos.d0, opts.surface);
    for (let h = 0; h <= H; h++) inc[h] += pos.w * (dBase[h] - dLive[h]);
  }
  const spread = new Float64Array(H + 1);
  for (let h = 0; h <= H; h++) spread[h] = opts.baseSp + (path3mPct[h] - opts.sofr3m) + inc[h];
  return spread;
}

/**
 * STATIC basis profile: the single granular-core sleeve position, anchored at
 * the observed sleeve deposit rate. Passed to switchingSpreadFromProfile it
 * reproduces runMmaChampionOnPaths's inline spread construction bit-for-bit.
 */
export function granularSpreadProfile(calib: MmaRunnerCalib): SpreadProfilePosition[] {
  return [{ z: calib.granLnb - calib.surface.lnBRef, w: 1, d0: calib.granD }];
}

/** A balance-bin block: last-observed mean ln balance and dollar share per bin. */
export interface SpreadBalanceBins {
  readonly lnbLast: readonly number[];
  readonly weightsLast: readonly number[];
}

/**
 * DYNAMIC basis profile: the full book balance profile, each bin anchored at its
 * own base-rate equilibrium dTarget(sofr3m, z). Anchoring at the surface's own
 * resting rate needs no observed per-bin deposit rate (the synth bin block
 * carries none) and holds the base trajectory flat, so inc measures each bin's
 * repricing away from base as rates move.
 */
export function bookSpreadProfile(calib: MmaRunnerCalib, bins: SpreadBalanceBins): SpreadProfilePosition[] {
  return bins.lnbLast.map((lnb, i) => {
    const z = lnb - calib.surface.lnBRef;
    return { z, w: bins.weightsLast[i], d0: dTarget(calib.sofr3m, z, calib.surface) };
  });
}

/** Repricing-basis selector for the decay tab's what-if toggle. */
export type RepricingBasis = "static" | "dynamic";

/**
 * Build the spread-path function runMmaChampionOnPaths / mmaChampionEffDur inject.
 * STATIC returns undefined so the runner keeps its bit-identical inline path (the
 * default basis the comparison grid and pins are struck on); DYNAMIC
 * returns the book-level book-profile closure.
 */
export function makeMmaSpreadFn(
  basis: RepricingBasis,
  baseSp: number,
  calib: MmaRunnerCalib,
  bins: SpreadBalanceBins,
  hProj: number = MMA_H_PROJ,
): ((path3mPct: Float64Array) => Float64Array) | undefined {
  if (basis === "static") return undefined;
  const profile = bookSpreadProfile(calib, bins);
  const opts: SwitchingSpreadOpts = { baseSp, sofr3m: calib.sofr3m, surface: calib.surface };
  return (path3mPct: Float64Array) => switchingSpreadFromProfile(path3mPct, profile, opts, hProj);
}
