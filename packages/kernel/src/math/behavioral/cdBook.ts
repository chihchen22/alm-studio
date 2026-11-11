/**
 * Commercial CD prepayment / renewal / liquidity cohort model -- faithful
 * TypeScript port of a Python reference model's cohort walks (the run-off and
 * going-concern EVE walk, the renewal-ON liquidity walk and the rung-1 / rung-2 /
 * static-rho benchmark ladder). The illustrative parameter set, the discount
 * curve, the stylized book and the fixtures arrive via
 * illustrative/cdIllustrative.ts; this module is the pure math.
 *
 * The four model equations (single evaluation path, mirroring the Python reference;
 * nothing outside hazardCore/renewalProb/pFull hand-evaluates a logistic):
 *
 *   1. Withdrawal hazard (monthly, off-maturity months only) -- H7, one
 *      monotone S-curve:
 *        h = expit(const + b1Moneyness*m + bLogTtmStd*z_lnTtm + bLogBalStd*z_lnBal)
 *      m = par all-in rate at the REMAINING-term tenor - contract rate
 *      (decimal, positive = depositor earning below market); z_lnTtm and
 *      z_lnBal are ln(remaining months) and ln(balance dollars) standardized
 *      against the persisted standardization constants (NEVER re-derived from
 *      a live batch -- the A18 bug class); logit argument clipped to +/-35. One
 *      monotone S-curve, four parameters; the Stage 4b per-bucket quadratics,
 *      the MEDIUM moneyness clip, the ZIRP ridge and the SHORT/MEDIUM/LONG
 *      hazard TTM-bucket convention are retired. Values beyond the moneyness
 *      domain the parameter set was specified on are disclosed functional-form
 *      extrapolation, not clipped.
 *   2. Renewal logistic (fires ONLY at a cohort's own maturity month, on the
 *      hazard-survived balance):
 *        rho = expit(seg[termBucket] + gamma*mRen + delta24m*1{term=24m})
 *      mRen = forward CD offer rate for the same term - expiring contract
 *      rate; termBucket is the ORIGINAL-term bucket (1-12m SHORT, 18/24m
 *      MEDIUM, 36-60m LONG).
 *   3. Severity part 1 (full vs partial): P(full) = expit(tb[termBucket]
 *      + beta_m*m + beta_b*logBalStd); LONG falls back to tbShort (no separate
 *      LONG intercept). The log-balance covariate has NO persisted mean/std:
 *      it is standardized LIVE each walk month against that month's
 *      cross-section of not-at-maturity live cohorts, x = (ln(clip(bal, 1,
 *      inf)) - mean)/std with population std (ddof = 0) and fallback 1.0
 *      when n <= 1 or std == 0.
 *   4. Expected withdrawal fraction (the ONE quantity both modules consume):
 *        pi = h * (pFull*1.0 + (1 - pFull)*eSevPartial)
 *      applied as a deterministic continuous decrement; part-2 severity is
 *      a fixed Beta-mixture mean E[sev|partial] read from the parameter set;
 *      full closure is a point mass at 1.0.
 *
 * Walk mechanics: remaining months are measured from each cohort-generation's
 * OWN birth month; the hazard decrement applies only to cohorts NOT at their
 * maturity month; coupon accrues monthly = balance * rate / 12 on the
 * PRE-withdrawal balance; renewal spawns a like-for-like term at the shocked
 * forward offer rate (matching-tenor all-in + that term's offer spread, thin
 * terms pooled); generation cap 40; minimum live balance read from the parameter
 * set (the illustrative set carries $1,000; the engine's corrected convention $1). Discounting:
 * all-in curve (SOFR zero + TLP spread), continuous compounding, linear
 * interpolation with flat extrapolation (np.interp semantics), parallel
 * shock on the SOFR leg only (TLP static); the same shocked curve drives the
 * moneyness and offer legs. EVE HEADLINE = RUN-OFF (renewals off: the full
 * surviving balance exits at par at first contractual maturity); the
 * going-concern renewal-chain PV is a diagnostic only (it carries the
 * negative forward rollover margin, excluded from the headline).
 *
 * Scale convention: the walk carries three $1-denominated constants (minimum
 * live balance, the $1 ln-clip in severity part 1, the renewal-spawn floor),
 * so a notional-100 book is walked at balance * walkScale (1e7) and every reported figure is
 * divided back to notional units. WAL and effective duration are scale-free.
 * The CD_BOOK fixtures were produced under exactly this convention.
 */

import {
  CD_BOOK_ILLUSTRATIVE,
  CD_ILLUSTRATIVE_PARAMS,
  CD_NOTIONAL_USD,
  CD_STATIC_RHO,
} from "./illustrative/cdIllustrative";

// ---------------------------------------------------------------------------
// Types and defaults
// ---------------------------------------------------------------------------

/** SHORT/MEDIUM/LONG cell label (used for both TTM cells and term buckets). */
export type CdSml = "SHORT" | "MEDIUM" | "LONG";

/** All-in discount curve: SOFR zeros + static TLP spread on a common grid. */
export interface CdCurve {
  t: readonly number[];
  z: readonly number[];
  tlpSpread: readonly number[];
}

/** Withdrawal-hazard coefficients (H7: one monotone S-curve, 4 parameters). */
export interface CdHazardParams {
  /** Logistic intercept (the parameter set's `const`). */
  intercept: number;
  /** Moneyness slope, per unit decimal m. */
  b1Moneyness: number;
  /** Shift per standardized log months-to-maturity. */
  bLogTtmStd: number;
  /** Shift per standardized log balance (dollars). */
  bLogBalStd: number;
  /** Persisted standardization constants (never re-derived). */
  lnTtmMean: number;
  lnTtmStd: number;
  lnBalMean: number;
  lnBalStd: number;
  /** Moneyness domain the parameter set was specified on; values beyond are disclosed extrapolation (no clip). */
  fittedMoneynessDomainLo: number;
  fittedMoneynessDomainHi: number;
  /** Logit-argument clip, shared by all three logistics (hazard_lib: +/-35). */
  logitClip: number;
}

/** Renewal-logistic coefficients (original-term-bucket intercepts). */
export interface CdRenewalParams {
  segShort: number;
  segMedium: number;
  segLong: number;
  gammaMoneyness: number;
  delta24m: number;
}

/** Severity part-1 (full-vs-partial) coefficients; LONG falls back to tbShort. */
export interface CdSeverityPart1Params {
  tbShort: number;
  tbMedium: number;
  moneyness: number;
  logBalanceStd: number;
}

/** The tweakable model parameter set (defaults live in CD_DEFAULT_PARAMS). */
export interface CdModelParams {
  hazard: CdHazardParams;
  renewal: CdRenewalParams;
  severityPart1: CdSeverityPart1Params;
  /** E[severity | partial] -- the fixed Beta-mixture mean. */
  eSevPartial: number;
  /** Forward CD offer spread over the matching-tenor all-in rate, by term. */
  offerSpreadByTerm: Readonly<Record<number, number>>;
  curve: CdCurve;
  horizonMonths: number;
  maxRenewalGenerations: number;
  /** Minimum live balance in WALK dollars; a cohort at or below it is dropped. */
  minLiveBalance: number;
  /** Notional-to-walk-dollars scale (fixtures were produced at 1e7). */
  walkScale: number;
}

/** One row of a CD book: a cohort at the as-of date (generation 0). */
export interface CdBookRow {
  termMonths: number;
  monthsToMaturity: number;
  balance: number;
  contractRate: number;
}

/** Standard IRRBB shock grid in basis points. */
export const CD_SHOCKS_BP: readonly number[] = [-200, -100, 0, 100, 200];

/** Static-renewal comparator default rho (illustrative, spec v2 Section 3.3). */
export const CD_STATIC_RHO_DEFAULT = CD_STATIC_RHO;

/** Regulatory runoff-ladder bucket labels (edges 1/3/6/12/24/60/horizon). */
export const CD_LADDER_LABELS: readonly string[] = [
  "0-1m",
  "1-3m",
  "3-6m",
  "6-12m",
  "12-24m",
  "24-60m",
  "60m+",
];

/** Original-term bucket map (hazard_lib TERM_BUCKET_MAP; structural). */
const TERM_BUCKET_MAP: Readonly<Record<number, CdSml>> = {
  1: "SHORT",
  2: "SHORT",
  3: "SHORT",
  6: "SHORT",
  9: "SHORT",
  12: "SHORT",
  18: "MEDIUM",
  24: "MEDIUM",
  36: "LONG",
  48: "LONG",
  60: "LONG",
};

/**
 * The shape of an export bundle this module can build a CdModelParams from.
 * Structural on purpose: a caller passes a bundle here explicitly, and this module
 * imports none.
 */
export interface CdExportBundle {
  params: {
    hazard: {
      const: number;
      b1Moneyness: number;
      bLogTtmStd: number;
      bLogBalStd: number;
      standardization: { lnTtmMean: number; lnTtmStd: number; lnBalMean: number; lnBalStd: number };
      fittedMoneynessDomain: { lo: number; hi: number };
      logitClip: number;
    };
    renewal: { segShort: number; segMedium: number; segLong: number; gammaMoneyness: number; delta24m: number };
    severityPart1: { tbShort: number; tbMedium: number; moneyness: number; logBalanceStd: number };
    eSevPartial: number;
    walk: { horizonMonths: number; maxRenewalGenerations: number; minLiveBalanceDollars: number; stylizedWalkScale: number };
  };
  offerSpreadByTerm: Readonly<Record<string, number>>;
  curve: { t: readonly number[]; z: readonly number[]; tlpSpread: readonly number[] };
}

/** Build a CdModelParams from an export bundle (fidelity-test path). */
export function buildCdParamsFrom(bundle: CdExportBundle): CdModelParams {
  const p = bundle.params;
  const offerSpreadByTerm: Record<number, number> = {};
  for (const [k, v] of Object.entries(bundle.offerSpreadByTerm)) {
    offerSpreadByTerm[Number(k)] = v;
  }
  return {
    hazard: {
      intercept: p.hazard.const,
      b1Moneyness: p.hazard.b1Moneyness,
      bLogTtmStd: p.hazard.bLogTtmStd,
      bLogBalStd: p.hazard.bLogBalStd,
      lnTtmMean: p.hazard.standardization.lnTtmMean,
      lnTtmStd: p.hazard.standardization.lnTtmStd,
      lnBalMean: p.hazard.standardization.lnBalMean,
      lnBalStd: p.hazard.standardization.lnBalStd,
      fittedMoneynessDomainLo: p.hazard.fittedMoneynessDomain.lo,
      fittedMoneynessDomainHi: p.hazard.fittedMoneynessDomain.hi,
      logitClip: p.hazard.logitClip,
    },
    renewal: {
      segShort: p.renewal.segShort,
      segMedium: p.renewal.segMedium,
      segLong: p.renewal.segLong,
      gammaMoneyness: p.renewal.gammaMoneyness,
      delta24m: p.renewal.delta24m,
    },
    severityPart1: {
      tbShort: p.severityPart1.tbShort,
      tbMedium: p.severityPart1.tbMedium,
      moneyness: p.severityPart1.moneyness,
      logBalanceStd: p.severityPart1.logBalanceStd,
    },
    eSevPartial: p.eSevPartial,
    offerSpreadByTerm,
    curve: { t: bundle.curve.t, z: bundle.curve.z, tlpSpread: bundle.curve.tlpSpread },
    horizonMonths: p.walk.horizonMonths,
    maxRenewalGenerations: p.walk.maxRenewalGenerations,
    minLiveBalance: p.walk.minLiveBalanceDollars,
    walkScale: p.walk.stylizedWalkScale,
  };
}

/**
 * Defaults: the illustrative parameter set, so a caller that omits params walks
 * it. Another set is used only by passing buildCdParamsFrom(...) explicitly.
 */
export const CD_DEFAULT_PARAMS: CdModelParams = CD_ILLUSTRATIVE_PARAMS;

// ---------------------------------------------------------------------------
// Curve: linear interpolation (np.interp semantics), continuous compounding,
// parallel shock on the SOFR leg only (the TLP spread is static).
// ---------------------------------------------------------------------------

function interp1(x: number, xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const slope = (ys[hi] - ys[lo]) / (xs[hi] - xs[lo]);
  return slope * (x - xs[lo]) + ys[lo];
}

/** SOFR zero rate at t years (linear interp, flat extrapolation). */
export function sofrZero(tYears: number, params: CdModelParams = CD_DEFAULT_PARAMS): number {
  return interp1(tYears, params.curve.t, params.curve.z);
}

/** Static TLP spread at t years (linear interp, flat extrapolation). */
export function tlpSpreadAt(tYears: number, params: CdModelParams = CD_DEFAULT_PARAMS): number {
  return interp1(tYears, params.curve.t, params.curve.tlpSpread);
}

/** Market-rate leg of moneyness: SOFR + TLP + shock at the given tenor. */
export function parMarketRate(
  tYears: number,
  shockBp: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  return sofrZero(tYears, params) + tlpSpreadAt(tYears, params) + shockBp / 10000;
}

/** All-in discount factor, continuous compounding, shocked SOFR leg. */
export function discountFactor(
  tYears: number,
  shockBp: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  const z = sofrZero(tYears, params) + tlpSpreadAt(tYears, params) + shockBp / 10000;
  return Math.exp(-z * tYears);
}

/**
 * Scenario forward CD offer rate: shocked matching-tenor all-in rate + that
 * term's offer spread (thin terms carry the pooled SHORT-terms average,
 * already folded into offerSpreadByTerm by the export).
 */
export function forwardCdOfferRate(
  termMonths: number,
  shockBp: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  const spread = params.offerSpreadByTerm[termMonths];
  if (spread === undefined) throw new Error(`no CD offer spread for term ${termMonths}m`);
  return parMarketRate(termMonths / 12, shockBp, params) + spread;
}

// ---------------------------------------------------------------------------
// Evaluators (single evaluation path, mirroring the Python reference)
// ---------------------------------------------------------------------------

/** Original-term bucket (renewal/severity intercepts; NOT the hazard cell). */
export function termBucketOf(termMonths: number): CdSml {
  const b = TERM_BUCKET_MAP[termMonths];
  if (b === undefined) throw new Error(`no term bucket for original term ${termMonths}m`);
  return b;
}

function clippedExpit(z: number, clip: number): number {
  const zc = Math.min(clip, Math.max(-clip, z));
  return 1 / (1 + Math.exp(-zc));
}

/**
 * H7 withdrawal hazard, the byte-level analogue of hazard_lib.predict_hazard:
 * one monotone logistic S-curve in moneyness shifted by standardized log-TTM
 * and log-balance. Every hazard evaluation in this module routes through here.
 *
 *   m           moneyness (market all-in rate at the remaining-term tenor minus
 *               contract rate, decimal; positive = depositor earning below market)
 *   ttmMonths   remaining whole months to contractual maturity (floored at 1)
 *   balance     balance at risk entering the month, in DOLLARS (floored at 1
 *               before the log; the walk carries this in walk dollars)
 *
 * Both covariates are standardized against the PERSISTED standardization
 * constants (never re-derived from a live batch -- the A18 bug class). No input
 * clip: the form is monotone in moneyness by construction, and values beyond
 * the parameter set's moneyness domain are disclosed functional-form extrapolation.
 */
export function hazardCore(
  m: number,
  ttmMonths: number,
  balance: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  const hz = params.hazard;
  const lnTtmStd = (Math.log(Math.max(1, ttmMonths)) - hz.lnTtmMean) / hz.lnTtmStd;
  const lnBalStd = (Math.log(Math.max(1, balance)) - hz.lnBalMean) / hz.lnBalStd;
  const z = hz.intercept + hz.b1Moneyness * m + hz.bLogTtmStd * lnTtmStd + hz.bLogBalStd * lnBalStd;
  return clippedExpit(z, hz.logitClip);
}

/**
 * Monthly withdrawal hazard from raw inputs (H7). Alias of hazardCore, kept as
 * the public raw-input name; under H7 there is no SML-cell derivation step, so
 * the two are identical.
 */
export function withdrawalHazard(
  m: number,
  ttmMonths: number,
  balance: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  return hazardCore(m, ttmMonths, balance, params);
}

/**
 * Renewal probability at a cohort's own maturity month. mRen = forward CD
 * offer rate for the same term minus the EXPIRING contract rate (decimal).
 */
export function renewalProb(
  mRen: number,
  termMonths: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  const rn = params.renewal;
  const bucket = termBucketOf(termMonths);
  const seg = bucket === "SHORT" ? rn.segShort : bucket === "MEDIUM" ? rn.segMedium : rn.segLong;
  const z = seg + rn.gammaMoneyness * mRen + rn.delta24m * (termMonths === 24 ? 1 : 0);
  return clippedExpit(z, params.hazard.logitClip);
}

/**
 * Severity part 1: P(full closure | withdrawal event). Takes the raw
 * (unclipped) moneyness, the LIVE-standardized log-balance covariate, and the
 * ORIGINAL term in months (LONG buckets fall back to the tbShort intercept).
 */
export function pFull(
  m: number,
  logBalStd: number,
  termMonths: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  const sv = params.severityPart1;
  const tb = termBucketOf(termMonths) === "MEDIUM" ? sv.tbMedium : sv.tbShort;
  const z = tb + sv.moneyness * m + sv.logBalanceStd * logBalStd;
  return clippedExpit(z, params.hazard.logitClip);
}

/**
 * pi = h * (pFull*1.0 + (1 - pFull)*eSevPartial) -- the expected fraction of
 * cohort balance withdrawn this month, combining the incidence hazard with
 * the two-part severity model (hazard_lib.expected_monthly_withdrawal_fraction).
 */
export function expectedWithdrawalFraction(
  hazard: number,
  pFullVal: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  // min(pi, 1): the Python reference's cap, inert at the default parameters
  // (pi <= h <= 1 structurally when eSevPartial <= 1) but kept so a tweaked
  // eSevPartial > 1 cannot withdraw more than a cohort's full balance.
  return Math.min(
    1,
    hazard * (pFullVal * 1.0 + (1 - pFullVal) * params.eSevPartial),
  );
}

// ---------------------------------------------------------------------------
// The cohort walk (22_irrbb_eve.run_cohort_walk / 23_liquidity_gap.run_liquidity_walk
// share identical balance dynamics; renewals ON/OFF is the only switch)
// ---------------------------------------------------------------------------

/** Aggregated cashflows for one walk month, in NOTIONAL (per-book) units. */
export interface CdWalkMonthRecord {
  month: number;
  tYears: number;
  /** Hazard-driven principal outflow (early withdrawal), off-maturity cohorts. */
  earlyWithdrawal: number;
  /** Maturity-month principal: full par exit (run-off) or non-renewal (renewals ON). */
  maturityOutflow: number;
  /** Coupon accrued on the PRE-withdrawal balance, all live cohorts. */
  coupon: number;
  /** Total live balance after this month's decrements, renewals and $1 floor. */
  survivingBalance: number;
}

export interface CdWalkResult {
  records: CdWalkMonthRecord[];
  /** Balance still live when the walk ends (per-notional units). */
  residualBalance: number;
  /** PV time for the residual stub: horizonMonths / 12, always. */
  residualTYears: number;
  finalMonth: number;
}

export interface CdWalkOptions {
  /** false = run-off (EVE headline); true = renewal chain (going-concern / liquidity). */
  renewals: boolean;
  /**
   * Per-walk-month parallel shock path in bp (index 0 = walk month 1). When
   * present it replaces the scalar shockBp for the BEHAVIORAL legs -- the
   * hazard moneyness and the renewal offer rate reprice off the shocked curve
   * month by month; this is the seam the stochastic comparison bands drive
   * (mirroring competingRisks.mktRatePath). Discounting is NOT read here:
   * pvOfWalk keeps its own scalar shock, exactly as the fans keep flat
   * discounting on the mortgage side. Must cover the full walk horizon
   * (length >= horizonMonths); a flat path equal to shockBp reproduces the
   * scalar walk bit-for-bit.
   */
  shockBpPath?: readonly number[];
}

interface Cohort {
  generation: number;
  balance: number; // walk dollars
  contractRate: number;
  termMonths: number;
  monthsToMaturity: number;
  monthBorn: number;
}

/**
 * Walk the book month by month under a parallel shock. The book arrives in
 * notional units; internally balances run at balance * walkScale so the $1
 * constants keep their dollar meaning, and the returned records are
 * divided back to notional units.
 */
export function runCohortWalk(
  book: readonly CdBookRow[],
  shockBp: number,
  opts: CdWalkOptions,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): CdWalkResult {
  const { renewals, shockBpPath } = opts;
  if (shockBpPath !== undefined && shockBpPath.length < params.horizonMonths) {
    throw new Error(
      "config conflict: shockBpPath must cover the full walk horizon " +
        `(length >= ${params.horizonMonths} months), got length ${shockBpPath.length}; ` +
        "a shorter path would silently produce NaN moneyness past its end",
    );
  }
  const scale = params.walkScale;
  let cohorts: Cohort[] = book.map((r) => ({
    generation: 0,
    balance: r.balance * scale,
    contractRate: r.contractRate,
    termMonths: r.termMonths,
    monthsToMaturity: r.monthsToMaturity,
    monthBorn: 0,
  }));

  const records: CdWalkMonthRecord[] = [];
  let month = 0;
  while (cohorts.length > 0 && month < params.horizonMonths) {
    month += 1;
    const tYears = month / 12;
    const n = cohorts.length;
    // Behavioral-leg shock this month: the path seam when present, else scalar.
    const sBp = shockBpPath !== undefined ? shockBpPath[month - 1] : shockBp;

    // remaining months from each cohort-generation's OWN birth month
    const remaining: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = cohorts[i];
      remaining[i] = Math.max(1, c.monthsToMaturity - (month - 1 - c.monthBorn));
    }

    // hazard decrement -- cohorts NOT at their maturity month only, with the
    // live log-balance standardization over this month's off-maturity
    // cross-section (population std, $1 clip, fallback 1.0 when degenerate)
    const withdrawal: number[] = new Array(n).fill(0);
    const namIdx: number[] = [];
    for (let i = 0; i < n; i++) if (remaining[i] > 1) namIdx.push(i);
    if (namIdx.length > 0) {
      const logBal = namIdx.map((i) => Math.log(Math.max(cohorts[i].balance, 1)));
      let mean = 0;
      for (const v of logBal) mean += v;
      mean /= logBal.length;
      let varSum = 0;
      for (const v of logBal) varSum += (v - mean) * (v - mean);
      const sd = Math.sqrt(varSum / logBal.length);
      const denom = logBal.length > 1 && sd > 0 ? sd : 1.0;
      for (let j = 0; j < namIdx.length; j++) {
        const i = namIdx[j];
        const c = cohorts[i];
        const m = parMarketRate(remaining[i] / 12, sBp, params) - c.contractRate;
        // H7 hazard: moneyness + persisted-standardized log-TTM + log balance
        // (the balance at risk entering the month, in walk dollars).
        const h = hazardCore(m, remaining[i], c.balance, params);
        const pf = pFull(m, (logBal[j] - mean) / denom, c.termMonths, params);
        withdrawal[i] = expectedWithdrawalFraction(h, pf, params) * c.balance;
      }
    }

    // coupon accrues on the PRE-withdrawal balance, all cohorts (including
    // the ones at their maturity month)
    let coupon = 0;
    for (const c of cohorts) coupon += (c.balance * c.contractRate) / 12;

    let early = 0;
    for (let i = 0; i < n; i++) {
      early += withdrawal[i];
      cohorts[i].balance -= withdrawal[i];
    }

    // maturity month: full par exit (run-off) or renewal logistic on the
    // hazard-survived balance; renewal spawns a like-for-like term at the
    // forward offer rate, generation cap and $1 spawn floor
    let maturityOutflow = 0;
    const next: Cohort[] = [];
    const spawns: Cohort[] = [];
    for (let i = 0; i < n; i++) {
      const c = cohorts[i];
      if (remaining[i] > 1) {
        next.push(c);
        continue;
      }
      if (!renewals) {
        maturityOutflow += c.balance;
        continue;
      }
      const offer = forwardCdOfferRate(c.termMonths, sBp, params);
      const rho = renewalProb(offer - c.contractRate, c.termMonths, params);
      maturityOutflow += (1 - rho) * c.balance;
      const spawned = rho * c.balance;
      if (spawned > params.minLiveBalance && c.generation + 1 <= params.maxRenewalGenerations) {
        spawns.push({
          generation: c.generation + 1,
          balance: spawned,
          contractRate: offer,
          termMonths: c.termMonths,
          monthsToMaturity: c.termMonths,
          monthBorn: month,
        });
      }
    }
    cohorts = next.concat(spawns).filter((c) => c.balance > params.minLiveBalance);

    let surviving = 0;
    for (const c of cohorts) surviving += c.balance;
    records.push({
      month,
      tYears,
      earlyWithdrawal: early / scale,
      maturityOutflow: maturityOutflow / scale,
      coupon: coupon / scale,
      survivingBalance: surviving / scale,
    });
  }

  let residual = 0;
  for (const c of cohorts) residual += c.balance;
  return {
    records,
    residualBalance: residual / scale,
    residualTYears: params.horizonMonths / 12,
    finalMonth: month,
  };
}

// ---------------------------------------------------------------------------
// PV / duration / EVE (module 1)
// ---------------------------------------------------------------------------

/** PV of a walk's cashflows + residual stub under the shocked all-in curve. */
export function pvOfWalk(
  walk: CdWalkResult,
  shockBp: number,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): number {
  let pv = 0;
  for (const r of walk.records) {
    pv += (r.earlyWithdrawal + r.maturityOutflow + r.coupon) * discountFactor(r.tYears, shockBp, params);
  }
  pv += walk.residualBalance * discountFactor(walk.residualTYears, shockBp, params);
  return pv;
}

/** Symmetric two-sided effective duration from a PV-by-shock grid. */
export function effDuration(pvByShock: Readonly<Record<number, number>>, pairBp: number): number {
  return (pvByShock[-pairBp] - pvByShock[pairBp]) / ((2 * pvByShock[0] * pairBp) / 10000);
}

export interface CdEveLeg {
  /** Liability PV per unit of book notional (per 100 for a notional-100 book). */
  pvByShock: Record<number, number>;
  effDurPm100Years: number;
  effDurPm200Years: number;
}

export interface CdRunoffEveResult extends CdEveLeg {
  /** Renewal-chain PV, diagnostic only (carries the forward rollover margin). */
  goingConcern: CdEveLeg & { renewalMarginPvBase: number };
}

/**
 * Run-off EVE headline + going-concern diagnostic over a shock grid. The
 * shock list must contain 0 and the +/-100 / +/-200 pairs for the effective
 * durations to be finite.
 */
export function runoffEve(
  book: readonly CdBookRow[],
  shocks: readonly number[] = CD_SHOCKS_BP,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): CdRunoffEveResult {
  const pvByShock: Record<number, number> = {};
  const gcPvByShock: Record<number, number> = {};
  for (const s of shocks) {
    pvByShock[s] = pvOfWalk(runCohortWalk(book, s, { renewals: false }, params), s, params);
    gcPvByShock[s] = pvOfWalk(runCohortWalk(book, s, { renewals: true }, params), s, params);
  }
  return {
    pvByShock,
    effDurPm100Years: effDuration(pvByShock, 100),
    effDurPm200Years: effDuration(pvByShock, 200),
    goingConcern: {
      pvByShock: gcPvByShock,
      effDurPm100Years: effDuration(gcPvByShock, 100),
      effDurPm200Years: effDuration(gcPvByShock, 200),
      renewalMarginPvBase: gcPvByShock[0] - pvByShock[0],
    },
  };
}

// ---------------------------------------------------------------------------
// Prepay (renewal-off) WAL and liquidity (renewal-ON) profile (module 2)
// ---------------------------------------------------------------------------

export interface CdPrepayWal {
  walMonths: number;
  /** Early-withdrawal share of total principal exits, percent. */
  earlyWithdrawalPctOfExits: number;
}

/** Renewal-off hazard-only WAL (24_wal_to_maturity semantics, base shock). */
export function prepayWal(
  book: readonly CdBookRow[],
  params: CdModelParams = CD_DEFAULT_PARAMS,
): CdPrepayWal {
  const walk = runCohortWalk(book, 0, { renewals: false }, params);
  let num = 0;
  let tot = 0;
  let early = 0;
  for (const r of walk.records) {
    const p = r.earlyWithdrawal + r.maturityOutflow;
    num += r.month * p;
    tot += p;
    early += r.earlyWithdrawal;
  }
  return { walMonths: num / tot, earlyWithdrawalPctOfExits: (early / tot) * 100 };
}

export interface CdLadderBucket {
  bucketLabel: string;
  outflow: number;
  earlyWithdrawal: number;
  nonRenewal: number;
  shareOfExitedPct: number;
}

export interface CdLiquidityProfile {
  walMonths: number;
  earlyWithdrawalPctOfExited: number;
  /** Total exited principal in notional units. */
  exited: number;
  ladder: CdLadderBucket[];
  /** Balance still live at the horizon (notional units). */
  residualTail: number;
}

function ladderBucketIndex(month: number): number {
  if (month <= 1) return 0;
  if (month <= 3) return 1;
  if (month <= 6) return 2;
  if (month <= 12) return 3;
  if (month <= 24) return 4;
  if (month <= 60) return 5;
  return 6;
}

/** Renewal-ON undiscounted WAL + regulatory 7-bucket runoff ladder. */
export function liquidityProfile(
  book: readonly CdBookRow[],
  shockBp = 0,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): CdLiquidityProfile {
  const walk = runCohortWalk(book, shockBp, { renewals: true }, params);
  const nB = CD_LADDER_LABELS.length;
  const ewByBucket: number[] = new Array(nB).fill(0);
  const nrByBucket: number[] = new Array(nB).fill(0);
  let walNum = 0;
  let exited = 0;
  let early = 0;
  for (const r of walk.records) {
    const out = r.earlyWithdrawal + r.maturityOutflow;
    walNum += r.month * out;
    exited += out;
    early += r.earlyWithdrawal;
    const b = ladderBucketIndex(r.month);
    ewByBucket[b] += r.earlyWithdrawal;
    nrByBucket[b] += r.maturityOutflow;
  }
  const ladder: CdLadderBucket[] = CD_LADDER_LABELS.map((label, i) => {
    const gross = ewByBucket[i] + nrByBucket[i];
    return {
      bucketLabel: label,
      outflow: gross,
      earlyWithdrawal: ewByBucket[i],
      nonRenewal: nrByBucket[i],
      shareOfExitedPct: (gross / exited) * 100,
    };
  });
  return {
    walMonths: walNum / exited,
    earlyWithdrawalPctOfExited: (early / exited) * 100,
    exited,
    ladder,
    residualTail: walk.residualBalance,
  };
}

// ---------------------------------------------------------------------------
// Benchmark ladder (25_benchmarks semantics)
// ---------------------------------------------------------------------------

interface Rung2Group {
  mtm: number;
  bal: number; // walk dollars
  cpn: number; // walk dollars * annual rate
}

function rung2Groups(book: readonly CdBookRow[], params: CdModelParams): Rung2Group[] {
  const map = new Map<number, Rung2Group>();
  for (const r of book) {
    const bal = r.balance * params.walkScale;
    const g = map.get(r.monthsToMaturity);
    if (g) {
      g.bal += bal;
      g.cpn += bal * r.contractRate;
    } else {
      map.set(r.monthsToMaturity, { mtm: r.monthsToMaturity, bal, cpn: bal * r.contractRate });
    }
  }
  return [...map.values()].sort((a, b) => a.mtm - b.mtm);
}

function totalWalkBalance(book: readonly CdBookRow[], params: CdModelParams): number {
  let total = 0;
  for (const r of book) total += r.balance * params.walkScale;
  return total;
}

/** (pv, earlyShare, walMonths) for a flat monthly haircut w (rung 2 walk). */
function runRung2(
  groups: readonly Rung2Group[],
  totalBalance: number,
  w: number,
  shockBp: number,
  params: CdModelParams,
): { pv: number; earlyShare: number; walMonths: number } {
  let pv = 0;
  let walNum = 0;
  let early = 0;
  for (const g of groups) {
    let b = g.bal;
    const cpnRateMonthly = g.cpn / g.bal / 12;
    for (let month = 1; month <= g.mtm; month++) {
      const d = discountFactor(month / 12, shockBp, params);
      pv += b * cpnRateMonthly * d;
      if (month < g.mtm) {
        const out = b * w;
        early += out;
        pv += out * d;
        walNum += out * month;
        b -= out;
      } else {
        pv += b * d;
        walNum += b * month;
      }
    }
  }
  return { pv, earlyShare: early / totalBalance, walMonths: walNum / totalBalance };
}

/** Bisect the flat haircut w so the rung-2 early-exit share hits the target. */
function solveRung2W(
  groups: readonly Rung2Group[],
  totalBalance: number,
  targetEarlyShare: number,
  params: CdModelParams,
): number {
  let lo = 0.0;
  let hi = 0.2;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    const { earlyShare } = runRung2(groups, totalBalance, mid, 0, params);
    if (earlyShare < targetEarlyShare) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The rung-2 constant monthly haircut, level-matched so the total early-exit
 * share equals the full (rung-4) model's own early-exit share on this
 * book -- level-matching, target = prepay early pct / 100.
 */
export function rung2LevelMatchedW(
  book: readonly CdBookRow[],
  params: CdModelParams = CD_DEFAULT_PARAMS,
  targetEarlyShare?: number,
): number {
  const target = targetEarlyShare ?? prepayWal(book, params).earlyWithdrawalPctOfExits / 100;
  return solveRung2W(rung2Groups(book, params), totalWalkBalance(book, params), target, params);
}

export interface CdRung1Result {
  walMonths: number;
  pvByShock: Record<number, number>;
  effDurPm100Years: number;
  effDurPm200Years: number;
}

/** Rung 1: contractual only -- hold every balance to its stated maturity. */
export function rung1Contractual(
  book: readonly CdBookRow[],
  shocks: readonly number[] = CD_SHOCKS_BP,
  params: CdModelParams = CD_DEFAULT_PARAMS,
): CdRung1Result {
  const scale = params.walkScale;
  let total = 0;
  let walNum = 0;
  for (const r of book) {
    total += r.balance * scale;
    walNum += r.balance * scale * r.monthsToMaturity;
  }
  const uniq = [...new Set(book.map((r) => r.monthsToMaturity))].sort((a, b) => a - b);
  const pvByShock: Record<number, number> = {};
  for (const s of shocks) {
    let pv = 0;
    for (const m of uniq) {
      let cpn = 0;
      let bal = 0;
      for (const r of book) {
        if (r.monthsToMaturity !== m) continue;
        cpn += (r.balance * scale * r.contractRate) / 12;
        bal += r.balance * scale;
      }
      let dSum = 0;
      let dLast = 0;
      for (let month = 1; month <= m; month++) {
        dLast = discountFactor(month / 12, s, params);
        dSum += dLast;
      }
      pv += cpn * dSum;
      pv += bal * dLast;
    }
    pvByShock[s] = pv / scale;
  }
  return {
    walMonths: walNum / total,
    pvByShock,
    effDurPm100Years: effDuration(pvByShock, 100),
    effDurPm200Years: effDuration(pvByShock, 200),
  };
}

export interface CdRung2Result {
  wMonthly: number;
  levelMatchTargetEarlyShare: number;
  achievedEarlyShare: number;
  walMonths: number;
  pvByShock: Record<number, number>;
  effDurPm100Years: number;
  effDurPm200Years: number;
}

/**
 * Rung 2: constant monthly early-withdrawal haircut w, level-matched to the
 * book's own rung-4 early-exit share (or an explicit target share).
 */
export function rung2StaticHaircut(
  book: readonly CdBookRow[],
  shocks: readonly number[] = CD_SHOCKS_BP,
  params: CdModelParams = CD_DEFAULT_PARAMS,
  targetEarlyShare?: number,
): CdRung2Result {
  const target = targetEarlyShare ?? prepayWal(book, params).earlyWithdrawalPctOfExits / 100;
  const groups = rung2Groups(book, params);
  const total = totalWalkBalance(book, params);
  const w = solveRung2W(groups, total, target, params);
  const base = runRung2(groups, total, w, 0, params);
  const pvByShock: Record<number, number> = {};
  for (const s of shocks) {
    pvByShock[s] = runRung2(groups, total, w, s, params).pv / params.walkScale;
  }
  return {
    wMonthly: w,
    levelMatchTargetEarlyShare: target,
    achievedEarlyShare: base.earlyShare,
    walMonths: base.walMonths,
    pvByShock,
    effDurPm100Years: effDuration(pvByShock, 100),
    effDurPm200Years: effDuration(pvByShock, 200),
  };
}

export interface CdStaticRhoResult {
  rho: number;
  wMonthly: number;
  walMonths: number;
  resolvedShareOfBook: number;
  /** Balance still live at the horizon (notional units). */
  residual: number;
}

/**
 * Static-rho liquidity benchmark (the de-facto rung 3, liquidity side only):
 * constant book-wide renewal probability rho at every maturity event with
 * like-for-like rollover, PLUS the rung-2 constant monthly haircut w
 * off-maturity, walked over the full horizon, undiscounted WAL. w defaults
 * to the level-matched rung-2 haircut for this book.
 */
export function staticRhoBenchmark(
  book: readonly CdBookRow[],
  rho: number = CD_STATIC_RHO_DEFAULT,
  params: CdModelParams = CD_DEFAULT_PARAMS,
  wMonthly?: number,
): CdStaticRhoResult {
  const scale = params.walkScale;
  const w = wMonthly ?? rung2LevelMatchedW(book, params);
  const total = totalWalkBalance(book, params);

  // group by (mtm, term), mirroring the 25_benchmarks cohort aggregation
  interface SrhoRow {
    bal: number;
    mtm: number;
    term: number;
  }
  const map = new Map<string, SrhoRow>();
  for (const r of book) {
    const key = `${r.monthsToMaturity}|${r.termMonths}`;
    const g = map.get(key);
    if (g) g.bal += r.balance * scale;
    else map.set(key, { bal: r.balance * scale, mtm: r.monthsToMaturity, term: r.termMonths });
  }
  let coh: SrhoRow[] = [...map.values()].sort((a, b) => a.mtm - b.mtm || a.term - b.term);

  let walNum = 0;
  let exited = 0;
  for (let month = 1; month <= params.horizonMonths; month++) {
    if (coh.length === 0) break;
    for (const row of coh) {
      if (row.mtm === 1) continue;
      const outW = row.bal * w;
      walNum += outW * month;
      exited += outW;
      row.bal -= outW;
    }
    const atMat = coh.filter((row) => row.mtm === 1);
    if (atMat.length > 0) {
      const keep = coh.filter((row) => row.mtm !== 1);
      const renewed: SrhoRow[] = [];
      for (const row of atMat) {
        const outM = row.bal * (1 - rho);
        walNum += outM * month;
        exited += outM;
        // mtm set to term + 1 here, decremented to term just below
        renewed.push({ bal: row.bal * rho, mtm: row.term + 1, term: row.term });
      }
      coh = keep.concat(renewed);
    }
    for (const row of coh) row.mtm -= 1;
    coh = coh.filter((row) => row.bal > params.minLiveBalance);
  }
  let residual = 0;
  for (const row of coh) residual += row.bal;
  return {
    rho,
    wMonthly: w,
    walMonths: walNum / total,
    resolvedShareOfBook: exited / total,
    residual: residual / scale,
  };
}

// ---------------------------------------------------------------------------
// Stochastic comparison bands (wave 3): per-path renewal-off WAL and effective
// duration through the shockBpPath seam
// ---------------------------------------------------------------------------

/** A P5/mean/P95 band of a per-path scalar statistic. */
export interface CdBand {
  mean: number;
  p5: number;
  p95: number;
}

/** Linear-interpolated percentile of an ascending-sorted array (fan convention). */
function cdPercentile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const rest = pos - lo;
  return sorted[lo + 1] !== undefined ? sorted[lo] + rest * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

function cdBandOf(values: Float64Array): CdBand {
  const n = values.length;
  if (n === 1) return { mean: values[0], p5: values[0], p95: values[0] };
  const sorted = Array.from(values).sort((a, b) => a - b);
  return {
    mean: sorted.reduce((s, v) => s + v, 0) / n,
    p5: cdPercentile(sorted, 0.05),
    p95: cdPercentile(sorted, 0.95),
  };
}

/** WAL in months of a renewal-off walk's principal exits (prepayWal semantics). */
function walMonthsOfWalk(walk: CdWalkResult): number {
  let num = 0;
  let tot = 0;
  for (const r of walk.records) {
    const p = r.earlyWithdrawal + r.maturityOutflow;
    num += r.month * p;
    tot += p;
  }
  return num / tot;
}

export interface CdPathBands {
  /** Renewal-off (IRRBB run-off) WAL band across paths, months. */
  walMonths: CdBand;
  /** Renewal-off liability effective-duration band across paths, years. */
  effDurYears: CdBand;
  nPaths: number;
}

/**
 * Run the renewal-off walk once per shock path and band the per-path WAL and
 * effective duration -- the object the comparison grid's stochastic CD cells
 * render. Per path the effective duration mirrors the deterministic ±pairBp
 * frame path-wise: the whole behavioral shock path AND the discount shock move
 * together, effDur_p = (PV(path - pair) - PV(path + pair)) / (2 · PV(path) ·
 * pair/1e4). A single flat-zero path reproduces the deterministic prepay WAL
 * and the runoffEve ±pairBp effective duration bit-for-bit (parity test).
 * No pin gate applies to these bands.
 */
export function runCdPathBands(
  book: readonly CdBookRow[],
  shockPathsBp: ReadonlyArray<readonly number[]>,
  params: CdModelParams = CD_DEFAULT_PARAMS,
  pairBp = 100,
): CdPathBands {
  const nPaths = shockPathsBp.length;
  if (nPaths === 0) throw new Error("runCdPathBands: shockPathsBp must be non-empty");
  const wal = new Float64Array(nPaths);
  const eff = new Float64Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const base = shockPathsBp[p];
    const dn = new Array<number>(base.length);
    const up = new Array<number>(base.length);
    for (let t = 0; t < base.length; t++) {
      dn[t] = base[t] - pairBp;
      up[t] = base[t] + pairBp;
    }
    const walkBase = runCohortWalk(book, 0, { renewals: false, shockBpPath: base }, params);
    wal[p] = walMonthsOfWalk(walkBase);
    const pv0 = pvOfWalk(walkBase, 0, params);
    const pvDn = pvOfWalk(runCohortWalk(book, 0, { renewals: false, shockBpPath: dn }, params), -pairBp, params);
    const pvUp = pvOfWalk(runCohortWalk(book, 0, { renewals: false, shockBpPath: up }, params), pairBp, params);
    eff[p] = (pvDn - pvUp) / ((2 * pv0 * pairBp) / 10000);
  }
  return { walMonths: cdBandOf(wal), effDurYears: cdBandOf(eff), nPaths };
}

/* ------------------------------------------------------------------ */
/* Lab integration: instrument terms + gap-analytics cashflow adapter  */
/* ------------------------------------------------------------------ */

/**
 * Instrument-library terms for the CD book. The model parameters stay on the
 * CD tab (tab-local, reset to illustrative); the shared slot carries only the
 * dollar scale the stylized 100-unit book maps to, so the gap tabs and the
 * CD tab agree on book size.
 */
export interface CdBookTerms {
  label?: string;
  /** Dollar notional the stylized book is scaled to. */
  notional: number;
}

export const CD_BOOK_TERMS_DEFAULTS: CdBookTerms = {
  label: "CD Book",
  // The specification's illustrative book size (Section 3.3, `notional`). The
  // CD tab prints this figure in its cohort walk, so the shared slot the gap
  // tabs read has to be the same number.
  notional: CD_NOTIONAL_USD,
};

/**
 * Cashflow rows for the gap analytics, shaped like math/instruments Cashflow
 * (structural match, so no cross-layer type import). Runs the cohort walk at
 * zero shock on the stylized book scaled to `notional`:
 *   balance       start-of-month surviving book,
 *   principalPaid early withdrawal + maturity outflow that month,
 *   interestPaid  coupon accrued that month,
 *   couponRate    implied average coupon on the opening balance (decimal pa).
 * renewals=false is the run-off view (repricing gap: every dollar reprices at
 * its contractual exit); renewals=true is the funding view (liquidity gap).
 */
export function cdCashflows(
  notional: number,
  opts: CdWalkOptions,
  params: CdModelParams = CD_DEFAULT_PARAMS,
  book: readonly CdBookRow[] = CD_BOOK_ILLUSTRATIVE,
): Array<{
  monthOffset: number;
  balance: number;
  principalPaid: number;
  interestPaid: number;
  couponRate: number;
}> {
  let bookTotal = 0;
  for (const r of book) bookTotal += r.balance;
  const unitScale = bookTotal > 0 ? notional / bookTotal : 0;
  const walk = runCohortWalk(book, 0, opts, params);
  const rows: Array<{
    monthOffset: number;
    balance: number;
    principalPaid: number;
    interestPaid: number;
    couponRate: number;
  }> = [];
  let opening = bookTotal;
  for (const rec of walk.records) {
    const principal = rec.earlyWithdrawal + rec.maturityOutflow;
    rows.push({
      monthOffset: rec.month,
      balance: opening * unitScale,
      principalPaid: principal * unitScale,
      interestPaid: rec.coupon * unitScale,
      couponRate: opening > 0 ? (rec.coupon * 12) / opening : 0,
    });
    opening = rec.survivingBalance;
  }
  return rows;
}
