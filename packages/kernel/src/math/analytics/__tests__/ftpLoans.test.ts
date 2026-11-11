import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { loadMarketSnapshot } from "../../rates/marketData";
import { bootstrapZeroCurve, type ZeroCurve } from "../../rates/bootstrap";
import { calibrateHW } from "../../rates/hwCalibrate";
import { simulateHW, type HWSimulationResult } from "../../rates/simulateHw";
import { simulateBGM, type BGMSimulationResult } from "../../rates/simulateBgm";
import { LEGACY_TEST_TLP_CURVE } from "../../rates/__tests__/legacyTlpFixture";
import { MORTGAGE_DEFAULTS } from "../../instruments/mortgage";
import { mortgageStochasticFtp } from "../ftpLoans";

const MARKET_PATH = resolve(__dirname, "..", "..", "..", "..", "public", "market_public.json");

/** Shared fixtures, built once (30Y horizon needed for the 360M mortgage). */
let curve: ZeroCurve;
let hwSim: HWSimulationResult;
let bgmSim: BGMSimulationResult;

async function fixtures() {
  if (curve) return;
  const snap = await loadMarketSnapshot(MARKET_PATH);
  curve = bootstrapZeroCurve(snap);
  const hw = calibrateHW(snap, curve);
  hwSim = simulateHW(curve, hw.a, hw.sigma, {
    horizonYears: 30,
    dtYears: 1 / 12,
    nPairs: 32,
    seed: 20250930n,
  });
  bgmSim = simulateBGM(
    curve,
    { a: 0.5327, b: 0.2159, c: 0.498, d: 0.7294, beta: 0.0, volScalar: 0.2403, displacement: 0, cevBeta: 1 },
    { horizonYears: 30, dtYears: 1 / 12, nPairs: 32, seed: 20250930n },
  );
}

describe("mortgageStochasticFtp", () => {
  it("HW machinery control: with CPR forced off, stochastic equals deterministic", async () => {
    await fixtures();
    const r = mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "hw", hwSim, null);
    // CPR=0 cashflows are path-independent and E_p[D_p] = P^M exactly, so the
    // path-averaged par rate must collapse to the deterministic one.
    expect(r.stochOff.ir).toBeCloseTo(r.detOff.ir, 8);
    expect(r.stochOff.all).toBeCloseTo(r.detOff.all, 8);
    expect(r.martingaleErrBp).toBeLessThan(1e-6);
  });

  it("BGM machinery control: same collapse under the BGM engine", async () => {
    await fixtures();
    const r = mortgageStochasticFtp(
      MORTGAGE_DEFAULTS,
      curve,
      LEGACY_TEST_TLP_CURVE,
      "bgm",
      null,
      bgmSim,
    );
    expect(r.stochOff.ir).toBeCloseTo(r.detOff.ir, 8);
    expect(r.stochOff.all).toBeCloseTo(r.detOff.all, 8);
    expect(r.martingaleErrBp).toBeLessThan(1e-6);
  });

  it("HW: triples are additive and the prepayment option has positive vol value", async () => {
    await fixtures();
    const r = mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "hw", hwSim, null);
    expect(r.stoch.ir + r.stoch.lp).toBeCloseTo(r.stoch.all, 12);
    expect(r.det.ir + r.det.lp).toBeCloseTo(r.det.all, 12);
    // Prepayments concentrate in low-rate states: the expected par rate over
    // the path distribution exceeds the single-path rate.
    expect(r.volValue.ir).toBeGreaterThan(0);
    expect(r.volValue.all).toBeGreaterThan(0);
  });

  it("HW: Z − OAS corroborates the IR-leg vol value within MC tolerance", async () => {
    await fixtures();
    const r = mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "hw", hwSim, null);
    expect(Number.isFinite(r.zSpread)).toBe(true);
    expect(Number.isFinite(r.oas)).toBe(true);
    // Distinct functionals + 64 paths: corroboration, not equality.
    expect(Math.abs(r.zSpread - r.oas - r.volValue.ir)).toBeLessThan(0.003);
  });

  it("per-path table: one row per path, all-in above IR, sane WAL / life CPR", async () => {
    await fixtures();
    const r = mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "hw", hwSim, null);
    expect(r.perPath.length).toBe(r.nPaths);
    for (const row of r.perPath) {
      expect(row.allInFtp).toBeGreaterThan(row.irFtp);
      expect(row.walYears).toBeGreaterThan(0);
      expect(row.walYears).toBeLessThan(30);
      expect(row.lifeCpr).toBeGreaterThanOrEqual(0);
      expect(row.lifeCpr).toBeLessThan(1);
    }
    // Cross-path means reconcile with the per-path table.
    const meanWal = r.perPath.reduce((s, x) => s + x.walYears, 0) / r.nPaths;
    expect(meanWal).toBeCloseTo(r.walStochYears, 10);
  });

  it("throws when the required simulation is missing", async () => {
    await fixtures();
    expect(() =>
      mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "hw", null, bgmSim),
    ).toThrow(/HW simulation/);
    expect(() =>
      mortgageStochasticFtp(MORTGAGE_DEFAULTS, curve, LEGACY_TEST_TLP_CURVE, "bgm", hwSim, null),
    ).toThrow(/BGM simulation/);
  });
});
