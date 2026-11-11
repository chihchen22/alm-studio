/**
 * BgmRatePath.
 *
 *  - Zero-vol degeneracy at horizons 120 and 360, on a 360-month BGM simulation (decision 97): every
 *    rateAt and every forwardRateAt on a saved tenor of one month or longer is within 1e-12 of
 *    DeterministicRatePath. The 1D saved tenor is read verbatim from the kernel row; at zero vol it sits
 *    up to about 2.6 bp from the curve's own 1D forward (the kernel projects a sub-month stub by simple
 *    compounding of the monthly forward, the curve interpolates inside the month), which is pinned here
 *    as a disclosed kernel convention, not a plumbing error.
 *  - The 1M inversion is restated in this file from the kernel's quoting rule, never imported:
 *      semiannual_bond: 1/P = (1 + y/2)^(2 tau), simple forward = (1/P - 1) / tau, tau = 1/12;
 *      annual_act360:   the quoted sub-1Y yield is already the simple forward.
 *  - The clamp rules copy the kernel StochasticRatePath: rateAt clamps the step to [0, nSteps - 1];
 *    forwardRateAt(s, tau) reads row min(s - 1, nRows - 1).
 *  - An off-grid tenor is a typed BgmTenorError (no averaging of spot rates); within 1e-9 is on grid.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DeterministicRatePath,
  StochasticRatePath,
  bootstrapZeroCurve,
  loadMarketSnapshot,
  simulateBGM,
  type BGMSimulationResult,
  type ZeroCurve,
} from "@alm/kernel";
import { BGM_SAVED_TENORS_YEARS } from "../../contracts/stochastic";
import { buildBaseCurve } from "../rateEnvironment";
import { BgmRatePath, BgmTenorError } from "../bgmRatePath";

const PUBLIC_PACK = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const ACT360_FIXTURE = fileURLToPath(
  new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
);

const DT = 1 / 12;
const TENORS = [...BGM_SAVED_TENORS_YEARS];
const ONE_DAY = 1 / 360;
/** Every saved tenor of one month or longer. */
const MONTH_PLUS = TENORS.filter((t) => t >= DT - 1e-12);
/** A Rebonato parameter set near the public-pack fit (illustrative, not a calibration). */
const VOL = { a: 0.2, b: 0.5, c: 0.48, d: 0.8, beta: 0.0, volScalar: 0.031 };
const ZERO_VOL = { ...VOL, volScalar: 0 };

function simulate(curve: ZeroCurve, params: typeof VOL, nPairs = 2): BGMSimulationResult {
  return simulateBGM(curve, params, {
    horizonYears: 30,
    dtYears: DT,
    nPairs,
    seed: 20261017n,
    savedTenors: TENORS,
  });
}

/** The kernel's flat rates tensor read restated: [path][step][tenor]. */
function rawRow(sim: BGMSimulationResult, p: number, row: number, tenorYears: number): number {
  const ti = TENORS.findIndex((t) => Math.abs(t - tenorYears) < 1e-9);
  const nSteps = sim.times.length;
  return sim.rates[(p * nSteps + row) * TENORS.length + ti];
}

describe("BgmRatePath zero-vol degeneracy on the public pack (curve default v2)", () => {
  let curve: ZeroCurve;
  let sim: BGMSimulationResult;
  beforeAll(async () => {
    curve = buildBaseCurve(await loadMarketSnapshot(PUBLIC_PACK));
    sim = simulate(curve, ZERO_VOL);
  });

  for (const horizon of [120, 360]) {
    it(`equals DeterministicRatePath on every rateAt and every forwardRateAt of 1M..30Y at horizon ${horizon}`, () => {
      expect(sim.times.length).toBe(360);
      const det = new DeterministicRatePath(curve, horizon, DT);
      for (let p = 0; p < sim.nPaths; p++) {
        const path = new BgmRatePath(sim, p, curve, horizon);
        expect(path.nSteps).toBe(horizon);
        expect(path.times).toEqual(det.times);
        for (let s = 0; s < horizon; s++) {
          expect(Math.abs(path.rateAt(s) - det.rateAt(s))).toBeLessThan(1e-12);
          for (const tau of MONTH_PLUS) {
            expect(Math.abs(path.forwardRateAt(s, tau) - det.forwardRateAt(s, tau))).toBeLessThan(1e-12);
          }
        }
      }
    });
  }

  it("reads the 1D tenor verbatim from the kernel row; at zero vol it sits within 3 bp of the curve's 1D forward", () => {
    const horizon = 360;
    const det = new DeterministicRatePath(curve, horizon, DT);
    const path = new BgmRatePath(sim, 0, curve, horizon);
    let maxGap = 0;
    for (let s = 1; s < horizon; s++) {
      expect(path.forwardRateAt(s, ONE_DAY)).toBe(rawRow(sim, 0, s - 1, ONE_DAY));
      maxGap = Math.max(maxGap, Math.abs(path.forwardRateAt(s, ONE_DAY) - det.forwardRateAt(s, ONE_DAY)));
    }
    // Measured 2.58e-4 at step 120 (Task 2 report); a kernel sub-month quoting convention, disclosed.
    expect(maxGap).toBeLessThan(3e-4);
    expect(path.forwardRateAt(0, ONE_DAY)).toBe(curve.forwardSwapRate(0, ONE_DAY));
  });
});

describe("BgmRatePath 1M inversion by convention (restated, nonzero vol)", () => {
  it("semiannual_bond: rateAt(s) = ((1 + y/2)^(2 tau) - 1) / tau of saved row s-1, tau = 1/12", async () => {
    const curve = buildBaseCurve(await loadMarketSnapshot(PUBLIC_PACK));
    expect(curve.convention).toBe("semiannual_bond");
    const sim = simulate(curve, VOL);
    for (const p of [0, 1, 3]) {
      const path = new BgmRatePath(sim, p, curve, 360);
      expect(path.rateAt(0)).toBe(curve.forwardRate(0, DT));
      for (const s of [1, 2, 12, 60, 119, 120, 359]) {
        const y = rawRow(sim, p, s - 1, DT);
        const invP = Math.pow(1 + y / 2, 2 * DT);
        const simple = (invP - 1) / DT;
        expect(Math.abs(path.rateAt(s) - simple)).toBeLessThan(1e-15);
        // Quoted bond-equivalent sits above the simple forward.
        expect(y).toBeGreaterThan(path.rateAt(s));
      }
    }
  });

  it("annual_act360: rateAt(s) is the saved 1M row itself (the quoted sub-1Y basis is simple)", async () => {
    const snapshot = await loadMarketSnapshot(ACT360_FIXTURE);
    const curve = bootstrapZeroCurve(snapshot);
    expect(curve.convention).toBe("annual_act360");
    const sim = simulate(curve, VOL);
    const path = new BgmRatePath(sim, 2, curve, 120);
    for (const s of [1, 12, 60, 119]) {
      expect(path.rateAt(s)).toBe(rawRow(sim, 2, s - 1, DT));
    }
  });
});

describe("BgmRatePath clamp rules equal the kernel StochasticRatePath's", () => {
  let curve: ZeroCurve;
  let sim: BGMSimulationResult;
  beforeAll(async () => {
    curve = buildBaseCurve(await loadMarketSnapshot(PUBLIC_PACK));
    sim = simulate(curve, VOL);
  });

  it("rateAt clamps the step to [0, nSteps - 1] exactly as StochasticRatePath on the same 1M series", () => {
    for (const horizon of [120, 360]) {
      const path = new BgmRatePath(sim, 1, curve, horizon);
      const series: number[] = [];
      for (let s = 0; s < horizon; s++) series.push(path.rateAt(s));
      const kernel = new StochasticRatePath(series, DT);
      expect(path.nSteps).toBe(kernel.nSteps);
      expect(path.times).toEqual(kernel.times);
      for (const s of [-5, -1, 0, 1, horizon - 2, horizon - 1, horizon, horizon + 1, horizon + 40]) {
        expect(path.rateAt(s)).toBe(kernel.rateAt(s));
      }
    }
  });

  it("forwardRateAt(s, tau) reads row min(s - 1, nRows - 1), nRows the run horizon; step <= 0 reads the curve", () => {
    const horizon = 120;
    const path = new BgmRatePath(sim, 1, curve, horizon);
    for (const tau of [DT, 5, 10, 30]) {
      expect(path.forwardRateAt(0, tau)).toBe(curve.forwardSwapRate(0, tau));
      expect(path.forwardRateAt(-3, tau)).toBe(curve.forwardSwapRate(0, tau));
      expect(path.forwardRateAt(1, tau)).toBe(rawRow(sim, 1, 0, tau));
      expect(path.forwardRateAt(horizon, tau)).toBe(rawRow(sim, 1, horizon - 1, tau));
      expect(path.forwardRateAt(horizon + 50, tau)).toBe(rawRow(sim, 1, horizon - 1, tau));
    }
  });
});

describe("BgmRatePath off-grid tenors", () => {
  it("refuses a 4-year read with a typed BgmTenorError at any step; within 1e-9 of a saved tenor is on grid", async () => {
    const curve = buildBaseCurve(await loadMarketSnapshot(PUBLIC_PACK));
    const sim = simulate(curve, VOL, 1);
    const path = new BgmRatePath(sim, 0, curve, 120);
    for (const step of [0, 1, 12, 500]) {
      let err: unknown;
      try {
        path.forwardRateAt(step, 4);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(BgmTenorError);
      expect((err as BgmTenorError).tenorYears).toBe(4);
      expect((err as Error).message).toContain("4 years");
      expect((err as Error).message).toContain("saved tenors");
    }
    expect(() => path.forwardRateAt(12, 3 / 12)).toThrow(BgmTenorError);
    expect(path.forwardRateAt(12, 5 + 5e-10)).toBe(path.forwardRateAt(12, 5));
    expect(() => path.forwardRateAt(12, 5 + 2e-9)).toThrow(BgmTenorError);
  });

  it("refuses a run horizon longer than the simulation grid", async () => {
    const curve = buildBaseCurve(await loadMarketSnapshot(PUBLIC_PACK));
    const sim = simulate(curve, VOL, 1);
    expect(() => new BgmRatePath(sim, 0, curve, 361)).toThrow(/360/);
  });
});
