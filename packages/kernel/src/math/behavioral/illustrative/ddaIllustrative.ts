/**
 * DDA (non-interest-bearing) decay: the illustrative parameter set.
 *
 * VALUES: the illustrative deposit parameterization, version 3,
 * Section 3.1 (slider table plus the "non-slider structure, by rule" list),
 * with the functional form in Section 2.1, the branch choice on rs0 in the same
 * place, and the v3 move of theta from 0.20 to 0.05 in Section 8. Nothing here
 * is fitted, transformed, or tuned against any bank's deposit data.
 *
 * ROUND-NUMBER RULE. Every value is a hand-set round number, at most two
 * significant figures, tied to a public convention, a published paper, a
 * regulatory cap, or a stated absence of anchor. A value change is a new
 * version of the spec (Section 6, "Versioning"), never a silent edit here; the
 * pinning test beside this module fails on any drift.
 */

import type { DdaChampionParams } from "../ddaChampion";

/** The spec version these constants transcribe. */
export const DDA_ILLUSTRATIVE_SPEC = "illustrative-deposit-parameterization v3 (2026-09-08)";

/**
 * The five slider-backed structural parameters (Section 3.1).
 *
 * theta     closure elasticity, per pp of up shock (ruling on the
 *           duration-sign check, spec Section 8: the book's run-off effective
 *           duration must shorten as rates rise without changing sign)
 * drift.a   drift a, per pp per month; drift.b drift b, per pp per point-month
 * collapse  gamma per pp, mu per point-month, rJump a fraction
 * rs0       0 exactly: the snapshot sits on its own 24-month average, so the
 *           base curve is the closure leg alone (branch choice, Section 2.1)
 * C0        point-months, set equal to the drift threshold a/|b|
 */
export const DDA_ILLUSTRATIVE_PARAMS: DdaChampionParams = {
  theta: 0.05,
  drift: { a: 0.002, b: -0.0002 },
  collapse: { gamma: 0.005, mu: 0.02, rJump: 0.2 },
  rs0: 0.0,
  C0: 10,
};

/** Core proportion cap, BCBS (2016) IRRBB retail transactional deposits. */
export const DDA_F_STABLE = 0.9;

/** Age-hazard ramp endpoints: 3.0 percent monthly at age 1, 1.8 at age 36. */
export const DDA_HZ_AGE1 = 0.03;
export const DDA_HZ_AGE36 = 0.018;
/** Age at which the ramp flattens (months). */
export const DDA_HZ_RAMP_END_AGE = 36;
/** Hazard clip ceiling for the shocked closure leg. */
export const DDA_HZ_MAX = 0.1;

/**
 * Monthly closure hazard at a given account age in months: 3.0 percent at age
 * one, falling linearly to 1.8 percent at age 36, flat at 1.8 thereafter
 * (about 20 percent annual attrition for a seasoned account). Ages below one
 * carry the age-one value. Seasoning shape from the vintage literature
 * (Sheehan, 2013); the level is set so the seasoned core WAL under the house
 * 240-month convention lands inside the BCBS five-year cap with a margin.
 */
export function ddaHazardAtAge(ageMonths: number): number {
  if (ageMonths <= 1) return DDA_HZ_AGE1;
  if (ageMonths >= DDA_HZ_RAMP_END_AGE) return DDA_HZ_AGE36;
  const slope = (DDA_HZ_AGE36 - DDA_HZ_AGE1) / (DDA_HZ_RAMP_END_AGE - 1);
  return DDA_HZ_AGE1 + slope * (ageMonths - 1);
}

/**
 * The hazard vector the retention composition indexes. Survival is
 * S(k) = prod_{j<k}(1 - hz(j)), so element j is the hazard of the month that
 * carries an account from age j to age j+1, that is the hazard "at age j+1".
 */
export function ddaHazardRamp(length: number): number[] {
  const out = new Array<number>(length);
  for (let j = 0; j < length; j++) out[j] = ddaHazardAtAge(j + 1);
  return out;
}

/**
 * Vector length: the oldest snapshot cohort (180 months) plus the 240-month
 * horizon, with headroom, so the age-index guard never bites.
 */
export const DDA_HZ_LENGTH = 480;

/** The illustrative age-hazard ramp, built by the rule above. */
export const DDA_HZ_FULL: readonly number[] = ddaHazardRamp(DDA_HZ_LENGTH);

/** Snapshot age mix: six cohorts, a seasoned stock with a young tail. */
export const DDA_W0_AGES: readonly number[] = [6, 18, 36, 72, 120, 180];
export const DDA_W0_WEIGHTS: readonly number[] = [0.1, 0.15, 0.2, 0.25, 0.2, 0.1];

/** Monthly survivor-drift increment clip (judgment). */
export const DDA_DRIFT_CLIP = { lo: -0.02, hi: 0 } as const;

/** Monthly collapse-probability cap (judgment). */
export const DDA_P_MAX_COLLAPSE = 0.05;

/**
 * Concentration overlay ramp, prudential judgment: a two-million-dollar
 * account has roughly a quarter of its balance booked overnight, a
 * twenty-million-dollar account half.
 */
export const DDA_CONCENTRATION = {
  /** Logistic centre in dollars. */
  b0: 2_000_000,
  /** Steepness per log dollar. */
  kappa: 1.0,
  /** Ceiling of the overnight fraction. */
  phiMax: 0.5,
  /** Balance from which the ceiling is clamped, in dollars. */
  bFloor: 20_000_000,
} as const;

/**
 * Book bucket table the average overnight fraction is taken over. Implied
 * mean phi is about 0.17.
 */
export const DDA_BOOK_BUCKETS = {
  balances: [50_000, 500_000, 5_000_000] as readonly number[],
  shares: [0.3, 0.4, 0.3] as readonly number[],
} as const;

/**
 * Overnight fraction booked against an account balance, the concentration
 * overlay of Section 2.1: a logistic in log balance, normalised so it reaches
 * phiMax at bFloor and clamped there above it.
 */
export function ddaOvernightFraction(balanceUsd: number): number {
  const { b0, kappa, phiMax, bFloor } = DDA_CONCENTRATION;
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const scale = sigmoid(kappa * (Math.log(bFloor) - Math.log(b0)));
  const raw = (phiMax * sigmoid(kappa * (Math.log(balanceUsd) - Math.log(b0)))) / scale;
  return Math.min(phiMax, raw);
}

/** Balance-weighted mean overnight fraction over the book bucket table. */
export const DDA_MEAN_PHI = DDA_BOOK_BUCKETS.balances.reduce(
  (acc, b, i) => acc + DDA_BOOK_BUCKETS.shares[i] * ddaOvernightFraction(b),
  0,
);
