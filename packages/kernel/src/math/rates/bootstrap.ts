/**
 * Zero-coupon bootstrap for the discount curve.
 *
 * Port of the Lab's Python reference. Two par-instrument conventions are supported,
 * selected by the snapshot's own curve block (`day_count` / `fixed_payment_freq`)
 * and carried on `MarketSnapshot.curveConvention`:
 *
 * "semiannual_bond" (the shipped public pack, U.S. Treasury CMT par yields)
 * - EVERY node is a constant-maturity par yield quoted bond-equivalent, i.e. on
 *   a semi-annual compounding basis, ACT/ACT approximated by exact half-year
 *   periods. The treatment follows from the tenor alone, never from the `type`
 *   label:
 *     t < 0.5y  (1M, 3M bills): no coupon falls before maturity, so the node is
 *       a pure discount instrument quoted on the bond-equivalent
 *       (coupon-equivalent) basis: DF(t) = (1 + y/2)^(-2t), and the continuously
 *       compounded zero is 2·ln(1 + y/2).
 *     0.5y <= t < 1y (the 6M node): a par bond with its single semi-annual
 *       coupon paid at maturity, 1 = (1 + y/2)·DF(t). Continuous with the branch
 *       above at t = 0.5 exactly.
 *     t >= 1y: a semi-annual coupon bond priced at par, coupon = y/2 paid at
 *       0.5, 1.0, ..., T, plus redemption at T.
 *   This is the U.S. Treasury CMT quote convention: the published curve is a par
 *   yield curve, its yields are bond-equivalent yields for semi-annual-pay
 *   securities, and the bill inputs enter at their bond-equivalent
 *   (coupon-equivalent) yields rather than on a money-market basis.
 *
 * "annual_act360" (the retired constructed fixture, and any pack that declares
 * an annual fixed leg)
 * - Day count ACT/360 (annual fixed coupon = 365/360 fraction).
 * - Cash leg and every tenor <= 1Y: simple compounding DF = 1 / (1 + r * t).
 * - Swap leg beyond 1Y: annual fixed schedule, par swap equation.
 *
 * Shared by both: continuously compounded zero output, linear-in-zero-rate
 * interpolation, par equation solved by Brent root finding.
 *
 * References
 * - Andersen-Piterbarg Vol I Sec 6 (curve construction).
 */

import type { CurveConvention, MarketSnapshot } from "./marketData";
import { brentq } from "./rootFind";

export interface ZeroCurve {
  readonly t: number[]; // tenors in years
  readonly z: number[]; // continuously compounded zero rates
  zeroRate(time: number): number;
  discountFactor(time: number): number;
  /**
   * Simply-compounded forward rate over [t1, t2]:
   *   f = (P(t1)/P(t2) - 1) / (t2 - t1)
   * Money-market convention. Correct for τ ≤ 1Y (caps, FTP, SOFR fix
   * derivation). For τ > 1Y, use forwardSwapRate instead — simple
   * compounding overstates long-tenor rates by hundreds of bps.
   */
  forwardRate(t1: number, t2: number): number;
  /**
   * Forward rate quoted bond-equivalent semi-annual, the U.S. Treasury CMT
   * quote basis:
   *   f_BEY(t1, t2) = 2·(exp(f_cont/2) − 1),
   * where f_cont = ln(P(t1)/P(t2)) / (t2 − t1) is the continuously compounded
   * forward off the zero curve. Use this wherever a forward is DISPLAYED or
   * consumed as a quoted rate LEVEL (behavioral drivers read a CMT-quoted
   * level). Use forwardRate for accrual math, and for model internals that need
   * a money-market forward. Under "annual_act360" there is no bond-equivalent
   * quote basis, so this returns the simply-compounded forward unchanged.
   */
  forwardRateBey(t1: number, t2: number): number;
  /** The par-instrument convention this curve was bootstrapped under. */
  readonly convention: CurveConvention;
  /**
   * Forward par rate on the curve's own fixed-leg convention, so that
   * forwardSwapRate(0, T) round-trips the input par quote at every node.
   *
   * "semiannual_bond": a forward par TREASURY yield, the same three-branch
   *   treatment the bootstrap applies, solved on forward discount factors.
   *   For τ < 0.5Y: pure discount quoted bond-equivalent,
   *     S = 2·((P(t1)/P(t2))^(1/(2τ)) − 1)  (identical to forwardRateBey).
   *   For 0.5Y ≤ τ < 1Y: a single semi-annual coupon at maturity,
   *     S = 2·(P(t1)/P(t2) − 1).
   *   For τ ≥ 1Y: par coupon of a semi-annual bond,
   *     S = (P(t1) - P(t2)) / (Σ_{k=1..2n} 0.5·P(t1 + k/2)),  2n = round(2τ).
   * "annual_act360":
   *   For τ ≤ 1Y: simple-compounded forward (single-payment OIS convention).
   *   For τ > 1Y, integer: S = (P(t1) - P(t2)) / (Σ_k (365/360) · P(t1+k)).
   *
   * Use this for any par-rate driver (mortgage prepayment, long-tenor forward
   * display, tractor new-money yields). Note that `bgmPricing.buildSwap` still
   * builds an annual ACT/360 swap for swaption pricing; that is the vol-surface
   * lane's convention and is deliberately left alone here.
   */
  forwardSwapRate(t1: number, t2: number): number;
}

/** Annual fixed coupon fraction under ACT/360 (365/360 per full year). */
const ACT_360_ANNUAL = 365 / 360;

/**
 * Forward par rate over [t1, t2] implied by an arbitrary discount function, on
 * the given par-instrument convention. Shared by ZeroCurve.forwardSwapRate and
 * by the all-in (benchmark + TLP) forward on the Curve tab and the curve export,
 * so a synthetic all-in curve is always quoted on the same basis as the
 * benchmark curve it is built from.
 *
 * "semiannual_bond" is the forward par TREASURY yield: pure discount quoted
 * bond-equivalent below the first coupon date, a single semi-annual coupon at
 * maturity on [0.5Y, 1Y), and a semi-annual par bond at and beyond 1Y.
 * "annual_act360" is simple-compounded cash to 1Y and the annual ACT/360 par
 * swap rate beyond it.
 */
export function parForwardFromDf(
  df: (u: number) => number,
  t1: number,
  t2: number,
  convention: CurveConvention,
): number {
  if (t2 <= t1) {
    throw new Error(`parForwardFromDf: t2=${t2} must exceed t1=${t1}`);
  }
  const tau = t2 - t1;
  const p1 = df(t1);
  if (convention === "semiannual_bond") {
    const ratio = p1 / df(t2);
    if (tau < 0.5 - 1e-9) return 2 * (ratio ** (1 / (2 * tau)) - 1);
    if (tau < 1.0 - 1e-9) return 2 * (ratio - 1);
    const half = Math.round(2 * tau);
    let annuity = 0;
    for (let k = 1; k <= half; k++) annuity += 0.5 * df(t1 + k / 2);
    return (p1 - df(t1 + half / 2)) / annuity;
  }
  if (tau <= 1.0 + 1e-9) return (p1 / df(t2) - 1) / tau;
  const n = Math.round(tau);
  let annuity = 0;
  for (let k = 1; k <= n; k++) annuity += ACT_360_ANNUAL * df(t1 + k);
  return (p1 - df(t1 + n)) / annuity;
}

/**
 * Forward rate over [t1, t2] quoted bond-equivalent semi-annual, from an
 * arbitrary discount function: f_BEY = 2·(exp(f_cont/2) − 1). Under
 * "annual_act360" there is no bond-equivalent quote basis and the
 * simply-compounded forward is returned instead.
 */
export function beyForwardFromDf(
  df: (u: number) => number,
  t1: number,
  t2: number,
  convention: CurveConvention,
): number {
  if (t2 <= t1) {
    throw new Error(`beyForwardFromDf: t2=${t2} must exceed t1=${t1}`);
  }
  if (convention !== "semiannual_bond") return (df(t1) / df(t2) - 1) / (t2 - t1);
  return 2 * (Math.exp(Math.log(df(t1) / df(t2)) / (t2 - t1) / 2) - 1);
}

function lerp(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[xs.length - 1];
  // binary search would be O(log n); array sizes are tiny here
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const w = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - w) + ys[i + 1] * w;
    }
  }
  return ys[ys.length - 1];
}

function makeCurve(
  t: number[],
  z: number[],
  convention: CurveConvention = "annual_act360",
): ZeroCurve {
  return {
    t,
    z,
    convention,
    zeroRate(time: number): number {
      return lerp(t, z, time);
    },
    discountFactor(time: number): number {
      return Math.exp(-this.zeroRate(time) * time);
    },
    forwardRate(t1: number, t2: number): number {
      if (t2 <= t1) {
        throw new Error(`forwardRate: t2=${t2} must exceed t1=${t1}`);
      }
      return (this.discountFactor(t1) / this.discountFactor(t2) - 1) / (t2 - t1);
    },
    forwardRateBey(t1: number, t2: number): number {
      return beyForwardFromDf((u) => this.discountFactor(u), t1, t2, convention);
    },
    forwardSwapRate(t1: number, t2: number): number {
      // Boundaries match the bootstrap in each convention, so that
      // forwardSwapRate(0, T) reproduces the input par quote exactly.
      return parForwardFromDf((u) => this.discountFactor(u), t1, t2, convention);
    },
  };
}

function annualFixSchedule(tN: number): number[] {
  const n = Math.round(tN);
  if (Math.abs(n - tN) > 1e-6) {
    throw new Error(`non-integer maturity ${tN} not supported by annual schedule`);
  }
  const sched: number[] = [];
  for (let i = 1; i <= n; i++) sched.push(i);
  return sched;
}

/**
 * Semi-annual coupon dates 0.5, 1.0, ..., tN for a bond-equivalent par
 * instrument. Exact half-year periods stand in for ACT/ACT accrual.
 */
function semiannualFixSchedule(tN: number): number[] {
  const half = Math.round(2 * tN);
  if (Math.abs(half - 2 * tN) > 1e-6) {
    throw new Error(
      `maturity ${tN} is not a whole number of half-years; unsupported by the semiannual schedule`,
    );
  }
  const sched: number[] = [];
  for (let i = 1; i <= half; i++) sched.push(i / 2);
  return sched;
}

export function bootstrapZeroCurve(snapshot: MarketSnapshot): ZeroCurve {
  const convention = snapshot.curveConvention;
  const quotes = [...snapshot.curveQuotes];
  for (let i = 0; i < quotes.length - 1; i++) {
    if (!(quotes[i].tYears < quotes[i + 1].tYears)) {
      throw new Error("curve quotes must be strictly ascending in t_years");
    }
  }

  const tNodes: number[] = [];
  const zNodes: number[] = [];
  const semiConv = convention === "semiannual_bond";

  for (const q of quotes) {
    if (semiConv) {
      // Treasury/CMT: the tenor alone selects the treatment. The `type` label is
      // metadata, never a switch, so legacy CASH/SWAP packs and the new
      // BILL_BEY/CMT_PAR packs bootstrap identically.
      if (q.tYears < 0.5 - 1e-9) {
        // Bill quoted coupon-equivalent: pure discount at the BEY.
        tNodes.push(q.tYears);
        zNodes.push(2 * Math.log1p(q.rate / 2));
        continue;
      }
      if (q.tYears < 1.0 - 1e-9) {
        // One semi-annual coupon, paid at maturity.
        const df = 1.0 / (1.0 + q.rate / 2);
        tNodes.push(q.tYears);
        zNodes.push(-Math.log(df) / q.tYears);
        continue;
      }
    } else if (q.instrumentType === "CASH" || q.tYears <= 1.0) {
      const df = 1.0 / (1.0 + q.rate * q.tYears);
      const z = -Math.log(df) / q.tYears;
      tNodes.push(q.tYears);
      zNodes.push(z);
      continue;
    }

    const priorT = [...tNodes];
    const priorZ = [...zNodes];
    const schedule = semiConv ? semiannualFixSchedule(q.tYears) : annualFixSchedule(q.tYears);

    const parResidual = (zN: number): number => {
      const tt = [...priorT, q.tYears];
      const zz = [...priorZ, zN];
      let pvFixed = 0;
      let prevDate = 0;
      for (const couponDate of schedule) {
        const zAt = lerp(tt, zz, couponDate);
        const dfAt = Math.exp(-zAt * couponDate);
        // Semi-annual bond: exact 0.5-year accrual (coupon = rate/2).
        // Annual ACT/360 swap: 365/360 per full year.
        const tau = semiConv ? 0.5 : (couponDate - prevDate) * (365 / 360);
        pvFixed += q.rate * tau * dfAt;
        prevDate = couponDate;
      }
      const dfN = Math.exp(-zN * q.tYears);
      // Par bond: 1 = coupon PV + redemption PV. Par swap: 1 - DF(T) = coupon PV.
      // Same equation either way.
      const pvFloat = 1.0 - dfN;
      return pvFloat - pvFixed;
    };

    const lo = Math.max(priorZ[priorZ.length - 1] - 0.05, 1e-5);
    const hi = priorZ[priorZ.length - 1] + 0.10;
    let zSolved: number;
    try {
      zSolved = brentq(parResidual, lo, hi);
    } catch {
      zSolved = brentq(parResidual, 1e-5, 0.30);
    }
    tNodes.push(q.tYears);
    zNodes.push(zSolved);
  }

  return makeCurve(tNodes, zNodes, convention);
}

/**
 * Parallel-shifted copy of a zero curve: every node's zero rate moves by
 * shockBp. Interpolation is linear in zero rate, so zeroRate(t) shifts by
 * exactly s at every t and discount factors scale by exp(-s·t). This is the
 * EVE-style curve shock (discounting side); ShockedPath in seg.ts shifts only
 * the projection path (cashflow side).
 */
export function shockCurve(curve: ZeroCurve, shockBp: number): ZeroCurve {
  const s = shockBp / 1e4;
  return makeCurve([...curve.t], curve.z.map((z) => z + s), curve.convention);
}

/**
 * Rebuild a ZeroCurve from the plain {t, z, convention} triple that survives a
 * structured-clone hop into a Web Worker. The convention must travel with the
 * nodes: without it the worker's forwardSwapRate would silently fall back to
 * the annual ACT/360 fixed leg and disagree with the main thread.
 */
export function rehydrateCurve(payload: {
  t: number[];
  z: number[];
  convention?: CurveConvention;
}): ZeroCurve {
  return makeCurve(payload.t, payload.z, payload.convention ?? "annual_act360");
}

export function _annualFixSchedule(tN: number): number[] {
  return annualFixSchedule(tN);
}

export function _semiannualFixSchedule(tN: number): number[] {
  return semiannualFixSchedule(tN);
}

export function _curveLerp(t: number[], z: number[], x: number): number {
  return lerp(t, z, x);
}
