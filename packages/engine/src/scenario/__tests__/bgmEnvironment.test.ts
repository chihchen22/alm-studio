/**
 * The BGM environment.
 *
 *  - Calibration on the kernel's 28-point default subset of the long-yield volatility surface: on the
 *    public pack and curve default v2 the fit is 12.45 bp over 28 points at the solver's 150-iteration
 *    cap, and the 10 bp gate is reported (rmseGateBreached === rmseBp > 10), never refused.
 *  - The simulation is always 360 months; paths, discount factors and the martingale block read the
 *    first horizonMonths rows (decision 97).
 *  - Zero-vol degeneracy at horizons 120 and 360: every path equals DeterministicRatePath and every
 *    corrected discount factor equals the curve's.
 *  - The martingale helpers are restated in this file on the 1D saved row, from the kernel formulas:
 *      raw drift  = (mean_p prod_k exp(-0.5 (r_{k-1} + r_k) dt) - P(0, T)) * 1e4, r_{-1} = -ln P(0, dt)/dt;
 *      pair SE    = sqrt(sum_j (pairMean_j - mean)^2 / (nPairs - 1)) / sqrt(nPairs) on the terminal DF.
 *  - Refusals: a short-rate volatility shock first (override or not), an empty long-yield block, and a
 *    default subset under 8 points, all typed and in words.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  DeterministicRatePath,
  loadMarketSnapshot,
  type MarketSnapshot,
  type ZeroCurve,
} from "@alm/kernel";
import { BGM_SAVED_TENORS_YEARS, type BgmModelOverride } from "../../contracts/stochastic";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { buildBaseCurve } from "../rateEnvironment";
import {
  BgmShockUnreadError,
  BgmSubsetError,
  StochasticLongYieldVolsError,
  buildBgmEnvironment,
  type BgmEnvironment,
} from "../bgmEnvironment";

const PUBLIC_PACK = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const DT = 1 / 12;
const MONTH_PLUS = BGM_SAVED_TENORS_YEARS.filter((t) => t >= DT - 1e-12);
/** The kernel default subset, restated: expiries 1M, 3M, 6M, 1Y, 2Y, 5Y, 10Y by tenors 1Y, 2Y, 5Y, 10Y. */
const SUBSET_EXPIRIES = [1 / 12, 3 / 12, 6 / 12, 1, 2, 5, 10];
const SUBSET_TENORS = [1, 2, 5, 10];
const inSet = (x: number, set: number[]): boolean => set.some((v) => Math.abs(x - v) < 1e-9);
const inSubset = (q: { expiryYears: number; tenorYears: number }): boolean =>
  inSet(q.expiryYears, SUBSET_EXPIRIES) && inSet(q.tenorYears, SUBSET_TENORS);

const OVERRIDE: BgmModelOverride = { a: 0.2, b: 0.5, c: 0.48, d: 0.8, beta: 0.0, volScalar: 0.031, reason: "illustrative" };
const ZERO_VOL: BgmModelOverride = { ...OVERRIDE, volScalar: 0, reason: "zero-vol degeneracy probe" };

let snapshot: MarketSnapshot;
let curve: ZeroCurve;
beforeAll(async () => {
  snapshot = await loadMarketSnapshot(PUBLIC_PACK);
  curve = buildBaseCurve(snapshot);
});

/** The 1D saved row of path p at sim index k, restated from the kernel's flat tensor layout. */
function oneDay(env: BgmEnvironment, p: number, k: number): number {
  const nSteps = env.sim.times.length;
  return env.sim.rates[(p * nSteps + k) * env.sim.tenors.length + 0];
}

describe("BGM calibration on the default subset of the long-yield volatility surface", () => {
  let env: BgmEnvironment;
  beforeAll(() => {
    env = buildBgmEnvironment(snapshot, curve, { horizonMonths: 120, nPaths: 20, seed: 7n });
  });

  it("fits the 28-point subset at 12.45 bp on curve default v2, reports the 10 bp gate, records the iteration cap", () => {
    const c = env.calibration;
    if (c.source !== "long-yield-atm-calibration") throw new Error(`unexpected arm ${c.source}`);
    expect(c.nQuotes).toBe(28);
    expect(c.subset).toHaveLength(28);
    expect(c.subset.every(inSubset)).toBe(true);
    expect(snapshot.swaptionATMQuotes.filter(inSubset)).toHaveLength(28);
    expect(Object.keys(c.subset[0])).toEqual(["expiryYears", "tenorYears"]);
    expect(c.rmseGateBp).toBe(10);
    expect(c.rmseGateBreached).toBe(c.rmseBp > 10);
    expect(c.rmseBp).toBeCloseTo(12.45, 2);
    expect(c.rmseGateBreached).toBe(true);
    expect(c.iterations).toBe(150);
    expect(c.displacement).toBe(0.05);
    expect(c.cevBeta).toBe(0.5);
    expect(Object.keys(c)).toEqual([
      "source", "a", "b", "c", "d", "beta", "volScalar", "displacement", "cevBeta",
      "rmseBp", "rmseGateBp", "rmseGateBreached", "nQuotes", "subset", "iterations",
    ]);
  });

  it("simulates 360 months and hands out horizonMonths rows of paths and discount factors", () => {
    expect(env.sim.times.length).toBe(360);
    expect(env.sim.nPaths).toBe(20);
    expect(env.paths).toHaveLength(20);
    expect(env.discount.Dcorr).toHaveLength(20);
    for (let p = 0; p < 20; p++) {
      expect(env.paths[p].nSteps).toBe(120);
      expect(env.discount.Dcorr[p].length).toBe(120);
    }
    expect(env.simulation.savedTenors).toEqual([...BGM_SAVED_TENORS_YEARS]);
    expect(env.simulation.nCapFires).toBe(0);
    expect(env.simulation.nFloorFires).toBe(0);
    expect(env.simulation.nTotalEvolutions).toBe(env.sim.nTotalEvolutions);
    expect(env.simulation.nTotalEvolutions).toBeGreaterThan(0);
    expect(env.simulation.fixedCostMs).toBeGreaterThan(0);
    expect(Object.keys(env.simulation)).toEqual(["nCapFires", "nFloorFires", "nTotalEvolutions", "savedTenors", "fixedCostMs"]);
  });

  it("restates the martingale block at the run horizon on the 1D row, corrected residual below 1e-8 bp", () => {
    const m = env.martingale;
    const h = 120;
    expect(m.terminalYears).toBeCloseTo(h * DT, 12);
    expect(m.correctedMaxAbsErrBp).toBeLessThan(1e-8);

    // Corrected identity over the run horizon, restated.
    let maxErr = 0;
    for (let k = 0; k < h; k++) {
      let mean = 0;
      for (let p = 0; p < 20; p++) mean += env.discount.Dcorr[p][k];
      mean /= 20;
      maxErr = Math.max(maxErr, Math.abs(mean - curve.discountFactor((k + 1) * DT)) * 1e4);
    }
    expect(maxErr).toBeLessThan(1e-8);

    // Uncorrected trapezoid drift at the run horizon, restated.
    const f0 = -Math.log(curve.discountFactor(DT)) / DT;
    let rawMean = 0;
    for (let p = 0; p < 20; p++) {
      let cum = 1;
      let prev = f0;
      for (let k = 0; k < h; k++) {
        const r = oneDay(env, p, k);
        cum *= Math.exp(-0.5 * (prev + r) * DT);
        prev = r;
      }
      rawMean += cum;
    }
    rawMean /= 20;
    const raw = (rawMean - curve.discountFactor(h * DT)) * 1e4;
    expect(Math.abs(m.rawTerminalErrBp - raw)).toBeLessThan(1e-9);
    expect(m.rawTerminalErrBp).not.toBe(0);

    // Antithetic-pair SE of the corrected terminal DF, restated.
    const last = h - 1;
    let mean = 0;
    for (let p = 0; p < 20; p++) mean += env.discount.Dcorr[p][last];
    mean /= 20;
    let ss = 0;
    for (let j = 0; j < 10; j++) {
      const pm = (env.discount.Dcorr[2 * j][last] + env.discount.Dcorr[2 * j + 1][last]) / 2;
      ss += (pm - mean) ** 2;
    }
    const se = Math.sqrt(ss / 9) / Math.sqrt(10);
    expect(Math.abs(m.terminalDfStandardError - se)).toBeLessThan(1e-15);
    expect(m.terminalDfStandardError).toBeGreaterThan(0);
  });
});

describe("BGM zero-vol degeneracy through the environment", () => {
  for (const horizon of [120, 360]) {
    it(`every path equals DeterministicRatePath and every corrected DF equals the curve at horizon ${horizon}`, () => {
      const env = buildBgmEnvironment(snapshot, curve, { horizonMonths: horizon, nPaths: 4, seed: 1n, modelParams: ZERO_VOL });
      expect(env.sim.times.length).toBe(360);
      const det = new DeterministicRatePath(curve, horizon, DT);
      for (const path of env.paths) {
        for (let s = 0; s < horizon; s++) {
          expect(Math.abs(path.rateAt(s) - det.rateAt(s))).toBeLessThan(1e-12);
          for (const tau of MONTH_PLUS) {
            expect(Math.abs(path.forwardRateAt(s, tau) - det.forwardRateAt(s, tau))).toBeLessThan(1e-12);
          }
        }
      }
      for (const d of env.discount.Dcorr) {
        for (let k = 0; k < horizon; k++) {
          expect(Math.abs(d[k] / curve.discountFactor((k + 1) * DT) - 1)).toBeLessThan(1e-12);
        }
      }
      expect(env.martingale.correctedMaxAbsErrBp).toBeLessThan(1e-8);
      expect(env.martingale.terminalDfStandardError).toBeLessThan(1e-15);
    });
  }

  it("records the override arm verbatim, with the model key that tells it from the HW override", () => {
    const env = buildBgmEnvironment(snapshot, curve, { horizonMonths: 12, nPaths: 20, seed: 1n, modelParams: ZERO_VOL });
    expect(env.calibration).toEqual({ source: "override", model: "bgm-lmm-2f", ...ZERO_VOL });
    expect(Object.keys(env.calibration)).toEqual(["source", "model", "a", "b", "c", "d", "beta", "volScalar", "reason"]);
  });
});

describe("BGM refusals (decision 84)", () => {
  const OPTS = { horizonMonths: 12, nPaths: 20, seed: 1n };

  function caught(f: () => unknown): unknown {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  }

  it("refuses a short-rate volatility shock first, with and without an override, in the decision 84 c words", () => {
    const shocked = deriveMarketSnapshot(snapshot, [{ op: "scale-short-rate-vol", value: 1.5 }], {
      baseId: "market-public-2026-03-31",
    }).snapshot;
    for (const opts of [OPTS, { ...OPTS, modelParams: OVERRIDE }]) {
      const err = caught(() => buildBgmEnvironment(shocked, curve, opts));
      expect(err).toBeInstanceOf(BgmShockUnreadError);
      expect((err as BgmShockUnreadError).layer).toBe("stochastic.calibration");
      expect((err as Error).message).toContain(
        "the market carries a short-rate volatility shock, which the BGM model does not read " +
          "(it calibrates to the long-yield surface), so the shock would be silently ignored; " +
          "run Hull-White on this market, or BGM on the unshocked base.",
      );
    }
    // First: an empty long-yield block on a shocked market still reads the shock refusal.
    const shockedEmpty = { ...shocked, swaptionATMQuotes: [] } as MarketSnapshot;
    expect(caught(() => buildBgmEnvironment(shockedEmpty, curve, OPTS))).toBeInstanceOf(BgmShockUnreadError);
    // A TLP-only derived market is not a short-rate volatility shock.
    const tlp = deriveMarketSnapshot(snapshot, [{ op: "add", value: 10 }], { baseId: "market-public-2026-03-31" }).snapshot;
    expect(buildBgmEnvironment(tlp, curve, { ...OPTS, modelParams: OVERRIDE }).calibration.source).toBe("override");
  });

  it("refuses an empty long-yield volatility block without an override, and waives it under one", () => {
    const empty = { ...snapshot, swaptionATMQuotes: [] } as MarketSnapshot;
    const err = caught(() => buildBgmEnvironment(empty, curve, OPTS));
    expect(err).toBeInstanceOf(StochasticLongYieldVolsError);
    expect((err as StochasticLongYieldVolsError).layer).toBe("stochastic.calibration");
    expect((err as Error).message).toContain("long-yield volatility surface");
    expect(buildBgmEnvironment(empty, curve, { ...OPTS, modelParams: OVERRIDE }).calibration.source).toBe("override");
  });

  it("refuses a default subset under 8 points, naming the subset and the count, and waives it under an override", () => {
    const sub = snapshot.swaptionATMQuotes.filter(inSubset);
    const offSubset = snapshot.swaptionATMQuotes.filter((q) => !inSubset(q));
    const thin = { ...snapshot, swaptionATMQuotes: [...offSubset, ...sub.slice(0, 7)] } as MarketSnapshot;
    const err = caught(() => buildBgmEnvironment(thin, curve, OPTS));
    expect(err).toBeInstanceOf(BgmSubsetError);
    expect((err as BgmSubsetError).found).toBe(7);
    expect((err as Error).message).toContain("7 of the 28");
    expect((err as Error).message).toContain("at least 8");
    expect(buildBgmEnvironment(thin, curve, { ...OPTS, modelParams: OVERRIDE }).calibration.source).toBe("override");
    // A block holding no subset point at all is the subset refusal with count 0, not the empty-block one.
    const none = { ...snapshot, swaptionATMQuotes: offSubset } as MarketSnapshot;
    const err0 = caught(() => buildBgmEnvironment(none, curve, OPTS));
    expect(err0).toBeInstanceOf(BgmSubsetError);
    expect((err0 as BgmSubsetError).found).toBe(0);
  });

  it("refuses a horizon beyond the 360-month BGM grid", () => {
    expect(() => buildBgmEnvironment(snapshot, curve, { ...OPTS, horizonMonths: 361, modelParams: OVERRIDE })).toThrow(/360/);
  });
});
