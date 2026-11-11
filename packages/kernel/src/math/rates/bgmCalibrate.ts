/**
 * BGM/LMM Rebonato 2-factor least-squares calibration.
 *
 * TypeScript port of the Lab's Python reference. Fits (a, b, c, d, beta,
 * volScalar) to the ATM long-yield volatility grid by bounded least squares
 * over a fixed multi-start set. On the shipped Treasury-only public pack that
 * grid is a SYNTHETIC at-the-money bond-yield surface (realized yield vol x a
 * stated premium), not a set of swaption market quotes; the fit is identical
 * either way.
 *
 * Solver history: through 2026-08-30 this used `ml-levenberg-marquardt`, whose
 * unscaled damping and unconditional step acceptance turned the fit into a
 * random walk on this six-parameter problem. It never walked below its
 * starting error on the public surface, which is how the public pack shipped a
 * calibration that returned its own
 * initial guess (18.96 bp parity / 15.52 bp default engine, against a Python
 * reference at 15.04 / 12.00). Replaced 2026-08-31 by
 * `src/math/optim/levenbergMarquardt.ts`; see that file for the mechanism.
 *
 * Acceptance threshold: RMSE <= 10 bps in normal vol terms across the ATM
 * long-yield grid (model audit memo, Sec 7). The public realized-anchored surface
 * does not meet it in either engine, in Python or in TypeScript: it is simply
 * not Rebonato-reachable at a 10 bp tolerance, and the fit-error badge on the
 * BGM panel reports that breach at calibration rather than hiding it.
 */

import { levenbergMarquardtLS } from "../optim/levenbergMarquardt";

import type { MarketSnapshot } from "./marketData";
import type { ZeroCurve } from "./bootstrap";
import {
  BGM_CEV_BETA_OF_RECORD,
  BGM_DISPLACEMENT_OF_RECORD,
  buildSwap,
  rebonatoSwaptionNormalVolGrid,
  type RebonatoParams,
  type SwapStructure,
} from "./bgmPricing";

export interface BGMCalibrationResult extends RebonatoParams {
  rmseBp: number;
  residualsBp: number[];
  expiries: number[];
  tenors: number[];
  parRates: number[];
  marketVols: number[];
  modelVols: number[];
  iterations: number;
  /** Displacement δ used at fit time (echoed for downstream consumers). */
  displacement: number;
  /** CEV exponent β_cev used at fit time. β=1 = shifted lognormal LMM. */
  cevBeta: number;
}

export interface BGMCalibrationOptions {
  aInit?: number;
  bInit?: number;
  cInit?: number;
  dInit?: number;
  betaInit?: number;
  volScalarInit?: number;
  maxIterations?: number;
  /** Displacement δ for the shifted-CEV LMM. Held fixed during fit. Omitted = default engine 0.05. */
  displacement?: number;
  /** CEV exponent β_cev for the shifted-CEV LMM. Held fixed during fit. β=1 = DD. Omitted = default engine 0.5. */
  cevBeta?: number;
}

/**
 * Default (a, b, c, d) starting points. The Rebonato objective is multi-modal
 * and its minima are shallow: on the public surface the spread between basins
 * reachable from a coarse start grid is under half a bp, but a single start can
 * sit 0.4 bp above the best of them. When the caller supplies no explicit
 * inits, every start is fit and the lowest RMSE wins. Six starts cost about
 * 0.5 s on the 28-quote default subset.
 *
 * The first two are the legacy pair; the other four were added 2026-08-31 with
 * the solver replacement, chosen from a 72-point (a, b, c, d) sweep as the
 * smallest set that reaches the sweep's best RMSE on the
 * public surface in lognormal parity, and the public surface at the engine of
 * record. They are start points, not fitted values: no start sits in the basin
 * the Python reference lands in.
 */
const DEFAULT_ABCD_STARTS: ReadonlyArray<[number, number, number, number]> = [
  [0.10, 0.20, 0.50, 0.80],
  [0.60, 0.60, 0.65, 0.70],
  [1.40, 0.20, 0.50, 0.80],
  [0.10, 0.60, 0.25, 0.80],
  [0.60, 0.20, 1.00, 0.45],
  [0.10, 0.20, 1.00, 0.45],
];

export function calibrateBGM(
  snapshot: MarketSnapshot,
  curve: ZeroCurve,
  options: BGMCalibrationOptions = {},
): BGMCalibrationResult {
  const betaInit = options.betaInit ?? 0.08;
  const maxIterations = options.maxIterations ?? 150;
  const displacement = options.displacement ?? BGM_DISPLACEMENT_OF_RECORD;
  const cevBeta = options.cevBeta ?? BGM_CEV_BETA_OF_RECORD;
  const hasExplicitInit =
    options.aInit !== undefined ||
    options.bInit !== undefined ||
    options.cInit !== undefined ||
    options.dInit !== undefined;
  const abcdStarts: ReadonlyArray<[number, number, number, number]> = hasExplicitInit
    ? [[options.aInit ?? 0.10, options.bInit ?? 0.20, options.cInit ?? 0.50, options.dInit ?? 0.80]]
    : DEFAULT_ABCD_STARTS;

  const swaps: SwapStructure[] = [];
  const expiries: number[] = [];
  const tenors: number[] = [];
  const parRates: number[] = [];
  const marketVols: number[] = [];
  for (const q of snapshot.swaptionATMQuotes) {
    const swap = buildSwap(curve, q.expiryYears, q.expiryYears + q.tenorYears);
    swaps.push(swap);
    expiries.push(q.expiryYears);
    tenors.push(q.tenorYears);
    parRates.push(swap.S0);
    marketVols.push(q.normalVol);
  }

  const meanS = parRates.reduce((s, v) => s + v, 0) / parRates.length;
  const meanVolN = marketVols.reduce((s, v) => s + v, 0) / marketVols.length;
  // Heuristic init: under shifted-CEV freeze σ_N ≈ (S+δ)^β · σ_LN_kernel,
  // so vol_scalar ≈ σ_N / (S+δ)^β. β=1 short-circuits Math.pow so δ=0, β=1
  // reproduces the original init bit-for-bit.
  const denom =
    cevBeta === 1.0 ? meanS + displacement : Math.pow(meanS + displacement, cevBeta);
  const volScalarInit = options.volScalarInit ?? meanVolN / denom;

  const unpack = (params: number[]): RebonatoParams => ({
    a: params[0],
    b: params[1],
    c: params[2],
    d: params[3],
    beta: params[4],
    volScalar: params[5],
    displacement,
    cevBeta,
  });

  // Residuals in bp, the same objective the Python reference minimises.
  const residuals = (params: number[]): number[] => {
    const grid = rebonatoSwaptionNormalVolGrid(swaps, unpack(params));
    return grid.map((m, i) => (m - marketVols[i]) * 1e4);
  };

  let best: {
    fitted: RebonatoParams;
    modelVols: number[];
    residualsBp: number[];
    rmseBp: number;
    iterations: number;
  } | null = null;

  for (const [aInit, bInit, cInit, dInit] of abcdStarts) {
    const result = levenbergMarquardtLS(
      residuals,
      [aInit, bInit, cInit, dInit, betaInit, volScalarInit],
      {
        minValues: [0.0, 0.0, 1e-3, 0.0, -1.0, 0.01],
        maxValues: [5.0, 5.0, 5.0, 5.0, +1.0, 2.0],
        damping: 1e-3,
        gradientDifference: [1e-6, 1e-6, 1e-6, 1e-6, 1e-5, 1e-6],
        maxIterations,
        tolerance: 1e-12,
      },
    );

    const fitted: RebonatoParams = unpack(result.parameterValues);
    const modelVols = rebonatoSwaptionNormalVolGrid(swaps, fitted);
    const residualsBp = modelVols.map((m, i) => (m - marketVols[i]) * 1e4);
    const rmseBp = Math.sqrt(residualsBp.reduce((s, r) => s + r * r, 0) / residualsBp.length);
    if (best === null || rmseBp < best.rmseBp) {
      best = { fitted, modelVols, residualsBp, rmseBp, iterations: result.iterations };
    }
  }

  return {
    ...best!.fitted,
    displacement,
    cevBeta,
    rmseBp: best!.rmseBp,
    residualsBp: best!.residualsBp,
    expiries,
    tenors,
    parRates,
    marketVols,
    modelVols: best!.modelVols,
    iterations: best!.iterations,
  };
}
