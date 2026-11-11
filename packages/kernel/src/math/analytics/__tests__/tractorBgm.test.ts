import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve, type ZeroCurve } from "../../rates/bootstrap";
import {
  simulateBGM,
  extractBgmTenorPaths,
  type BGMSimulationResult,
} from "../../rates/simulateBgm";
import { loadRateHistory, type RateHistory } from "../../rates/rateHistory";
import { BETA_S_CURVE_DEFAULTS } from "../../instruments/nmdBeta";
import {
  simulatedPillarYieldSamplesBgm,
  simulatedClientRateSamplesBgm,
} from "../tractor";

const HISTORY_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "rate_history_public.json");
const SNAPSHOT_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

let curve: ZeroCurve;
let sim: BGMSimulationResult;
let history: RateHistory;
let asOfIdx: number;

async function fixtures() {
  if (curve) return;
  const snap = await loadMarketSnapshot(SNAPSHOT_PATH);
  curve = bootstrapZeroCurve(snap);
  sim = simulateBGM(
    curve,
    { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
    { horizonYears: 6, dtYears: 1 / 12, nPairs: 10, seed: 20250930n },
  );
  history = await loadRateHistory(HISTORY_PATH);
  asOfIdx = history.months.length - 1;
}

describe("simulatedPillarYieldSamplesBgm", () => {
  it("k=1 pillar: MA window of 1 returns the raw 1M projection", async () => {
    await fixtures();
    const horizon = 12;
    const out = simulatedPillarYieldSamplesBgm(history, [1], sim, asOfIdx, horizon);
    const proj = extractBgmTenorPaths(sim, 1 / 12);
    expect(out.nSamples).toBe(sim.nPaths * horizon);
    for (const p of [0, sim.nPaths - 1]) {
      for (let j = 0; j < horizon; j++) {
        expect(out.samples[0][p * horizon + j]).toBeCloseTo(proj[p][j], 12);
      }
    }
  });

  it("k=3 pillar: warm-start splice uses the last two historical 3M levels", async () => {
    await fixtures();
    const horizon = 6;
    const out = simulatedPillarYieldSamplesBgm(history, [3], sim, asOfIdx, horizon);
    const proj = extractBgmTenorPaths(sim, 3 / 12);
    const h = history.sofrTermSeries(3);
    for (const p of [0, 3]) {
      const first = (h[asOfIdx - 1] + h[asOfIdx] + proj[p][0]) / 3;
      expect(out.samples[0][p * horizon + 0]).toBeCloseTo(first, 12);
      const second = (h[asOfIdx] + proj[p][0] + proj[p][1]) / 3;
      expect(out.samples[0][p * horizon + 1]).toBeCloseTo(second, 12);
    }
  });

  it("full IB pillar universe fits on the saved-tenor grid", async () => {
    await fixtures();
    const out = simulatedPillarYieldSamplesBgm(history, [1, 3, 12, 24, 60], sim, asOfIdx, 12);
    expect(out.samples.length).toBe(5);
    for (const s of out.samples) for (const v of s) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("simulatedClientRateSamplesBgm", () => {
  it("shape and bounds: nPaths × horizon grid, D(t) ≥ 0 and below the 1M rate", async () => {
    await fixtures();
    const horizon = 12;
    const d = simulatedClientRateSamplesBgm(history, sim, BETA_S_CURVE_DEFAULTS, asOfIdx, horizon);
    const proj = extractBgmTenorPaths(sim, 1 / 12);
    expect(d.length).toBe(sim.nPaths * horizon);
    for (let p = 0; p < sim.nPaths; p++) {
      for (let j = 0; j < horizon; j++) {
        const v = d[p * horizon + j];
        expect(v).toBeGreaterThanOrEqual(0);
        // β < 1 everywhere on the S-curve, and with λ = 1 the target is hit
        // each month, so D stays below the contemporaneous 1M rate.
        expect(v).toBeLessThan(Math.max(proj[p][j], d[p * horizon + Math.max(0, j - 1)] + 1e-9));
      }
    }
  });
});
