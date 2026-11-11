/**
 * Non-maturity deposit (NMD) instrument — balance-sensitivity surface form.
 *
 * Decay model: every dollar is rate-sensitive, but the sensitivity rises with
 * account size. The book is partitioned into account-size buckets (NMDParams.
 * buckets); each bucket runs the same age-ramped closure(t) composed with a
 * one-sided rate incentive S(r)·A(t)·B(t), scaled by the balance-sensitivity
 * multiplier g(b̄_i) at the bucket's representative balance:
 *
 *   base_incentive(t) = maxRateGrowth + (maxRateDecay − maxRateGrowth) /
 *                       (1 + exp(−K · (r_1M(t) − midpoint)))   ← opportunity-cost
 *                       logistic on the spot LEVEL r (a 0%-paying deposit's
 *                       incentive to leave is the rate it forgoes)
 *   regimeAmp(t)      = 1 + α · max(0, r_1M(t) − MA_P(r_1M; t))  ← surge amplifier
 *                       (excursion form); dormant at or below the trailing
 *                       regime, amplifies once the rate has jumped above it
 *   g(b̄_i)            = gMin + (gMax − gMin) / (1 + exp(−κ_b·(ln b̄_i − ln b*)))
 *   rateIncentive_i   = max(0, base_incentive · regimeAmp · B(t) · g(b̄_i))
 *   decay_i(t)        = 1 − (1 − closure(t)) · (1 − rateIncentive_i / 100)
 *
 *   default: maxRateGrowth = 0 (one-sided), burnoutLambda = 0 (no burnout),
 *   regimeAlpha = 2.0, midpoint a positive level (the opportunity-cost centre).
 *
 * The portfolio cashflow is the sum across buckets. Small balances barely
 * rate-shop (g → gMin); large balances respond fully (g → gMax).
 *
 * EVE / duration: the incentive logistic reads the spot LEVEL r, so it responds
 * genuinely to a parallel shock (negative convexity — runoff accelerates as
 * rates rise). The regime amplifier reads the excursion r − MA(r), which is
 * invariant to a permanent parallel shift once the MA warmup is re-leveled, so
 * it needs no freeze. The MA warmup is in % pa, truncated at the Sep 2025
 * as-of date.
 *
 * Bank's-perspective convention: liability. depositRate = 0 for Non-IB.
 * The full FTP credit on the all-in funding curve is the deposit franchise.
 */

import type {
  Cashflow,
  Instrument,
  InstrumentTermsBase,
  RatePath,
} from "./types";
import {
  balanceSensitivity,
  buildWarmupSOFR1M,
  NMD_DEFAULTS,
  nmdIncentiveAt,
  normalizedBuckets,
  regimeAmplifier,
  type NMDParams,
} from "../behavioral/nmdModel";

export interface NMDTerms extends InstrumentTermsBase {
  type: "nmd";
  /** Static deposit rate the bank pays, decimal annualised (0 for Non-IB). */
  depositRate: number;
  /**
   * Deposit-rate beta of a plain deposit, a decimal from 0 to 1. No gap ladder
   * reads it; only the replicating-portfolio funding credit does, as the share
   * of the balance that reprices at once.
   */
  beta: number;
  /** Closure-and-incentive parameter set (includes the balance-sensitivity surface). */
  nmdParams: NMDParams;
}

export const NMD_TERMS_DEFAULTS: NMDTerms = {
  id: "nmd-1",
  type: "nmd",
  label: "Non-IB NMD",
  notional: 1_000_000,
  maturityMonths: 360,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  depositRate: 0,
  beta: 0,
  // Balance-sensitivity surface parameters. Phase 5 anchors the SEASONED-STOCK
  // WAL (vintage superposition, analytics/nmdStock.ts) to ~5y on the 3/31 curve;
  // the fresh age-0 cohort then runs shorter (~4.4y, the marginal new-money
  // life). Retail-skewed bucket distribution.
  //   maxRateGrowth = 0     → one-sided shape (no inflow side)
  //   burnoutLambda = 0     → money stays rate-responsive throughout
  //   logisticMidpoint = 1.0 → opportunity-cost centre: the incentive logistic
  //                            reads the spot LEVEL r (% pa). 1.0 puts the 3/31
  //                            operating level (~3.66%) near the lower climb region
  //                            of the logistic, maximising the marginal rate response
  //                            and producing a material convexity wedge (effDur
  //                            ~2.85y single / ~3.38y book vs ~3.55y static / ~4.43y
  //                            WAL). The regime amplifier (parallel-invariant) carries
  //                            the surge path-dependency.
  //   logisticK = 1.5       → reactivity of the level logistic
  //   regimeAlpha = 2.0     → surge amplifier 1 + 2·max(0, r − MA₂₄); off at
  //                           base (r 3.66% ≤ MA₂₄ 4.97% on the 3/31 curve → 0
  //                           excursion), amplifies in a 2022-style spike
  //   maxRateDecay = 1.98   → re-solved so the seasoned-stock WAL lands at 5.0y
  //                           (60.0m), just under the 10Y pillar (60.5m) so the
  //                           RP/FTP stock-WAL cap binds (cohort runs ~4.43y)
  nmdParams: {
    ...NMD_DEFAULTS,
    maxRateDecay: 1.98,
    maxRateGrowth: 0,
    burnoutLambda: 0,
    logisticMidpoint: 1.0,
    logisticK: 1.5,
    regimeAlpha: 2.0,
  },
};

export class NMDeposit implements Instrument {
  readonly terms: NMDTerms;
  private readonly historical: ReadonlyArray<number>;

  constructor(terms: NMDTerms, historical?: ReadonlyArray<number>) {
    if (terms.notional <= 0) throw new Error("NMDeposit: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("NMDeposit: projection horizon must be positive");
    if (terms.depositRate < 0) throw new Error("NMDeposit: depositRate must be non-negative");
    if (terms.nmdParams.maPeriod <= 0) throw new Error("NMDeposit: maPeriod must be positive");
    this.terms = terms;
    this.historical = historical ?? buildWarmupSOFR1M();
  }

  repricingSchedule(): number[] {
    return [];
  }

  /**
   * Bucket-level monthly simulation. Each account-size bucket decays at
   * closure(t) composed with a balance-graded rate incentive (g(b̄_i) scaling
   * the opportunity-cost level logistic, amplified by the regime excursion).
   * Returns per-month per-bucket opening balances alongside the cashflow legs;
   * generateCashflows and the bucket-composition chart both consume this so the
   * loop exists exactly once.
   *
   * Incentive driver: the spot LEVEL r_1M. Regime amplifier: 1 + α·max(0, r − MA).
   * Under a parallel EVE shock the level incentive responds (negative convexity)
   * while the excursion-based amplifier stays invariant once the MA warmup is
   * re-leveled with the shock. See analytics/duration.ts.
   */
  simulateBook(path: RatePath): Array<{
    monthOffset: number;
    byBucket: number[];
    balance: number;
    principalPaid: number;
    interestPaid: number;
    couponRate: number;
  }> {
    const { notional, maturityMonths, depositRate, nmdParams } = this.terms;
    const monthlyDepositRate = depositRate / 12;
    const buckets = normalizedBuckets(nmdParams.buckets);
    const gByBucket = buckets.map((b) => balanceSensitivity(b.repBalance, nmdParams.sens));

    const histLen = this.historical.length;
    if (histLen < nmdParams.maPeriod) {
      throw new Error(`NMDeposit: historical SOFR too short for MA period of ${nmdParams.maPeriod}`);
    }

    // Build [historical || path] rate array in % pa for MA computation.
    const fullHistory: number[] = new Array(histLen + maturityMonths);
    for (let i = 0; i < histLen; i++) fullHistory[i] = this.historical[i];
    for (let t = 0; t < maturityMonths; t++) fullHistory[histLen + t] = path.rateAt(t) * 100;
    const offset = histLen;

    const out: Array<{
      monthOffset: number;
      byBucket: number[];
      balance: number;
      principalPaid: number;
      interestPaid: number;
      couponRate: number;
    }> = [];

    const bal = buckets.map((b) => notional * b.share);
    let cumIncentive = 0;
    const tau = Math.max(nmdParams.closureTauMonths, 1e-6);

    for (let m = 1; m <= maturityMonths; m++) {
      const idx = offset + m - 1;
      const currentRatePct = fullHistory[idx];

      let maSum = 0;
      for (let j = 1; j <= nmdParams.maPeriod; j++) maSum += fullHistory[idx - j];
      const ma = maSum / nmdParams.maPeriod;

      // Opportunity-cost incentive: one-sided logistic on the spot LEVEL r.
      const baseIncentive = nmdIncentiveAt(nmdParams, currentRatePct);
      // Regime amplifier: 1 + α·max(0, r − MA). Invariant to a parallel shift
      // (r and MA move together once the warmup re-levels), so the duration
      // engine needs no freeze; the LEVEL incentive above still responds.
      const regimeAmp = regimeAmplifier(currentRatePct, ma, nmdParams.regimeAlpha);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(m - 1) / tau);
      const closureFactor = 1 - closureT / 100;

      const opening = bal.slice();
      const bal0 = bal.reduce((s, v) => s + v, 0);
      let decayTotal = 0;
      for (let i = 0; i < buckets.length; i++) {
        const rateIncentiveDecay = Math.max(0, baseIncentive * burnoutB * regimeAmp * gByBucket[i]);
        const decayDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);
        const decayAmt = Math.max(0, bal[i] * decayDecimal);
        bal[i] = Math.max(0, bal[i] - decayAmt);
        decayTotal += decayAmt;
      }
      const principalPaid = m === maturityMonths ? bal0 : Math.min(bal0, decayTotal);
      const interest = bal0 * monthlyDepositRate;

      out.push({
        monthOffset: m,
        byBucket: opening,
        balance: bal0,
        principalPaid,
        interestPaid: interest,
        couponRate: depositRate,
      });

      if (baseIncentive > 0) cumIncentive += baseIncentive;
      if (m === maturityMonths) {
        for (let i = 0; i < bal.length; i++) bal[i] = 0;
      }
      if (bal.reduce((s, v) => s + v, 0) < 1e-6 && m < maturityMonths) break;
    }

    return out;
  }

  generateCashflows(path: RatePath): Cashflow[] {
    return this.simulateBook(path).map((s) => ({
      monthOffset: s.monthOffset,
      balance: s.balance,
      principalPaid: s.principalPaid,
      interestPaid: s.interestPaid,
      couponRate: s.couponRate,
    }));
  }
}

export function isNMDTerms(t: InstrumentTermsBase): t is NMDTerms {
  return t.type === "nmd";
}
