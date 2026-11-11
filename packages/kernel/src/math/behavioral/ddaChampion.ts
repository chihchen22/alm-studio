/**
 * DDA (non-interest-bearing) seasoned-stock decay model: a single-core per-band
 * engine (retention composition, runoff PV and effective duration), ported from a
 * Python reference implementation. Parameters and data are passed in; this module
 * is the pure math.
 *
 * Model structure per shock (delta in PERCENT points, e.g. +1.0 = +100 bp):
 *
 *   R(h) = [ sum_a w0(a) * Scum(a+h)/Scum(a) ] * driftcum(h),   h = 0..240
 *
 *   - Closure leg: empirical age-hazard ramp hzFull, scaled by the scalar
 *     one-sided multiplier exp(theta * max(delta, 0)), hazards clipped to
 *     [0, 0.99]; Scum(k) = prod_{j<k}(1 - hz_j), Scum(0) = 1.
 *   - Regime path ("transient" convention, carry-absolute-C):
 *     rs_h = rs0 + delta * max(0, 1 - h/24);  C_h = C0 + sum_{j=1..h} max(rs_j, 0)
 *     (h = 0 is the snapshot month and is NOT accrued into C).
 *   - Survivor drift: g = min(0, max(rs,0)*(a + b*C)), clipped to the caller's
 *     band (the illustrative default is [-0.020, 0]).
 *   - Collapse: p = clip(gamma*max(rs,0)*exp(-mu*C), 0, pMax); loss = p*(1-rJump).
 *     The calm floor c0 is deliberately NOT applied (perband_core:
 *     the calm base collapse is already absorbed in the closure+drift calm
 *     fit; re-adding it would double-count).
 *   - driftcum(h) = prod_{k=1..h} (1+g_k)(1-L_k), driftcum(0) = 1 -- note the
 *     Python uses fac[1:], so index 0 of the path never enters the product.
 *
 * All rate responses are one-sided (up-only): at/below-trend regime states
 * give g = L = 0 and down-shocks give closure multiplier 1, so R under down
 * shocks is identical to base. When the reference-date regime state rs0 is below
 * zero, the BASE curve is pure age-mix closure survival (driftcum = 1 throughout).
 *
 * R(0) = sum_a w0(a) = 1 up to float noise (the exported weights sum to 1);
 * mirroring perband_retention, it is computed, not forced.
 *
 * EVE: runoff CF(h) = R(h-1) - R(h) for h = 1..240 plus the terminal
 * stub R(240) at month 240 (principal conserves exactly). Discounting uses
 * continuously compounded zeros with linear interpolation in the zero rate and
 * flat extrapolation (np.interp semantics), the shock added as delta_bp/1e4,
 * and -- on the all-in basis -- a static TLP spread. The shock moves BOTH the
 * discount curve and the behavioral curve R_delta, so the duration is an
 * EFFECTIVE duration. Shocks (0, +/-100, +/-200 bp);
 * effDur = (L_-100 - L_+100) / (2 * L_0 * 0.01).
 *
 * Static benchmark helpers (stages 60/61): a rate-invariant vintage schedule
 * priced under shocked discounting only (discount-only duration, zero
 * behavioral leg), and the stable/non-stable bifurcated book where the
 * non-stable remainder (1 - fStable) is booked as overnight cash -- PV = par
 * = 1 under EVERY shock (it pays at t = 0, no discounting), WAL 0, effective
 * duration exactly 0. So L_book(s) = fStable * L_vintage(s) + (1 - fStable)
 * and WAL_book = fStable * WAL_vintage.
 */

import { retentionCurveOnPath } from "./ddaChampionPaths";
import {
  DDA_DRIFT_CLIP,
  DDA_HZ_MAX,
  DDA_P_MAX_COLLAPSE,
} from "./illustrative/ddaIllustrative";

/** Projection horizon in months (20 years). */
export const H_PROJ = 240;
/** Months over which the 24m MA absorbs a held parallel shock ("transient"). */
export const MA_WINDOW = 24;
/**
 * The three clips, defaulted to the ILLUSTRATIVE set rather than hard-coded to
 * any other set (spec Section 3.1, "non-slider structure, by rule":
 * drift floor -0.020 with a ceiling of 0, collapse cap 0.050, hazard ceiling
 * 0.10). All three are inactive at the illustrative parameters, which is what
 * the DDA tab's parameter table tells the reader; the point of reading them
 * from the same module the tab prints is that the two can no longer disagree.
 * Every consumer takes the clip as an argument, so a caller on another
 * parameter set passes its own.
 */
export const DRIFT_LO = DDA_DRIFT_CLIP.lo;
export const DRIFT_HI = DDA_DRIFT_CLIP.hi;
export const P_MAX_COLLAPSE = DDA_P_MAX_COLLAPSE;
export const HAZARD_MAX = DDA_HZ_MAX;
/** EVE shock set in basis points (order mirrors eve.SHOCKS). */
export const SHOCKS_BP: readonly number[] = [0, 100, -100, 200, -200];

/** Survivor-drift parameters: a >= 0 level, b <= 0 the rs x C amplification. */
export interface DdaDrift {
  a: number;
  b: number;
}

/** Collapse-channel parameters (the calm floor c0 is NOT applied). */
export interface DdaCollapse {
  gamma: number;
  mu: number;
  rJump: number;
}

/**
 * The three clips the composition applies. They travel with the parameter set,
 * because a clip is only meaningful beside the values it bounds: the
 * illustrative set's clips are inactive at its own parameters, while another
 * set can sit against them. A parameter set that omits them gets the
 * illustrative defaults.
 */
export interface DdaClips {
  /** Monthly survivor-drift increment floor and ceiling. */
  driftLo: number;
  driftHi: number;
  /** Monthly collapse-probability cap. */
  pMax: number;
  /** Closure-hazard ceiling after the one-sided multiplier. */
  hzMax: number;
}

/** The illustrative clips, spec Section 3.1 ("non-slider structure, by rule"). */
export const DDA_CLIPS_ILLUSTRATIVE: DdaClips = {
  driftLo: DRIFT_LO,
  driftHi: DRIFT_HI,
  pMax: P_MAX_COLLAPSE,
  hzMax: HAZARD_MAX,
};

/** The tweakable parameter set (the illustrative values live in the spec module). */
export interface DdaChampionParams {
  /** One-sided closure elasticity: hazard mult = exp(theta * max(delta, 0)). */
  theta: number;
  drift: DdaDrift;
  collapse: DdaCollapse;
  /** Reference-date regime state rs0 = SOFR3M - MA24(SOFR3M), percent points. */
  rs0: number;
  /** Reference-date cumulative above-trend exposure (burnout accumulator). */
  C0: number;
  /** Clips for this set; the illustrative ones when omitted. */
  clips?: DdaClips;
}

/**
 * Forward (regime state, cumulative exposure C) path of length hProj+1 under a
 * held parallel shock of deltaPp percent points -- the 'transient' convention
 * with carry-absolute-C (perband_core.shock_regime_path, convention="transient",
 * c_reset=False, c_max=None): the 24m MA absorbs the shock linearly, and C
 * accrues forward from the absolute C0. rs_0 is the snapshot month and is NOT
 * accrued (C0 already reflects it).
 */
export function shockRegimePath(
  rs0: number,
  C0: number,
  deltaPp: number,
  hProj: number,
): { rs: Float64Array; C: Float64Array } {
  const rs = new Float64Array(hProj + 1);
  const C = new Float64Array(hProj + 1);
  let cum = 0;
  for (let h = 0; h <= hProj; h++) {
    rs[h] = rs0 + deltaPp * Math.max(0, 1 - h / MA_WINDOW);
    if (h > 0) cum += Math.max(rs[h], 0);
    C[h] = C0 + cum;
  }
  return { rs, C };
}

/**
 * Survivor-drift increment g = min(0, max(rs, 0) * (a + b*C)), UNCLIPPED
 * (the clip is applied by the composition, matching perband_retention).
 * Exactly 0 whenever rs <= 0.
 */
export function driftIncrement(drift: DdaDrift, rs: number, C: number): number {
  return Math.min(0, Math.max(rs, 0) * (drift.a + drift.b * C));
}

/**
 * Collapse balance loss L = clip(gamma * max(rs,0) * exp(-mu*C), 0, pMax)
 * * (1 - rJump), pMax defaulting to the illustrative cap. NO calm floor c0
 * (deliberate documented deviation, see perband_core.collapse_loss_perband).
 * Exactly 0 whenever rs <= 0.
 */
export function collapseLoss(
  collapse: DdaCollapse,
  rs: number,
  C: number,
  pMax: number = P_MAX_COLLAPSE,
): number {
  const pExcess = collapse.gamma * Math.max(rs, 0) * Math.exp(-collapse.mu * C);
  const p = Math.min(Math.max(pExcess, 0), pMax);
  return p * (1 - collapse.rJump);
}

/**
 * One-sided (NIBD down-floored) closure-hazard multiplier
 * exp(theta * max(deltaPp, 0)). Down-shocks return exactly 1 (no sub-baseline
 * stickiness); deltaPp in percent points. Not on the run call path
 * post-retentionCurve-unification below (retentionCurve now delegates to
 * retentionCurveOnPath's own closureMultPath, which is not this function) --
 * kept for its direct unit test and as the model's canonical closed-form
 * statement of the held-shock multiplier.
 */
export function onesidedClosureMult(theta: number, deltaPp: number): number {
  return Math.exp(theta * Math.max(deltaPp, 0));
}

/**
 * driftcum(h) = prod_{k=1..h} (1 + g_k)(1 - L_k) with g clipped to the drift
 * band and the collapse probability capped, both from `clips` (the illustrative
 * set by default); driftcum(0) = 1. Index alignment mirrors the Python
 * `np.concatenate([[1.0], np.cumprod(fac[1:])])`: path index 0 never enters
 * the product.
 */
export function driftCollapseCum(
  drift: DdaDrift,
  collapse: DdaCollapse,
  rs: Float64Array,
  C: Float64Array,
  clips: DdaClips = DDA_CLIPS_ILLUSTRATIVE,
): Float64Array {
  const cum = new Float64Array(rs.length);
  cum[0] = 1;
  let acc = 1;
  for (let k = 1; k < rs.length; k++) {
    const g = Math.min(Math.max(driftIncrement(drift, rs[k], C[k]), clips.driftLo), clips.driftHi);
    const L = collapseLoss(collapse, rs[k], C[k], clips.pMax);
    acc *= (1 + g) * (1 - L);
    cum[k] = acc;
  }
  return cum;
}

/**
 * Seasoned-stock retention curve R(h), h = 0..hProj, under a parallel shock of
 * deltaPp percent points -- the full perband_retention composition on the
 * transient shock path:
 *
 *   R(h) = [ sum_a w0(a) * Scum(a+h)/Scum(a) ] * driftcum(h),  clipped >= 0
 *
 * The closure hazard is hzFull * exp(theta * max(deltaPp, 0)), clipped to
 * [0, 0.99]. R(0) = sum of the w0 weights = 1 up to float noise.
 *
 * Delegates to retentionCurveOnPath (ddaChampionPaths.ts), which generalizes
 * this held-scalar-shock case to a calendar-varying closure multiplier and is
 * proven to reproduce this function's output bit-for-bit under a constant
 * shift (see ddaChampionPaths.test.ts's retentionCurveOnPath equivalence
 * test). A held shock of deltaPp is exactly a levelPct path that is flat at
 * deltaPp from h=1 onward, referenced off an arbitrary level0=0 (only the
 * difference levelPct[h] - levelPct[0] enters closureMultPath's math, so the
 * absolute reference is irrelevant). Assumes DDA_CHAMPION.w0Ages is already
 * ascending -- retentionCurveOnPath sums cohorts in array order rather than
 * re-sorting; see the w0Ages-ordering test in ddaChampion.test.ts.
 */
export function retentionCurve(
  params: DdaChampionParams,
  hzFull: readonly number[],
  w0Ages: readonly number[],
  w0Weights: readonly number[],
  deltaPp: number,
  hProj: number = H_PROJ,
): Float64Array {
  const { rs, C } = shockRegimePath(params.rs0, params.C0, deltaPp, hProj);
  const levelPct = new Float64Array(hProj + 1).fill(deltaPp);
  levelPct[0] = 0;
  return retentionCurveOnPath(params, { hzFull, w0Ages, w0Weights }, rs, C, levelPct, hProj);
}

/**
 * Retention curve per shock (bp). Convenience wrapper for the EVE measures.
 * Params and data are REQUIRED: callers pass the parameter set they mean
 * (the illustrative set on the routed tabs) explicitly.
 */
export function championRetentionByShock(
  params: DdaChampionParams,
  data: {
    hzFull: readonly number[];
    w0Ages: readonly number[];
    w0Weights: readonly number[];
  },
  shocksBp: readonly number[] = SHOCKS_BP,
): Record<number, Float64Array> {
  const out: Record<number, Float64Array> = {};
  for (const s of shocksBp) {
    out[s] = retentionCurve(params, data.hzFull, data.w0Ages, data.w0Weights, s / 100);
  }
  return out;
}

/** House sum convention: WAL = (1/12) * sum_{h=1..H} R(h), in years. */
export function walYears(R: ArrayLike<number>): number {
  let s = 0;
  for (let h = 1; h < R.length; h++) s += R[h];
  return s / 12;
}

// ---------------------------------------------------------------------------
// EVE -- runoff PV + terminal stub on the lab zero curve
// ---------------------------------------------------------------------------

/** Lab market snapshot: t in years, continuously compounded zeros, TLP spread. */
export interface LabCurve {
  readonly t: readonly number[];
  readonly z: readonly number[];
  readonly tlpSpread: readonly number[];
}

export type DiscountBasis = "sofr" | "allin";

/** np.interp semantics: linear interpolation, flat (clamped) extrapolation. */
function interpFlat(x: number, xs: readonly number[], ys: readonly number[]): number {
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
  return ys[lo] + ((x - xs[lo]) * (ys[hi] - ys[lo])) / (xs[hi] - xs[lo]);
}

/**
 * Discount factor at t years under a parallel shock of deltaBp basis points:
 * exp(-(z(t) + delta/1e4 [+ tlp(t)]) * t); TLP static across shocks.
 */
export function discountFactor(
  curve: LabCurve,
  deltaBp: number,
  basis: DiscountBasis,
  tYears: number,
): number {
  let rate = interpFlat(tYears, curve.t, curve.z) + deltaBp / 1e4;
  if (basis === "allin") rate += interpFlat(tYears, curve.t, curve.tlpSpread);
  return Math.exp(-rate * tYears);
}

/**
 * PV per $1 of starting balance: sum_h [R(h-1) - R(h)] * DF(h/12) plus the
 * terminal stub R(H) * DF(H/12). The same deltaBp shocks the discount curve;
 * pass the MATCHING shocked retention curve R_delta so differencing across
 * shocks yields an effective (not modified) duration.
 */
export function presentValue(
  R: ArrayLike<number>,
  curve: LabCurve,
  deltaBp: number,
  basis: DiscountBasis,
): number {
  const H = R.length - 1;
  let pv = 0;
  let df = 1;
  for (let h = 1; h <= H; h++) {
    df = discountFactor(curve, deltaBp, basis, h / 12);
    pv += (R[h - 1] - R[h]) * df;
  }
  return pv + R[H] * df;
}

/** Retention curve per shock (bp); must cover every shock in SHOCKS_BP. */
export type RetentionByShock = Readonly<Record<number, ArrayLike<number>>>;

export interface LiabilityMeasures {
  /** L at the base curve, per $1 of starting balance. */
  depositPv: number;
  /** (L_-100 - L_+100) / (2 * L_0 * 0.01), years. */
  effDur: number;
  /** (L_+100 + L_-100 - 2 L_0) / (L_0 * 0.01^2). */
  convexity: number;
  /** {'+100', ...} -> L_delta / L_0 - 1. */
  dPvPct: Record<string, number>;
  /** shock bp -> L. */
  liability: Record<number, number>;
}

function shockKey(s: number): string {
  return s > 0 ? `+${s}` : `${s}`;
}

/**
 * Deposit-book measures on the liability PV L (eve.liability_measures). The
 * shock moves BOTH the discount curve and the behavioral leg R_delta.
 */
export function liabilityMeasures(
  RByShock: RetentionByShock,
  curve: LabCurve,
  basis: DiscountBasis,
): LiabilityMeasures {
  const L: Record<number, number> = {};
  for (const s of SHOCKS_BP) L[s] = presentValue(RByShock[s], curve, s, basis);
  const L0 = L[0];
  const dPvPct: Record<string, number> = {};
  for (const s of SHOCKS_BP) {
    if (s !== 0) dPvPct[shockKey(s)] = L[s] / L0 - 1;
  }
  return {
    depositPv: L0,
    effDur: (L[-100] - L[100]) / (2 * L0 * 0.01),
    convexity: (L[100] + L[-100] - 2 * L0) / (L0 * 0.01 ** 2),
    dPvPct,
    liability: L,
  };
}

export interface FranchiseMeasures {
  /** Franchise value V = par - L at the base curve. */
  eveBase: number;
  /** (V_-100 - V_+100) / (2 * V_0 * 0.01), years. */
  effDur: number;
  convexity: number;
  /** {'+100', ...} -> V_delta / V_0 - 1. */
  dEvePct: Record<string, number>;
  /** shock bp -> V. */
  value: Record<number, number>;
  /** shock bp -> L (the raw liability PVs, for the lab tie-out). */
  liability: Record<number, number>;
}

/**
 * Franchise-value measures V = par - L (eve.eve_measures): the below-market
 * funding benefit of the non-interest-bearing book.
 */
export function franchiseMeasures(
  RByShock: RetentionByShock,
  curve: LabCurve,
  basis: DiscountBasis,
  par = 1,
): FranchiseMeasures {
  const liability: Record<number, number> = {};
  const value: Record<number, number> = {};
  for (const s of SHOCKS_BP) {
    liability[s] = presentValue(RByShock[s], curve, s, basis);
    value[s] = par - liability[s];
  }
  const v0 = value[0];
  const dEvePct: Record<string, number> = {};
  for (const s of SHOCKS_BP) {
    if (s !== 0) dEvePct[shockKey(s)] = value[s] / v0 - 1;
  }
  return {
    eveBase: v0,
    effDur: (value[-100] - value[100]) / (2 * v0 * 0.01),
    convexity: (value[100] + value[-100] - 2 * v0) / (v0 * 0.01 ** 2),
    dEvePct,
    value,
    liability,
  };
}

// ---------------------------------------------------------------------------
// Static benchmark (stages 60/61) -- rate-invariant vintage schedules
// ---------------------------------------------------------------------------

/**
 * Bifurcated static book WAL = fStable * scheduleWal. The non-stable remainder
 * (1 - fStable) is booked overnight: WAL 0 by convention. Shock-invariant by
 * construction (the schedule has no rate input).
 */
export function staticBookWal(scheduleWal: number, fStable: number): number {
  return fStable * scheduleWal;
}

/**
 * Discount-only measures for one static schedule: the SAME curve under every
 * shock, so the shock moves the discount curve only ("effective" duration
 * collapses to the PV-weighted time of a fixed runoff strip; zero behavioral
 * leg). Mirrors stage 61 static_variant.
 */
export function staticLiabilityMeasures(
  schedule: ArrayLike<number>,
  curve: LabCurve,
  basis: DiscountBasis,
): LiabilityMeasures {
  const RByShock: Record<number, ArrayLike<number>> = {};
  for (const s of SHOCKS_BP) RByShock[s] = schedule;
  return liabilityMeasures(RByShock, curve, basis);
}

export interface BifurcatedStaticMeasures {
  /** L_book at the base curve. */
  depositPv: number;
  /** Discount-only effective duration of the bifurcated book, years. */
  effDur: number;
  /** shock bp -> L_book. */
  liabilityByShock: Record<number, number>;
}

/**
 * Stable/non-stable bifurcated static book (stage 61 bifurcated_book): the
 * stable fraction fStable follows the vintage schedule; the non-stable
 * remainder is overnight cash priced at PAR under EVERY shock -- it pays at
 * t = 0, so PV = 1, WAL 0 and effective duration exactly 0 (the Python books
 * the non-stable sleeve analytically, not as a discounted cash flow).
 *
 *   L_book(s) = fStable * L_vintage(s) + (1 - fStable)
 */
export function bifurcatedStaticMeasures(
  fStable: number,
  schedule: ArrayLike<number>,
  curve: LabCurve,
  basis: DiscountBasis,
): BifurcatedStaticMeasures {
  const L: Record<number, number> = {};
  for (const s of SHOCKS_BP) {
    L[s] = fStable * presentValue(schedule, curve, s, basis) + (1 - fStable);
  }
  const L0 = L[0];
  return {
    depositPv: L0,
    effDur: (L[-100] - L[100]) / (2 * L0 * 0.01),
    liabilityByShock: L,
  };
}
