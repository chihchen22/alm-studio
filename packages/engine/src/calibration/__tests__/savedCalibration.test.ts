/**
 * Studio slice S2b-3 test (c), the engine half. A fit with no solver option is the run-time fit (Hull-White near
 * 0.89 bp within its 5 bp gate; BGM near 12.45 bp outside its 10 bp gate, stopping at its 150-iteration cap). A run
 * that uses a saved Hull-White fit and a run that passes the same parameters through the override seam are
 * byte-equal in everything but the calibration arm and its schema stamp. A saved fit on another curve is refused.
 * Expected magnitudes are the measured figures of record, not read back from this module.
 */
import { describe, expect, it } from "vitest";
import { calibrateHW } from "@alm/kernel";
import { runStochastic } from "../../run/stochastic";
import { baseAssumptions, loadMarket, makeRunRequest, regulatoryScenarios, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { bgmSolverOptionsOf, CalibrationFitError, curveFingerprintOf, fitCalibration, savedCalibrationMismatch, type SavedCalibrationUse } from "../savedCalibration";

const market = await loadMarket();

function use(fit: ReturnType<typeof fitCalibration>, over: Partial<SavedCalibrationUse> = {}): SavedCalibrationUse {
  return {
    calibrationId: "cal-test",
    model: fit.model,
    parameters: fit.parameters,
    rmseBp: fit.rmseBp,
    gateBp: fit.gateBp,
    breached: fit.breached,
    acceptance: fit.breached ? { kind: "outside-gate", reason: "teaching run" } : { kind: "within-gate" },
    pins: { marketId: "m", marketHash: "h", curveDefault: fit.curveDefault, curveFingerprint: fit.curveFingerprint },
    ...over,
  };
}

function request() {
  const set = baseAssumptions();
  return makeRunRequest(market, { runId: "RUN-CAL", seed: "20261103", assumptionSets: [set], scenarios: [regulatoryScenarios(set.id)[0]!] });
}

describe("fitting as its own action", () => {
  it("Hull-White: the run-time fit exactly, near 0.89 bp, within its 5 bp gate", () => {
    const fit = fitCalibration(market, "hull-white-1f");
    const direct = calibrateHW(market, buildBaseCurve(market));
    expect(fit.parameters).toEqual({ model: "hull-white-1f", a: direct.a, sigma: direct.sigma });
    expect(fit.rmseBp).toBe(direct.rmseBp);
    expect(fit.rmseBp).toBeGreaterThan(0.85);
    expect(fit.rmseBp).toBeLessThan(0.95);
    expect([fit.gateBp, fit.breached]).toEqual([5, false]);
    expect(fit.quotes.length).toBe(fit.nQuotes);
    for (const q of fit.quotes) expect(q.residualBp).toBeCloseTo(q.modelVolBp - q.marketVolBp, 9);
  });

  it("BGM: near 12.45 bp, outside its 10 bp gate, stopping at the 150-iteration cap; solver options reach the kernel", () => {
    const fit = fitCalibration(market, "bgm-lmm-2f");
    expect(fit.rmseBp).toBeGreaterThan(12.3);
    expect(fit.rmseBp).toBeLessThan(12.6);
    expect([fit.gateBp, fit.breached, fit.iterations]).toEqual([10, true, 150]);
    const short = fitCalibration(market, "bgm-lmm-2f", { maxIterations: 5, aInit: 0.6, bInit: 0.6, cInit: 0.65, dInit: 0.7 });
    expect(short.iterations).toBeLessThanOrEqual(5);
    expect(short.solver).toEqual({ maxIterations: 5, aInit: 0.6, bInit: 0.6, cInit: 0.65, dInit: 0.7 });
    expect(short.rmseBp).not.toBe(fit.rmseBp);
  }, 60_000);

  it("refuses solver options on Hull-White and bad options on BGM, in words", () => {
    expect(() => fitCalibration(market, "hull-white-1f", { maxIterations: 10 })).toThrow("BGM fit only");
    expect(() => bgmSolverOptionsOf({ maxIterations: 0 })).toThrow(CalibrationFitError);
    expect(() => bgmSolverOptionsOf({ tolerance: 1 })).toThrow('unknown solver option "tolerance"');
  });
});

describe("a run on a saved fit", () => {
  it("is byte-equal to the override seam with the same parameters, the calibration arm and stamp aside", () => {
    const fit = fitCalibration(market, "hull-white-1f");
    const p = fit.parameters as { a: number; sigma: number };
    const saved = runStochastic(request(), twoSidedBook(), { nPaths: 20, savedCalibration: use(fit) });
    const override = runStochastic(request(), twoSidedBook(), { nPaths: 20, modelParams: { a: p.a, sigma: p.sigma, reason: "same parameters" } });
    expect(saved.schemaVersion).toBe("0.5.0");
    expect(override.schemaVersion).toBe("0.3.0");
    expect(saved.calibration).toEqual({
      source: "saved-calibration", model: "hull-white-1f", calibrationId: "cal-test", parameters: fit.parameters,
      rmseBp: fit.rmseBp, rmseGateBp: 5, rmseGateBreached: false, marketId: "m", marketHash: "h", curveFingerprint: fit.curveFingerprint,
    });
    const strip = (e: Record<string, unknown>) => JSON.stringify({ ...e, calibration: null, schemaVersion: null });
    expect(strip(saved as unknown as Record<string, unknown>)).toBe(strip(override as unknown as Record<string, unknown>));
  });

  it("refuses a fit on another curve, beside modelParams, and for another model", () => {
    const fit = fitCalibration(market, "hull-white-1f");
    const other = use(fit, { pins: { marketId: "m", marketHash: "h", curveDefault: fit.curveDefault, curveFingerprint: "not-this-curve" } });
    expect(() => runStochastic(request(), twoSidedBook(), { nPaths: 20, savedCalibration: other })).toThrow("fitted on a different curve");
    expect(() => runStochastic(request(), twoSidedBook(), { nPaths: 20, savedCalibration: use(fit), modelParams: { a: 0.1, sigma: 0.01, reason: "x" } })).toThrow("not both");
    expect(() => runStochastic(request(), twoSidedBook(), { nPaths: 20, model: "bgm-lmm-2f", savedCalibration: use(fit) })).toThrow("is a hull-white-1f fit");
  });

  it("names the snapshot in one sentence when the market differs", () => {
    const fit = fitCalibration(market, "hull-white-1f");
    const why = savedCalibrationMismatch(use(fit, { pins: { marketId: "snap-a", marketHash: "h1", curveDefault: "", curveFingerprint: fit.curveFingerprint } }), "snap-b", "h2", curveFingerprintOf(market));
    expect(why).toBe('The saved calibration cal-test was fitted on market snapshot "snap-a", and this run reads "snap-b": fit the model again on this market, or run on that one.');
  });
});
