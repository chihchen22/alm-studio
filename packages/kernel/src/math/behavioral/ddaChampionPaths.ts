/**
 * DDA decay model generalized to a live per-path SOFR3M driver (deterministic
 * forward, HW, or BGM projected to the 3M tenor), for the size-blended
 * single-account fan. Extends the held-scalar-shock model in ddaChampion.ts
 * WITHOUT modifying it -- every function here is new, reusing ddaChampion.ts's
 * exported drift/collapse primitives unchanged.
 *
 * Two independent channels respond to the live path differently:
 *
 *   - Closure-hazard channel (theta): a calendar-indexed generalization of
 *     onesidedClosureMult(theta, deltaPp) -- exp(theta * max(level(h) -
 *     level0, 0)) -- evaluated per calendar month off the live path's own
 *     level instead of a single held scalar. Reduces EXACTLY to the existing
 *     formula for a path that holds a constant level shift from h=0 onward.
 *
 *   - Drift/collapse channel (rs, C): reconstructed from the shipped SOFR3M
 *     history (src/math/rates/rateHistory.ts, the same series driving the
 *     Replicating Portfolio tractor pillars) concatenated with the live
 *     forward path, so the moving-average index adjusts slower to rate
 *     movements. Anchored so rs(0) = params.rs0 exactly. This does NOT
 *     bit-reduce to the old closed-form shockRegimePath transient -- that
 *     formula assumed an instantaneous full-size excursion jump at h=0,
 *     whereas a trailing MA absorbs the shock gradually. Intentional,
 *     documented divergence toward a more realistic mechanic.
 *
 * Because the closure multiplier now varies by CALENDAR month (not account
 * age), the existing Scum-ratio trick (Scum[a+h]/Scum[a], shared across
 * cohorts) is invalid -- it only works for a calendar-time-INVARIANT
 * multiplier. retentionCurveOnPath replaces it with a per-cohort
 * forward loop, structurally identical to mmaTwoSleeve.granularRetention's
 * own per-cohort loop.
 */

import type { DdaChampionParams, DiscountBasis, LabCurve } from "./ddaChampion";
import {
  DDA_CLIPS_ILLUSTRATIVE,
  H_PROJ,
  driftCollapseCum,
  presentValue,
} from "./ddaChampion";
import { trailingMA } from "../rates/rateHistory";
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
 * Per-month closure-hazard multiplier from a live level path (percent),
 * generalizing onesidedClosureMult(theta, deltaPp) to a calendar-indexed
 * array. `levelPct[0]` is treated as level0 (today, never shocked in the
 * base/deterministic case); `levelPct[h]` for h >= 1 is the live path's
 * projected level at month h. Reduces EXACTLY to a constant
 * exp(theta * deltaPp) when the path holds a flat deltaPp shift from h=0
 * onward (the held-shock case ddaChampion.championRetentionByShock covers).
 */
export function closureMultPath(theta: number, levelPct: Float64Array): Float64Array {
  const level0 = levelPct[0];
  const mult = new Float64Array(levelPct.length);
  for (let h = 0; h < levelPct.length; h++) {
    mult[h] = Math.exp(theta * Math.max(levelPct[h] - level0, 0));
  }
  return mult;
}

/** Months in the trailing SOFR3M moving average (matches ddaChampion.ts's MA_WINDOW). */
const MA_WINDOW_3M = 24;

/**
 * Reconstruct the calendar-indexed excursion rs(h) and burnout accumulator
 * C(h), h = 0..hProj, from the trailing history: rawExcursion(t) =
 * level(t) - trailingMA(level, t, 24), computed over the concatenation of
 * `historicalSOFR3MPct` (ending at "now", h=0) and the live `path3mPct`
 * (h = 1..hProj; path3mPct[k] is the level at h = k+1). The whole series is
 * shifted by a constant offset so rs(0) = params.rs0 EXACTLY -- the
 * parameter set's own history window is not shipped, so this anchors the
 * reconstruction to the set's reference state.
 * C(h) = C0 + cumsum(max(rs(k), 0)) for h = 1..hProj, the unchanged burnout
 * formula (ddaChampion.ts's shockRegimePath), now driven by the reconstructed rs.
 */
export function buildRs3mPath(
  historicalSOFR3MPct: ReadonlyArray<number>,
  path3mPct: ArrayLike<number>,
  params: Pick<DdaChampionParams, "rs0" | "C0">,
  hProj: number = H_PROJ,
): { rs: Float64Array; C: Float64Array } {
  const histLen = historicalSOFR3MPct.length;
  if (histLen < MA_WINDOW_3M) {
    throw new Error(`buildRs3mPath: need >= ${MA_WINDOW_3M} months of history, got ${histLen}`);
  }
  if (path3mPct.length < hProj) {
    throw new Error(`buildRs3mPath: path3mPct length ${path3mPct.length} < hProj ${hProj}`);
  }

  const full = new Array<number>(histLen + hProj);
  for (let i = 0; i < histLen; i++) full[i] = historicalSOFR3MPct[i];
  for (let h = 1; h <= hProj; h++) full[histLen - 1 + h] = path3mPct[h - 1];
  const nowIdx = histLen - 1;

  const rawExcursion = (globalIdx: number): number =>
    full[globalIdx] - trailingMA(full, globalIdx, MA_WINDOW_3M);

  const anchorOffset = params.rs0 - rawExcursion(nowIdx);

  const rs = new Float64Array(hProj + 1);
  const C = new Float64Array(hProj + 1);
  rs[0] = params.rs0;
  C[0] = params.C0;
  let cum = 0;
  for (let h = 1; h <= hProj; h++) {
    rs[h] = rawExcursion(nowIdx + h) + anchorOffset;
    cum += Math.max(rs[h], 0);
    C[h] = params.C0 + cum;
  }
  return { rs, C };
}

/** Data shape retentionCurveOnPath needs (mirrors DDA_CHAMPION's
 *  hzFull/w0Ages/w0Weights fields without importing the whole parameter type). */
export interface DdaChampionData {
  hzFull: readonly number[];
  w0Ages: readonly number[];
  w0Weights: readonly number[];
}

/**
 * Retention curve R(h), h = 0..hProj, driven by a live path: a per-cohort
 * forward recursion over the snapshot age mix (w0Ages/w0Weights), using a
 * CALENDAR-indexed closure multiplier (closureMultPath) instead of the
 * age-indexed Scum-ratio trick -- the trick only works for a multiplier that
 * is the SAME at every calendar month, which a live path violates. Verified
 * (by its test) to reproduce ddaChampion.retentionCurve's Scum-ratio output
 * bit-for-bit when `mult` is constant across h, because the algebra is
 * identical: Scum(a+h)/Scum(a) = prod_{k=a}^{a+h-1}(1 - hzFull[k]*mult), and
 * this loop computes prod_{k=1}^{h}(1 - hzFull[a+k-1]*mult(k)) -- the same
 * product, term for term, when mult(k) is constant.
 *
 * driftcum(h) is an OVERALL multiplicative overlay applied AFTER summing the
 * age-mix survival across cohorts (matching ddaChampion.retentionCurve's own
 * composition: R(h) = [sum_a w0(a)*Scum(a+h)/Scum(a)] * driftcum(h)), not a
 * per-cohort factor -- driftCollapseCum is reused UNMODIFIED from
 * ddaChampion.ts (already generic over Float64Array rs/C).
 */
export function retentionCurveOnPath(
  params: DdaChampionParams,
  data: DdaChampionData,
  rs: Float64Array,
  C: Float64Array,
  levelPct: Float64Array,
  hProj: number = H_PROJ,
): Float64Array {
  if (rs.length !== hProj + 1 || C.length !== hProj + 1 || levelPct.length !== hProj + 1) {
    throw new Error("retentionCurveOnPath: rs/C/levelPct must each have length hProj + 1");
  }
  const clips = params.clips ?? DDA_CLIPS_ILLUSTRATIVE;
  const mult = closureMultPath(params.theta, levelPct);
  const driftcum = driftCollapseCum(params.drift, params.collapse, rs, C, clips);

  const H = hProj;
  const sumWeighted = new Float64Array(H + 1);
  sumWeighted[0] = 1; // R(0) = sum of the w0 weights = 1, same convention as retentionCurve
  for (let i = 0; i < data.w0Ages.length; i++) {
    const a = data.w0Ages[i];
    const w = data.w0Weights[i];
    let s = 1;
    for (let h = 1; h <= H; h++) {
      const idx = a + h - 1;
      const hzBase =
        idx < data.hzFull.length ? data.hzFull[idx] : data.hzFull[data.hzFull.length - 1];
      let hz = hzBase * mult[h];
      if (hz < 0) hz = 0;
      else if (hz > clips.hzMax) hz = clips.hzMax;
      s *= 1 - hz;
      sumWeighted[h] += w * s;
    }
  }
  const R = new Float64Array(H + 1);
  for (let h = 0; h <= H; h++) R[h] = Math.max(0, sumWeighted[h] * driftcum[h]);
  return R;
}

/**
 * Run the DDA decay model, size-blended by `phiB`, across N Monte Carlo 3M-tenor
 * rate paths (length 1 = deterministic). Each path is decimal-annualised
 * (matching projectHWToTenor / the deterministic forward loop); converted to
 * percent internally to match the model's own units. Returns the
 * cross-path mean/P5/P95 retention and balance fans plus the mean-based WAL.
 *
 * `closureLevel0Pct`, when provided, overrides the closure-hazard channel's
 * reference level (used for `levelPct[0]`) instead of deriving it from
 * `historicalSOFR3MPct`'s tail -- this lets `ddaChampionEffDur` hold the
 * closure channel's reference fixed while still shocking `historicalSOFR3MPct`
 * for the (separately invariant) drift/collapse channel. Left optional
 * (rather than required) because most callers want the plain "derive from
 * history's own tail" behavior; CAUTION for any new caller that shocks
 * `historicalSOFR3MPct`: omitting this parameter re-derives the reference
 * from the shocked tail, silently canceling the closure-hazard response --
 * pass the UNSHOCKED tail explicitly in that case, as ddaChampionEffDur does.
 */
export function runDdaChampionOnPaths(
  paths3mDecimal: ArrayLike<ArrayLike<number>>,
  params: DdaChampionParams,
  data: DdaChampionData,
  historicalSOFR3MPct: ReadonlyArray<number>,
  phiB: number,
  hProj: number = H_PROJ,
  closureLevel0Pct?: number,
): ChampionScenarioOutput {
  const nPaths = paths3mDecimal.length;
  if (nPaths === 0) throw new Error("runDdaChampionOnPaths: paths3mDecimal must be non-empty");

  const H = hProj;
  const level0Pct = closureLevel0Pct ?? historicalSOFR3MPct[historicalSOFR3MPct.length - 1];
  const overnight = overnightCurve(H);

  const retMat: Float64Array[] = new Array(nPaths);
  const coreMat: Float64Array[] = new Array(nPaths);

  for (let p = 0; p < nPaths; p++) {
    const path = paths3mDecimal[p];
    if (path.length < H) {
      throw new Error(`runDdaChampionOnPaths: path ${p} has length ${path.length} < hProj ${H}`);
    }
    const path3mPct = new Float64Array(H);
    for (let h = 0; h < H; h++) path3mPct[h] = path[h] * 100;
    const { rs, C } = buildRs3mPath(historicalSOFR3MPct, path3mPct, params, H);
    const levelPct = new Float64Array(H + 1);
    levelPct[0] = level0Pct;
    for (let h = 1; h <= H; h++) levelPct[h] = path3mPct[h - 1];
    const core = retentionCurveOnPath(params, data, rs, C, levelPct, H);
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

/**
 * Effective duration of the size-blended DDA fan: bump the future path by
 * +/-100bp AND shift history by the same bp/100 (mirrors NmdTab.runAnalytics's
 * own convention) so the drift/collapse channel stays parallel-invariant
 * (the invariance property) while the closure-hazard channel -- driven
 * off the UNSHIFTED level0Pct -- genuinely responds. PV via presentValue,
 * reused unmodified from ddaChampion.ts; finite-differenced exactly as
 * liabilityMeasures does.
 *
 * `precomputedBase`, when provided, must be the result of calling
 * runDdaChampionOnPaths with these same paths/params/data/history/phiB/hProj
 * and closureLevel0Pct = historicalSOFR3MPct's tail -- it is used in place of
 * recomputing that identical unshocked fan, for callers (DdaTab's "Run
 * analytics") that already ran that exact scenario a moment earlier.
 */
export function ddaChampionEffDur(
  paths3mDecimal: ArrayLike<ArrayLike<number>>,
  params: DdaChampionParams,
  data: DdaChampionData,
  historicalSOFR3MPct: ReadonlyArray<number>,
  phiB: number,
  curve: LabCurve,
  basis: DiscountBasis,
  hProj: number = H_PROJ,
  precomputedBase?: ChampionScenarioOutput,
): number {
  const shockBp = 100;
  const level0PctBase = historicalSOFR3MPct[historicalSOFR3MPct.length - 1];
  const histUp = historicalSOFR3MPct.map((v) => v + shockBp / 100);
  const histDown = historicalSOFR3MPct.map((v) => v - shockBp / 100);
  const pathsUp = shiftDecimalPaths(paths3mDecimal, shockBp);
  const pathsDown = shiftDecimalPaths(paths3mDecimal, -shockBp);

  const base = precomputedBase ?? runDdaChampionOnPaths(
    paths3mDecimal, params, data, historicalSOFR3MPct, phiB, hProj, level0PctBase,
  );
  const up = runDdaChampionOnPaths(pathsUp, params, data, histUp, phiB, hProj, level0PctBase);
  const down = runDdaChampionOnPaths(pathsDown, params, data, histDown, phiB, hProj, level0PctBase);

  const pvBase = presentValue(base.retMean, curve, 0, basis);
  const pvUp = presentValue(up.retMean, curve, shockBp, basis);
  const pvDown = presentValue(down.retMean, curve, -shockBp, basis);
  return pvBase > 0 ? (pvDown - pvUp) / (2 * pvBase * 0.01) : 0;
}
