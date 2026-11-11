/**
 * CD early redemption and liquidity: the illustrative parameter set.
 *
 * VALUES: the illustrative deposit parameterization, version 3,
 * Section 3.3 (slider table plus the "non-slider structure, by rule" list),
 * with the functional form and the three branch choices (cohort-grain balance
 * covariate, LONG severity falling back to the SHORT intercept, the 24-month
 * dummy set jointly with the MEDIUM intercept) in Section 2.3. Nothing here is
 * fitted, transformed, or tuned against any bank's deposit data.
 *
 * ROUND-NUMBER RULE. Every value is a hand-set round number, at most two
 * significant figures, tied to a public convention, a published paper, a
 * regulatory cap, or a stated absence of anchor. The cohort book is DERIVED by
 * rule: contract rates are today's par all-in rate for the original term plus
 * that term's offer spread, so the base book starts at the money and moneyness
 * arises only from shocks and curve roll. A value change is a new version of
 * the spec (Section 6, "Versioning"), never a silent edit here; the pinning
 * test beside this module fails on any drift.
 *
 * The discount curve is the public Lab grid (published UST par yields), the
 * same object the rest of the Lab prices on.
 */

import { LAB_CURVE_PUBLIC } from "../defaults/labCurvePublic";
import type { CdBookRow, CdModelParams } from "../cdBook";

/** The spec version these constants transcribe. */
export const CD_ILLUSTRATIVE_SPEC = "illustrative-deposit-parameterization v3 (2026-09-08)";

/** Illustrative book size in dollars. */
export const CD_NOTIONAL_USD = 50_000_000;

/**
 * The book is carried in per-100 units, so walk dollars equal notional dollars
 * at this scale (Section 3.3, "walk scale such that walk dollars equal
 * notional dollars").
 */
export const CD_WALK_SCALE = CD_NOTIONAL_USD / 100;

/** Static renewal comparator; band marks at 0.60 / 0.75 / 0.90. */
export const CD_STATIC_RHO = 0.75;

/**
 * Forward CD offer spread over the shocked all-in matching tenor. Gilkeson,
 * Porter and Smith (2000) report retail CD yields persistently below
 * Treasuries, mean near -41 bp, the premium collected for the written
 * withdrawal put.
 */
export const CD_OFFER_SPREAD_SHORT = -0.0025;
export const CD_OFFER_SPREAD_LONG = -0.005;

export const CD_OFFER_SPREAD_BY_TERM: Readonly<Record<number, number>> = {
  1: CD_OFFER_SPREAD_SHORT,
  2: CD_OFFER_SPREAD_SHORT,
  3: CD_OFFER_SPREAD_SHORT,
  6: CD_OFFER_SPREAD_SHORT,
  9: CD_OFFER_SPREAD_SHORT,
  12: CD_OFFER_SPREAD_SHORT,
  18: CD_OFFER_SPREAD_LONG,
  24: CD_OFFER_SPREAD_LONG,
  36: CD_OFFER_SPREAD_LONG,
  48: CD_OFFER_SPREAD_LONG,
  60: CD_OFFER_SPREAD_LONG,
};

/** The full illustrative parameter set on the Lab walk's parameter shape. */
export const CD_ILLUSTRATIVE_PARAMS: CdModelParams = {
  hazard: {
    intercept: -5.5,
    b1Moneyness: 40,
    bLogTtmStd: 0.4,
    bLogBalStd: 0.2,
    // Persisted standardisation: a book centered near nine months remaining,
    // and roughly eighteen cohorts across fifty million dollars.
    lnTtmMean: 2.2,
    lnTtmStd: 0.9,
    lnBalMean: 15,
    lnBalStd: 1.0,
    // Beyond plus or minus 300 bp is disclosed extrapolation.
    fittedMoneynessDomainLo: -0.03,
    fittedMoneynessDomainHi: 0.03,
    logitClip: 15,
  },
  renewal: {
    // 80 / 75 / 70 percent base renewal by original-term bucket.
    segShort: 1.4,
    segMedium: 1.1,
    segLong: 0.85,
    gammaMoneyness: -15,
    // Set jointly with segMedium so 24-month renewal reads below 18-month.
    delta24m: -0.2,
  },
  severityPart1: {
    // 70 and 65 percent of withdrawal events are full closures; LONG falls
    // back to the SHORT intercept by construction.
    tbShort: 0.85,
    tbMedium: 0.6,
    moneyness: 10,
    logBalanceStd: -0.3,
  },
  eSevPartial: 0.4,
  offerSpreadByTerm: CD_OFFER_SPREAD_BY_TERM,
  curve: {
    t: LAB_CURVE_PUBLIC.t,
    z: LAB_CURVE_PUBLIC.z,
    tlpSpread: LAB_CURVE_PUBLIC.tlpSpread,
  },
  horizonMonths: 120,
  maxRenewalGenerations: 3,
  /** Minimum live balance in WALK dollars. */
  minLiveBalance: 1000,
  walkScale: CD_WALK_SCALE,
};

/** Cohort book: original terms and their dollar shares. */
export const CD_BOOK_TERMS: readonly number[] = [6, 12, 18, 24, 36, 60];
export const CD_BOOK_SHARES: readonly number[] = [0.15, 0.4, 0.1, 0.15, 0.1, 0.1];

/** Each term splits into three equal cohorts at these fractions of term left. */
export const CD_COHORT_FRACTIONS: readonly number[] = [0.25, 0.5, 0.75];

/** Linear interpolation with flat extrapolation, np.interp semantics. */
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
  const w = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + w * (ys[hi] - ys[lo]);
}

/** Unshocked par all-in rate (SOFR zero plus static TLP spread) at t years. */
export function cdParAllInRate(tYears: number): number {
  const c = CD_ILLUSTRATIVE_PARAMS.curve;
  return interp1(tYears, c.t, c.z) + interp1(tYears, c.t, c.tlpSpread);
}

/**
 * The illustrative cohort book, in per-100 units. Eighteen cohorts: six terms,
 * each split three ways at one quarter, one half and three quarters of the
 * term remaining, every cohort carrying the same original-term contract rate,
 * so the base book starts at the money.
 */
export const CD_BOOK_ILLUSTRATIVE: readonly CdBookRow[] = CD_BOOK_TERMS.flatMap((term, i) => {
  const contractRate = cdParAllInRate(term / 12) + CD_OFFER_SPREAD_BY_TERM[term];
  const balance = (CD_BOOK_SHARES[i] * 100) / CD_COHORT_FRACTIONS.length;
  return CD_COHORT_FRACTIONS.map((f) => ({
    termMonths: term,
    monthsToMaturity: Math.max(1, Math.round(term * f)),
    balance,
    contractRate,
  }));
});

/** Number of cohorts in the illustrative book: six terms, three cohorts each. */
export const CD_COHORT_COUNT = CD_BOOK_ILLUSTRATIVE.length;

/**
 * As-of date of the public discount grid the book prices on (published UST par
 * yields, H.15 via FRED). It is a market-data date, not a calibration date:
 * nothing here is calibrated.
 */
export const CD_CURVE_DATE = "2026-03-31";
