/**
 * Live fit error for the HW and BGM slider panels.
 *
 * The panels never re-calibrate. A slider move re-prices the same ATM targets
 * the solver minimised against and reports the RMSE of the new parameters, so
 * the number a reader watches while dragging is the objective itself, not a
 * proxy for it. At the fitted values that number reproduces `fit.rmseBp`, which
 * is what makes the badge's "at calibration" state checkable.
 *
 * Both functions repeat the residual arithmetic of `hwCalibrate.ts` and
 * `bgmCalibrate.ts` verbatim: model vol minus market vol, scaled to bp, root
 * mean square. Any drift between those files and this one shows up as a parity
 * failure in `__tests__/fitError.test.ts`.
 */

import type { ZeroCurve } from "./bootstrap";
import type { HWCalibrationResult } from "./hwCalibrate";
import type { BGMCalibrationResult } from "./bgmCalibrate";
import { hwCapletNormalVolVec } from "./hwPricing";
import {
  buildSwap,
  rebonatoSwaptionNormalVolGrid,
  type RebonatoParams,
  type SwapStructure,
} from "./bgmPricing";

/** RMSE in normal-vol bp of model vols against market vols, both in decimals. */
function rmseBp(modelVols: readonly number[], marketVols: readonly number[]): number {
  const residualsBp = modelVols.map((m, i) => (m - marketVols[i]) * 1e4);
  return Math.sqrt(residualsBp.reduce((s, r) => s + r * r, 0) / residualsBp.length);
}

/**
 * HW fit error at an arbitrary (a, sigma) against the ATM short-rate column the
 * calibration used. Expiries, the underlying accrual and the forwards all come
 * from the fit, so the objective is held fixed while the parameters move.
 */
export function hwFitRmseBp(a: number, sigma: number, fit: HWCalibrationResult): number {
  const modelVols = hwCapletNormalVolVec(a, sigma, fit.expiries, fit.underlyingTau, fit.forwards);
  return rmseBp(modelVols, fit.marketVols);
}

/**
 * The swap structures behind a BGM fit's quote grid, in the fit's own order.
 *
 * `BGMCalibrationResult` keeps the expiries, tenors, par rates and market vols
 * but not the `SwapStructure` array the pricer needs, so the panel rebuilds it
 * once from the bootstrapped curve and memoises it on (curve, fit). Each swap
 * is the same `buildSwap(curve, T, T + tenor)` the calibrator built.
 */
export function bgmSwapsForFit(curve: ZeroCurve, fit: BGMCalibrationResult): SwapStructure[] {
  return fit.expiries.map((T, i) => buildSwap(curve, T, T + fit.tenors[i]));
}

/**
 * BGM fit error at arbitrary Rebonato parameters against the ATM long-yield
 * grid. `swaps` comes from `bgmSwapsForFit` and is reused across slider moves;
 * displacement and the CEV exponent are settings the fit is conditional on and
 * belong in `params` exactly as the fit recorded them.
 */
export function bgmFitRmseBp(
  params: RebonatoParams,
  fit: BGMCalibrationResult,
  swaps: ReadonlyArray<SwapStructure>,
): number {
  return rmseBp(rebonatoSwaptionNormalVolGrid(swaps, params), fit.marketVols);
}
