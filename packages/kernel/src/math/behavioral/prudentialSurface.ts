/**
 * Prudential overnight size-surface for a DDA / MMA deposit book, ported from a
 * Python reference (pure math, additive).
 *
 * One continuous form replaces the hard granular / concentration carve:
 *
 *   R_book(b, h) = (1 - phi(b)) * R_core(h) + phi(b) * R_overnight(h)
 *
 * R_core(h) is the granular core retention curve;
 * R_overnight = [1, 0, 0, ...] books full runoff by month 1 (WAL 0). phi(b) is
 * a top-pinned logistic in ln(peak balance), normalized so phi($10M) = phiMax
 * EXACTLY: accounts at/over the $10M clamp book pure overnight, and the ramp
 * below is smooth (no binary cliff). With backloaded parameters
 * (b0 ~ $9M, kappa ~ 8) the sub-$1M bulk is untouched (phi ~ 0) and only the
 * $5-10M band is materially haircut.
 *
 * At book level the composition is linear in phi, so a single balance-weighted
 * scalar phiBar (exported per book) collapses it to:
 *
 *   R_book(h) = (1 - phiBar) * R_core(h) + phiBar * R_overnight(h)
 *
 * ECONOMIC BASIS: a prudential concentration haircut, deliberately NOT a fit to
 * history (large accounts are, if anything, historically stickier). Under the
 * SR 11-7 effective challenge this single surface is the LIQUIDITY view only
 * (concentration -> overnight, a gap / LCR floor). A value view can re-anchor the
 * concentration mass to a measured stress quantile instead; that lives outside
 * this module.
 */

/** Overflow guard on the logistic argument (mirrors python _ARG_CLIP). */
const ARG_CLIP = 60;

function sigmoid(x: number): number {
  const c = Math.min(Math.max(x, -ARG_CLIP), ARG_CLIP);
  return 1 / (1 + Math.exp(-c));
}

/**
 * Top-pinned logistic prudential ramp phi in ln(peak balance). Returns a value
 * in [0, phiMax], monotone non-decreasing in the balance, with phi(sleeveFloor)
 * = phiMax EXACTLY (the overnight boundary condition) and phi clamped to phiMax
 * for balances at/above the floor. `balance` and b0/sleeveFloor are in dollars.
 */
export function phi(
  balance: number,
  b0: number,
  kappa: number,
  phiMax: number,
  sleeveFloor: number,
): number {
  const lnCap = Math.log(sleeveFloor);
  const lnb = Math.log(Math.max(balance, Number.MIN_VALUE));
  if (lnb >= lnCap) return phiMax;
  const lnb0 = Math.log(b0);
  const num = sigmoid(kappa * (lnb - lnb0));
  const den = sigmoid(kappa * (lnCap - lnb0));
  return Math.min(Math.max((phiMax * num) / den, 0), phiMax);
}

/**
 * The low-granular overnight retention leg: R[0] = 1, R[h>=1] = 0 (WAL 0).
 * Length hProj+1 to align with the core retention curves.
 */
export function overnightCurve(hProj: number): Float64Array {
  const ov = new Float64Array(hProj + 1);
  ov[0] = 1;
  return ov;
}

/**
 * Whole-book LIQUIDITY retention curve: the balance-weighted blend of the core
 * curve and the overnight leg. R_book(h) = (1 - phiBar) * R_core(h) for h >= 1,
 * and R_book(0) = (1 - phiBar) * R_core(0) + phiBar ~ 1 (R_core(0) = 1). This
 * is the concentration-overnight liquidity view; feed it to the existing
 * liability / franchise measures for its WAL, PV, and effective duration.
 */
export function bookLiquidityRetention(
  rCore: ArrayLike<number>,
  phiBar: number,
): Float64Array {
  const n = rCore.length;
  const out = new Float64Array(n);
  const w = 1 - phiBar;
  out[0] = w * rCore[0] + phiBar; // overnight leg contributes phiBar at h=0
  for (let h = 1; h < n; h++) out[h] = w * rCore[h];
  return out;
}

/**
 * Whole-book WAL under the judgment dial, on the full core basis. The
 * concentration leg is booked at a chosen WAL setting (0 = overnight, the default;
 * a granular P5 stress anchor is the alternative), and the book WAL is the
 * phi-weighted blend
 *
 *   R_book WAL = (1 - phiBar) * coreWalYears + phiBar * legWalYears.
 *
 * This is the WAL-level form of the R_book(h) composition (WAL is linear in the
 * blend).
 */
export function dialBookWal(
  coreWalYears: number,
  phiBar: number,
  legWalYears: number,
): number {
  return (1 - phiBar) * coreWalYears + phiBar * legWalYears;
}

/** Convenience: apply the liquidity blend across a per-shock retention map. */
export function bookLiquidityByShock(
  rCoreByShock: Readonly<Record<number, ArrayLike<number>>>,
  phiBar: number,
): Record<number, Float64Array> {
  const out: Record<number, Float64Array> = {};
  for (const key of Object.keys(rCoreByShock)) {
    const s = Number(key);
    out[s] = bookLiquidityRetention(rCoreByShock[s], phiBar);
  }
  return out;
}
