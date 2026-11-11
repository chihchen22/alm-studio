/**
 * EVE discount function on the all-in funding curve.
 *
 *   DF_all-in(t) = DF_rf(t) · exp(−tlp(t) · t)
 *
 * The risk-free leg is rebuilt from the SHIFTED curve under each shock (shockCurve);
 * the TLP spread over the risk-free curve is held STATIC across shocks. This is byte-identical
 * to the `dfFor` the kernel effective-duration engine builds internally
 * (analytics/duration.ts), so EVE PV and effective duration discount on one
 * path. The `"risk-free"` basis drops the TLP overlay, a variant which
 * the result's `discountBasis` field exposes without a schema change.
 *
 * The shift goes through shiftCurveParallel (curveBuilder/fastCurve.ts): the
 * kernel shockCurve for a kernel curve, unchanged, and the same arithmetic on
 * the engine's fast curve for a fast one, so a dense setup curve stays fast
 * under the effective-duration legs.
 */
import type { TLPCurve, ZeroCurve } from "@alm/kernel";
import type { Position } from "../contracts/position";
import { shiftCurveParallel } from "../curveBuilder/fastCurve";

/**
 * "spread-consistent": the all-in factor times
 * exp(-s t), with s the position's own discount spread (positionDiscountSpreadBp).
 * A position with spread 0 discounts exactly as on "all-in".
 */
export type DiscountBasis = "all-in" | "risk-free" | "spread-consistent";

/**
 * The spread, in bp, a position discounts at on the "spread-consistent" basis:
 * its `discountSpreadBp`, 0 when absent, and 0 whatever the field says for a
 * deposit (nmd, nmd-b) and for a child of the regulatory transform (a position
 * carrying parentPositionId), which are deposit slices. Every other basis
 * ignores the value. A non-finite value is refused by name.
 */
export function positionDiscountSpreadBp(pos: Position): number {
  const raw = pos.discountSpreadBp;
  if (raw === undefined) return 0;
  if (!Number.isFinite(raw)) {
    throw new Error(
      `position "${pos.id}": discountSpreadBp must be a finite number of basis points, got ${String(raw)}`,
    );
  }
  if (pos.terms.type === "nmd" || pos.terms.type === "nmd-b" || pos.parentPositionId !== undefined) return 0;
  return raw;
}

/**
 * Discount function for `curve`, parallel-shifted by `shockBp` on the risk-free leg.
 * `shockBp === 0` uses the curve as supplied (no `shockCurve` copy). The `t ≤ 0`
 * guard returns 1 so a time-zero flow is undiscounted, matching the kernel.
 * `spreadBp` is read on the "spread-consistent" basis only, and a spread of 0
 * there returns the all-in function itself, so a deposit or a spread-less
 * position prices bit for bit as on "all-in". The caller resolves the spread
 * with positionDiscountSpreadBp.
 */
export function discountFunction(
  curve: ZeroCurve,
  tlp: TLPCurve,
  shockBp: number,
  basis: DiscountBasis = "all-in",
  spreadBp = 0,
): (tYears: number) => number {
  const c = shockBp === 0 ? curve : shiftCurveParallel(curve, shockBp);
  if (basis === "risk-free") return (t) => c.discountFactor(t);
  if (basis === "spread-consistent" && spreadBp !== 0) {
    const s = spreadBp / 1e4;
    return (t) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-(tlp.tlp(t) + s) * t));
  }
  return (t) => (t <= 0 ? 1 : c.discountFactor(t) * Math.exp(-tlp.tlp(t) * t));
}

/**
 * One discount function per distinct spread, built on first use. The duration
 * and key-rate legs price position by position, so this keeps the closure count
 * at the number of distinct spreads, not the number of positions.
 */
export function spreadDiscountCache(
  curve: ZeroCurve,
  tlp: TLPCurve,
  shockBp: number,
  basis: DiscountBasis,
): (pos: Position) => (tYears: number) => number {
  const byBp = new Map<number, (tYears: number) => number>();
  return (pos) => {
    const bp = basis === "spread-consistent" ? positionDiscountSpreadBp(pos) : 0;
    let df = byBp.get(bp);
    if (df === undefined) {
      df = discountFunction(curve, tlp, shockBp, basis, bp);
      byBp.set(bp, df);
    }
    return df;
  };
}
