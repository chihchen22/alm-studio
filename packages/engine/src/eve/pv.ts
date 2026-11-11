/**
 * Present value of a bucketed monthly cash-flow series.
 *
 * Bucket k holds month (k+1)'s activity: the m03 aggregator maps a kernel
 * Cashflow to bucket = monthOffset - 1 (aggregate.ts / ADR-004), so bucket k is
 * discounted at t = (k+1)/12. That makes this PV identical, term by term, to the
 * kernel `pvCashflows` run on the same instruments' raw legs (which discounts at
 * t = monthOffset/12) — the reconciliation that ties reported EVE to the
 * projection engine's cash flows.
 *
 * Sign convention (results.ts): principal and interest are both cash flows to
 * the bank, positive, for assets AND liabilities. EVE nets the two sides at the
 * scenario level (pvAssets − pvLiabilities); this function returns a positive PV
 * for either side.
 */
import type { Position } from "../contracts/position";
import type { BucketedSeries } from "../contracts/results";
import { NotImplementedError } from "../runtime/notImplemented";
import { positionDiscountSpreadBp } from "./discount";

/**
 * The one discount spread, in bp, a family's bucketed series discounts at on
 * the "spread-consistent" basis. PV is linear in the cash flows, so
 * when every position of the family carries the same spread the family PV of
 * the bucketed series on that spread IS the sum of the per-position PVs, term
 * by term, and the headline keeps reconciling to the projected cash flows. A
 * family whose positions carry two or more spreads cannot be priced off its
 * family series (the projection keeps no per-position series), so it is
 * refused by name rather than priced on one of them. A family with no
 * positions discounts at 0.
 */
export function familyDiscountSpreadBp(familyId: string, positions: readonly Position[]): number {
  if (positions.length === 0) return 0;
  const first = positionDiscountSpreadBp(positions[0]!);
  for (let i = 1; i < positions.length; i++) {
    const bp = positionDiscountSpreadBp(positions[i]!);
    if (bp !== first) {
      throw new NotImplementedError(
        "eve",
        `family "${familyId}" mixes discountSpreadBp values (${first} on position "${positions[0]!.id}", ` +
          `${bp} on position "${positions[i]!.id}"); the spread-consistent basis prices a family off ` +
          `its bucketed series, which needs one spread per family. Give every position of the family ` +
          `the same discountSpreadBp, or split the family.`,
      );
    }
  }
  return first;
}

/** PV of one bucketed series under a discount function df(tYears). */
export function pvBucketedSeries(
  series: BucketedSeries,
  df: (tYears: number) => number,
): number {
  const { principal, interest } = series;
  let pv = 0;
  for (let k = 0; k < principal.length; k++) {
    pv += df((k + 1) / 12) * (principal[k] + interest[k]);
  }
  return pv;
}
