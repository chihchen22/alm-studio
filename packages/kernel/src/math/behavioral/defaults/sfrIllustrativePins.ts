/**
 * Committed pins for the illustrative SFR single-loan surface.
 *
 * Source: an illustrative worked example: one $1mm 30-year fixed level-pay loan
 * at the 2026-03-31 current coupon, valued on the PUBLIC market pack (shipped as
 * public/market_public.json, on the U.S. Treasury CMT convention: semi-annual par
 * bonds from 1Y out, coupon-equivalent bills) with curve-DF x 250bp-spread
 * discounting. 10Y spot par 4.3000%, current coupon 6.8000%.
 *
 * CLEAN-ROOM PROVENANCE: the prepayment parameters behind every number here
 * are the hand-specified illustrative set (round values anchored to the PSA
 * benchmark curve and the Richard and Roll (1989) model family). They are not
 * fitted to any dataset, and results computed from them are teaching exhibits,
 * not model output.
 *
 * Only the DETERMINISTIC quantities gate the live TypeScript engine: the gate in
 * `__tests__/sfrIllustrative.test.ts` reproduces a Python reference readout at
 * 2e-3 on PV percent of face, WAL years and effective-duration years. The
 * stochastic readout values are for on-screen reference only (2000 antithetic
 * paths, seed 20250930, a 10Y-tenor swaption column, a shifted-CEV BGM with
 * displacement 0.05 and CEV 0.5); the in-app HW/BGM bands are a separate,
 * ungated illustration.
 */

/** Deterministic pins, full precision. */
export const SFR_ILLUS_PINS = {
  // `basis` renders on screen in the pin card.
  basis:
    "illustrative parameterization v1; public market pack 2026-03-31, U.S. Treasury CMT " +
    "convention across the whole curve (bills coupon-equivalent, semi-annual par bonds " +
    "at 1Y+, forwards quoted BEY); current coupon = 10Y par + 250bp; " +
    "curve discounting; single $1mm 30Y loan, voluntary-only",
  /** Base PV, percent of face. */
  basePvPctFace: 99.32294981013334,
  /** Principal-resolution WAL, years. */
  baseWalYears: 10.812633641257584,
  /** Central-difference effective duration on the ±100bp legs, years. */
  effDurPm100: 6.120200435253016,
  /** Central-difference effective duration on the ±200bp legs, years. */
  effDurPm200: 4.7172789459091575,
  /** PV grid, percent of face, at the ±200/±100 legs. */
  pvPctFaceDn200: 105.66042701132166,
  pvPctFaceDn100: 104.88819848648899,
  pvPctFaceUp100: 92.73067127331716,
  pvPctFaceUp200: 86.9190646119243,
  /** WAL grid, years, at the ±200 legs. */
  walDn200: 2.4826675395622018,
  walUp200: 11.55952760128146,
  /** Balance-weighted lifetime CPR, decimal, base leg. */
  lifeCpr: 0.06083582617107164,
  /** First-year cumulative CPR, decimal, base leg. */
  firstYearCpr: 0.02132458302719431,
} as const;

/**
 * Hand-checkable S-curve reference points (fully seasoned, seasonality-neutral),
 * annual CPR percent by incentive. The +100bp point is the logistic midpoint,
 * exactly (minCpr + maxCpr) / 2 by construction.
 */
export const SFR_ILLUS_SCURVE_REF = {
  outOfMoney200Bp: 6.032613939578493,
  atTheMoney: 10.47563262125337,
  inTheMoney100Bp: 35.5,
  inTheMoney200Bp: 60.52436737874663,
} as const;

/**
 * Stochastic readout (Python reference engine; display reference ONLY, never a
 * gate on the Lab's own bands). Option cost = deterministic base PV minus the
 * stochastic fan-mean base PV, bp of face.
 */
export const SFR_ILLUS_STOCH_REFERENCE = {
  convention:
    "Python reference engine: 2000 antithetic paths, seed 20250930, 10Y-tenor ATM swaption column, " +
    "per-path reconstructed money-market DFs x 250bp spread; BGM is Rebonato LMM with the shifted-CEV " +
    "default engine (displacement 0.05, CEV 0.5).",
  // On the CMT-convention curve.
  hw: {
    pvPctFaceMean: 96.56820890771542,
    walMeanYears: 8.073101078220208,
    lifeCprMean: 0.12132332620687437,
    effDurPm100: 4.865756022184069,
    effDurPm200: 4.627851154746848,
    optionCostBp: 275.474090241791,
    optionCostSeBp: 6.614657186006401,
  },
  bgm: {
    pvPctFaceMean: 96.72196697919748,
    walMeanYears: 7.881811920517434,
    lifeCprMean: 0.12471329503526542,
    effDurPm100: 4.931709508470208,
    effDurPm200: 4.674095291695262,
    optionCostBp: 260.0982830935845,
    optionCostSeBp: 8.868053389703395,
  },
} as const;

/** Cross-language PV gate tolerance, percent of face (deliberately looser than same-language). */
export const SFR_ILLUS_PV_TOL_PCTFACE = 2e-3;
/** WAL gate tolerance, years. */
export const SFR_ILLUS_WAL_TOL_Y = 2e-3;
/** Effective-duration gate tolerance, years. */
export const SFR_ILLUS_EFFDUR_TOL_Y = 2e-3;

/**
 * The standard disclosure paragraph (spec v1 Section 5), rendered wherever the
 * illustrative numbers appear.
 */
export const SFR_ILLUS_DISCLOSURE =
  "The prepayment parameters used here are illustrative. They are round values chosen by judgment and " +
  "anchored to published conventions (the PSA and SDA benchmark curves and the Richard and Roll (1989) " +
  "model family), representative of agency-collateral behavior. They are not fitted to any dataset, and " +
  "results computed from them are teaching exhibits, not model output.";
