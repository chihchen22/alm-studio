/**
 * Short-rate volatility op vocabulary.
 *
 * The constants and the two predicates the derivation, the server lineage walk
 * and the stochastic environment share. No node:crypto and no import of
 * deriveMarketSnapshot, so the stochastic environment and a client bundle can
 * name them without pulling the derivation, and its hash, in.
 *
 * The volatilities these ops move are the public pack's constructed
 * illustrative short-rate analog (capQuotes), not market quotes.
 */

/** The two short-rate volatility op names, the raw key of record being short_rate_vol_surface. */
export const SHORT_RATE_VOL_OP_KINDS: readonly ["scale-short-rate-vol", "add-short-rate-vol"] = ["scale-short-rate-vol", "add-short-rate-vol"];

/** A scale factor must be from 0.25 to 4: a demonstration lever, inside the 5 bp calibration gate on the public pack up to a factor of 5.6. */
export const SHORT_RATE_VOL_SCALE_MIN = 0.25;
export const SHORT_RATE_VOL_SCALE_MAX = 4;

/**
 * Every derived short-rate volatility must stay finite, above 0 and below this
 * ceiling (decimal normal vol, 500 bp). It restates the upper bound of the
 * Hull-White sigma the calibration fits, 0.05
 * (packages/kernel/src/math/rates/hwCalibrate.ts:84): a surface at or above it
 * pins the fitted sigma at the bound.
 */
export const SHORT_RATE_VOL_CEILING = 0.05;

/** True for a plain object whose op is one of the two short-rate volatility ops. */
export function isShortRateVolOp(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const op = (raw as { op?: unknown }).op;
  return op === "scale-short-rate-vol" || op === "add-short-rate-vol";
}

/** How many short-rate volatility ops the snapshot's own derivedFrom.ops names (0 when it has no derivedFrom). */
export function shortRateVolOpCount(snapshot: unknown): number {
  if (snapshot === null || typeof snapshot !== "object") return 0;
  const from = (snapshot as { derivedFrom?: unknown }).derivedFrom;
  if (from === null || typeof from !== "object") return 0;
  const ops = (from as { ops?: unknown }).ops;
  return Array.isArray(ops) ? ops.filter(isShortRateVolOp).length : 0;
}
