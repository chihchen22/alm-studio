/**
 * Illustrative single-loan SFR prepayment surface (hand-set illustrative parameterization).
 *
 * The prepayment parameters here are ILLUSTRATIVE: round values chosen by
 * judgment and anchored to published conventions (the PSA benchmark curve and
 * the Richard and Roll (1989) model family), representative of agency-collateral
 * behavior. They are not fitted to any dataset, and results computed from them
 * are teaching exhibits, not model output. Specification: the illustrative
 * prepayment parameterization, version 1.
 *
 * The valuation basis is market convention, on one worked example: one $1mm
 * 30-year fixed level-pay loan written at the
 * 2026-03-31 current coupon (10Y spot par swap + 250bp all-in spread), the
 * projected mortgage rate in month t is the curve's own forward 10Y par swap at
 * that horizon plus the same spread, and discounting is the curve's discount
 * factors times a continuous 250bp spread. A parallel shock shifts the zero
 * curve and BOTH legs regenerate from it.
 *
 * The functional form is the engine's four-factor CPR family (prepay.ts
 * FourFactorCPR) with the burnout factor switched off, leaving three active
 * factors: the refi-incentive logistic on (WAC - market mortgage rate), the
 * 30-month seasoning ramp, and the summer-peak seasonality sinusoid.
 *
 * Deterministic outputs are gated against the committed illustrative readout
 * (defaults/sfrIllustrativePins.ts); the stochastic fan helpers here are
 * Lab-only illustrations and carry no pin.
 */

import { FourFactorCPR, amortizeMortgage, type AmortRow } from "./prepay";
import type { MBSParams } from "./mbsModel";
import { shockCurve, type ZeroCurve } from "../rates/bootstrap";
import { fanPercentile } from "./fanStats";

// ---------------------------------------------------------------------------
// Basis and parameters
// ---------------------------------------------------------------------------

/** Market-convention valuation basis (no fitted content). */
export const SFR_ILLUS_BASIS = {
  /** The benchmark tenor the mortgage rate rides on. */
  benchmarkTenorYears: 10,
  /** All-in coupon spread over the benchmark: 120bp secondary + 130bp primary-secondary, stated. */
  spread: 0.025,
  /** Loan term, months (30Y fixed level-pay, age 0). */
  termMonths: 360,
  /** Loan face at origination. */
  b0: 1_000_000,
} as const;

/**
 * The illustrative parameter set (spec v1, verbatim). Every value is a round
 * number with a stated public anchor; none is fitted to, transformed from, or
 * tuned against any dataset.
 */
export const SFR_ILLUS_PARAMS = {
  /** Turnover floor, percent CPR (PSA convention plateau). */
  minCpr: 6.0,
  /** Ceiling, percent CPR (Richard-Roll family illustrative ceiling). */
  maxCpr: 65.0,
  /** Logistic slope per percent incentive (engine default). */
  steepness: 2.5,
  /** Incentive at the S-curve midpoint, bp (judgment; public aggregate behavior). */
  inflection: 100,
  /** Months to full seasoning (PSA 30-month ramp). */
  seasoningRamp: 30,
  /** Seasonality peak/trough amplitude, percent around 1.0 (summer peak). */
  seasonalityAmp: 20,
  /** Burnout OFF per spec. */
  burnoutDecay: 0,
} as const;

/** Deterministic shock legs, basis points, ascending. */
export const SFR_ILLUS_SHOCK_GRID = [-200, -100, 0, 100, 200] as const;

/** Incentive floor on the market rate (keeps the logistic argument finite). */
const RATE_FLOOR = 1e-4;

/** The 30Y current coupon off the curve: 10Y spot par swap + the all-in spread. */
export function sfrIllusCurrentCoupon(curve: ZeroCurve): number {
  return curve.forwardSwapRate(0, SFR_ILLUS_BASIS.benchmarkTenorYears) + SFR_ILLUS_BASIS.spread;
}

/** Forward-consistent market mortgage-rate path: fwd 10Y par swap + spread, per month. */
export function sfrIllusRatePath(curve: ZeroCurve, months: number): number[] {
  const out: number[] = [];
  for (let t = 1; t <= months; t++) {
    const t0 = (t - 1) / 12;
    out.push(curve.forwardSwapRate(t0, t0 + SFR_ILLUS_BASIS.benchmarkTenorYears) + SFR_ILLUS_BASIS.spread);
  }
  return out;
}

/** df[m] discounts month-m cash: curve DF times the continuous 250bp spread; df[0] = 1. */
export function sfrIllusDfPath(curve: ZeroCurve, months: number): number[] {
  const out: number[] = [1];
  for (let t = 1; t <= months; t++) {
    out.push(curve.discountFactor(t / 12) * Math.exp((-SFR_ILLUS_BASIS.spread * t) / 12));
  }
  return out;
}

/** Assemble the full MBSParams the four-factor family consumes (wac in percent). */
export function sfrIllusMbsParams(wacDecimal: number, p: SfrIllusParamValues = SFR_ILLUS_PARAMS): MBSParams {
  return {
    secSpread: 120,
    primSpread: 130,
    wac: wacDecimal * 100,
    minCpr: p.minCpr,
    maxCpr: p.maxCpr,
    steepness: p.steepness,
    inflection: p.inflection,
    seasoningRamp: p.seasoningRamp,
    seasonalityAmp: p.seasonalityAmp,
    burnoutDecay: p.burnoutDecay,
  };
}

/** The drivable subset of the illustrative parameters (the tab's sliders). */
export interface SfrIllusParamValues {
  readonly minCpr: number;
  readonly maxCpr: number;
  readonly steepness: number;
  readonly inflection: number;
  readonly seasoningRamp: number;
  readonly seasonalityAmp: number;
  readonly burnoutDecay: number;
}

// ---------------------------------------------------------------------------
// Deterministic valuation
// ---------------------------------------------------------------------------

export interface SfrIllusRun {
  /** Present value, dollars. */
  readonly pv: number;
  /** Present value, percent of face. */
  readonly pvPctFace: number;
  /** Principal-resolution WAL, years (denominator = face). */
  readonly wal: number;
  /** Balance-weighted lifetime CPR, decimal. */
  readonly lifeCpr: number;
  /** First-year cumulative CPR, decimal. */
  readonly firstYearCpr: number;
  /** Annual CPR schedule (decimal, per month). */
  readonly cpr: Float64Array;
  /** Monthly SMM schedule (decimal). */
  readonly smm: Float64Array;
  /** Amortized cashflow rows (dollars). */
  readonly rows: AmortRow[];
}

/**
 * Voluntary-only single-loan valuation on one rate path / df vector, mirroring
 * the readout script's price_loan conventions: PV = sum (principal + interest)
 * x df; WAL = sum principal x month / 12 / face; lifetime CPR from the
 * balance-weighted SMM.
 */
export function priceSfrIllusLoan(args: {
  ratePath: ArrayLike<number>;
  df: ArrayLike<number>;
  wac: number;
  params?: SfrIllusParamValues;
  /** Frozen CPR schedule override (the static comparator). */
  cprOverride?: ArrayLike<number>;
}): SfrIllusRun {
  const { ratePath, df, wac, params = SFR_ILLUS_PARAMS, cprOverride } = args;
  const { termMonths, b0 } = SFR_ILLUS_BASIS;
  let cpr: Float64Array;
  if (cprOverride) {
    cpr = Float64Array.from({ length: termMonths }, (_, i) => cprOverride[i] ?? 0);
  } else {
    const model = new FourFactorCPR(sfrIllusMbsParams(wac, params));
    cpr = model.cprSchedule({
      term: termMonths,
      age: 0,
      noteRate: wac,
      mortgageRateAt: (m) => Math.max(ratePath[m - 1], RATE_FLOOR),
    });
  }
  const rows = amortizeMortgage({ notional: b0, noteRate: wac, term: termMonths, cprSchedule: cpr });

  const smm = new Float64Array(termMonths);
  for (let m = 0; m < termMonths; m++) smm[m] = 1 - Math.pow(1 - cpr[m], 1 / 12);

  let pv = 0;
  let walNum = 0;
  let balSum = 0;
  let smmW = 0;
  for (const r of rows) {
    pv += (r.principalPaid + r.interestPaid) * (df[r.monthOffset] as number);
    walNum += r.principalPaid * r.monthOffset;
    balSum += r.balance;
    smmW += smm[r.monthOffset - 1] * r.balance;
  }
  const lifeCpr = balSum > 0 ? 1 - Math.pow(1 - smmW / balSum, 12) : 0;
  let surv = 1;
  for (let m = 0; m < Math.min(12, termMonths); m++) surv *= 1 - smm[m];
  return {
    pv,
    pvPctFace: (pv / b0) * 100,
    wal: walNum / 12 / b0,
    lifeCpr,
    firstYearCpr: 1 - surv,
    cpr,
    smm,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Shock grid + static comparator
// ---------------------------------------------------------------------------

export interface SfrIllusGridModel {
  /** One run per SFR_ILLUS_SHOCK_GRID leg with the prepayment model live. */
  readonly dynGrid: readonly SfrIllusRun[];
  /** The same legs with the base-case CPR schedule frozen. */
  readonly statGrid: readonly SfrIllusRun[];
  readonly base: SfrIllusRun;
  /** The user's own shock leg (equals base at 0bp). */
  readonly dynCurrent: SfrIllusRun;
}

/**
 * Run the deterministic shock grid. Each leg shifts the zero curve; the
 * projected mortgage-rate path and the discount factors both regenerate from
 * the shifted curve. The WAC is fixed at the BASE curve's current coupon: the
 * loan was written at today's coupon and a shock does not rewrite its note
 * rate. The static comparator freezes the base leg's own CPR schedule, so its
 * principal timing is shock-invariant by construction.
 */
export function runSfrIllusGrid(
  curve: ZeroCurve,
  cfg: { params?: SfrIllusParamValues; shockBp?: number } = {},
): SfrIllusGridModel {
  const { params = SFR_ILLUS_PARAMS, shockBp = 0 } = cfg;
  const wac = sfrIllusCurrentCoupon(curve);
  const months = SFR_ILLUS_BASIS.termMonths;
  const runAt = (bp: number, cprOverride?: ArrayLike<number>): SfrIllusRun => {
    const c = bp === 0 ? curve : shockCurve(curve, bp);
    return priceSfrIllusLoan({
      ratePath: sfrIllusRatePath(c, months),
      df: sfrIllusDfPath(c, months),
      wac,
      params,
      cprOverride,
    });
  };
  const dynGrid = SFR_ILLUS_SHOCK_GRID.map((s) => runAt(s));
  const base = dynGrid[2];
  const statGrid = SFR_ILLUS_SHOCK_GRID.map((s) => runAt(s, base.cpr));
  return {
    dynGrid,
    statGrid,
    base,
    dynCurrent: shockBp === 0 ? base : runAt(shockBp),
  };
}

/** Central-difference effective duration, years. */
export function sfrIllusEffDur(pvDn: number, pvBase: number, pvUp: number, dy: number): number {
  return (pvDn - pvUp) / (2 * pvBase * dy);
}

/** dPV in basis points of BASE economic value. */
export function sfrIllusDPvBpOfBase(basePv: number, shockedPv: number): number {
  return ((shockedPv - basePv) / basePv) * 1e4;
}

// ---------------------------------------------------------------------------
// Stochastic fan (Lab-only illustration; no committed stochastic pin)
// ---------------------------------------------------------------------------

/** A P5/mean/P95 band of a per-path scalar statistic (WAL years, effDur years). */
export interface SfrIllusBand {
  readonly mean: number;
  readonly p5: number;
  readonly p95: number;
}

export interface SfrIllusFan {
  /** Annualized CPR fan, percent. */
  cprMean: Float64Array;
  cprP5: Float64Array;
  cprP95: Float64Array;
  /** Surviving balance as percent of face (anchored at 100 at t = 0 by the caller). */
  balMean: Float64Array;
  balP5: Float64Array;
  balP95: Float64Array;
  /** Per-path principal-resolution WAL band, years. */
  walMean: number;
  walP5: number;
  walP95: number;
}

/**
 * Run the illustrative loan one market-rate path at a time and aggregate CPR,
 * surviving-balance and WAL fans. Discounting does not enter (WAL and the two
 * shape fans are principal-timing objects), so this runner takes no df.
 */
export function runSfrIllusFan(
  mktPaths: ReadonlyArray<ArrayLike<number>>,
  wac: number,
  params: SfrIllusParamValues = SFR_ILLUS_PARAMS,
): SfrIllusFan {
  if (mktPaths.length === 0) throw new Error("runSfrIllusFan: mktPaths must be non-empty");
  const { termMonths, b0 } = SFR_ILLUS_BASIS;
  const nPaths = mktPaths.length;
  const cprCol: Float64Array[] = new Array(termMonths);
  const balCol: Float64Array[] = new Array(termMonths);
  for (let t = 0; t < termMonths; t++) {
    cprCol[t] = new Float64Array(nPaths);
    balCol[t] = new Float64Array(nPaths);
  }
  const walByPath = new Float64Array(nPaths);

  const dfUnit = new Float64Array(termMonths + 1).fill(1);
  for (let p = 0; p < nPaths; p++) {
    const res = priceSfrIllusLoan({ ratePath: mktPaths[p], df: dfUnit, wac, params });
    walByPath[p] = res.wal;
    let bal: number = b0;
    for (let t = 0; t < termMonths; t++) {
      cprCol[t][p] = res.cpr[t] * 100;
      const row = res.rows[t];
      bal = row ? row.balance - row.principalPaid : 0;
      balCol[t][p] = (bal / b0) * 100;
    }
  }

  const mean = (arr: Float64Array) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const bandOf = (arr: Float64Array): [number, number, number] => {
    if (nPaths === 1) return [arr[0], arr[0], arr[0]];
    const sorted = Array.from(arr).sort((a, b) => a - b);
    return [mean(arr), fanPercentile(sorted, 0.05), fanPercentile(sorted, 0.95)];
  };

  const cprMean = new Float64Array(termMonths);
  const cprP5 = new Float64Array(termMonths);
  const cprP95 = new Float64Array(termMonths);
  const balMean = new Float64Array(termMonths);
  const balP5 = new Float64Array(termMonths);
  const balP95 = new Float64Array(termMonths);
  for (let t = 0; t < termMonths; t++) {
    [cprMean[t], cprP5[t], cprP95[t]] = bandOf(cprCol[t]);
    [balMean[t], balP5[t], balP95[t]] = bandOf(balCol[t]);
  }
  const [walMean, walP5, walP95] = bandOf(walByPath);
  return { cprMean, cprP5, cprP95, balMean, balP5, balP95, walMean, walP5, walP95 };
}

/**
 * Per-path effective-duration band. For each path the whole market-rate path
 * and the discount-factor vector are shocked together by ±dy: the caller
 * supplies the base and ±dy df vectors regenerated from the shocked curve, and
 * each shocked leg reads the path shifted by the same ±dy (floored at 1e-4).
 * effDur_p = (PV_dn - PV_up) / (2 · PV_base · dy). Lab-only illustration.
 */
export function runSfrIllusEffDurBand(
  mktPaths: ReadonlyArray<ArrayLike<number>>,
  wac: number,
  dfs: { base: ArrayLike<number>; dn: ArrayLike<number>; up: ArrayLike<number> },
  dy = 0.02,
  params: SfrIllusParamValues = SFR_ILLUS_PARAMS,
): SfrIllusBand {
  if (mktPaths.length === 0) throw new Error("runSfrIllusEffDurBand: mktPaths must be non-empty");
  const shift = (path: ArrayLike<number>, d: number): number[] => {
    const out = new Array<number>(path.length);
    for (let i = 0; i < path.length; i++) out[i] = Math.max(RATE_FLOOR, (path[i] as number) + d);
    return out;
  };
  const effDurs = new Float64Array(mktPaths.length);
  for (let p = 0; p < mktPaths.length; p++) {
    const path = mktPaths[p];
    const pv0 = priceSfrIllusLoan({ ratePath: path, df: dfs.base, wac, params }).pv;
    const pvDn = priceSfrIllusLoan({ ratePath: shift(path, -dy), df: dfs.dn, wac, params }).pv;
    const pvUp = priceSfrIllusLoan({ ratePath: shift(path, dy), df: dfs.up, wac, params }).pv;
    effDurs[p] = sfrIllusEffDur(pvDn, pv0, pvUp, dy);
  }
  if (mktPaths.length === 1) return { mean: effDurs[0], p5: effDurs[0], p95: effDurs[0] };
  const sorted = Array.from(effDurs).sort((a, b) => a - b);
  return {
    mean: effDurs.reduce((s, v) => s + v, 0) / effDurs.length,
    p5: fanPercentile(sorted, 0.05),
    p95: fanPercentile(sorted, 0.95),
  };
}
