/**
 * Stochastic envelope contract 0.3.0.
 *
 *  - The BGM constants carry the values of record: gate 10 bp, subset floor 8, the ten saved tenors,
 *    and the override bounds (the kernel's fit bounds with the volScalar floor opened to 0).
 *  - A stored 0.2.0 envelope still reads as a StochasticRunResult, and its HW calibration arm keeps its
 *    key order through a JSON round trip, byte for byte against the committed golden
 *    run/__tests__/golden/stochastic-hw-vanilla-64.json (sha256 412426dc...).
 *  - The two BGM arms and the simulation block type-check (the root typecheck reads this file).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BGM_OVERRIDE_BOUNDS,
  BGM_RMSE_GATE_BP,
  BGM_SAVED_TENORS_YEARS,
  BGM_SUBSET_MIN_POINTS,
  HW_RMSE_GATE_BP,
  STOCHASTIC_RESULT_SCHEMA_VERSION,
  type BgmModelOverride,
  type StochasticCalibrationSummary,
  type StochasticModel,
  type StochasticRunResult,
} from "../stochastic";

const FIXTURE = fileURLToPath(new URL("../../run/__tests__/golden/stochastic-hw-vanilla-64.json", import.meta.url));

describe("stochastic contract 0.3.0 constants", () => {
  it("moves the envelope to 0.3.0 and keeps the HW gate", () => {
    expect(STOCHASTIC_RESULT_SCHEMA_VERSION).toBe("0.3.0");
    expect(HW_RMSE_GATE_BP).toBe(5);
  });

  it("names the two models", () => {
    const models: StochasticModel[] = ["hull-white-1f", "bgm-lmm-2f"];
    expect(models).toHaveLength(2);
  });

  it("pins the BGM gate, subset floor and saved tenors", () => {
    expect(BGM_RMSE_GATE_BP).toBe(10);
    expect(BGM_SUBSET_MIN_POINTS).toBe(8);
    expect([...BGM_SAVED_TENORS_YEARS]).toEqual([1 / 360, 1 / 12, 1, 2, 3, 5, 7, 10, 20, 30]);
  });

  it("pins the BGM override bounds (decision 84)", () => {
    expect(BGM_OVERRIDE_BOUNDS).toEqual({
      a: [0, 5],
      b: [0, 5],
      c: [1e-3, 5],
      d: [0, 5],
      beta: [-1, 1],
      volScalar: [0, 2],
    });
    const probe: BgmModelOverride = { a: 0.1, b: 0.1, c: 1, d: 0.01, beta: 0.1, volScalar: 0, reason: "zero-vol probe" };
    expect(Object.keys(probe)).toEqual(["a", "b", "c", "d", "beta", "volScalar", "reason"]);
  });
});

describe("a stored 0.2.0 envelope", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const parsed = JSON.parse(text) as StochasticRunResult;

  it("parses as a StochasticRunResult with the HW model and no simulation block", () => {
    expect(parsed.schemaVersion).toBe("0.2.0");
    expect(parsed.kind).toBe("stochastic-distribution");
    expect(parsed.model).toBe("hull-white-1f");
    expect(parsed.calibration.source).toBe("cap-atm-calibration");
    expect(Object.prototype.hasOwnProperty.call(parsed, "simulation")).toBe(false);
  });

  it("keeps the HW calibration arm key order through a JSON round trip, byte for byte", () => {
    expect(Object.keys(parsed.calibration)).toEqual([
      "source",
      "a",
      "sigma",
      "rmseBp",
      "rmseGateBp",
      "rmseGateBreached",
      "nQuotes",
      "underlyingTau",
      "iterations",
    ]);
    expect(JSON.stringify(parsed, null, 2) + "\n").toBe(text);
  });
});

describe("the BGM arms and the simulation block type-check", () => {
  it("accepts the long-yield calibration arm, the BGM override arm and a BGM envelope", () => {
    const fitted: StochasticCalibrationSummary = {
      source: "long-yield-atm-calibration",
      a: 0.1,
      b: 0.2,
      c: 0.8,
      d: 0.05,
      beta: 0.1,
      volScalar: 1,
      displacement: 0.05,
      cevBeta: 0.5,
      rmseBp: 12.45,
      rmseGateBp: BGM_RMSE_GATE_BP,
      rmseGateBreached: true,
      nQuotes: 28,
      subset: [{ expiryYears: 1, tenorYears: 5 }],
      iterations: 150,
    };
    const supplied: StochasticCalibrationSummary = {
      source: "override",
      model: "bgm-lmm-2f",
      a: 0.1,
      b: 0.2,
      c: 0.8,
      d: 0.05,
      beta: 0.1,
      volScalar: 0,
      reason: "zero-vol probe",
    };
    const parsed = JSON.parse(readFileSync(FIXTURE, "utf8")) as StochasticRunResult;
    const bgm: StochasticRunResult = {
      ...parsed,
      schemaVersion: STOCHASTIC_RESULT_SCHEMA_VERSION,
      model: "bgm-lmm-2f",
      calibration: fitted,
      simulation: {
        nCapFires: 0,
        nFloorFires: 0,
        nTotalEvolutions: 1000,
        savedTenors: [...BGM_SAVED_TENORS_YEARS],
        fixedCostMs: 3200,
      },
    };
    expect(bgm.model).toBe("bgm-lmm-2f");
    expect(bgm.simulation?.savedTenors).toHaveLength(10);
    expect(supplied.source).toBe("override");
    expect("model" in supplied && supplied.model).toBe("bgm-lmm-2f");
  });
});
