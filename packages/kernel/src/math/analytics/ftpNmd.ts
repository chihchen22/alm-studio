/**
 * FTP — NMD side: replicating-portfolio FTP at portfolio (stock) level.
 *
 * Unlike the loans tab (marginal FTP on new volumes), the NMD FTP credit is
 * computed on the standing book under a constant-balance-sheet assumption and
 * decomposed into a 3×4 matrix — columns {Stable, Non-stable, Stress}, rows
 * {IR, TLP, HQLA buffer, All-in}:
 *
 *   Allocation slices (a partition of the book, sum to 1):
 *     stressed s            = LCR 30-day runoff fraction, eats non-stable first
 *     nonStableSurviving    = max((1 − w_s) − s, 0)
 *     stableAfterStress     = max(w_s − max(s − (1 − w_s), 0), 0)
 *
 *   IR row (credit against SOFR):
 *     Stable     = stableAfterStress · Σ w_k·Y_k     (replicating-portfolio yield)
 *     Non-stable = nonStableSurviving · Y_3M         (3M MA of 3M)
 *     Stress     = stressed · Y_overnight            (funded overnight)
 *
 *   TLP row (term-liquidity premium):
 *     Stable     = stableAfterStress · Σ w_k·TLP(τ_k)
 *     Non-stable = nonStableSurviving · TLP(3M)
 *     Stress     = 0                                 (overnight bucket, no TLP)
 *
 *   HQLA buffer row (cost of holding the buffer against the runoff):
 *     Stress     = −(bufferTarget · s · carry)       (a charge)
 *     Stable / Non-stable = 0
 *
 *   All-in row = IR + TLP + HQLA buffer per column.
 *
 *   allInCredit = irCredit + tlpCredit − bufferCharge
 *   ftpMargin   = allInCredit − clientRate           (deposit-franchise margin)
 *
 * The stressed slice earns the overnight rate (it is funded at, and held as,
 * overnight HQLA) and bears the buffer carry charge; it carries no term IR
 * premium and no TLP. This is a snapshot of the stock / portfolio-level FTP as
 * of the market date.
 */

import type { TLPCurve } from "../rates/tlpCurve";
import type { RateHistory } from "../rates/rateHistory";
import type { CurveQuote } from "../rates/marketData";
import { newMoneyYield } from "./tractor";

/** Non-stable tranche convention: 3-month MA of the 3-month tenor. */
export const NON_STABLE_TENOR_MONTHS = 3;

export interface NmdFtpAssumptions {
  /** Fraction of the book treated as IRR-stable (replicated), in [0, 1]. */
  stableShare: number;
  /** 30-day LCR stress runoff fraction of the total book, in [0, 1]. */
  lcrRunoff: number;
  /** HQLA buffer held against the runoff, as a multiple (e.g. 1.2 = 120%). */
  bufferTarget: number;
  /** HQLA cost of carry in bp per annum, deducted (e.g. 15). */
  carryBp: number;
}

/** TLP allocation slices, fractions of the total book (sum to 1). */
export interface NmdFtpSlices {
  stressed: number;
  nonStableSurviving: number;
  stableAfterStress: number;
}

/** One matrix column: the IR / TLP / buffer rate contributions of a slice. */
export interface NmdFtpColumn {
  /** Share of the book in this slice. */
  share: number;
  /** IR credit contribution (decimal, share-weighted). */
  ir: number;
  /** TLP credit contribution (decimal, share-weighted). */
  tlp: number;
  /** HQLA buffer charge contribution (decimal, negative). */
  buffer: number;
  /** All-in = ir + tlp + buffer. */
  allIn: number;
}

/** The 3-column decomposition matrix (rows are the column fields). */
export interface NmdFtpMatrix {
  stable: NmdFtpColumn;
  nonStable: NmdFtpColumn;
  stress: NmdFtpColumn;
}

export interface NmdFtpDecomposition {
  /** IR leg row total: Stable + Non-stable + Stress IR. */
  irCredit: number;
  /** TLP leg row total (Stable + Non-stable; Stress is zero). */
  tlpCredit: number;
  /** HQLA buffer drag = bufferTarget · lcrRunoff · carry (decimal, positive). */
  bufferCharge: number;
  /** irCredit + tlpCredit − bufferCharge. */
  allInCredit: number;
  /** allInCredit − clientRate (deposit-franchise margin). */
  ftpMargin: number;
  /** The 3×(IR/TLP/buffer/All-in) decomposition matrix. */
  matrix: NmdFtpMatrix;
  slices: NmdFtpSlices;
  /** Component rates for display / export. */
  stableRpYield: number;
  nonStableYield: number;
  stableRpTlp: number;
  nonStableTlp: number;
  overnightYield: number;
}

export interface NmdFtpInputs {
  /** Pillar tenors in months (the stable tranche's replicating universe). */
  pillars: ReadonlyArray<number>;
  /** Optimal replicating weights on those pillars; must sum to 100%. */
  weights: ReadonlyArray<number>;
  /** Trailing-MA pillar yields at the as-of month, decimal per annum. */
  pillarYields: ReadonlyArray<number>;
  /** 3M MA of the 3M tenor at the as-of month (the k=3 pillar yield). */
  nonStableYield: number;
  /** Overnight / short rate the stressed slice earns, decimal per annum. */
  overnightYield: number;
  /** Deposit rate paid: 0 for Non-IB, D(0) for IB. */
  clientRate: number;
  tlp: TLPCurve;
  assumptions: NmdFtpAssumptions;
}

export function computeNmdFtp(inputs: NmdFtpInputs): NmdFtpDecomposition {
  const { pillars, weights, pillarYields, nonStableYield, overnightYield, clientRate, tlp, assumptions } =
    inputs;
  const { stableShare, lcrRunoff, bufferTarget, carryBp } = assumptions;

  if (pillars.length !== weights.length || pillars.length !== pillarYields.length) {
    throw new Error("computeNmdFtp: pillars / weights / pillarYields length mismatch");
  }
  if (stableShare < 0 || stableShare > 1) {
    throw new Error(`computeNmdFtp: stableShare ${stableShare} outside [0, 1]`);
  }
  if (lcrRunoff < 0 || lcrRunoff > 1) {
    throw new Error(`computeNmdFtp: lcrRunoff ${lcrRunoff} outside [0, 1]`);
  }
  if (bufferTarget < 0) {
    throw new Error(`computeNmdFtp: bufferTarget ${bufferTarget} must be non-negative`);
  }
  let wSum = 0;
  for (const w of weights) wSum += w;
  if (Math.abs(wSum - 1) > 1e-6) {
    throw new Error(`computeNmdFtp: weights sum to ${wSum}, expected 100%`);
  }
  for (let i = 0; i < pillarYields.length; i++) {
    if (!Number.isFinite(pillarYields[i])) {
      throw new Error(
        `computeNmdFtp: pillar yield for ${pillars[i]}M is not finite (incomplete MA window?)`,
      );
    }
  }
  if (!Number.isFinite(nonStableYield)) {
    throw new Error("computeNmdFtp: nonStableYield is not finite (incomplete MA window?)");
  }
  if (!Number.isFinite(overnightYield)) {
    throw new Error("computeNmdFtp: overnightYield is not finite");
  }

  let stableRpYield = 0;
  let stableRpTlp = 0;
  for (let i = 0; i < pillars.length; i++) {
    stableRpYield += weights[i] * pillarYields[i];
    stableRpTlp += weights[i] * tlp.tlp(pillars[i] / 12);
  }
  const nonStableTlp = tlp.tlp(NON_STABLE_TENOR_MONTHS / 12);

  const nonStable = 1 - stableShare;
  const slices: NmdFtpSlices = {
    stressed: lcrRunoff,
    nonStableSurviving: Math.max(nonStable - lcrRunoff, 0),
    stableAfterStress: Math.max(stableShare - Math.max(lcrRunoff - nonStable, 0), 0),
  };

  const bufferCharge = bufferTarget * lcrRunoff * (carryBp / 1e4);

  const col = (share: number, ir: number, tlpVal: number, buffer: number): NmdFtpColumn => ({
    share,
    ir,
    tlp: tlpVal,
    buffer,
    allIn: ir + tlpVal + buffer,
  });

  const stable = col(
    slices.stableAfterStress,
    slices.stableAfterStress * stableRpYield,
    slices.stableAfterStress * stableRpTlp,
    0,
  );
  const nonStableCol = col(
    slices.nonStableSurviving,
    slices.nonStableSurviving * nonStableYield,
    slices.nonStableSurviving * nonStableTlp,
    0,
  );
  const stress = col(slices.stressed, slices.stressed * overnightYield, 0, -bufferCharge);

  const irCredit = stable.ir + nonStableCol.ir + stress.ir;
  const tlpCredit = stable.tlp + nonStableCol.tlp + stress.tlp;
  const allInCredit = irCredit + tlpCredit - bufferCharge;

  return {
    irCredit,
    tlpCredit,
    bufferCharge,
    allInCredit,
    ftpMargin: allInCredit - clientRate,
    matrix: { stable, nonStable: nonStableCol, stress },
    slices,
    stableRpYield,
    nonStableYield,
    stableRpTlp,
    nonStableTlp,
    overnightYield,
  };
}

/** Trailing-MA pillar yields at the as-of month for the given pillar set. */
export function pillarTrailingYields(
  history: RateHistory,
  pillars: ReadonlyArray<number>,
  asOfIdx: number,
): number[] {
  return pillars.map((k) => history.pillarYield(asOfIdx, Math.max(1, Math.round(k))));
}

/** Non-stable tranche yield at the as-of month: the k=3 tractor pillar. */
export function nonStableYieldAt(history: RateHistory, asOfIdx: number): number {
  return history.pillarYield(asOfIdx, NON_STABLE_TENOR_MONTHS);
}

/** Overnight / short rate the stressed slice earns: the 1M tractor pillar. */
export function overnightYieldAt(history: RateHistory, asOfIdx: number): number {
  return history.pillarYield(asOfIdx, 1);
}

/**
 * Marginal (new-money) FTP asset yields: each pillar priced at today's curve par
 * rate, the non-stable tranche at the 3M node, the stress slice at the 1D-cash
 * overnight node. The marginal counterpart to the stock view's trailing-MA
 * helpers (pillarTrailingYields / nonStableYieldAt / overnightYieldAt): same
 * computeNmdFtp consumer, but priced on the live curve rather than the realized
 * carry. Feeds the cohort-WAL replicating blend, never interleaved with the
 * trailing-MA stock decomposition.
 */
export function newMoneyFtpYields(
  pillars: ReadonlyArray<number>,
  quotes: ReadonlyArray<CurveQuote>,
): { pillarYields: number[]; nonStableYield: number; overnightYield: number } {
  return {
    pillarYields: pillars.map((k) => newMoneyYield(k, quotes)),
    nonStableYield: newMoneyYield(NON_STABLE_TENOR_MONTHS, quotes),
    overnightYield: newMoneyYield(1, quotes),
  };
}
