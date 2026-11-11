/**
 * The report readers over the two BGM calibration arms (Task 1 narrowing).
 *
 *  - contextValues keeps its 23 rows for every arm; on a BGM arm calibration.a and calibration.sigma
 *    read null, the fit figures read verbatim on the long-yield arm and the
 *    reason on the BGM override arm.
 *  - calibrationParametersText gives "a=..., sigma=..." for HW and the six Rebonato values with
 *    displacement and CEV for BGM, every number read verbatim (String of the stored value).
 *  - summarizeStochastic reads the long-yield arm against its 10 bp gate in the BGM texts, the BGM
 *    override as no-gate naming the model, and carries every arm verbatim in `calibration`.
 * Expected values are literals restated by hand.
 */
import { describe, expect, it } from "vitest";
import type {
  StochasticCalibrationSummary,
  StochasticDistribution,
  StochasticRunResult,
} from "../../contracts/stochastic";
import { calibrationParametersText, contextValues } from "../stochasticFields";
import { summarizeStochastic } from "../stochasticSummary";

const P = [0.05, 0.25, 0.5, 0.75, 0.95];
const dist = (mean: number): StochasticDistribution => ({
  nPaths: 20,
  mean,
  standardError: 1,
  stdev: 2,
  min: mean - 5,
  max: mean + 5,
  quantiles: P.map((p, i) => ({ p, value: mean - 2 + i })),
});

const HW_FIT: StochasticCalibrationSummary = {
  source: "cap-atm-calibration",
  a: 0.01,
  sigma: 0.006,
  rmseBp: 2,
  rmseGateBp: 5,
  rmseGateBreached: false,
  nQuotes: 15,
  underlyingTau: 0.25,
  iterations: 9,
};
const HW_OVERRIDE: StochasticCalibrationSummary = { source: "override", a: 0.03, sigma: 0.01, reason: "stress lever" };
const BGM_FIT: StochasticCalibrationSummary = {
  source: "long-yield-atm-calibration",
  a: 0.11,
  b: 0.22,
  c: 0.8,
  d: 0.05,
  beta: 0.1,
  volScalar: 1.25,
  displacement: 0.05,
  cevBeta: 0.5,
  rmseBp: 12.45,
  rmseGateBp: 10,
  rmseGateBreached: true,
  nQuotes: 28,
  subset: [
    { expiryYears: 1, tenorYears: 5 },
    { expiryYears: 5, tenorYears: 5 },
  ],
  iterations: 150,
};
const BGM_OVERRIDE: StochasticCalibrationSummary = {
  source: "override",
  model: "bgm-lmm-2f",
  a: 0.1,
  b: 0.2,
  c: 0.7,
  d: 0.04,
  beta: 0.3,
  volScalar: 0,
  reason: "zero-vol probe",
};

const BGM_ARMS = new Set<StochasticCalibrationSummary>([BGM_FIT, BGM_OVERRIDE]);

function envelope(calibration: StochasticCalibrationSummary): StochasticRunResult {
  return {
    schemaVersion: "0.3.0",
    kind: "stochastic-distribution",
    model: BGM_ARMS.has(calibration) ? "bgm-lmm-2f" : "hull-white-1f",
    runId: "run-x",
    scenarioId: "base",
    assumptionSetId: "as-1",
    seed: "1",
    nPaths: 20,
    horizonMonths: 360,
    discountBasis: "all-in",
    calibration,
    martingale: { correctedMaxAbsErrBp: 0.001, rawTerminalErrBp: 2.5, terminalDfStandardError: 0.0004, terminalYears: 30 },
    eveDistribution: dist(100),
    nii12mDistribution: dist(10),
    notImplemented: [],
  };
}

const calRows = (c: StochasticCalibrationSummary) =>
  contextValues(envelope(c), {}).filter((r) => r.field.startsWith("calibration."));

describe("contextValues over every calibration arm", () => {
  it("keeps 23 rows for all four arms", () => {
    for (const c of [HW_FIT, HW_OVERRIDE, BGM_FIT, BGM_OVERRIDE]) {
      expect(contextValues(envelope(c), {})).toHaveLength(23);
    }
  });

  it("reads the HW arms as before", () => {
    expect(calRows(HW_FIT)).toEqual([
      { field: "calibration.source", value: "cap-atm-calibration" },
      { field: "calibration.a", value: 0.01 },
      { field: "calibration.sigma", value: 0.006 },
      { field: "calibration.rmseBp", value: 2 },
      { field: "calibration.rmseGateBp", value: 5 },
      { field: "calibration.rmseGateBreached", value: false },
      { field: "calibration.nQuotes", value: 15 },
      { field: "calibration.reason", value: null },
    ]);
    expect(calRows(HW_OVERRIDE)).toEqual([
      { field: "calibration.source", value: "override" },
      { field: "calibration.a", value: 0.03 },
      { field: "calibration.sigma", value: 0.01 },
      { field: "calibration.rmseBp", value: null },
      { field: "calibration.rmseGateBp", value: null },
      { field: "calibration.rmseGateBreached", value: null },
      { field: "calibration.nQuotes", value: null },
      { field: "calibration.reason", value: "stress lever" },
    ]);
  });

  it("reads a and sigma null on the long-yield arm, with its fit figures verbatim", () => {
    expect(calRows(BGM_FIT)).toEqual([
      { field: "calibration.source", value: "long-yield-atm-calibration" },
      { field: "calibration.a", value: null },
      { field: "calibration.sigma", value: null },
      { field: "calibration.rmseBp", value: 12.45 },
      { field: "calibration.rmseGateBp", value: 10 },
      { field: "calibration.rmseGateBreached", value: true },
      { field: "calibration.nQuotes", value: 28 },
      { field: "calibration.reason", value: null },
    ]);
  });

  it("reads a and sigma null on the BGM override arm, with its reason verbatim", () => {
    expect(calRows(BGM_OVERRIDE)).toEqual([
      { field: "calibration.source", value: "override" },
      { field: "calibration.a", value: null },
      { field: "calibration.sigma", value: null },
      { field: "calibration.rmseBp", value: null },
      { field: "calibration.rmseGateBp", value: null },
      { field: "calibration.rmseGateBreached", value: null },
      { field: "calibration.nQuotes", value: null },
      { field: "calibration.reason", value: "zero-vol probe" },
    ]);
  });
});

describe("calibrationParametersText", () => {
  it("names a and sigma for HW", () => {
    expect(calibrationParametersText(HW_FIT)).toBe("a=0.01, sigma=0.006");
    expect(calibrationParametersText(HW_OVERRIDE)).toBe("a=0.03, sigma=0.01");
  });

  it("names the six Rebonato values with displacement and CEV for BGM", () => {
    expect(calibrationParametersText(BGM_FIT)).toBe(
      "a=0.11, b=0.22, c=0.8, d=0.05, beta=0.1, volScalar=1.25, displacement=0.05, cevBeta=0.5",
    );
    expect(calibrationParametersText(BGM_OVERRIDE)).toBe(
      "a=0.1, b=0.2, c=0.7, d=0.04, beta=0.3, volScalar=0, displacement=0.05, cevBeta=0.5",
    );
  });
});

const BGM_WITHIN =
  "Calibrated to the default subset of the long-yield volatility surface (28 points) of the run's market snapshot. The fit RMSE is within the acceptance gate, as the envelope records (calibration.rmseGateBreached false).";
const BGM_BREACHED =
  "Calibrated to the default subset of the long-yield volatility surface (28 points) of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.";
const BGM_NONE =
  "The BGM parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.";
const HW_NONE =
  "The Hull-White parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.";

describe("summarizeStochastic over the BGM arms (slice two, Task 5)", () => {
  it("reads a breached long-yield fit with the BGM text, naming the subset count", () => {
    expect(summarizeStochastic({ envelope: envelope(BGM_FIT) }).calibrationGate).toEqual({
      state: "gate-breached",
      rmseBp: 12.45,
      rmseGateBp: 10,
      text: BGM_BREACHED,
    });
  });

  it("reads a long-yield fit within the gate with the BGM text", () => {
    const within: StochasticCalibrationSummary = { ...BGM_FIT, rmseBp: 8.5, rmseGateBreached: false };
    BGM_ARMS.add(within);
    expect(summarizeStochastic({ envelope: envelope(within) }).calibrationGate).toEqual({
      state: "within-gate",
      rmseBp: 8.5,
      rmseGateBp: 10,
      text: BGM_WITHIN,
    });
  });

  it("reads the BGM override as no-gate, naming the model", () => {
    expect(summarizeStochastic({ envelope: envelope(BGM_OVERRIDE) }).calibrationGate).toEqual({
      state: "no-gate",
      rmseBp: null,
      rmseGateBp: null,
      text: BGM_NONE,
    });
  });

  it("carries the calibration arm verbatim in the additive calibration field", () => {
    for (const c of [HW_FIT, HW_OVERRIDE, BGM_FIT, BGM_OVERRIDE]) {
      const s = summarizeStochastic({ envelope: envelope(c) });
      expect(s.calibration).toEqual(c);
      expect(s.calibration).not.toBe(c);
    }
  });

  it("leaves the HW gate states and the HW override text unchanged", () => {
    expect(summarizeStochastic({ envelope: envelope(HW_FIT) }).calibrationGate.state).toBe("within-gate");
    expect(summarizeStochastic({ envelope: envelope(HW_OVERRIDE) }).calibrationGate).toEqual({
      state: "no-gate",
      rmseBp: null,
      rmseGateBp: null,
      text: HW_NONE,
    });
  });
});
