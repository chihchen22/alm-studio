/**
 * FTP — loans side: stochastic option-adjusted mortgage FTP for the UI.
 *
 * The fixed-rate loan, floating-rate loan, and mortgage all carry MARGINAL
 * FTP on new volumes (analytics/ftp.ts, static strip on one forward-implied
 * path). The prepayable mortgage additionally gets a stochastic view here:
 * its cashflows are regenerated along every simulated benchmark path (HW or
 * BGM 10Y projection + spreads), discounted with per-path money-market DFs
 * (reconstructPathDF / reconstructPathDFBgm), and path-averaged into the
 * IR / LP / all-in par-coupon triple via ftpStochastic primitives.
 *
 * Option-cost readout follows the Lab's FTP stochastic research script:
 *   vol value = (stoch on − stoch off) − (det on − det off)   per leg,
 * the option premium a single forward-implied path misses; cross-checked by
 * Z-spread (deterministic) vs OAS (stochastic), both over SOFR.
 *
 * Benchmark convention (matches the research script's stochBench): month 1 uses the time-0
 * curve 10Y (known at origination); month m ≥ 2 uses the simulated 10Y at
 * the start of month m (projection step m − 2).
 */

import { DeterministicRatePath } from "../rates/ratePath";
import { DriverPath } from "./duration";
import { Mortgage, type MortgageTerms } from "../instruments/mortgage";
import type { Cashflow } from "../instruments/types";
import type { ZeroCurve } from "../rates/bootstrap";
import type { TLPCurve } from "../rates/tlpCurve";
import {
  projectHWToTenor,
  reconstructPathDF,
  type HWSimulationResult,
  type PathDFResult,
} from "../rates/simulateHw";
import {
  extractBgmTenorPaths,
  reconstructPathDFBgm,
  type BGMSimulationResult,
} from "../rates/simulateBgm";
import {
  deterministicFtpTriple,
  parRateSingle,
  solveOAS,
  solveZSpread,
  stochasticFtpTriple,
  type FtpCashflow,
  type FtpTriple,
  type Discount,
} from "./ftpStochastic";

/** Mortgage refi benchmark tenor (mirrors mortgage.ts, which keeps it private). */
const BENCH_TENOR_YEARS = 10;

export type StochasticEngine = "hw" | "bgm";

export interface MortgageFtpPathRow {
  path: number;
  /** Per-path par-matched IR FTP (SOFR-only discounting on this path). */
  irFtp: number;
  /** Per-path par-matched all-in FTP (SOFR + TLP). */
  allInFtp: number;
  walYears: number;
  lifeCpr: number;
}

export interface MortgageStochasticFtp {
  engine: StochasticEngine;
  nPaths: number;
  /** Deterministic single-path triple, prepayment ON (the static-strip view). */
  det: FtpTriple;
  /** Deterministic, CPR forced to zero (contractual amortization only). */
  detOff: FtpTriple;
  /** Path-averaged triple, prepayment ON. */
  stoch: FtpTriple;
  /** Path-averaged, CPR forced to zero (machinery control: ≈ detOff). */
  stochOff: FtpTriple;
  /** (stoch on − off) − (det on − off): the vol value one path misses. */
  volValue: FtpTriple;
  /** Z-spread of the det-on cashflows over SOFR (static comparator). */
  zSpread: number;
  /** OAS of the stochastic cashflows over SOFR; Z − OAS ≈ IR vol value. */
  oas: number;
  /** max|E_p[D_p] − P^M| in bp across horizons (martingale check). */
  martingaleErrBp: number;
  walDetYears: number;
  lifeCprDet: number;
  /** Cross-path means. */
  walStochYears: number;
  lifeCprStoch: number;
  perPath: MortgageFtpPathRow[];
}

function toFtpCashflows(cf: ReadonlyArray<Cashflow>): FtpCashflow[] {
  return cf.map((c) => ({
    monthOffset: c.monthOffset,
    balanceStart: c.balance,
    principalPaid: c.principalPaid,
    interestPaid: c.interestPaid,
  }));
}

/** WAL (years) of one cashflow stream. */
export function cashflowWalYears(cf: ReadonlyArray<FtpCashflow>): number {
  let num = 0;
  let den = 0;
  for (const c of cf) {
    num += (c.monthOffset / 12) * c.principalPaid;
    den += c.principalPaid;
  }
  return den > 1e-12 ? num / den : 0;
}

/** Life CPR (balance-weighted, annualised) of one stream (the research script's convention). */
export function cashflowLifeCpr(
  cf: ReadonlyArray<FtpCashflow>,
  noteRate: number,
  termMonths: number,
): number {
  let wSum = 0;
  let cprSum = 0;
  const mr = noteRate / 12;
  for (const c of cf) {
    const remMonths = termMonths - c.monthOffset + 1;
    const sp =
      c.balanceStart > 1e-6 ? c.balanceStart * (mr / (Math.pow(1 + mr, remMonths) - 1)) : 0;
    const pp = Math.max(0, c.principalPaid - sp);
    const base = Math.max(1e-9, c.balanceStart - sp);
    const smm = Math.min(1, pp / base);
    const cpr = 1 - Math.pow(1 - smm, 12);
    cprSum += cpr * c.balanceStart;
    wSum += c.balanceStart;
  }
  return wSum > 1e-12 ? cprSum / wSum : 0;
}

/** Same terms with the refi S-curve zeroed: CPR ≡ 0 (contractual only). */
function zeroCprTerms(terms: MortgageTerms): MortgageTerms {
  return { ...terms, cprParams: { ...terms.cprParams, minCpr: 0, maxCpr: 0 } };
}

/**
 * Stochastic option-adjusted mortgage FTP under the selected engine.
 * Throws if the required simulation has not been run.
 */
export function mortgageStochasticFtp(
  terms: MortgageTerms,
  curve: ZeroCurve,
  tlp: TLPCurve,
  engine: StochasticEngine,
  hwSim: HWSimulationResult | null,
  bgmSim: BGMSimulationResult | null,
): MortgageStochasticFtp {
  let proj: Float64Array[];
  let dfRes: PathDFResult;
  if (engine === "hw") {
    if (!hwSim) throw new Error("mortgageStochasticFtp: HW simulation not available");
    proj = projectHWToTenor(hwSim, curve, BENCH_TENOR_YEARS);
    dfRes = reconstructPathDF(hwSim, curve);
  } else {
    if (!bgmSim) throw new Error("mortgageStochasticFtp: BGM simulation not available");
    proj = extractBgmTenorPaths(bgmSim, BENCH_TENOR_YEARS);
    dfRes = reconstructPathDFBgm(bgmSim, curve);
  }
  const nPaths = proj.length;
  const term = terms.maturityMonths;
  const N = terms.notional;

  const mortOn = new Mortgage(terms);
  const mortOff = new Mortgage(zeroCprTerms(terms));

  // Deterministic baselines on the forward-implied path.
  const detPath = new DeterministicRatePath(curve, term);
  const cfDetOn = toFtpCashflows(mortOn.generateCashflows(detPath));
  const cfDetOff = toFtpCashflows(mortOff.generateCashflows(detPath));
  const det = deterministicFtpTriple(cfDetOn, N, curve, tlp);
  const detOff = deterministicFtpTriple(cfDetOff, N, curve, tlp);

  // Per-path benchmark drivers and cashflows.
  const det0 = curve.forwardSwapRate(0, BENCH_TENOR_YEARS);
  const cfOn: FtpCashflow[][] = new Array(nPaths);
  const cfOff: FtpCashflow[][] = new Array(nPaths);
  for (let p = 0; p < nPaths; p++) {
    const bench = new Float64Array(term);
    bench[0] = det0;
    const row = proj[p];
    for (let s = 1; s < term; s++) bench[s] = row[Math.min(s - 1, row.length - 1)];
    const path = new DriverPath(bench);
    cfOn[p] = toFtpCashflows(mortOn.generateCashflows(path));
    cfOff[p] = toFtpCashflows(mortOff.generateCashflows(path));
  }

  const { Dcorr, meanErrBp } = dfRes;
  const stoch = stochasticFtpTriple(cfOn, N, Dcorr, tlp);
  const stochOff = stochasticFtpTriple(cfOff, N, Dcorr, tlp);
  const volValue: FtpTriple = {
    ir: stoch.ir - stochOff.ir - (det.ir - detOff.ir),
    lp: stoch.lp - stochOff.lp - (det.lp - detOff.lp),
    all: stoch.all - stochOff.all - (det.all - detOff.all),
  };

  const baseDfp = (p: number, t: number): number => {
    const k = Math.round(t * 12) - 1;
    return k < 0 ? 1 : Dcorr[p][Math.min(k, Dcorr[p].length - 1)];
  };
  let zSpread = NaN;
  try {
    zSpread = solveZSpread(cfDetOn, (t) => curve.discountFactor(t), N);
  } catch {
    /* leave NaN */
  }
  let oas = NaN;
  try {
    oas = solveOAS(cfOn, baseDfp, N);
  } catch {
    /* leave NaN */
  }

  const perPath: MortgageFtpPathRow[] = new Array(nPaths);
  let walSum = 0;
  let cprSum = 0;
  for (let p = 0; p < nPaths; p++) {
    const dfIRp: Discount = (t) => baseDfp(p, t);
    const dfAllp: Discount = (t) => baseDfp(p, t) * Math.exp(-tlp.tlp(t) * t);
    const w = cashflowWalYears(cfOn[p]);
    const c = cashflowLifeCpr(cfOn[p], terms.noteRate, term);
    walSum += w;
    cprSum += c;
    perPath[p] = {
      path: p + 1,
      irFtp: parRateSingle(cfOn[p], N, dfIRp),
      allInFtp: parRateSingle(cfOn[p], N, dfAllp),
      walYears: w,
      lifeCpr: c,
    };
  }

  return {
    engine,
    nPaths,
    det,
    detOff,
    stoch,
    stochOff,
    volValue,
    zSpread,
    oas,
    martingaleErrBp: meanErrBp,
    walDetYears: cashflowWalYears(cfDetOn),
    lifeCprDet: cashflowLifeCpr(cfDetOn, terms.noteRate, term),
    walStochYears: walSum / nPaths,
    lifeCprStoch: cprSum / nPaths,
    perPath,
  };
}
