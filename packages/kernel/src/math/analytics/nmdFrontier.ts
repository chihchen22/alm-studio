/**
 * Engine-selectable NMD replicating-portfolio frontiers (Non-IB yield space +
 * IB margin space), shared by the Replicating Portfolio tab and the NMD FTP
 * tab. Factors the frontier construction that previously lived inline in the
 * RP tab and adds a Hull-White | BGM switch over the simulated pillar-yield
 * and client-rate samples.
 *
 * The two engines feed the same downstream machinery (sampleMean /
 * sampleCovariance / buildFrontier / buildMarginFrontier); only the path
 * source differs (`simulatedPillarYieldSamples` vs the *Bgm variant), so a
 * blend optimized on either engine is directly comparable.
 */

import type { RateHistory } from "../rates/rateHistory";
import type { ZeroCurve } from "../rates/bootstrap";
import type { HWSimulationResult } from "../rates/simulateHw";
import type { BGMSimulationResult } from "../rates/simulateBgm";
import { betaAtRate, type BetaSCurveParams } from "../instruments/nmdBeta";
import {
  FORECAST_HORIZON_MONTHS,
  blendWalMonths,
  buildFrontier,
  buildMarginFrontier,
  pillarWalMonths,
  regressOnSamples,
  sampleCovariance,
  sampleMean,
  simulatedClientRateSamples,
  simulatedClientRateSamplesBgm,
  simulatedPillarYieldSamples,
  simulatedPillarYieldSamplesBgm,
  type FrontierPoint,
  type FrontierResult,
  type PillarRegression,
} from "./tractor";

export type StochasticEngine = "hw" | "bgm";

/** Pillar universes (≤120M optimization cap; the 180M MA window is data-thin). */
export const NONIB_PILLARS = [3, 12, 24, 60, 120] as const;
export const IB_PILLARS = [1, 3, 12, 24, 60, 120] as const;
/** Union used to estimate one joint covariance across both books. */
export const UNION_PILLARS = [1, 3, 12, 24, 60, 120] as const;

/**
 * Liquidity-WAL overlay (~5y): the contingent-liquidity / LCR constraint on how
 * long the franchise can be funded. Phase 3 splits this from the RP's behavioral
 * anchor: the RP frontier is bound by the cohort-derived *stock WAL* (passed via
 * the `caps` arg), and this liquidity cap is shown as a SEPARATE reference, never
 * the thing that sizes the RP (never fund the liquidity gap off the RP).
 */
export const LIQ_WAL_CAP_MONTHS = 60;
/**
 * Default Non-IB blend WAL bound when no behavioral cap is supplied. Equals the
 * liquidity cap so callers that do not re-anchor (e.g. the FTP tab) keep the
 * legacy behavior; the RP tab overrides it with the computed stock WAL.
 */
export const NONIB_WAL_CAP_MONTHS = LIQ_WAL_CAP_MONTHS;
/** IB has no separate liquidity-WAL cap; the 120M pillar bounds WAL at 60.5m. */
export const IB_WAL_CAP_MONTHS = pillarWalMonths(120);

export interface NmdFrontiers {
  engine: StochasticEngine;
  nibFrontier: FrontierResult;
  ibFrontier: FrontierResult;
  ibReg: PillarRegression;
  ibRegPoint: FrontierPoint;
  /** Non-IB pillar sample-mean yields (decimal), aligned to NONIB_PILLARS. */
  nibMu: number[];
  /** IB pillar sample-mean yields (decimal), aligned to IB_PILLARS. */
  ibMu: number[];
  nSamples: number;
}

/**
 * Build both books' frontiers on the selected engine's simulated paths.
 * Throws if the required simulation is missing (caller gates on this).
 */
export function buildNmdFrontiers(
  engine: StochasticEngine,
  history: RateHistory,
  hwSim: HWSimulationResult | null,
  bgmSim: BGMSimulationResult | null,
  curve: ZeroCurve,
  asOfIdx: number,
  sCurve: BetaSCurveParams,
  horizonMonths: number = FORECAST_HORIZON_MONTHS,
  caps: { nibWalCapMonths?: number; ibWalCapMonths?: number } = {},
): NmdFrontiers {
  const union: number[] = [...UNION_PILLARS];

  let pySamples: number[][];
  let dSamples: number[];
  if (engine === "hw") {
    if (!hwSim) throw new Error("buildNmdFrontiers: HW simulation not available");
    pySamples = simulatedPillarYieldSamples(history, union, hwSim, curve, asOfIdx, horizonMonths).samples;
    dSamples = simulatedClientRateSamples(history, hwSim, curve, sCurve, asOfIdx, horizonMonths);
  } else {
    if (!bgmSim) throw new Error("buildNmdFrontiers: BGM simulation not available");
    pySamples = simulatedPillarYieldSamplesBgm(history, union, bgmSim, asOfIdx, horizonMonths).samples;
    dSamples = simulatedClientRateSamplesBgm(history, bgmSim, sCurve, asOfIdx, horizonMonths);
  }

  const muU = sampleMean(pySamples);
  const covU = sampleCovariance(pySamples);
  const idxOf = (k: number) => union.indexOf(k);
  const nSamples = pySamples.length ? pySamples[0].length : 0;

  // Non-IB: yield-space frontier. rf = forecast-mean overnight yield over the
  // SAME horizon, so Sharpe is a term-premium-per-risk measure.
  const nibIdx = NONIB_PILLARS.map(idxOf);
  const nibMu = nibIdx.map((i) => muU[i]);
  const nibCov = nibIdx.map((i) => nibIdx.map((j) => covU[i][j]));
  const rf = muU[idxOf(1)];
  const nibCap = caps.nibWalCapMonths ?? NONIB_WAL_CAP_MONTHS;
  const nibFrontier = buildFrontier([...NONIB_PILLARS], nibMu, nibCov, nibCap, rf, {
    seed: 0xa11ce,
  });

  // IB: margin-space frontier + NNLS tracking portfolio.
  const ibIdx = IB_PILLARS.map(idxOf);
  const ibMu = ibIdx.map((i) => muU[i]);
  const ibCov = ibIdx.map((i) => ibIdx.map((j) => covU[i][j]));
  const ibYsamples = ibIdx.map((i) => pySamples[i]);
  const joint = sampleCovariance([...ibYsamples, dSamples]);
  const covYD = ibIdx.map((_, i) => joint[i][ibYsamples.length]);
  const varD = joint[ibYsamples.length][ibYsamples.length];
  const muD = sampleMean([dSamples])[0];
  const ibCap = caps.ibWalCapMonths ?? IB_WAL_CAP_MONTHS;
  const ibFrontier = buildMarginFrontier([...IB_PILLARS], ibMu, ibCov, covYD, varD, muD, ibCap, {
    seed: 0x1b2c3,
  });
  const ibReg = regressOnSamples(ibYsamples, dSamples);

  let regRet = -muD;
  let regVar = varD;
  for (let i = 0; i < IB_PILLARS.length; i++) {
    regRet += ibReg.weights[i] * ibMu[i];
    regVar -= 2 * ibReg.weights[i] * covYD[i];
    for (let j = 0; j < IB_PILLARS.length; j++) regVar += ibReg.weights[i] * ibCov[i][j] * ibReg.weights[j];
  }
  const regVol = Math.sqrt(Math.max(0, regVar));
  const ibRegPoint: FrontierPoint = {
    weights: ibReg.weights,
    ret: regRet,
    vol: regVol,
    walMonths: blendWalMonths([...IB_PILLARS], ibReg.weights),
    sharpe: regVol > 0 ? regRet / regVol : 0,
  };

  return { engine, nibFrontier, ibFrontier, ibReg, ibRegPoint, nibMu, ibMu, nSamples };
}

/** Current deposit rate paid, D(0) = β(r₀)·r₀ on the as-of 1M rate (decimal). */
export function currentClientRate(
  history: RateHistory,
  asOfIdx: number,
  sCurve: BetaSCurveParams,
): number {
  const r0Pct = history.sofrTermRate(asOfIdx, 1) * 100;
  return (betaAtRate(r0Pct, sCurve) * r0Pct) / 100;
}
