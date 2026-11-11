import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve } from "../bootstrap";
import { calibrateHW } from "../hwCalibrate";
import { simulateHW, projectHWToTenor, reconstructPathDF } from "../simulateHw";
import { hwBondPrice } from "../hwPricing";
import { simulateBGM, getRate } from "../simulateBgm";
import { PCG32 } from "../random";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

function percentile(arr: ArrayLike<number>, q: number): number {
  const sorted = Array.from(arr).sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = base + 1;
  if (next < sorted.length) return sorted[base] + rest * (sorted[next] - sorted[base]);
  return sorted[base];
}

describe("PCG32 RNG", () => {
  it("is reproducible with the same seed", () => {
    const r1 = new PCG32(42n);
    const r2 = new PCG32(42n);
    for (let i = 0; i < 100; i++) {
      expect(r1.nextUint32()).toBe(r2.nextUint32());
    }
  });

  it("generates ~standard normals (Box-Muller)", () => {
    const rng = new PCG32(123n);
    const N = 10000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const z = rng.nextNormal();
      sum += z;
      sumSq += z * z;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1.0)).toBeLessThan(0.05);
  });
});

describe("HW simulator", () => {
  it("antithetic identity: mean(X) across paths is zero to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n,
    });
    let maxAbsMean = 0;
    for (let k = 0; k < sim.times.length; k++) {
      let s = 0;
      for (let p = 0; p < sim.nPaths; p++) s += sim.XPaths[p][k];
      const mean = s / sim.nPaths;
      maxAbsMean = Math.max(maxAbsMean, Math.abs(mean));
    }
    expect(maxAbsMean).toBeLessThan(1e-12);
  });

  it("martingale correction: mean DF matches market to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 10.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n,
    });
    let maxErrBp = 0;
    for (let k = 0; k < sim.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(sim.dfSimulated[k] - sim.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });

  it("1Y forward distribution at 1Y horizon: mean within MC tolerance of Python reference", async () => {
    // The TS code emits the par swap rate (annual ACT/360) for τ ≥ 1Y,
    // which is the Python simple rate scaled by 360/365 ≈ 0.9863 (~5 bp lower
    // at these levels). Within the MC tolerance below.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 5.0, dtYears: 1 / 12, nPairs: 250, seed: 20250930n,
    });
    const fwd = projectHWToTenor(sim, curve, 1.0);
    // 1Y horizon = step 11 (0-indexed for end-of-month-12).
    const k = 11;
    const cs = new Float64Array(sim.nPaths);
    for (let p = 0; p < sim.nPaths; p++) cs[p] = fwd[p][k];
    const mean = Array.from(cs).reduce((s, v) => s + v, 0) / cs.length;
    const p5 = percentile(cs, 0.05);
    const p95 = percentile(cs, 0.95);
    // PUBLIC BASIS, TREASURY CMT CONVENTION, re-pinned 2026-09-01 on the
    // regenerated pack (D1 cap-anchoring fix). Python reference, same seed and
    // path count, from
    // runs/2026-03-31_20250930_500paths_public-basis-cmt-fixwave-2026-09-01
    // (paths_hw_1Y.csv, month 12): mean 0.039466, p5 0.029466, p95 0.049527.
    //
    // The MEAN is essentially unmoved (0.039574 -> 0.039466, about 1 bp): the
    // level is set by the curve, which did not change. The FAN halves, p5-p95
    // 3979 bp -> 2006 bp, because the cap column HW fits fell from 98-126 bp
    // to 54-64 bp when it was re-anchored on the short rate, and the fitted
    // sigma halved with it (0.012198 -> 0.006118). That is the intended effect
    // of D1, not a simulator change.
    //
    // Superseded pins on the mis-indexed cap column: mean 0.039574,
    // p5 0.019799, p95 0.059590 (run ..._public-basis-cmt). Before the CMT
    // convention: mean 0.040263, p5 0.020475, p95 0.060292.
    // Tolerances unchanged: mean within 30 bp; percentiles within 80 bp.
    expect(Math.abs(mean - 0.039466)).toBeLessThan(0.003);
    expect(Math.abs(p5 - 0.029466)).toBeLessThan(0.008);
    expect(Math.abs(p95 - 0.049527)).toBeLessThan(0.008);
  });

  it("phi identity: E[D(t)·P(t, t+10)] reprices P^M(0, t+10)", async () => {
    // Guards both phi carriers (short-rate shift + B·φ bond-variance cross
    // term, aligned with the Python reference engine 2026-07-26). The pre-fix convention
    // passed every marginal check but over-priced this joint expectation by
    // +3.5% at t = 10y on this snapshot; MC noise at 500 paths is ~0.4%.
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const hw = calibrateHW(snap, curve);
    const sim = simulateHW(curve, hw.a, hw.sigma, {
      horizonYears: 10.0, dtYears: 1 / 12, nPairs: 250, seed: 20250930n,
    });
    const { Dcorr } = reconstructPathDF(sim, curve);
    const k = sim.times.length - 1; // t = 10y
    const t = sim.times[k];
    const tau = 10.0;
    const P0t = curve.discountFactor(t);
    const P0T = curve.discountFactor(t + tau);
    let mean = 0;
    for (let p = 0; p < sim.nPaths; p++) {
      mean += Dcorr[p][k] * hwBondPrice(P0t, P0T, hw.a, hw.sigma, t, tau, sim.XPaths[p][k]);
    }
    mean /= sim.nPaths;
    expect(Math.abs(mean / P0T - 1.0)).toBeLessThan(0.01);
  });
});

describe("BGM simulator", () => {
  it("martingale correction: mean DF matches market to numerical precision", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
      { horizonYears: 10.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n },
    );
    let maxErrBp = 0;
    for (let k = 0; k < sim.times.length; k++) {
      maxErrBp = Math.max(maxErrBp, Math.abs(sim.dfSimulated[k] - sim.dfMarket[k]) * 1e4);
    }
    expect(maxErrBp).toBeLessThan(1e-6);
  });

  it("Glasserman-Zhao log-coordinate scheme: in-scope p95 is sensible; sentinel guard rare", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
      { horizonYears: 30.0, dtYears: 1 / 12, nPairs: 100, seed: 20250930n },
    );
    // Under the GZ log-coordinate scheme, the F_CEILING clip is replaced by
    // a numerical safety guard at log F = 100 (F ≈ 2.7e43). Some far-tail
    // paths in the calibrated lognormal LMM legitimately reach this region;
    // a small saturation rate is a model property, not a bug. Anything below
    // 0.5% of evolutions is acceptable.
    const capRate = sim.nCapFires / Math.max(sim.nTotalEvolutions, 1);
    expect(capRate).toBeLessThan(0.005);
    expect(sim.nFloorFires).toBe(0);

    // In-scope (≤ 10Y horizon, ≤ 10Y tenor): every cell's p95 should be a
    // finite, sensible rate. This is what charts and downstream consumers see.
    const inScopeStep = sim.times.findIndex((t) => t > 10) - 1;
    const inScopeTenor = Array.from(sim.tenors).filter((t) => t <= 10).length;
    let maxP95 = 0;
    const nT = sim.tenors.length;
    const nS = sim.times.length;
    for (let s = 0; s <= inScopeStep; s++) {
      for (let ti = 0; ti < inScopeTenor; ti++) {
        const cs = new Float64Array(sim.nPaths);
        for (let p = 0; p < sim.nPaths; p++) cs[p] = sim.rates[(p * nS + s) * nT + ti];
        maxP95 = Math.max(maxP95, percentile(cs, 0.95));
      }
    }
    expect(maxP95).toBeGreaterThan(0.04); // at least 4% somewhere in scope
    expect(maxP95).toBeLessThan(0.5); // < 50% in-scope (≤ 10Y horizon × ≤ 10Y tenor)
  });

  it("getRate accessor returns same data as direct flat-array indexing", async () => {
    const snap = await loadMarketSnapshot(MARKET_PATH);
    const curve = bootstrapZeroCurve(snap);
    const sim = simulateBGM(
      curve,
      { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
      { horizonYears: 1.0, dtYears: 1 / 12, nPairs: 10, seed: 20250930n },
    );
    const nT = sim.tenors.length;
    const nS = sim.times.length;
    for (const [p, s, ti] of [[0, 0, 0], [3, 5, 2], [10, 11, 9]] as const) {
      expect(getRate(sim, p, s, ti)).toBe(sim.rates[(p * nS + s) * nT + ti]);
    }
  });
});
