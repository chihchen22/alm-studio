import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { bootstrapZeroCurve } from "../bootstrap";
import { loadMarketSnapshot } from "../marketData";
import { calibrateHW } from "../hwCalibrate";
import { projectHWToTenor, simulateHW } from "../simulateHw";
import { extractBgmTenorPaths, simulateBGM } from "../simulateBgm";

// Same resolution idiom as simulators.test.ts.
const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

describe("3M-tenor projection sanity (design spec section 7)", () => {
  it("HW's 3M-tenor mean path tracks the curve's own 3M forward at the first step", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const curveFwd3m = curve.forwardRate(0, 0.25);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n,
    });
    const paths = projectHWToTenor(sim, curve, 0.25);
    let sum = 0;
    for (const p of paths) sum += p[0];
    const meanAtStep0 = sum / paths.length;
    expect(Math.abs(meanAtStep0 - curveFwd3m)).toBeLessThan(0.005); // within 50bp at the first step
  });

  it("BGM's 3M-tenor mean path tracks the curve's own 3M forward at the first step", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const curveFwd3m = curve.forwardRate(0, 0.25);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
      { horizonYears: 5.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n },
    );
    // 3/12 = 0.25 is already in simulateBGM's DEFAULT_SAVED_TENORS, no override needed.
    const paths = extractBgmTenorPaths(sim, 0.25);
    let sum = 0;
    for (const p of paths) sum += p[0];
    const meanAtStep0 = sum / paths.length;
    expect(Math.abs(meanAtStep0 - curveFwd3m)).toBeLessThan(0.005);
  });
});
