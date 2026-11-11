/**
 * MMA granular sleeve generalized to a live per-path SOFR3M driver, for the
 * size-blended single-account fan. Reuses mmaTwoSleeve.granularRetention's
 * existing spreadPath seam UNMODIFIED -- the only new code is converting a
 * live rate path into that spread path.
 *
 * MECHANISM (differential construction, matching sleeveCurves exactly).
 * simulateDepositRate's Nerlove recursion, held at any flat rate, drifts
 * from the observed anchor d0Gran toward the repricing surface's own
 * dTarget(rate, zGran) equilibrium -- a gap of tens of bp at the reference
 * snapshot's own rate, reflecting that the two sub-models (granular decay's
 * betaC/baseSp and the repricing surface's dTarget) were parameterized
 * independently and do not agree on the "resting" deposit rate. This drift
 * is NOT behavioral signal -- it is a shared artifact of the recursion,
 * present identically whether or not the rate is shocked. An earlier
 * version of this function used an ABSOLUTE spread (path3mPct(h) - Dg(h)),
 * which has nothing to cancel that artifact, so it leaked the full bias into
 * every result (confirmed by direct comparison against sleeveCurves).
 *
 * sleeveCurves (mmaTwoSleeve.ts, lines 302-339) avoids this by construction:
 * it computes a FIXED reference trajectory DgBase = simulateDepositRate held
 * flat at the reference snapshot's own rate, and measures the live/shocked
 * trajectory Dg only as a DIFFERENCE against that fixed reference --
 * (DgBase - Dg) -- so the shared drift artifact cancels almost entirely
 * (exactly, at zero shock, since DgBase and Dg are then the same recursion).
 * This function reproduces that same differential construction, generalized
 * from a scalar held shock to a live time-varying path:
 *
 *   DgBase[h]    = simulateDepositRate(flat at lv.sofr3m, zGran, d0Gran)[h]     (fixed, computed once)
 *   Dg_live[h]   = simulateDepositRate(path3mPct, zGran, d0Gran)[h]             (per path)
 *   dIncPath[h]  = (path3mPct[h] - lv.sofr3m) + (DgBase[h] - Dg_live[h])
 *   spreadPath[h]= params.baseSp + dIncPath[h]
 *
 * The fixed reference is anchored at the reference snapshot's own 3M rate
 * (lv.sofr3m), NOT its overnight rate (lv.sofr1d) -- path3mPct is a 3M-tenor
 * live path, so the reference it is differenced against must be tenor-
 * matched, or every live call (where level0Pct is today's actual current 3M
 * rate, essentially never exactly equal to the frozen sofr1d snapshot)
 * would carry a residual bias baked in from the tenor mismatch alone.
 *
 * This reduces to sleeveCurves's own spreadPath under its held-shock
 * convention (level0Pct = path level = lv.sofr1d + shockBp/100, held flat)
 * up to the tiny sofr1d-vs-sofr3m gap at the reference snapshot: sleeveCurves
 * itself is anchored at sofr1d (the overnight-driven function), while this runner is anchored at
 * sofr3m for tenor consistency with its own 3M-tenor path -- a deliberate,
 * disclosed divergence, not a bug.
 *
 * DISCLOSED SIMPLIFICATION: sleeveCurves drives simulateDepositRate off the
 * OVERNIGHT rate (sofr1d) for its scalar-shock construction. This runner
 * uses the SAME 3M-tenor path for both the spread's rate side and the
 * repricing driver, to avoid a second (1D-tenor) HW/BGM projection -- a
 * deliberate, minor deviation, not an oversight. The residual gap between this
 * runner and sleeveCurves is limited to the sofr1d-vs-sofr3m tenor substitution
 * at the reference snapshot (see the golden test's tolerance), not the
 * cross-model artifact.
 *
 * The concentration sleeve is NOT used at account grain -- superseded by the
 * phi(balance)/overnight blend (locked design decision: concentrated
 * balances are treated as non-structural, run off overnight, not re-anchored
 * to the empirical concentration cohort curve).
 */

import type { RepricingSurfaceParams } from "./repricingSurfaceTypes";
import {
  MMA_H_PROJ,
  granularRetention,
  presentValueIb,
  type MmaBasis,
  type MmaGranularData,
  type MmaGranularParams,
} from "./mmaTwoSleeve";
import { simulateDepositRate } from "./repricingSurface";
import { overnightCurve } from "./prudentialSurface";
import {
  type ChampionScenarioOutput,
  blendSizeCurve,
  percentileBands,
  shiftDecimalPaths,
  walBands,
  walFromRetention,
} from "./championFan";

/**
 * Constants the granular runner reads off the parameter set.
 * Lifting them to a parameter lets any basis (the public synthetic one ships)
 * drive the same runner with no code change. `granLnb`/`granD` are the granular sleeve's snapshot log-balance and
 * observed deposit rate; `sofr3m` is the reference-snapshot 3M rate the fixed
 * reference trajectory is anchored at; `surface` is the repricing beta(r, ln b)
 * parameter set the coupon leg reprices through.
 */
export interface MmaRunnerCalib {
  readonly granLnb: number;
  readonly granD: number;
  readonly sofr3m: number;
  readonly surface: RepricingSurfaceParams;
}

// `calib` is REQUIRED here so no caller silently inherits a default basis.

/**
 * Run the MMA granular model, size-blended by `phiB`, across N Monte
 * Carlo 3M-tenor rate paths (length 1 = deterministic; each path decimal-
 * annualised, length >= hProj, path[k] = level at h = k+1 -- the
 * projectHWToTenor / deterministic-forward-loop convention). `level0Pct` is
 * today's 3M level in percent (e.g. curve.forwardRate(0, 0.25) * 100),
 * needed because the raw path array has no h=0 entry.
 *
 * `spreadFn`, when supplied, overrides the inline switching-spread construction
 * with a caller-built spread path per Monte Carlo path (the decay tab's dynamic
 * repricing-basis what-if, mmaSwitchingSpread.ts). Omitting it leaves the
 * default single-z granular differential untouched and bit-identical.
 */
export function runMmaChampionOnPaths(
  paths3mDecimal: ArrayLike<ArrayLike<number>>,
  level0Pct: number,
  params: MmaGranularParams,
  data: MmaGranularData,
  phiB: number,
  hProj: number = MMA_H_PROJ,
  calib: MmaRunnerCalib,
  spreadFn?: (path3mPct: Float64Array) => Float64Array,
): ChampionScenarioOutput {
  const nPaths = paths3mDecimal.length;
  if (nPaths === 0) throw new Error("runMmaChampionOnPaths: paths3mDecimal must be non-empty");

  const H = hProj;
  const overnight = overnightCurve(H);
  const zGran = calib.granLnb - calib.surface.lnBRef;
  const d0Gran = calib.granD;
  const sofr3m = calib.sofr3m;

  // Fixed reference trajectory (sleeveCurves's DgBase, generalized): held
  // flat at the reference snapshot's own 3M rate (tenor-matched to the
  // live 3M path below), independent of the live path or shock. Computed
  // once -- shared across every path in the fan.
  const rBase = new Float64Array(H + 1).fill(sofr3m);
  // The fixed reference is only read by the inline (static) spread; a supplied
  // spreadFn builds its own reference internally, so skip it in that case.
  const DgBase = spreadFn ? null : simulateDepositRate(rBase, zGran, d0Gran, calib.surface);

  const retMat: Float64Array[] = new Array(nPaths);
  const coreMat: Float64Array[] = new Array(nPaths);

  for (let p = 0; p < nPaths; p++) {
    const path = paths3mDecimal[p];
    if (path.length < H) {
      throw new Error(`runMmaChampionOnPaths: path ${p} has length ${path.length} < hProj ${H}`);
    }
    const path3mPct = new Float64Array(H + 1);
    path3mPct[0] = level0Pct;
    for (let h = 1; h <= H; h++) path3mPct[h] = path[h - 1] * 100;

    let spreadPath: Float64Array;
    if (spreadFn) {
      spreadPath = spreadFn(path3mPct);
    } else {
      const DgLive = simulateDepositRate(path3mPct, zGran, d0Gran, calib.surface);
      spreadPath = new Float64Array(H + 1);
      for (let h = 0; h <= H; h++) {
        spreadPath[h] = params.baseSp + (path3mPct[h] - sofr3m) + (DgBase![h] - DgLive[h]);
      }
    }

    const core = granularRetention(params, data, spreadPath, H);
    coreMat[p] = core;
    retMat[p] = blendSizeCurve(core, overnight, phiB);
  }

  const coreBands = percentileBands(coreMat);
  const retBands = percentileBands(retMat);
  const wb = walBands(retMat);

  const balMean = new Float64Array(H + 1);
  const balP5 = new Float64Array(H + 1);
  const balP95 = new Float64Array(H + 1);
  for (let h = 0; h <= H; h++) {
    balMean[h] = retBands.mean[h] * 100;
    balP5[h] = retBands.p5[h] * 100;
    balP95[h] = retBands.p95[h] * 100;
  }

  return {
    retMean: retBands.mean,
    retP5: retBands.p5,
    retP95: retBands.p95,
    coreRetMean: coreBands.mean,
    balMean,
    balP5,
    balP95,
    wal: walFromRetention(retBands.mean),
    walMean: wb.mean,
    walP5: wb.p5,
    walP95: wb.p95,
  };
}

/** Cross-path mean 3M level at every calendar month (percent), h=0..H. */
function meanPathPct(
  paths3mDecimal: ArrayLike<ArrayLike<number>>,
  level0Pct: number,
  hProj: number,
): Float64Array {
  const nPaths = paths3mDecimal.length;
  const out = new Float64Array(hProj + 1);
  out[0] = level0Pct;
  for (let h = 1; h <= hProj; h++) {
    let sum = 0;
    for (let p = 0; p < nPaths; p++) sum += paths3mDecimal[p][h - 1] * 100;
    out[h] = sum / nPaths;
  }
  return out;
}

/**
 * Effective duration of the size-blended MMA granular fan: bump the future
 * path by +/-100bp (level0Pct bumps by the same amount, since MMA has no
 * separate excursion/history channel to keep invariant -- unlike DDA, both
 * of MMA's inputs are simple level shifts). PV via presentValueIb, reused
 * unmodified from mmaTwoSleeve.ts.
 *
 * DISCLOSED JENSEN SIMPLIFICATION (MMA-specific -- DDA has no analogous
 * exposure, see below). presentValueIb's interest leg is
 * R[h-1] * dPct[h]/1200 * df[h-1]: a PRODUCT of two quantities that both vary
 * across the Monte Carlo fan, retention R and coupon rate dPct. The
 * economically correct per-path PV would reprice each path's OWN coupon off
 * that path's OWN rate trajectory, then average the resulting PVs. This
 * function instead reprices a SINGLE coupon path off the CROSS-PATH MEAN rate
 * trajectory (meanPathPct) and multiplies it against the already
 * cross-path-averaged retMean -- i.e. it computes E[R]*E[D] where the correct
 * quantity is E[R*D]. The gap between the two is Cov(R, D) plus whatever
 * convexity simulateDepositRate's dTarget carries as a nonlinear (logistic
 * S-curve) function of the rate path -- both dropped by this shortcut. The
 * bias is exactly ZERO at nPaths=1 (the deterministic engine): with a single
 * path there is nothing to average, so meanPathPct reduces to that one path
 * exactly and "reprice-then-average" and "average-then-reprice" coincide. It
 * only bites for genuine multi-path fans (HW/BGM Monte Carlo, nPaths>1).
 *
 * Contrast with DDA: ddaChampionEffDur (ddaChampionPaths.ts) has NO analogous
 * Jensen exposure. DDA is non-interest-bearing, so its discounting
 * (presentValue, ddaChampion.ts) is LINEAR in retention alone --
 * (R[h-1]-R[h])*df[h] summed, with df depending only on the curve/shock, not
 * on R -- so PV(mean retention) == mean(PV(retention)) exactly; there is no
 * product of two random per-path quantities to create a covariance/convexity
 * gap. This is a genuine MMA-only caveat, not one shared with the DDA model's
 * fan.
 *
 * `precomputedBase`, when provided, must be the result of calling
 * runMmaChampionOnPaths with these same paths/level0Pct/params/data/phiB/hProj
 * -- used in place of recomputing that identical unshocked fan, for callers
 * (MmaTab's "Run analytics") that already ran that exact scenario a moment
 * earlier.
 */
export function mmaChampionEffDur(
  paths3mDecimal: ArrayLike<ArrayLike<number>>,
  level0Pct: number,
  params: MmaGranularParams,
  data: MmaGranularData,
  phiB: number,
  basis: MmaBasis,
  hProj: number = MMA_H_PROJ,
  // Required-but-nullable so the REQUIRED calib can follow it positionally
  // (callers without a precomputed base pass undefined explicitly).
  precomputedBase: ChampionScenarioOutput | undefined,
  calib: MmaRunnerCalib,
  spreadFn?: (path3mPct: Float64Array) => Float64Array,
): number {
  const shockBp = 100;
  const zGran = calib.granLnb - calib.surface.lnBRef;
  const d0Gran = calib.granD;

  const pathsUp = shiftDecimalPaths(paths3mDecimal, shockBp);
  const pathsDown = shiftDecimalPaths(paths3mDecimal, -shockBp);

  // The retention leg reprices through the active basis (spreadFn); the coupon
  // leg dPct below stays on the single-z basis (a disclosed simplification: the
  // toggle is a switching-spread/retention what-if, not a coupon-PV rebuild).
  const base = precomputedBase ?? runMmaChampionOnPaths(paths3mDecimal, level0Pct, params, data, phiB, hProj, calib, spreadFn);
  const up = runMmaChampionOnPaths(pathsUp, level0Pct + shockBp / 100, params, data, phiB, hProj, calib, spreadFn);
  const down = runMmaChampionOnPaths(pathsDown, level0Pct - shockBp / 100, params, data, phiB, hProj, calib, spreadFn);

  const dPctBase = simulateDepositRate(meanPathPct(paths3mDecimal, level0Pct, hProj), zGran, d0Gran, calib.surface);
  const dPctUp = simulateDepositRate(
    meanPathPct(pathsUp, level0Pct + shockBp / 100, hProj), zGran, d0Gran, calib.surface,
  );
  const dPctDown = simulateDepositRate(
    meanPathPct(pathsDown, level0Pct - shockBp / 100, hProj), zGran, d0Gran, calib.surface,
  );

  const pvBase = presentValueIb(base.retMean, dPctBase, 0, basis);
  const pvUp = presentValueIb(up.retMean, dPctUp, shockBp, basis);
  const pvDown = presentValueIb(down.retMean, dPctDown, -shockBp, basis);
  return pvBase > 0 ? (pvDown - pvUp) / (2 * pvBase * 0.01) : 0;
}
