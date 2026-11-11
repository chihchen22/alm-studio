/**
 * Per-path discounting for the stochastic run mode.
 *
 * The deterministic EVE discounts bucket k (month k+1's activity) at
 * t = (k+1)/12 on the all-in curve DF_rf(t) · exp(−tlp(t)·t) (discount.ts). The stochastic analogue replaces the curve's risk-free discount
 * factor with the path's own money-market discount factor D_p(t): the kernel's
 * reconstructPathDF emits Dcorr[p][k] at time (k+1)·dt, so discount index k
 * aligns with cash-flow bucket k EXACTLY, with no interpolation. The TLP
 * overlay stays STATIC across paths, mirroring the deterministic convention
 * (the TLP spread over the risk-free curve is held static across shocks).
 *
 * At zero volatility every path's Dcorr equals the market curve DF (the
 * terminal correction divides identical paths by their own mean), so this PV
 * collapses to the deterministic pvBucketedSeries + discountFunction pair —
 * the discounting half of the zero-vol degeneracy anchor.
 *
 * Determinism: pure arithmetic over the input arrays in index order.
 */
import type { TLPCurve } from "@alm/kernel";
import type { BucketedSeries } from "../contracts/results";
import { MONTHS_PER_YEAR } from "../contracts/stochastic";
import type { DiscountBasis } from "./discount";

/**
 * Precompute the static per-bucket TLP factors exp(−tlp(t_k)·t_k) at
 * t_k = (k+1)/12 — the same time convention pvBucketedSeries discounts at.
 * On the "risk-free" basis the overlay drops and every factor is 1, mirroring
 * discountFunction's basis switch.
 */
export function buildTlpFactors(
  horizonMonths: number,
  tlp: TLPCurve,
  basis: DiscountBasis,
): Float64Array {
  const factors = new Float64Array(horizonMonths);
  for (let k = 0; k < horizonMonths; k++) {
    const t = (k + 1) / MONTHS_PER_YEAR;
    factors[k] = basis === "risk-free" ? 1 : Math.exp(-tlp.tlp(t) * t);
  }
  return factors;
}

/**
 * PV of one bucketed series on one path's discount factors:
 *   pv = Σ_k Dcorr[k] · tlpFactor[k] · (principal[k] + interest[k]).
 * Throws when the series is longer than the discount grid — a misaligned grid
 * would silently drop tail cash flows, which is a wiring error, not a number.
 */
export function pvBucketedSeriesOnPath(
  series: BucketedSeries,
  pathDf: Float64Array,
  tlpFactors: Float64Array,
): number {
  const { principal, interest } = series;
  if (principal.length > pathDf.length || principal.length > tlpFactors.length) {
    throw new Error(
      `pvBucketedSeriesOnPath: series length ${principal.length} exceeds the ` +
        `discount grid (${pathDf.length} path DFs, ${tlpFactors.length} TLP factors); ` +
        `the simulation horizon must cover the cash-flow horizon`,
    );
  }
  let pv = 0;
  for (let k = 0; k < principal.length; k++) {
    pv += pathDf[k] * tlpFactors[k] * (principal[k] + interest[k]);
  }
  return pv;
}
