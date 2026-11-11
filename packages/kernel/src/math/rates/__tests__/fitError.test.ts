/**
 * Live fit error parity.
 *
 * The slider panels report the calibration objective while a reader drags, so
 * the one thing that has to hold is that the panel's arithmetic and the
 * solver's arithmetic are the same arithmetic. Both legs run the shipped public
 * calibration the way the pricing tests do, then ask the panel's function for
 * the RMSE at the fitted values and compare it with the RMSE the fit reported.
 *
 * Basis: `public/market_public.json`, the shipped public UST pack. The BGM leg
 * fits the default 28-quote subset, matching the lab's own selection.
 */

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  isDefaultCalibrationSwaption,
  loadMarketSnapshot,
  type MarketSnapshot,
} from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import { calibrateHW } from "../hwCalibrate";
import { calibrateBGM } from "../bgmCalibrate";
import { bgmFitRmseBp, bgmSwapsForFit, hwFitRmseBp } from "../fitError";

const PUBLIC_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

async function loadCalibSnapshot(): Promise<MarketSnapshot> {
  const snap = await loadMarketSnapshot(PUBLIC_PATH);
  return { ...snap, swaptionATMQuotes: snap.swaptionATMQuotes.filter(isDefaultCalibrationSwaption) };
}

describe("HW live fit error", () => {
  it("reproduces the fit's own RMSE at the fitted parameters", async () => {
    const snap = await loadMarketSnapshot(PUBLIC_PATH);
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateHW(snap, curve);

    expect(hwFitRmseBp(fit.a, fit.sigma, fit)).toBeCloseTo(fit.rmseBp, 9);
  });

  it("rises when the short-rate vol leaves the fitted value", async () => {
    const snap = await loadMarketSnapshot(PUBLIC_PATH);
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateHW(snap, curve);

    // Twice the fitted sigma roughly doubles every model vol on a column the
    // fit already matches to under a bp, so the objective has nowhere to go but
    // up. This is the property the badge rests on: off calibration is worse.
    expect(hwFitRmseBp(fit.a, fit.sigma * 2, fit)).toBeGreaterThan(fit.rmseBp);
  });
});

describe("BGM live fit error", () => {
  it("reproduces the fit's own RMSE at the fitted parameters", async () => {
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateBGM(snap, curve); // omitted options = default engine
    const swaps = bgmSwapsForFit(curve, fit);

    expect(swaps).toHaveLength(fit.marketVols.length);
    const live = bgmFitRmseBp(
      {
        a: fit.a,
        b: fit.b,
        c: fit.c,
        d: fit.d,
        beta: fit.beta,
        volScalar: fit.volScalar,
        displacement: fit.displacement,
        cevBeta: fit.cevBeta,
      },
      fit,
      swaps,
    );
    expect(live).toBeCloseTo(fit.rmseBp, 9);
  }, 120_000);

  it("rises when the vol multiplier is tripled", async () => {
    const snap = await loadCalibSnapshot();
    const curve = bootstrapZeroCurve(snap);
    const fit = calibrateBGM(snap, curve);
    const swaps = bgmSwapsForFit(curve, fit);
    const base: Parameters<typeof bgmFitRmseBp>[0] = {
      a: fit.a,
      b: fit.b,
      c: fit.c,
      d: fit.d,
      beta: fit.beta,
      volScalar: fit.volScalar,
      displacement: fit.displacement,
      cevBeta: fit.cevBeta,
    };

    expect(bgmFitRmseBp({ ...base, volScalar: fit.volScalar * 3 }, fit, swaps)).toBeGreaterThan(
      fit.rmseBp,
    );
  }, 120_000);
});
