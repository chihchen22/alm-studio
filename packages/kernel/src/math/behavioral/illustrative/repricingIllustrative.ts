/**
 * MMA repricing surface: the illustrative parameter set.
 *
 * VALUES: the illustrative deposit parameterization, version 3,
 * Section 3.4 (surface table plus the book-aggregation rule), with the
 * functional form in Section 2.4 and the initialisation branch choice in the
 * same place. The snapshot levels are the Section 3 preamble: a flat 4 percent
 * front end, overnight and three-month alike. Nothing here is fitted,
 * transformed, or tuned against any bank's deposit data.
 *
 * ROUND-NUMBER RULE. Every value is a hand-set round number, at most two
 * significant figures, tied to a public convention, a published paper, a
 * regulatory cap, or a stated absence of anchor. A value change is a new
 * version of the spec (Section 6, "Versioning"), never a silent edit here; the
 * pinning test beside this module fails on any drift.
 *
 * UNITS: rates are PERCENT p.a. throughout, matching repricingSurface.ts.
 */

import type {
  RepricingSurfaceBins,
  RepricingSurfaceParams,
} from "../repricingSurfaceTypes";
import { dTarget } from "../repricingSurface";

/** The spec version these constants transcribe. */
export const REPRICING_ILLUSTRATIVE_SPEC =
  "illustrative-deposit-parameterization v3 (2026-09-08)";

/**
 * Snapshot rate levels every deposit tab reads (Section 3 preamble): a round
 * mid-cycle 4 percent front end, at which the pass-through S-curve sits near
 * its upper shoulder so both up and down shocks travel visible territory.
 */
export const ILLUSTRATIVE_SNAPSHOT = {
  /** Overnight rate, percent p.a. */
  overnightPct: 4.0,
  /** Three-month rate, percent p.a., the tenor all three deposit engines read. */
  threeMonthPct: 4.0,
} as const;

/** Frozen centering constant: a 100,000 dollar reference account. */
export const REPRICING_LN_B_REF = Math.log(100_000);

/**
 * The eight free surface parameters plus the frozen centering constant.
 *
 * alpha  FDIC national money market rate near the zero bound, 2020-21, rounded
 * c0, c1 pass-through ceiling level and balance loading (Martin, Puri and
 *        Ufier (2022) direction; a 0.55 ceiling at the reference account)
 * s      floor ratio, administered stickiness near the zero bound
 * k, m   S-curve slope and midpoint, held so the large-balance long-run
 *        effective beta stays below one
 * l0, l1 Nerlove speed level and size loading, bracketing the two published
 *        adjustment speeds
 */
export const REPRICING_ILLUSTRATIVE_PARAMS: RepricingSurfaceParams = {
  alpha: 0.1,
  c0: 0.2,
  c1: 0.1,
  s: 0.05,
  k: 1.5,
  m: 2.0,
  l0: -1.4,
  l1: 0.3,
  lnBRef: REPRICING_LN_B_REF,
};

/**
 * Book aggregation bins, the same three the DDA concentration overlay uses:
 * 50,000 / 500,000 / 5,000,000 dollars at dollar shares 0.30 / 0.40 / 0.30.
 */
export const REPRICING_BIN_BALANCES: readonly number[] = [50_000, 500_000, 5_000_000];
export const REPRICING_BIN_SHARES: readonly number[] = [0.3, 0.4, 0.3];

/**
 * The bins the aggregate readouts use. Anchors are the surface's own equilibria
 * at the snapshot rate, per the initialisation branch choice in Section 2.4.
 */
export const REPRICING_ILLUSTRATIVE_BINS: RepricingSurfaceBins = {
  lnbLast: REPRICING_BIN_BALANCES.map((b) => Math.log(b)),
  weightsLast: REPRICING_BIN_SHARES,
  anchorsLast: REPRICING_BIN_BALANCES.map((b) =>
    dTarget(
      ILLUSTRATIVE_SNAPSHOT.threeMonthPct,
      Math.log(b) - REPRICING_LN_B_REF,
      REPRICING_ILLUSTRATIVE_PARAMS,
    ),
  ),
};

/**
 * Static comparator beta: the industry cumulative interest-bearing beta of the
 * last cycle.
 */
export const REPRICING_BETA_STATIC = 0.4;

/**
 * Equilibrium deposit rate at the snapshot for a given account balance, in
 * percent p.a. Used to derive the MMA sleeve anchors and the MMA base
 * switching spread by rule rather than by a second hand-set value.
 */
export function illustrativeEquilibriumRate(balanceUsd: number): number {
  return dTarget(
    ILLUSTRATIVE_SNAPSHOT.threeMonthPct,
    Math.log(balanceUsd) - REPRICING_LN_B_REF,
    REPRICING_ILLUSTRATIVE_PARAMS,
  );
}
