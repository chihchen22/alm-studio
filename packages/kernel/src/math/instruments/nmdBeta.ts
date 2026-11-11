/**
 * Interest-Bearing NMD-B with β-driven repricing — Phase 7.
 *
 * Layered on top of the four-factor decay model used by Non-IB NMD: the
 * deposit rate D(t) tracks the market index (1M SOFR by convention) through
 * a logistic S-curve β applied as a level ratio:
 *
 *     β(r) = β_min + (β_max − β_min) / (1 + exp(−k · (r − m)))
 *     D_target(t) = β(r(t)) · r(t)
 *     D(t) = D(t−1) + λ · (D_target(t) − D(t−1))
 *     D(0) = β(r(0)) · r(0)             (always the level target at t=0)
 *
 * with r in % per annum, m the inflection rate level (% per annum), k the
 * logistic steepness, and λ ∈ (0, 1] a Nerlove partial-adjustment factor
 * controlling how quickly D converges to its target each period (default
 * 1.0 = full snap to target; smaller values give smoother trajectories).
 *
 * Why level-ratio rather than incremental ΔD = β·Δr: the level form ensures
 * that under a flat market environment D ≈ β · r (the long-run pass-through),
 * not whatever D₀ was originally set to. With β ≈ 0.5 and SOFR ≈ 4%, this
 * gives D ≈ 2% — and therefore the spread r − D feeding the closure model's
 * rate-driven incentive sits near 2%, putting the logistic near its midpoint
 * (the same regime as the Non-IB NMD's r − MA spread of ≈ 0). This keeps the
 * closure-decay magnitudes consistent across the two models without
 * re-parameterizing the logistic shape.
 *
 * Default S-curve parameters are round illustrative textbook values, not
 * fitted to any data: β_min = 0.45, β_max = 0.80, k = 0.55, m = 4.0%.
 * Asymmetric volatility
 * (λ_up vs λ_down) and the FHLB-spread coefficient γ_fhlb are intentionally
 * omitted in this simpler version; if needed they can
 * be added as additional fields without breaking the interface.
 *
 * Decay overlay (balance-sensitivity surface): the book is partitioned into
 * account-size buckets (NMDParams.buckets). Each bucket decays at closure(t)
 * composed with a one-sided refi-style incentive S(spread) = max_decay /
 * (1 + exp(−K·(spread − midpoint))) (the generic logistic with max_growth = 0),
 * but the incentive is scaled by the balance-sensitivity multiplier g(b̄_i)
 * at the bucket's representative balance:
 *
 *   - Small balances (g → gMin): barely rate-shop; the bucket runs near
 *     closure-only, the relationship core that stays parked.
 *   - Large balances (g → gMax): respond fully. Hot commercial money
 *     withdraws fast when the market out-pays the deposit; when rates fall the
 *     term collapses toward closure-only — depositors keep money parked, they
 *     don't add to the cohort. The IB book skews toward these large, rate-aware
 *     balances, so it is shorter-WAL than Non-IB.
 *
 * Per the model audit memo (Sec 9) the incentive spread is r(t) − D(t) (the
 * depositor's actual switching incentive given the current deposit rate)
 * instead of r(t) − MA(r), so no MA history warmup is needed.
 *
 * No burnout by default (burnoutLambda = 0): unlike mortgage refi burnout,
 * rate-sensitive commercial money does not exhaust — it stays responsive to
 * every new spread widening. The rate response lives entirely in the r − D
 * spread logistic: D = β(r)·r reprices the coupon as the market moves, so the
 * switching spread r − D widens on up-paths (disproportionate uninsured flight,
 * the 2022-23 dynamic) and collapses toward the closure-only floor on down-paths
 * (2010s parked surge balances). The Non-IB cash-sorting salience multiplier is
 * NOT used here: the IB coupon already prices in the rate level through β, so an
 * extra level multiplier would double-count and break the EVE duration (it had to
 * be frozen under a parallel shock — a smell the Non-IB regime redesign removed).
 *
 * Bank's-perspective convention: liability. The repricing-gap split uses
 * β(r(0)) — the initial β at the t=0 market rate — so that the (1 − β) slice
 * is the rate-locked deposit franchise and the β slice reprices in the next
 * monthly bucket. As rates evolve over the projection horizon, the actual β
 * applied to ΔD changes month by month, but the gap's "fixed gap" measure
 * is taken at t=0.
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
  IB_BUCKETS,
  NMD_DEFAULTS,
  normalizedBuckets,
  regimeAmplifier,
  type NMDParams,
} from "../behavioral/nmdModel";

/** Logistic S-curve parameters mapping market rate level (% pa) to β ∈ [β_min, β_max]. */
export interface BetaSCurveParams {
  /** Lower asymptote — rate sensitivity at very low rate levels. */
  betaMin: number;
  /** Upper asymptote — rate sensitivity at very high rate levels. */
  betaMax: number;
  /** Logistic steepness — controls how sharply β transitions across the inflection. */
  k: number;
  /** Inflection rate level, in % per annum. */
  m: number;
  /** Nerlove partial-adjustment factor in (0, 1]. 1.0 = full pass-through;
   *  smaller values smooth the deposit-rate trajectory. */
  lambda: number;
}

/** Illustrative textbook values (round numbers, not fitted to any data). */
export const BETA_S_CURVE_DEFAULTS: BetaSCurveParams = {
  betaMin: 0.45,
  betaMax: 0.80,
  k: 0.55,
  m: 4.0,
  lambda: 1.0,
};

export interface NMDBetaTerms extends InstrumentTermsBase {
  type: "nmd-b";
  /** β S-curve parameters mapping market rate level to rate sensitivity. */
  sCurve: BetaSCurveParams;
  /** Closure-and-incentive parameter set (same shape as Non-IB NMD). */
  nmdParams: NMDParams;
}

export const NMD_B_TERMS_DEFAULTS: NMDBetaTerms = {
  id: "nmd-b-1",
  type: "nmd-b",
  label: "IB NMD",
  notional: 1_000_000,
  // Match Non-IB NMD and Mortgage horizon so all gap charts share an x-axis.
  maturityMonths: 360,
  originationOffsetMonths: 0,
  amortType: "level-pay",
  side: "liability",
  sCurve: BETA_S_CURVE_DEFAULTS,
  // Balance-sensitivity-surface re-parameterization vs Non-IB NMD (see header):
  //   maxRateGrowth = 0    → one-sided refi-style S-curve (no inflow side)
  //   burnoutLambda = 0    → commercial money stays rate-responsive
  //   maxRateDecay        → hot-money plateau, %/mo (pre-g(b) scaling)
  //   logisticMidpoint, logisticK → midpoint above the operating spread
  //     (1−β)·r ≈ 1.45% on the 3/31 curve (convex lower limb)
  //   buckets = IB_BUCKETS → commercial-skewed account-size distribution,
  //     so the book is shorter-WAL (target ~2.4y) than the retail Non-IB book.
  //
  // Phase 2 (regime redesign): the Non-IB cash-sorting salience multiplier r/ref
  // is DROPPED from IB entirely. The IB rate response is the r − D spread alone:
  // D = β(r)·r reprices the coupon under a parallel shock, so the switching spread
  // r − D still moves (widens on +shock → faster runoff = negative convexity), and
  // the β slice reprices the coupon. With salience gone there is no level term to
  // freeze, so the duration engine needs no basePath hack.
  //
  // Phase 3.1 (effective-duration repair): at logisticK = 1.0 the r − D decay
  // logistic was too STEEP — under the ±100bp EVE shock the spread moved and the
  // runoff over-accelerated, producing excessive negative convexity that drove the
  // effective duration slightly NEGATIVE on the stochastic (HW/BGM) legs (the
  // floating-coupon interest leg's negative duration, amplified by rate volatility
  // on high-rate paths). A deposit liability cannot have negative duration. The
  // empirical fix is to FLATTEN the decay slope: logisticK = 0.3 cuts the runoff's
  // shock-sensitivity so the rate-locked (1 − β) ≈ 20% slice retains ~2y duration,
  // landing the effective duration at ~0.25y (base) to ~0.39y (BGM) — POSITIVE and
  // stable across base/HW/BGM, matching the (1 − β)·D_locked ≈ 0.20 × 2y ≈ 0.40
  // economic anchor. maxRateDecay stays 9.5 (cutting it instead lengthens WAL past
  // 4y and overshoots BGM); the Nerlove λ smoothing was found inert for duration.
  // Side effect: the flatter (below-midpoint) logistic raises the base incentive, so
  // the deterministic-forward (cohort) WAL eases ~2.73y → ~2.38y (still 2–3y band);
  // the seasoned-stock WAL and the RP/FTP stock-WAL cap shift down proportionally.
  nmdParams: {
    ...NMD_DEFAULTS,
    maxRateDecay: 9.5,
    maxRateGrowth: 0,
    burnoutLambda: 0,
    logisticMidpoint: 2.0,
    logisticK: 0.3,
    // Phase 3: regime amplifier re-added with α = 0 (off by default). Overrides
    // the NMD_DEFAULTS value of 2.0 — IB is already-optimised non-operational money
    // where the r − D spread alone drives runoff; the amplifier is dormant at base
    // and available for stress exploration via the UI Regime amplifier card.
    regimeAlpha: 0,
    buckets: IB_BUCKETS,
  },
};

/** S-curve β at market rate level r (in % per annum). */
export function betaAtRate(rPct: number, p: BetaSCurveParams): number {
  return p.betaMin + (p.betaMax - p.betaMin) / (1 + Math.exp(-p.k * (rPct - p.m)));
}

export class NMDBeta implements Instrument {
  readonly terms: NMDBetaTerms;
  private readonly historical: ReadonlyArray<number>;

  constructor(terms: NMDBetaTerms, historical?: ReadonlyArray<number>) {
    if (terms.notional <= 0) throw new Error("NMDBeta: notional must be positive");
    if (terms.maturityMonths <= 0) throw new Error("NMDBeta: projection horizon must be positive");
    if (terms.sCurve.betaMin < 0 || terms.sCurve.betaMax <= terms.sCurve.betaMin) {
      throw new Error("NMDBeta: require 0 ≤ betaMin < betaMax");
    }
    if (terms.sCurve.lambda <= 0 || terms.sCurve.lambda > 1) {
      throw new Error("NMDBeta: lambda must be in (0, 1]");
    }
    this.terms = terms;
    this.historical = historical ?? buildWarmupSOFR1M();
  }

  /** NMD-B reprices the β slice at the next monthly bucket; the (1 − β)
   *  slice is rate-locked. The schedule itself is empty — the gap chart
   *  consumes the (β, balance) split directly via the analytics layer. */
  repricingSchedule(): number[] {
    return [];
  }

  /** Initial β computed from the path's t=0 market rate. Used by the
   *  repricing-gap analytic to size the rate-locked vs β-slice split. */
  initialBeta(path: RatePath): number {
    return betaAtRate(path.rateAt(0) * 100, this.terms.sCurve);
  }

  /** Generate the projected deposit-rate path D(t), in decimal, over the
   *  full projection horizon. D(t) tracks the level target β(r(t))·r(t)
   *  with optional Nerlove partial adjustment toward that target. */
  depositRatePath(path: RatePath): { rPct: number[]; dPct: number[]; betaPct: number[] } {
    const n = this.terms.maturityMonths;
    const rPct = new Array<number>(n);
    const dPct = new Array<number>(n);
    const betaPct = new Array<number>(n);
    const lambda = this.terms.sCurve.lambda;
    let dPrev = 0;
    for (let t = 0; t < n; t++) {
      const rNow = path.rateAt(t) * 100;
      const beta = betaAtRate(rNow, this.terms.sCurve);
      const target = beta * rNow;
      // D(0) snaps to the target. From t=1 onward, partial-adjustment toward
      // the target governed by λ. With λ=1 the deposit rate equals β·r at
      // every step.
      const dNow = t === 0 ? target : Math.max(0, dPrev + lambda * (target - dPrev));
      rPct[t] = rNow;
      dPct[t] = dNow;
      betaPct[t] = beta;
      dPrev = dNow;
    }
    return { rPct, dPct, betaPct };
  }

  /**
   * Bucket-level monthly simulation (see header): each account-size bucket
   * decays at closure(t) composed with the one-sided incentive S(spread)·B(t),
   * scaled by the balance-sensitivity multiplier g(b̄_i). Returns per-month
   * per-bucket opening balances alongside the cashflow legs; generateCashflows
   * and the tab's bucket-composition chart both consume this so the loop exists
   * exactly once. The incentive spread is r − D (the IB substitution).
   */
  simulateBook(path: RatePath): Array<{
    monthOffset: number;
    byBucket: number[];
    balance: number;
    principalPaid: number;
    interestPaid: number;
    couponRate: number;
  }> {
    const { notional, maturityMonths, nmdParams, sCurve } = this.terms;
    const buckets = normalizedBuckets(nmdParams.buckets);
    const gByBucket = buckets.map((b) => balanceSensitivity(b.repBalance, nmdParams.sens));

    // Build full rate series [warmup || forward path] for the MA window.
    const warmupLen = this.historical.length;
    const full = new Array<number>(warmupLen + maturityMonths);
    for (let i = 0; i < warmupLen; i++) full[i] = this.historical[i];
    for (let t = 0; t < maturityMonths; t++) full[warmupLen + t] = path.rateAt(t) * 100;

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

    // Deposit rate tracks D_target = β(r) · r each period, with optional
    // partial-adjustment smoothing controlled by λ. At t=0 (m=1) we snap to
    // the target so the initial spread r − D = (1 − β) · r is the long-run
    // pass-through gap (same regime as Non-IB NMD's r − MA ≈ 0 spread).
    let depositRatePct = 0;

    for (let m = 1; m <= maturityMonths; m++) {
      const idx = warmupLen + m - 1;
      const currentMarketPct = full[idx];
      // MA for the regime amplifier; ≡ 1 when regimeAlpha = 0 (IB default).
      let maSum = 0;
      for (let j = 1; j <= nmdParams.maPeriod; j++) maSum += full[idx - j];
      const ma = maSum / nmdParams.maPeriod;
      const regimeAmp = regimeAmplifier(currentMarketPct, ma, nmdParams.regimeAlpha);

      const betaT = betaAtRate(currentMarketPct, sCurve);
      const targetPct = betaT * currentMarketPct;
      depositRatePct =
        m === 1
          ? targetPct
          : Math.max(0, depositRatePct + sCurve.lambda * (targetPct - depositRatePct));

      // Per the model audit: rate-driven incentive uses (market − D) spread.
      const spread = currentMarketPct - depositRatePct;

      const expTerm = Math.exp(-nmdParams.logisticK * (spread - nmdParams.logisticMidpoint));
      const baseIncentive =
        nmdParams.maxRateGrowth +
        (nmdParams.maxRateDecay - nmdParams.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(m - 1) / tau);
      const closureFactor = 1 - closureT / 100;
      // Rate response: r − D spread logistic scaled by the regime amplifier
      // (α = 0 by default → regimeAmp = 1, identical to Phase 2 behaviour).
      const opening = bal.slice();
      const bal0 = bal.reduce((s, v) => s + v, 0);
      let decayTotal = 0;
      for (let i = 0; i < buckets.length; i++) {
        const rateIncentiveDecay = Math.max(0, baseIncentive * regimeAmp * burnoutB * gByBucket[i]);
        const decayDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);
        const decayAmt = Math.max(0, bal[i] * decayDecimal);
        bal[i] = Math.max(0, bal[i] - decayAmt);
        decayTotal += decayAmt;
      }
      const principalPaid = m === maturityMonths ? bal0 : Math.min(bal0, decayTotal);
      const depositRateDecimal = depositRatePct / 100;
      const interest = (bal0 * depositRateDecimal) / 12;

      out.push({
        monthOffset: m,
        byBucket: opening,
        balance: bal0,
        principalPaid,
        interestPaid: interest,
        couponRate: depositRateDecimal,
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

export function isNMDBetaTerms(t: InstrumentTermsBase): t is NMDBetaTerms {
  return t.type === "nmd-b";
}

/**
 * Monte Carlo NMD-B runner. Mirrors the shape of `runNMDOnPaths` so the
 * NmdBTab can render the same balance-fan / decay-fan / WAL output cards.
 * The deposit-rate path is computed per-path from the supplied 1M SOFR
 * realisations through the β S-curve, then the closure overlay runs against
 * spread = r − D (per audit memo Sec 9). No historical SOFR warmup is needed
 * because the spread doesn't reference an MA window.
 */
export interface NMDBetaScenarioOutput {
  decayMean: Float64Array;
  decayP5: Float64Array;
  decayP95: Float64Array;
  balMean: Float64Array;
  balP5: Float64Array;
  balP95: Float64Array;
  /** Mean deposit rate (% per annum) at each step across paths. */
  depositRateMean: Float64Array;
  depositRateP5: Float64Array;
  depositRateP95: Float64Array;
  /** Path-average WAL in years (with horizon-tail piece). */
  wal: number;
  /** Path-average life decay (% per month, balance-weighted). */
  lifeDecay: number;
}

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

export function runNMDBetaOnPaths(
  paths: ArrayLike<Float64Array>,
  terms: NMDBetaTerms,
  historical?: ReadonlyArray<number>,
): NMDBetaScenarioOutput {
  const nPaths = paths.length;
  if (nPaths === 0) throw new Error("runNMDBetaOnPaths: paths must be non-empty");
  const nSteps = paths[0].length;
  const { notional, nmdParams, sCurve } = terms;
  const buckets = normalizedBuckets(nmdParams.buckets);
  const gByBucket = buckets.map((b) => balanceSensitivity(b.repBalance, nmdParams.sens));
  const tau = Math.max(nmdParams.closureTauMonths, 1e-6);
  const warmup = historical ?? buildWarmupSOFR1M();
  const warmupLen = warmup.length;

  const allDecay: Float64Array[] = new Array(nSteps);
  const allBal: Float64Array[] = new Array(nSteps);
  const allDeposit: Float64Array[] = new Array(nSteps);
  for (let t = 0; t < nSteps; t++) {
    allDecay[t] = new Float64Array(nPaths);
    allBal[t] = new Float64Array(nPaths);
    allDeposit[t] = new Float64Array(nPaths);
  }

  let sumWal = 0;
  let sumLifeDecay = 0;

  for (let p = 0; p < nPaths; p++) {
    const path = paths[p];
    // Build full rate series [warmup || this path] for the MA window.
    const full = new Array<number>(warmupLen + nSteps);
    for (let i = 0; i < warmupLen; i++) full[i] = warmup[i];
    for (let t = 0; t < nSteps; t++) full[warmupLen + t] = path[t] * 100;

    const bal = buckets.map((b) => notional * b.share);
    let cumIncentive = 0;
    let depositRatePct = 0;
    let walSum = 0;
    let balSum = 0;
    let decayWeightSum = 0;

    for (let t = 1; t <= nSteps; t++) {
      const idx = warmupLen + t - 1;
      const currentMarketPct = full[idx];
      let maSum = 0;
      for (let j = 1; j <= nmdParams.maPeriod; j++) maSum += full[idx - j];
      const ma = maSum / nmdParams.maPeriod;
      const regimeAmp = regimeAmplifier(currentMarketPct, ma, nmdParams.regimeAlpha);

      const betaT = betaAtRate(currentMarketPct, sCurve);
      const targetPct = betaT * currentMarketPct;
      depositRatePct =
        t === 1
          ? targetPct
          : Math.max(0, depositRatePct + sCurve.lambda * (targetPct - depositRatePct));

      const spread = currentMarketPct - depositRatePct;
      const expTerm = Math.exp(-nmdParams.logisticK * (spread - nmdParams.logisticMidpoint));
      const baseIncentive =
        nmdParams.maxRateGrowth +
        (nmdParams.maxRateDecay - nmdParams.maxRateGrowth) / (1 + expTerm);

      const burnoutB = Math.exp(-nmdParams.burnoutLambda * cumIncentive);
      const closureT =
        nmdParams.closureSteady +
        (nmdParams.closureInitial - nmdParams.closureSteady) * Math.exp(-(t - 1) / tau);
      const closureFactor = 1 - closureT / 100;

      // Balance-sensitivity surface (matches simulateBook): each bucket decays
      // at closure composed with the clamped one-sided r − D incentive scaled by
      // the balance multiplier g(b̄_i) and the regime amplifier (α = 0 → amp = 1).
      let totalBefore = 0;
      let totalDecay = 0;
      for (let i = 0; i < buckets.length; i++) {
        totalBefore += bal[i];
        const rateIncentiveDecay = Math.max(0, baseIncentive * regimeAmp * burnoutB * gByBucket[i]);
        const decayDecimal = 1 - closureFactor * (1 - rateIncentiveDecay / 100);
        const decayAmt = Math.max(0, bal[i] * decayDecimal);
        bal[i] = Math.max(0, bal[i] - decayAmt);
        totalDecay += decayAmt;
      }
      const newTotal = totalBefore - totalDecay;
      const actualDecay = totalBefore > 0 ? (totalDecay / totalBefore) * 100 : 0;

      // Display in normalised (start = 100) units to match NmdTab convention.
      const balDisplay = (totalBefore / notional) * 100;
      const newBalDisplay = (newTotal / notional) * 100;

      allDecay[t - 1][p] = actualDecay;
      allBal[t - 1][p] = newBalDisplay;
      allDeposit[t - 1][p] = depositRatePct;

      balSum += balDisplay;
      decayWeightSum += actualDecay * balDisplay;
      if (totalDecay > 0) walSum += (totalDecay / notional) * (t / 12);

      if (baseIncentive > 0) cumIncentive += baseIncentive;
    }

    const residual = bal.reduce((s, v) => s + v, 0);
    walSum += (residual / notional) * (nSteps / 12);
    sumWal += walSum;
    sumLifeDecay += balSum > 0 ? decayWeightSum / balSum : 0;
  }

  const decayMean = new Float64Array(nSteps);
  const decayP5 = new Float64Array(nSteps);
  const decayP95 = new Float64Array(nSteps);
  const balMean = new Float64Array(nSteps);
  const balP5 = new Float64Array(nSteps);
  const balP95 = new Float64Array(nSteps);
  const depositRateMean = new Float64Array(nSteps);
  const depositRateP5 = new Float64Array(nSteps);
  const depositRateP95 = new Float64Array(nSteps);

  for (let t = 0; t < nSteps; t++) {
    if (nPaths === 1) {
      decayMean[t] = allDecay[t][0];
      decayP5[t] = allDecay[t][0];
      decayP95[t] = allDecay[t][0];
      balMean[t] = allBal[t][0];
      balP5[t] = allBal[t][0];
      balP95[t] = allBal[t][0];
      depositRateMean[t] = allDeposit[t][0];
      depositRateP5[t] = allDeposit[t][0];
      depositRateP95[t] = allDeposit[t][0];
    } else {
      const sortedDecay = Array.from(allDecay[t]).sort((a, b) => a - b);
      const sortedBal = Array.from(allBal[t]).sort((a, b) => a - b);
      const sortedDep = Array.from(allDeposit[t]).sort((a, b) => a - b);
      decayMean[t] = sortedDecay.reduce((s, v) => s + v, 0) / nPaths;
      decayP5[t] = percentile(sortedDecay, 0.05);
      decayP95[t] = percentile(sortedDecay, 0.95);
      balMean[t] = sortedBal.reduce((s, v) => s + v, 0) / nPaths;
      balP5[t] = percentile(sortedBal, 0.05);
      balP95[t] = percentile(sortedBal, 0.95);
      depositRateMean[t] = sortedDep.reduce((s, v) => s + v, 0) / nPaths;
      depositRateP5[t] = percentile(sortedDep, 0.05);
      depositRateP95[t] = percentile(sortedDep, 0.95);
    }
  }

  return {
    decayMean,
    decayP5,
    decayP95,
    balMean,
    balP5,
    balP95,
    depositRateMean,
    depositRateP5,
    depositRateP95,
    wal: sumWal / nPaths,
    lifeDecay: sumLifeDecay / nPaths,
  };
}
