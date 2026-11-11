/**
 * Single-run stochastic summary: summarizeStochastic reads
 * one stored StochasticRunResult envelope as context rows, statistic rows, the
 * calibration gate state, the verbatim notImplemented list and fixed notes.
 * Every expected value below is a literal restated by hand; only the function,
 * its error class and compareStochastic (for the consistency check) are
 * imported from the code under test.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  StochasticDistribution,
  StochasticRunResult,
} from "../../contracts/stochastic";
import { compareStochastic, type StochasticCompareSide } from "../stochasticCompare";
import { StochasticSummaryError, summarizeStochastic } from "../stochasticSummary";

const P = [0.05, 0.25, 0.5, 0.75, 0.95];

function dist(
  nPaths: number,
  mean: number,
  se: number,
  stdev: number,
  min: number,
  max: number,
  qs: number[],
): StochasticDistribution {
  return {
    nPaths,
    mean,
    standardError: se,
    stdev,
    min,
    max,
    quantiles: qs.map((value, i) => ({ p: P[i]!, value })),
  };
}

function base(over: Partial<StochasticRunResult> = {}): StochasticRunResult {
  return {
    schemaVersion: "0.1.0",
    kind: "stochastic-distribution",
    model: "hull-white-1f",
    runId: "run-a",
    scenarioId: "base",
    assumptionSetId: "as-1",
    seed: "1",
    nPaths: 20,
    horizonMonths: 360,
    discountBasis: "all-in",
    calibration: {
      source: "cap-atm-calibration",
      a: 0.01,
      sigma: 0.006,
      rmseBp: 7.5,
      rmseGateBp: 5,
      rmseGateBreached: true,
      nQuotes: 12,
      underlyingTau: 0.25,
      iterations: 9,
    },
    martingale: {
      correctedMaxAbsErrBp: 0.001,
      rawTerminalErrBp: 2.5,
      terminalDfStandardError: 0.0004,
      terminalYears: 30,
    },
    eveDistribution: dist(20, 100, 3, 10, 70, 130, [80, 90, 100, 110, 120]),
    nii12mDistribution: dist(20, 10, 0, 0, 10, 10, [10, 10, 10, 10, 10]),
    notImplemented: [],
    ...over,
  } as StochasticRunResult;
}

const A: StochasticCompareSide = { envelope: base(), portfolioId: "book-1", marketId: "mkt-1" };
const B: StochasticCompareSide = {
  envelope: base({
    runId: "run-b",
    seed: "2",
    eveDistribution: dist(20, 104, 4, 15, 60, 150, [78, 95, 101, 113, 127]),
  }),
  portfolioId: "book-1",
  marketId: "mkt-2",
};
const C: StochasticCompareSide = {
  envelope: base({
    runId: "run-c",
    seed: "1",
    nPaths: 40,
    eveDistribution: dist(40, 104, 4, 15, 60, 150, [78, 95, 101, 113, 127]),
    nii12mDistribution: dist(40, 10, 0, 0, 10, 10, [10, 10, 10, 10, 10]),
    calibration: { source: "override", a: 0.02, sigma: 0.01, reason: "verification seam" },
  } as Partial<StochasticRunResult>),
};

// Slice two Task 5: reworded to the words of record (was "the at-the-money cap
// volatilities of the run's market snapshot"); the texts are computed on read, so no stored byte moves.
const GATE_WITHIN =
  "Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE is within the acceptance gate, as the envelope records (calibration.rmseGateBreached false).";
const GATE_BREACHED =
  "Calibrated to the at-the-money column of the short-rate volatility surface of the run's market snapshot. The fit RMSE exceeds the acceptance gate, as the envelope records (calibration.rmseGateBreached true). The breach is reported, never refused: the distributions rest on a fit outside the gate.";
const GATE_NONE =
  "The Hull-White parameters were supplied by the caller (calibration.source override), not calibrated to the market snapshot, so no fit RMSE exists and no gate applies. The caller's reason is in calibration.reason.";

const NOTES = [
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every statistic is read verbatim from the run's stored envelope, and portfolioId and marketId from its stored submission; none is derived.",
  "The standard error is the standard error of the mean, computed by the engine over antithetic-pair averages (nPaths / 2 independent samples). The standard deviation is the per-path dispersion, not a standard error.",
  "Each quantile is the engine's interpolation between order statistics at the pinned p. Per-path values are not stored, so no other quantile is available.",
  "The distributions are for the base scenario only, the scenario the context names in scenarioId.",
];

describe("summarizeStochastic", () => {
  it("V1: reads envelope A as 23 context rows, two distributions, the gate and notes", () => {
    const s = summarizeStochastic(A);
    expect(s.kind).toBe("stochastic-run-summary");
    expect(s.runId).toBe("run-a");
    expect(s.context).toEqual([
      { field: "runId", value: "run-a" },
      { field: "portfolioId", value: "book-1" },
      { field: "marketId", value: "mkt-1" },
      { field: "schemaVersion", value: "0.1.0" },
      { field: "model", value: "hull-white-1f" },
      { field: "scenarioId", value: "base" },
      { field: "assumptionSetId", value: "as-1" },
      { field: "seed", value: "1" },
      { field: "nPaths", value: 20 },
      { field: "horizonMonths", value: 360 },
      { field: "discountBasis", value: "all-in" },
      { field: "calibration.source", value: "cap-atm-calibration" },
      { field: "calibration.a", value: 0.01 },
      { field: "calibration.sigma", value: 0.006 },
      { field: "calibration.rmseBp", value: 7.5 },
      { field: "calibration.rmseGateBp", value: 5 },
      { field: "calibration.rmseGateBreached", value: true },
      { field: "calibration.nQuotes", value: 12 },
      { field: "calibration.reason", value: null },
      { field: "martingale.correctedMaxAbsErrBp", value: 0.001 },
      { field: "martingale.rawTerminalErrBp", value: 2.5 },
      { field: "martingale.terminalDfStandardError", value: 0.0004 },
      { field: "martingale.terminalYears", value: 30 },
    ]);
    expect(s.eveDistribution).toEqual({
      rows: [
        { stat: "mean", p: null, value: 100 },
        { stat: "standardError", p: null, value: 3 },
        { stat: "stdev", p: null, value: 10 },
        { stat: "min", p: null, value: 70 },
        { stat: "max", p: null, value: 130 },
        { stat: "quantile", p: 0.05, value: 80 },
        { stat: "quantile", p: 0.25, value: 90 },
        { stat: "quantile", p: 0.5, value: 100 },
        { stat: "quantile", p: 0.75, value: 110 },
        { stat: "quantile", p: 0.95, value: 120 },
      ],
    });
    expect(s.nii12mDistribution).toEqual({
      rows: [
        { stat: "mean", p: null, value: 10 },
        { stat: "standardError", p: null, value: 0 },
        { stat: "stdev", p: null, value: 0 },
        { stat: "min", p: null, value: 10 },
        { stat: "max", p: null, value: 10 },
        { stat: "quantile", p: 0.05, value: 10 },
        { stat: "quantile", p: 0.25, value: 10 },
        { stat: "quantile", p: 0.5, value: 10 },
        { stat: "quantile", p: 0.75, value: 10 },
        { stat: "quantile", p: 0.95, value: 10 },
      ],
    });
    expect(s.calibrationGate).toEqual({
      state: "gate-breached",
      rmseBp: 7.5,
      rmseGateBp: 5,
      text: GATE_BREACHED,
    });
    expect(s.notImplemented).toEqual([]);
    expect(s.notes).toEqual(NOTES);
    // The envelope's calibration arm, verbatim and additive.
    expect(s.calibration).toEqual({
      source: "cap-atm-calibration",
      a: 0.01,
      sigma: 0.006,
      rmseBp: 7.5,
      rmseGateBp: 5,
      rmseGateBreached: true,
      nQuotes: 12,
      underlyingTau: 0.25,
      iterations: 9,
    });
    expect(s.calibration).not.toBe(A.envelope.calibration);
  });

  it("V6: a stored 0.2.0 envelope (the HW golden) summarises with the reworded text and its calibration", () => {
    const golden = JSON.parse(
      readFileSync(new URL("../../run/__tests__/golden/stochastic-hw-vanilla-64.json", import.meta.url), "utf8"),
    ) as StochasticRunResult;
    expect(golden.schemaVersion).toBe("0.2.0");
    const s = summarizeStochastic({ envelope: golden });
    expect(s.calibrationGate).toEqual({
      state: "within-gate",
      rmseBp: 0.9009946994701852,
      rmseGateBp: 5,
      text: GATE_WITHIN,
    });
    expect(s.calibration).toEqual({
      source: "cap-atm-calibration",
      a: 0.010724117190284644,
      sigma: 0.006116484379837266,
      rmseBp: 0.9009946994701852,
      rmseGateBp: 5,
      rmseGateBreached: false,
      nQuotes: 15,
      underlyingTau: 0.25,
      iterations: 2000,
    });
    expect(s.context).toHaveLength(23);
  });

  it("V2: a fit within the gate", () => {
    const e = base();
    const s = summarizeStochastic({
      envelope: {
        ...e,
        calibration: {
          source: "cap-atm-calibration",
          a: 0.01,
          sigma: 0.006,
          rmseBp: 0.9,
          rmseGateBp: 5,
          rmseGateBreached: false,
          nQuotes: 12,
          underlyingTau: 0.25,
          iterations: 9,
        },
      },
    });
    expect(s.calibrationGate).toEqual({
      state: "within-gate",
      rmseBp: 0.9,
      rmseGateBp: 5,
      text: GATE_WITHIN,
    });
  });

  it("V3: an override calibration has no gate and null fit fields", () => {
    const s = summarizeStochastic(C);
    const byField = new Map(s.context.map((r) => [r.field, r.value]));
    expect(byField.get("calibration.source")).toBe("override");
    expect(byField.get("calibration.a")).toBe(0.02);
    expect(byField.get("calibration.sigma")).toBe(0.01);
    expect(byField.get("calibration.rmseBp")).toBeNull();
    expect(byField.get("calibration.rmseGateBp")).toBeNull();
    expect(byField.get("calibration.rmseGateBreached")).toBeNull();
    expect(byField.get("calibration.nQuotes")).toBeNull();
    expect(byField.get("calibration.reason")).toBe("verification seam");
    expect(byField.get("portfolioId")).toBeNull();
    expect(byField.get("marketId")).toBeNull();
    expect(byField.get("nPaths")).toBe(40);
    expect(s.calibrationGate).toEqual({
      state: "no-gate",
      rmseBp: null,
      rmseGateBp: null,
      text: GATE_NONE,
    });
  });

  it("V4: notImplemented passes through verbatim as a copy", () => {
    const tags = [
      {
        _tag: "not-implemented" as const,
        layer: "stochastic.shocked-scenarios",
        reason: "base only, by design",
      },
    ];
    const e = base({ notImplemented: tags } as Partial<StochasticRunResult>);
    const s = summarizeStochastic({ envelope: e });
    expect(s.notImplemented).toEqual([
      { _tag: "not-implemented", layer: "stochastic.shocked-scenarios", reason: "base only, by design" },
    ]);
    expect(s.notImplemented).not.toBe(e.notImplemented);
  });

  it("V5: refuses an envelope whose kind is not stochastic-distribution", () => {
    const e = base({ kind: "x" } as unknown as Partial<StochasticRunResult>);
    let caught: unknown;
    try {
      summarizeStochastic({ envelope: e });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StochasticSummaryError);
    const err = caught as StochasticSummaryError;
    expect(err.name).toBe("StochasticSummaryError");
    expect(err.message).toBe(
      'stochastic summary: run "run-a" is not a stochastic distribution envelope (kind x)',
    );
    expect(err.field).toBe("kind");
    expect(err.value).toBe("x");
  });

  it("consistency: the context matches compareStochastic's side A field for field", () => {
    const s = summarizeStochastic(A);
    const c = compareStochastic(A, B);
    expect(s.context.map((r) => r.field)).toEqual(c.context.map((r) => r.field));
    s.context.forEach((r, i) => {
      expect(r.value).toBe(c.context[i]!.a);
    });
  });
});
