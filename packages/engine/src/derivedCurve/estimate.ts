/**
 * The spread estimate behind the Studio fill button (steps
 * B2 and B3a). A derived curve's grid can be estimated as one curve minus
 * another at the cut-off, row by row, on the read an index makes at that row's
 * tenor:
 *
 *  - A row of 12 months and below reads the n-month index rate gap, through the
 *    same IndexRatePath over DeterministicRatePath the run uses for index
 *    resets, so the estimate and a run's step-0 reset cannot drift apart.
 *  - A row above 12 months reads the par swap rate gap over n / 12 years,
 *    through DeterministicRatePath.forwardRateAt at step 0, the read a
 *    constant-maturity-swap index makes, on the curve's own fixed-leg
 *    convention. The kernel's swap read rounds a part year (to the nearest half
 *    year on the semi-annual bond basis, the nearest year on annual ACT/360), so
 *    such a row must sit on whole years; fillTenorProblems names any other.
 *
 * No formula is restated here.
 */
import { DeterministicRatePath, type ZeroCurve } from "@alm/kernel";
import type { DerivedCurveSpread } from "../contracts/derivedCurve";
import type { RateIndexTenor } from "../contracts/rateIndex";
import { IndexRatePath } from "../rateIndex/indexRatePath";

/** Rows above this many months fill with the par swap rate gap, and must sit on whole years. */
export const SWAP_FILL_ABOVE_MONTHS = 12;

/**
 * The n-month index rate at the cut-off (step 0), basis 0, in decimal. A grid
 * row may sit at any whole tenor from 1 to 360 months, wider than the four
 * index tenors RateIndexTenor names; IndexRatePath compounds n one-month
 * resets for any whole n, so the cast widens the type only.
 */
export function indexRateAt0(curve: ZeroCurve, tenorMonths: number): number {
  const index = { tenorMonths: tenorMonths as RateIndexTenor, basis: 0 };
  return new IndexRatePath(new DeterministicRatePath(curve, tenorMonths, 1 / 12), index).rateAt(0);
}

/**
 * The forward par swap rate at the cut-off over tenorMonths / 12 years, on the curve's own fixed-leg convention, in
 * decimal: the read a constant-maturity-swap index makes at step 0 (RatePath.forwardRateAt(0, tenorYears)), through
 * the same DeterministicRatePath, so the fill and the run cannot drift apart.
 */
export function swapRateAt0(curve: ZeroCurve, tenorMonths: number): number {
  return new DeterministicRatePath(curve, 1, 1 / 12).forwardRateAt(0, tenorMonths / 12);
}

/** One sentence per row above 12 months that is not a whole number of years, in row order. */
export function fillTenorProblems(tenors: readonly number[]): string[] {
  const out: string[] = [];
  tenors.forEach((n, i) => {
    if (n > SWAP_FILL_ABOVE_MONTHS && n % 12 !== 0) {
      out.push(`row ${i + 1}: a fill above 12 months reads the par swap rate, which needs whole years (24, 36 and so on up to 360 months); got ${n} months`);
    }
  });
  return out;
}

/**
 * One spread row per tenor: the gap of the from curve over the minus curve in
 * basis points, rounded to 1e-6 bp, on indexRateAt0 at 12 months and below and
 * swapRateAt0 above. The caller's validator judges the tenors; a row
 * fillTenorProblems refuses throws, so a caller that skips the check fails
 * loudly and never writes a rounded swap read.
 */
export function estimateSpreads(from: ZeroCurve, minus: ZeroCurve, tenors: readonly number[]): DerivedCurveSpread[] {
  const problems = fillTenorProblems(tenors);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return tenors.map((tenorMonths) => {
    const read = tenorMonths > SWAP_FILL_ABOVE_MONTHS ? swapRateAt0 : indexRateAt0;
    const bp = Math.round((read(from, tenorMonths) - read(minus, tenorMonths)) * 10000 * 1e6) / 1e6;
    // A tiny negative gap rounds to -0; store it as 0.
    return { tenorMonths, spreadBp: bp === 0 ? 0 : bp };
  });
}
