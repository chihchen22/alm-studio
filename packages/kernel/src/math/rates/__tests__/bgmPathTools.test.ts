import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../marketData";
import { bootstrapZeroCurve, type ZeroCurve } from "../bootstrap";
import {
  simulateBGM,
  getRate,
  bgmTenorIndex,
  extractBgmTenorPaths,
  reconstructPathDFBgm,
  type BGMSimulationResult,
} from "../simulateBgm";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

let curve: ZeroCurve;
let sim: BGMSimulationResult;

async function fixtures() {
  if (curve) return;
  const snap = await loadMarketSnapshot(MARKET_PATH);
  curve = bootstrapZeroCurve(snap);
  sim = simulateBGM(
    curve,
    { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
    { horizonYears: 10, dtYears: 1 / 12, nPairs: 20, seed: 20250930n },
  );
}

describe("BGM path tools", () => {
  it("extractBgmTenorPaths matches getRate cell-for-cell", async () => {
    await fixtures();
    for (const tenor of [1 / 360, 1 / 12, 0.25, 1, 2, 5, 10]) {
      const rows = extractBgmTenorPaths(sim, tenor);
      const ti = bgmTenorIndex(sim, tenor);
      expect(rows.length).toBe(sim.nPaths);
      for (const [p, k] of [
        [0, 0],
        [7, 33],
        [sim.nPaths - 1, sim.times.length - 1],
      ] as const) {
        expect(rows[p][k]).toBe(getRate(sim, p, k, ti));
      }
    }
  });

  it("bgmTenorIndex throws for a tenor off the saved grid", async () => {
    await fixtures();
    expect(() => bgmTenorIndex(sim, 4)).toThrow(/not in saved grid/);
  });

  it("reconstructPathDFBgm is a martingale: cross-path mean DF == market DF", async () => {
    await fixtures();
    const { Dcorr, meanErrBp } = reconstructPathDFBgm(sim, curve);
    expect(meanErrBp).toBeLessThan(1e-6);
    expect(Dcorr.length).toBe(sim.nPaths);
    // Positive rates: DFs strictly inside (0, 1] and decreasing along each path.
    for (const p of [0, sim.nPaths - 1]) {
      let prev = 1;
      for (let k = 0; k < sim.times.length; k++) {
        expect(Dcorr[p][k]).toBeGreaterThan(0);
        expect(Dcorr[p][k]).toBeLessThanOrEqual(prev + 1e-12);
        prev = Dcorr[p][k];
      }
    }
  });
});
