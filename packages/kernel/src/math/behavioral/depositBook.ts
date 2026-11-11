/**
 * Judgment-dial deposit BOOK aggregation, parameter-driven so any basis swaps in
 * without code change.
 *
 * The book composition is the smooth LN-balance prudential overnight size-surface
 * with the concentration overlay as a DISCLOSED JUDGMENT DIAL. At book level the
 * composition is linear in a single balance-weighted scalar phiBar:
 *
 *   R_book(h) = (1 - phiBar) * R_core(h) + phiBar * legCurve(h)
 *
 * where R_core is the granular core retention curve (ddaChampion / mmaTwoSleeve)
 * and legCurve is the concentration leg at the chosen dial setting (overnight =
 * [1,0,0,...], the default setting). The composition primitives live in
 * prudentialSurface.ts; this module adds two things:
 *
 *   1. phiBar as a COMPUTED parameter -- aggregatePhiBar reconstructs the dial
 *      overlay from an account-size distribution.
 *   2. a single book-measure entry point -- bookDeterministicMeasures composes the
 *      per-shock core into the dial book and returns WAL / PV / effective duration
 *      on the non-interest-bearing (DDA) discounting basis.
 *
 * The per-path book WAL distribution rides on ChampionScenarioOutput (walMean /
 * walP5 / walP95), populated by the two path runners; see championFan.walBands.
 *
 * BASIS NOTE. phiBar is an ACCOUNT-level balance-weighted mean; a bucket-median
 * reconstruction over a coarse bucket table lands somewhat short of it, because the
 * median peak understates the within-bucket concentration mass. So aggregatePhiBar
 * over a bucket table is a self-consistent reconstruction of the BUCKET
 * representation, not a bit-reproduction of the account-level scalar, and carries its
 * own internal-consistency identity (bookWalFromBuckets).
 */

import {
  type DiscountBasis,
  type LabCurve,
  type RetentionByShock,
  SHOCKS_BP,
  liabilityMeasures,
  walYears,
} from "./ddaChampion";
import { bookLiquidityByShock, phi } from "./prudentialSurface";

/** One account-size bucket of the book: a representative balance and its dollar weight. */
export interface AccountSizeBucket {
  /** Representative (median) peak balance of the bucket, in dollars. */
  readonly medianPeak: number;
  /** Fraction of book dollars in the bucket. */
  readonly dollarShare: number;
}

/** Prudential ramp parameters phi(b) = phiMax * sigma(k(lnb-lnb0)) / sigma(k(lnCap-lnb0)). */
export interface PhiParams {
  readonly b0: number;
  readonly kappa: number;
  readonly phiMax: number;
  readonly sleeveFloor: number;
}

/**
 * The dial overlay phiBar as LIVE math: the dollar-weighted mean prudential ramp
 * over the account-size distribution,
 *
 *   phiBar = sum_i dollarShare_i * phi(medianPeak_i) / sum_i dollarShare_i.
 *
 * This is the account-size-bucket aggregation to the single scalar the book
 * composition needs. See the module BASIS NOTE: over a coarse median-based bucket
 * table this reconstructs the bucket representation's phiBar, ~2pp below the
 * account-level frozen scalar; over an account-grain distribution it is the
 * phiBar itself. Normalized by the total dollar share so a partial book (weights
 * not summing to 1) still returns a proper weighted mean.
 */
export function aggregatePhiBar(
  buckets: readonly AccountSizeBucket[],
  phiParams: PhiParams,
): number {
  if (buckets.length === 0) throw new Error("aggregatePhiBar: buckets must be non-empty");
  let acc = 0;
  let wsum = 0;
  for (const b of buckets) {
    acc += b.dollarShare * phi(b.medianPeak, phiParams.b0, phiParams.kappa, phiParams.phiMax, phiParams.sleeveFloor);
    wsum += b.dollarShare;
  }
  if (wsum <= 0) throw new Error("aggregatePhiBar: total dollarShare must be positive");
  return acc / wsum;
}

/**
 * Book WAL aggregated directly from the size distribution: the dollar-weighted mean
 * of each bucket's surface WAL (1 - phi_i) * coreWal + phi_i * legWal. Algebraically
 * identical to (1 - phiBar) * coreWal + phiBar * legWal with phiBar from
 * aggregatePhiBar over the same buckets -- the bucket-weighted identity the invariant
 * test pins. legWalYears defaults to 0 (the overnight setting).
 */
export function bookWalFromBuckets(
  buckets: readonly AccountSizeBucket[],
  phiParams: PhiParams,
  coreWalYears: number,
  legWalYears = 0,
): number {
  if (buckets.length === 0) throw new Error("bookWalFromBuckets: buckets must be non-empty");
  let acc = 0;
  let wsum = 0;
  for (const b of buckets) {
    const p = phi(b.medianPeak, phiParams.b0, phiParams.kappa, phiParams.phiMax, phiParams.sleeveFloor);
    acc += b.dollarShare * ((1 - p) * coreWalYears + p * legWalYears);
    wsum += b.dollarShare;
  }
  return acc / wsum;
}

/** Deterministic dial-book measures on the non-interest-bearing (DDA) discounting basis. */
export interface BookDeterministicMeasures {
  /** The dial overlay weight actually used (echoed for the caller). */
  readonly phiBar: number;
  /** Book WAL at the base curve, years (= (1 - phiBar) * coreWAL for the overnight leg). */
  readonly bookWal: number;
  /** Book WAL by shock (bp), years. */
  readonly bookWalByShock: Record<number, number>;
  /** Book liability PV per $1 at the base curve, SOFR basis. */
  readonly depositPvSofr: number;
  /** Book effective duration, SOFR basis, years. */
  readonly effDurSofr: number;
  /** Book effective duration, all-in basis, years. */
  readonly effDurAllin: number;
  /** The composed book retention schedule by shock (bp), for downstream reuse. */
  readonly scheduleByShock: Record<number, Float64Array>;
}

/**
 * Compose the per-shock core retention into the dial book (overnight leg by
 * default) and return the deterministic measures the tabs and the comparison grid
 * need on the non-interest-bearing basis. The overlay phiBar is a PARAMETER, not a
 * baked constant: pass a scalar, or aggregatePhiBar(...) to drive it from a size
 * distribution.
 *
 * `coreByShock` must cover every shock in SHOCKS_BP (use championRetentionByShock()).
 * Reproduces DDA_PRUDENTIAL.liquidity.{walYears, effDurSofr, effDurAllin, depositPvSofr}
 * to ~1e-9 when fed DDA_PRUDENTIAL.phiBar (the acceptance proof, depositBook.test.ts).
 */
export function bookDeterministicMeasures(
  coreByShock: RetentionByShock,
  phiBar: number,
  curve: LabCurve,
): BookDeterministicMeasures {
  const scheduleByShock = bookLiquidityByShock(coreByShock, phiBar);
  const bookWalByShock: Record<number, number> = {};
  for (const s of SHOCKS_BP) bookWalByShock[s] = walYears(scheduleByShock[s]);
  const sofr = liabilityMeasures(scheduleByShock, curve, "sofr" as DiscountBasis);
  const allin = liabilityMeasures(scheduleByShock, curve, "allin" as DiscountBasis);
  return {
    phiBar,
    bookWal: bookWalByShock[0],
    bookWalByShock,
    depositPvSofr: sofr.depositPv,
    effDurSofr: sofr.effDur,
    effDurAllin: allin.effDur,
    scheduleByShock,
  };
}
