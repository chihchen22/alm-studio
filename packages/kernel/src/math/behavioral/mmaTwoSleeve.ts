/**
 * MMA two-sleeve decay model + repricing-coupled EVE: a TypeScript port of a
 * two-sleeve money-market decay design (a granular and a concentration sleeve).
 *
 * Ported operation-for-operation from a Python reference implementation (the
 * granular retention core, the concentration sleeve, the repricing-coupled shocks
 * and the EVE measures).
 * Parity tests pin the exported fixtures (bit-tight WALs, curve spots, EVE).
 *
 * Model. Granular sleeve (current balance < $10M): dollar retention
 * R_g(h) = S_c(h)·B(h). S_c seasons the calm-regime age-hazard curve over the
 * snapshot age mix, with a two-sided closure-incentive multiplier
 * exp(beta_c·(s(k) − s_base)) on the 3M spread s = sofr_3m − deposit_rate
 * (PERCENT). B is the empirical surviving-balance factor to month 42, then a
 * stabilize (base) or decline (downside) tail, with a mild balance
 * slope cumprod(1 + beta_b·(s − s_base)). R_g(h) > 1 at short horizons is
 * CORRECT behavior (survivors regrow early). Concentration sleeve (≥ $10M):
 * not fit: empirical lower-quantile cohort retention (P25 by default), static
 * across rate shocks by construction; only its coupon reprices.
 *
 * EVE (stage 22). Per parallel shock s ∈ {0, ±100, ±200}bp: the coupon leg
 * reprices through the repricing surface at the sleeve-level ln balance,
 * anchored at the OBSERVED sleeve deposit rate; the granular runoff responds
 * through the shock-differential spread path base_sp + s/100 + (D_base − D_shock),
 * so the base scenario reproduces the parameter set's base WAL exactly. IB liability
 * PV = principal runoff + terminal stub + coupon on start-of-month balance,
 * discounted at continuously compounded, linearly interpolated SOFR zeros
 * (all-in basis adds the TLP grid, static across shocks).
 *
 * !! UNITS: spreads and deposit-rate paths are in PERCENT p.a. (surface
 * convention, see repricingSurface.ts); curve z / tlp grids are DECIMAL;
 * monthly coupon = D/1200. Convert at the boundary.
 */

import { MMA_EVE_CURVE_PUBLIC as MMA_EVE_CURVE } from "./defaults/mmaEveCurvePublic";
import {
  MMA_CONC_HAZARD,
  MMA_ILLUSTRATIVE_DATA,
  MMA_ILLUSTRATIVE_PARAMS,
  MMA_LEVELS,
  MMA_SLEEVE_WEIGHTS,
  MMA_STABLE_SHARE,
} from "./illustrative/mmaIllustrative";
import { REPRICING_ILLUSTRATIVE_PARAMS } from "./illustrative/repricingIllustrative";
import type { RepricingSurfaceParams } from "./repricingSurfaceTypes";
import { simulateDepositRate } from "./repricingSurface";

/** Projection horizon in months (20 years). */
export const MMA_H_PROJ = 240;

/** Last observed month of the empirical surviving-balance factor B(h). */
export const MMA_B_WINDOW = 42;

/** Ages ≥ 120m use the pooled flat-regime tail hazard (the parameter set's rule). */
const HZ_TAIL_START = 120;

/** Parallel shocks, in bp, in the Python SHOCKS order. */
export const MMA_SHOCKS_BP = [0, 100, -100, 200, -200] as const;
export type MmaShockBp = (typeof MMA_SHOCKS_BP)[number];

export type MmaBasis = "sofr" | "allin";
export type MmaBTail = "stabilize" | "decline";
export type MmaConcQuantile = "mean" | "P50" | "P25" | "P10" | "P5";

/** Tweakable granular-sleeve parameters (the data arrays live in MmaGranularData). */
export interface MmaGranularParams {
  /** Closure-incentive slope on the 3M spread (per percent, two-sided). */
  betaC: number;
  /** Balance-growth incentive slope (per percent per month; noise-level). */
  betaB: number;
  /** Base 3M spread sofr_3m − deposit_rate at the snapshot (PERCENT). */
  baseSp: number;
  /** Optional override of the terminal monthly closure hazard (ages ≥ 120m). */
  tail?: number;
  /** Surviving-balance tail: "stabilize" (base) or "decline" (downside). */
  bTail: MmaBTail;
}

/** Granular-sleeve data arrays. */
export interface MmaGranularData {
  /** Monthly closure hazard by age, smoothed, tail-extended (length A+1+H+2). */
  hzFull: readonly number[];
  /** Snapshot account ages in months (balance-weighted mix). */
  ages0: readonly number[];
  /** Snapshot balance weights aligned to ages0 (sums to 1). */
  w0: readonly number[];
  /** Empirical surviving-balance factor B(h), h = 0..B_WINDOW (smoothed). */
  bEmp: readonly number[];
  /** Late drift (B(42) − B(30))/12 per month, for the decline tail. */
  late: number;
}

// Granular data and parameters are always passed in: granularRetention REQUIRES
// params and data, so no caller inherits a basis it did not choose. Every default argument elsewhere in this module is now the
// ILLUSTRATIVE set (illustrative/mmaIllustrative, spec v2): a routed tab that
// omits an argument gets hand-set values.

/**
 * Surviving-balance factor over the full horizon: the empirical B(h) to the
 * observation window, then either flat at B(window) ("stabilize", the base
 * case) or drifting down at min(late, 0) per month with a 0.35 floor
 * ("decline", downside). Port of the Python reference's B_full loop.
 */
export function buildBFull(
  bEmp: readonly number[],
  late: number,
  bTail: MmaBTail,
  hProj: number = MMA_H_PROJ,
): Float64Array {
  const B = new Float64Array(hProj + 1);
  const w = Math.min(bEmp.length - 1, hProj);
  for (let h = 0; h <= w; h++) B[h] = bEmp[h];
  const drift = Math.min(late, 0);
  for (let h = w + 1; h <= hProj; h++) {
    B[h] = bTail === "stabilize" ? B[w] : Math.max(0.35, B[h - 1] + drift);
  }
  return B;
}

/**
 * Granular-sleeve dollar retention R_g (length hProj+1, R[0] = 1). Exact port
 * of granular_decay.retention: with no spread path the spread is held at
 * baseSp (d_inc = 0); month k's hazard (k = 1..H) is hz[age + k − 1] times the
 * incentive multiplier exp(betaC·d_inc[k]) (the Python mult[1:H+1] indexing),
 * clipped to [0, 0.99]; ages are guarded at hz.length − H − 1; the balance
 * path is B(h)·cumprod(1 + betaB·d_inc) floored at 0.05; R is floored at 0.
 * Spread path in PERCENT, aligned to months 0..H (length ≥ H+1).
 */
export function granularRetention(
  params: MmaGranularParams,
  data: MmaGranularData,
  spreadPath?: ArrayLike<number>,
  hProj: number = MMA_H_PROJ,
): Float64Array {
  const H = hProj;
  const dInc = new Float64Array(H + 1);
  if (spreadPath !== undefined) {
    if (spreadPath.length < H + 1) {
      throw new Error(`spreadPath length ${spreadPath.length} < horizon+1 ${H + 1}`);
    }
    for (let h = 0; h <= H; h++) dInc[h] = spreadPath[h] - params.baseSp;
  }

  // Hazard vector; an explicit tail override replaces ages >= 120m, as in the parameter set.
  let hz: ArrayLike<number> = data.hzFull;
  if (params.tail !== undefined) {
    const t = Math.min(Math.max(params.tail, 0), 0.99);
    const hz2 = Float64Array.from(data.hzFull);
    for (let i = HZ_TAIL_START; i < hz2.length; i++) hz2[i] = t;
    hz = hz2;
  }
  const maxAge = hz.length - H - 1; // age index guard (np.minimum(ages0, len(hz)-H-1))

  const mult = new Float64Array(H + 1);
  for (let h = 0; h <= H; h++) mult[h] = Math.exp(params.betaC * dInc[h]);

  // Seasoned closure survival Sc[h] = sum_i w0[i] * prod_{k=1..h}(1 - haz_i(k)).
  const Sc = new Float64Array(H + 1);
  Sc[0] = 1;
  for (let i = 0; i < data.ages0.length; i++) {
    const a = Math.min(data.ages0[i], maxAge);
    const w = data.w0[i];
    let s = 1;
    for (let k = 0; k < H; k++) {
      let haz = hz[a + k] * mult[k + 1];
      if (haz < 0) haz = 0;
      else if (haz > 0.99) haz = 0.99;
      s *= 1 - haz;
      Sc[k + 1] += w * s;
    }
  }

  // Balance path with the incentive slope, floored at 0.05; R = Sc * B, floored at 0.
  const bFull = buildBFull(data.bEmp, data.late, params.bTail, H);
  const R = new Float64Array(H + 1);
  let gadj = 1;
  for (let h = 0; h <= H; h++) {
    gadj *= 1 + params.betaB * dInc[h];
    let b = bFull[h] * gadj;
    if (b < 0.05) b = 0.05;
    const r = Sc[h] * b;
    R[h] = r < 0 ? 0 : r;
  }
  R[0] = 1;
  return R;
}

/**
 * Concentration-sleeve retention curve (length hProj+1, R[0] = 1): a
 * constant-hazard exponential at the quantile label's monthly hazard, so
 * R(h) = (1 - hz)^h. Default label P25 (WAL about 2.0 years); mean and P10
 * bracket every run. Static across rate shocks by construction (only the
 * coupon reprices).
 */
export function concentrationCurve(
  quantile: MmaConcQuantile = "P25",
  hProj: number = MMA_H_PROJ,
): Float64Array {
  const hz = MMA_CONC_HAZARD[quantile];
  const R = new Float64Array(hProj + 1);
  let s = 1;
  R[0] = 1;
  for (let h = 1; h <= hProj; h++) {
    s *= 1 - hz;
    R[h] = s;
  }
  return R;
}

/**
 * Everything a sleeve run needs besides the granular parameters and data: the
 * snapshot rate and deposit-rate levels, the sleeve dollar weights, the
 * repricing surface, and the concentration-sleeve curve lookup. Defaults to
 * the illustrative set; the parity tests pass their own.
 */
export interface MmaSleeveBasis {
  readonly levels: {
    readonly sofr1d: number;
    readonly gran: { readonly d: number; readonly lnb: number };
    readonly conc: { readonly d: number; readonly lnb: number };
  };
  readonly weights: { readonly granular: number; readonly concentration: number };
  readonly surface: RepricingSurfaceParams;
  readonly concentrationCurve: (q: MmaConcQuantile) => Float64Array;
}

/** The illustrative sleeve basis (spec v2), the default everywhere below. */
export const MMA_ILLUSTRATIVE_BASIS: MmaSleeveBasis = {
  levels: MMA_LEVELS,
  weights: MMA_SLEEVE_WEIGHTS,
  surface: REPRICING_ILLUSTRATIVE_PARAMS,
  concentrationCurve,
};

/** Book retention w_g*R_g + w_c*R_c (snapshot dollar-share weights). */
export function bookRetention(
  Rg: ArrayLike<number>,
  Rc: ArrayLike<number>,
  wGran: number = MMA_SLEEVE_WEIGHTS.granular,
  wConc: number = MMA_SLEEVE_WEIGHTS.concentration,
): Float64Array {
  if (Rg.length !== Rc.length) {
    throw new Error(`sleeve curve lengths differ: ${Rg.length} vs ${Rc.length}`);
  }
  const R = new Float64Array(Rg.length);
  for (let h = 0; h < R.length; h++) R[h] = wGran * Rg[h] + wConc * Rc[h];
  return R;
}

/** WAL in years: simple area under the retention curve, sum(R[1:])/12 (no stub term). */
export function walYears(R: ArrayLike<number>): number {
  let s = 0;
  for (let h = 1; h < R.length; h++) s += R[h];
  return s / 12;
}

// ---------------------------------------------------------------------------
// EVE (stage 22): repricing-coupled shocks, IB liability PV, effective duration
// ---------------------------------------------------------------------------

/** np.interp semantics: linear inside the grid, clamped to the end values outside. */
function interpLinear(x: number, xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const slope = (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
  return slope * (x - xs[i - 1]) + ys[i - 1];
}

/**
 * Discount factors for month offsets 1..months under a parallel shock (bp).
 * Continuously compounded, linearly interpolated SOFR zeros (DECIMAL grid);
 * "allin" adds the TLP spread grid, held static across shocks.
 * Port of mma_eve.discount_factors; df[h-1] is the factor for month h.
 */
export function discountFactors(
  shockBp: number,
  basis: MmaBasis,
  months: number = MMA_H_PROJ,
  curve: { t: readonly number[]; z: readonly number[]; tlp: readonly number[] } = MMA_EVE_CURVE,
): Float64Array {
  // Default grid is the CONSTRUCTED curve module; the parity tests inject
  // another grid via this parameter.
  const { t, z, tlp } = curve;
  const df = new Float64Array(months);
  for (let h = 1; h <= months; h++) {
    const ty = h / 12;
    let rate = interpLinear(ty, t, z) + shockBp / 1e4;
    if (basis === "allin") rate += interpLinear(ty, t, tlp);
    df[h - 1] = Math.exp(-rate * ty);
  }
  return df;
}

/**
 * Interest-bearing deposit liability PV per $1: principal runoff
 * (R[h−1] − R[h])·DF(h) + terminal stub R[H]·DF(H), plus the coupon leg on the
 * start-of-month balance R[h−1]·D[h]/1200·DF(h). D in PERCENT, aligned to R
 * (length H+1). Port of mma_eve.present_value_ib.
 */
export function presentValueIb(
  R: ArrayLike<number>,
  dPct: ArrayLike<number>,
  shockBp: number,
  basis: MmaBasis,
  curve?: { t: readonly number[]; z: readonly number[]; tlp: readonly number[] },
): number {
  const H = R.length - 1;
  if (dPct.length !== H + 1) {
    throw new Error(`dPct length ${dPct.length} must match R length ${H + 1}`);
  }
  const df = discountFactors(shockBp, basis, H, curve);
  let principal = 0;
  for (let h = 1; h <= H; h++) principal += (R[h - 1] - R[h]) * df[h - 1];
  principal += R[H] * df[H - 1];
  let interest = 0;
  for (let h = 1; h <= H; h++) interest += R[h - 1] * (dPct[h] / 1200) * df[h - 1];
  return principal + interest;
}

/** Per-shock sleeve curves: granular/concentration retention + deposit-rate paths. */
export interface MmaSleeveCurveSet {
  /** Granular retention under the shock-differential spread path. */
  Rg: Float64Array;
  /** Granular deposit-rate path (PERCENT), repriced through the surface. */
  Dg: Float64Array;
  /** Concentration retention — static across shocks by construction. */
  Rc: Float64Array;
  /** Concentration deposit-rate path (PERCENT), repriced through the surface. */
  Dc: Float64Array;
}

/**
 * Per-shock sleeve curves, exact port of 22_rebuild_eve.sleeve_curves for one
 * shock. Flat overnight-rate paths at sofr_1d + s/100 (PERCENT); coupon paths
 * from the repricing surface at the sleeve-level ln balance, anchored at the
 * OBSERVED sleeve deposit rate (levels.gran.d / levels.conc.d — not snapped to
 * target). Granular spread path = baseSp + s/100 + (D_base − D_shock)
 * (widening = shock − passthrough; zero at base, so the base scenario
 * reproduces the parameter set's retention exactly). Concentration runoff static.
 */
export function sleeveCurves(
  shockBp: number,
  params: MmaGranularParams = MMA_ILLUSTRATIVE_PARAMS,
  data: MmaGranularData = MMA_ILLUSTRATIVE_DATA,
  quantile: MmaConcQuantile = "P25",
  basis: MmaSleeveBasis = MMA_ILLUSTRATIVE_BASIS,
): MmaSleeveCurveSet {
  const H = MMA_H_PROJ;
  const lv = basis.levels;
  const surface = basis.surface;
  const zGran = lv.gran.lnb - surface.lnBRef;
  const zConc = lv.conc.lnb - surface.lnBRef;

  const rBase = new Float64Array(H + 1).fill(lv.sofr1d);
  const rShock = new Float64Array(H + 1).fill(lv.sofr1d + shockBp / 100);

  const DgBase = simulateDepositRate(rBase, zGran, lv.gran.d, surface);
  const Dg = simulateDepositRate(rShock, zGran, lv.gran.d, surface);
  const Dc = simulateDepositRate(rShock, zConc, lv.conc.d, surface);

  const spreadPath = new Float64Array(H + 1);
  for (let h = 0; h <= H; h++) {
    spreadPath[h] = params.baseSp + (shockBp / 100 + (DgBase[h] - Dg[h]));
  }
  return {
    Rg: granularRetention(params, data, spreadPath, H),
    Dg,
    Rc: basis.concentrationCurve(quantile),
    Dc,
  };
}

/** Signed d_pv_pct keys, matching the Python f"{s:+d}" convention. */
export type MmaShockKey = "+100" | "-100" | "+200" | "-200";

/** Liability PV measures for one leg (book or sleeve), port of mma_eve._measures. */
export interface MmaLiabilityMeasures {
  /** Base liability PV per $1 of balance. */
  depositPv: number;
  /** Effective duration (L(−100) − L(+100)) / (2·L0·0.01), years. */
  effDur: number;
  /** Effective convexity (L(+100) + L(−100) − 2·L0) / (L0·0.01²). */
  convexity: number;
  /** PV change vs base, L(s)/L0 − 1, per shock. */
  dPvPct: Record<MmaShockKey, number>;
  /** Liability PV by shock (bp). */
  liability: Record<MmaShockBp, number>;
  /** Franchise value par − L0. */
  franchiseValue: number;
}

function measures(L: Record<MmaShockBp, number>, par = 1): MmaLiabilityMeasures {
  const L0 = L[0];
  return {
    depositPv: L0,
    effDur: (L[-100] - L[100]) / (2 * L0 * 0.01),
    convexity: (L[100] + L[-100] - 2 * L0) / (L0 * 0.01 ** 2),
    dPvPct: {
      "+100": L[100] / L0 - 1,
      "-100": L[-100] / L0 - 1,
      "+200": L[200] / L0 - 1,
      "-200": L[-200] / L0 - 1,
    },
    liability: { ...L },
    franchiseValue: par - L0,
  };
}

/** Book, granular, and concentration IB liability measures for one basis. */
export interface MmaEveResult {
  book: MmaLiabilityMeasures;
  granular: MmaLiabilityMeasures;
  concentration: MmaLiabilityMeasures;
}

/**
 * Interest-bearing EVE measures over the shock grid (0, ±100, ±200)bp on one
 * discount basis: per-sleeve IB PVs, book L = w_g·L_g + w_c·L_c, then
 * effective duration/convexity from the symmetric ±100bp difference.
 * Port of the per-basis loop in 22_rebuild_eve.main (single-point sleeve
 * ln-balance coupon legs; the bin-level Jensen check is not ported).
 */
export function liabilityMeasuresIb(
  basis: MmaBasis,
  params: MmaGranularParams = MMA_ILLUSTRATIVE_PARAMS,
  data: MmaGranularData = MMA_ILLUSTRATIVE_DATA,
  quantile: MmaConcQuantile = "P25",
  curve?: { t: readonly number[]; z: readonly number[]; tlp: readonly number[] },
  sleeveBasis: MmaSleeveBasis = MMA_ILLUSTRATIVE_BASIS,
): MmaEveResult {
  const wGran = sleeveBasis.weights.granular;
  const wConc = sleeveBasis.weights.concentration;
  const L = {} as Record<MmaShockBp, number>;
  const Lg = {} as Record<MmaShockBp, number>;
  const Lc = {} as Record<MmaShockBp, number>;
  for (const s of MMA_SHOCKS_BP) {
    const { Rg, Dg, Rc, Dc } = sleeveCurves(s, params, data, quantile, sleeveBasis);
    const pvg = presentValueIb(Rg, Dg, s, basis, curve);
    const pvc = presentValueIb(Rc, Dc, s, basis, curve);
    Lg[s] = pvg;
    Lc[s] = pvc;
    L[s] = wGran * pvg + wConc * pvc;
  }
  return { book: measures(L), granular: measures(Lg), concentration: measures(Lc) };
}

// ---------------------------------------------------------------------------
// Stage-17 static benchmark (stable-core / surge bifurcation)
// ---------------------------------------------------------------------------

/** Static stable-core/surge benchmark with its provenance caveat. */
export interface MmaStaticBenchmark {
  /** Stable share of the book. */
  stableShare: number;
  /** Stable-sleeve portfolio WAL (years). */
  stableFloorWalYears: number;
  /** Surge WAL (years): booked overnight, 1/12. */
  surgeWalYears: number;
  /** Benchmark book WAL = stableShare·stableFloorWAL + (1 − stableShare)·(1/12). */
  bookWalYears: number;
  /** Definition used to split stable from surge. */
  floorDefinition: string;
  /** What the comparator can and cannot say. */
  caveat: string;
}

/**
 * The illustrative stable-sleeve WAL: the granular sleeve's own base retention
 * under the illustrative set. Derived rather than picked, so the static
 * comparator carries no second hand-set number.
 */
export const MMA_ILLUSTRATIVE_STABLE_WAL = walYears(
  granularRetention(MMA_ILLUSTRATIVE_PARAMS, MMA_ILLUSTRATIVE_DATA),
);

/**
 * The traditional static comparator: a stable-core / surge bifurcation in
 * which the stable share runs on the model's own base retention and the
 * remainder is booked overnight. The stable share is tweakable; it defaults to
 * the Basel cap on the core proportion of retail non-transactional deposits.
 */
export function staticBenchmark(
  stableShare: number = MMA_STABLE_SHARE,
  stableFloorWalYears: number = MMA_ILLUSTRATIVE_STABLE_WAL,
): MmaStaticBenchmark {
  return {
    stableShare,
    stableFloorWalYears,
    surgeWalYears: 1 / 12,
    bookWalYears: stableShare * stableFloorWalYears + (1 - stableShare) * (1 / 12),
    floorDefinition:
      "Stable share held at the Basel cap on core retail non-transactional deposits; the remainder is booked overnight.",
    caveat:
      "A comparator, not a model: the split is a regulatory cap applied by hand, and it carries no rate response at all.",
  };
}
