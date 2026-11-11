/**
 * MMA two-sleeve decay and beta: the illustrative parameter set.
 *
 * VALUES: the illustrative deposit parameterization, version 3,
 * Section 3.2 (slider table plus the "non-slider structure, by rule" list),
 * with the functional form and the two branch choices (bTail "stabilize", the
 * STATIC spread basis) in Section 2.2. Nothing here is fitted, transformed, or
 * tuned against any bank's deposit data.
 *
 * ROUND-NUMBER RULE. Every value is a hand-set round number, at most two
 * significant figures, tied to a public convention, a published paper, a
 * regulatory cap, or a stated absence of anchor. Two readings are DERIVED by
 * rule rather than picked: the base switching spread and the two sleeve
 * deposit rates come from the repricing surface at the snapshot rate, so the
 * closure-incentive slope and the base spread are never set from different
 * sources (Section 2.2). A value change is a new version of the spec
 * (Section 6, "Versioning"), never a silent edit here; the pinning test beside
 * this module fails on any drift.
 */

import type { MmaRunnerCalib } from "../mmaGranularPaths";
import type { MmaGranularData, MmaGranularParams } from "../mmaTwoSleeve";
import {
  ILLUSTRATIVE_SNAPSHOT,
  REPRICING_ILLUSTRATIVE_PARAMS,
  REPRICING_LN_B_REF,
  illustrativeEquilibriumRate,
} from "./repricingIllustrative";

/** The spec version these constants transcribe. */
export const MMA_ILLUSTRATIVE_SPEC = "illustrative-deposit-parameterization v3 (2026-09-08)";

/** Sleeve reference balances in dollars: the core sleeve sits at z = 0. */
export const MMA_CORE_BALANCE_USD = 100_000;
export const MMA_CONC_BALANCE_USD = 5_000_000;

/** Sleeve deposit rates: the surface equilibria at the snapshot rate (percent). */
export const MMA_CORE_DEPOSIT_RATE = illustrativeEquilibriumRate(MMA_CORE_BALANCE_USD);
export const MMA_CONC_DEPOSIT_RATE = illustrativeEquilibriumRate(MMA_CONC_BALANCE_USD);

/**
 * Base switching spread, by rule: the snapshot rate less the core sleeve's
 * equilibrium deposit rate, about 1.8 percent. Defined this way so it is
 * consistent with the surface by construction.
 */
export const MMA_BASE_SPREAD = ILLUSTRATIVE_SNAPSHOT.threeMonthPct - MMA_CORE_DEPOSIT_RATE;

/**
 * The slider-backed granular-sleeve parameters (Section 3.2).
 *
 * betaC  closure incentive per percent of spread deviation, sized to
 *        Drechsler, Savov and Schnabl (2017)
 * betaB  balance slope per percent per month, noise level
 * baseSp derived above
 * tail   terminal monthly closure hazard, equal to the flat seasoned hazard
 * bTail  "stabilize", the base case; "decline" is the downside toggle
 */
export const MMA_ILLUSTRATIVE_PARAMS: MmaGranularParams = {
  betaC: 0.3,
  betaB: -0.002,
  baseSp: MMA_BASE_SPREAD,
  tail: 0.02,
  bTail: "stabilize",
};

/** Core proportion cap, BCBS (2016) IRRBB retail non-transactional deposits. */
export const MMA_STABLE_SHARE = 0.7;

/** Age-hazard ramp endpoints: 3.0 percent monthly at age 1, 2.0 at age 36. */
export const MMA_HZ_AGE1 = 0.03;
export const MMA_HZ_AGE36 = 0.02;
/** Age at which the ramp flattens (months). */
export const MMA_HZ_RAMP_END_AGE = 36;

/**
 * Monthly closure hazard at a given account age in months: 3.0 percent at age
 * one, falling linearly to 2.0 percent at age 36, flat thereafter (about 21
 * percent annual attrition, above DDA's 20, consistent with the BCBS ordering
 * of non-transactional below transactional stability).
 */
export function mmaHazardAtAge(ageMonths: number): number {
  if (ageMonths <= 1) return MMA_HZ_AGE1;
  if (ageMonths >= MMA_HZ_RAMP_END_AGE) return MMA_HZ_AGE36;
  const slope = (MMA_HZ_AGE36 - MMA_HZ_AGE1) / (MMA_HZ_RAMP_END_AGE - 1);
  return MMA_HZ_AGE1 + slope * (ageMonths - 1);
}

/**
 * Vector length: the oldest snapshot cohort (180 months) plus the 240-month
 * horizon, with headroom, so the age-index guard never bites.
 */
export const MMA_HZ_LENGTH = 480;

/** Element j is the hazard of the month carrying an account from age j to j+1. */
export function mmaHazardRamp(length: number): number[] {
  const out = new Array<number>(length);
  for (let j = 0; j < length; j++) out[j] = mmaHazardAtAge(j + 1);
  return out;
}

/** Snapshot age mix: the same six cohorts as DDA. */
export const MMA_AGES0: readonly number[] = [6, 18, 36, 72, 120, 180];
export const MMA_W0: readonly number[] = [0.1, 0.15, 0.2, 0.25, 0.2, 0.1];

/** Surviving-balance window in months (B(h) is specified out to month 42). */
export const MMA_B_WINDOW_MONTHS = 42;
/** B(0), the peak at month 18, and the monthly decline after it. */
export const MMA_B_START = 1.0;
export const MMA_B_PEAK = 1.1;
export const MMA_B_PEAK_MONTH = 18;
export const MMA_B_LATE_SLOPE = -0.002;

/**
 * Surviving-balance factor B(h): survivors regrow linearly from 1.00 at month
 * zero to 1.10 at month 18, then decline 0.002 per month to month 42.
 */
export function mmaBalanceFactor(h: number): number {
  if (h <= MMA_B_PEAK_MONTH) {
    return MMA_B_START + ((MMA_B_PEAK - MMA_B_START) / MMA_B_PEAK_MONTH) * h;
  }
  return MMA_B_PEAK + MMA_B_LATE_SLOPE * (h - MMA_B_PEAK_MONTH);
}

/** B(h) for h = 0..42, the window the tail extension continues from. */
export const MMA_B_EMP: readonly number[] = Array.from(
  { length: MMA_B_WINDOW_MONTHS + 1 },
  (_, h) => mmaBalanceFactor(h),
);

/** Late drift used by the "decline" tail, per month, by the construction above. */
export const MMA_LATE = MMA_B_LATE_SLOPE;

/** Decline-tail floor on the balance factor. */
export const MMA_B_DECLINE_FLOOR = 0.5;

/** The granular-sleeve structural data, built by the rules above. */
export const MMA_ILLUSTRATIVE_DATA: MmaGranularData = {
  hzFull: mmaHazardRamp(MMA_HZ_LENGTH),
  ages0: MMA_AGES0,
  w0: MMA_W0,
  bEmp: MMA_B_EMP,
  late: MMA_LATE,
};

/** Sleeve dollar weights. */
export const MMA_SLEEVE_WEIGHTS = { granular: 0.7, concentration: 0.3 } as const;

/**
 * Concentration-sleeve curves by quantile label, as constant-hazard
 * exponentials. Judgment: a prudential lower-quantile curve; the default label
 * is P25, whose WAL is about 2.0 years.
 */
export const MMA_CONC_HAZARD = {
  mean: 0.02,
  P50: 0.025,
  P25: 0.04,
  P10: 0.06,
  P5: 0.08,
} as const;

/** Default concentration quantile label. */
export const MMA_CONC_DEFAULT_QUANTILE = "P25";

/** Sleeve positions on the surface's log-balance axis. */
export const MMA_Z_CORE = Math.log(MMA_CORE_BALANCE_USD) - REPRICING_LN_B_REF;
export const MMA_Z_CONC = Math.log(MMA_CONC_BALANCE_USD) - REPRICING_LN_B_REF;

/** Snapshot rate levels the sleeve exhibits run on, percent p.a. */
export const MMA_LEVELS = {
  sofr1d: ILLUSTRATIVE_SNAPSHOT.overnightPct,
  sofr3m: ILLUSTRATIVE_SNAPSHOT.threeMonthPct,
  gran: { d: MMA_CORE_DEPOSIT_RATE, lnb: Math.log(MMA_CORE_BALANCE_USD) },
  conc: { d: MMA_CONC_DEPOSIT_RATE, lnb: Math.log(MMA_CONC_BALANCE_USD) },
} as const;

/**
 * Book-level overnight weight phiBar: the concentration sleeve's dollar share,
 * so 1 - phiBar is the granular-core share the decay engine retains.
 */
export const MMA_PHIBAR = MMA_SLEEVE_WEIGHTS.concentration;

/**
 * Granular runner constants: the snapshot levels plus the illustrative
 * repricing surface, the object the path runner reads.
 */
export const MMA_RUNNER_CALIB: MmaRunnerCalib = {
  granLnb: Math.log(MMA_CORE_BALANCE_USD),
  granD: MMA_CORE_DEPOSIT_RATE,
  sofr3m: ILLUSTRATIVE_SNAPSHOT.threeMonthPct,
  surface: REPRICING_ILLUSTRATIVE_PARAMS,
};
