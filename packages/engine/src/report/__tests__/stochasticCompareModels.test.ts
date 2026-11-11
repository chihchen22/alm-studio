/**
 * A stochastic compare of two different rate models.
 *
 *  - A Hull-White run and a BGM run on one seed and one path count share no draws (Hull-White draws
 *    one normal per antithetic pair per step, BGM two), so their standard-error basis is the additive
 *    `different-models`, never `shared-seed-bound`; the check sits after `same-run` and before the seed
 *    test, so it holds on different seeds and different path counts too.
 *  - The notes gain one sentence naming the two models; an HW pair's notes and bases are unchanged.
 *  - The context stays 23 rows: on the BGM side calibration.a and calibration.sigma read null with
 *    `same: false`, and the model row differs.
 * Expected values are literals restated by hand; only compareStochastic is imported.
 */
import { describe, expect, it } from "vitest";
import type {
  StochasticCalibrationSummary,
  StochasticDistribution,
  StochasticRunResult,
} from "../../contracts/stochastic";
import { compareStochastic } from "../stochasticCompare";

const P = [0.05, 0.25, 0.5, 0.75, 0.95];
const dist = (mean: number, se: number): StochasticDistribution => ({
  nPaths: 20,
  mean,
  standardError: se,
  stdev: 10,
  min: mean - 30,
  max: mean + 30,
  quantiles: P.map((p, i) => ({ p, value: mean - 20 + 10 * i })),
});

const HW_FIT: StochasticCalibrationSummary = {
  source: "cap-atm-calibration",
  a: 0.01,
  sigma: 0.006,
  rmseBp: 0.9,
  rmseGateBp: 5,
  rmseGateBreached: false,
  nQuotes: 15,
  underlyingTau: 0.25,
  iterations: 9,
};
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
  subset: [{ expiryYears: 1, tenorYears: 5 }],
  iterations: 150,
};

function hw(over: Partial<StochasticRunResult> = {}): StochasticRunResult {
  return {
    schemaVersion: "0.3.0",
    kind: "stochastic-distribution",
    model: "hull-white-1f",
    runId: "run-hw",
    scenarioId: "base",
    assumptionSetId: "as-1",
    seed: "42",
    nPaths: 20,
    horizonMonths: 360,
    discountBasis: "all-in",
    calibration: HW_FIT,
    martingale: { correctedMaxAbsErrBp: 0.001, rawTerminalErrBp: 2.5, terminalDfStandardError: 0.0004, terminalYears: 30 },
    eveDistribution: dist(100, 3),
    nii12mDistribution: dist(10, 0),
    notImplemented: [],
    ...over,
  };
}
const bgm = (over: Partial<StochasticRunResult> = {}): StochasticRunResult =>
  hw({ model: "bgm-lmm-2f", runId: "run-bgm", calibration: BGM_FIT, eveDistribution: dist(104, 4), ...over });

const TEXT_DIFFERENT_MODELS =
  "The two runs use different rate models whose simulators draw their random numbers differently (Hull-White one normal per antithetic pair per step, BGM two), so their path sets share no draws even under one seed and one path count. The figure sqrt(SE A^2 + SE B^2) is the standard error of the difference under independence, which the stored statistics cannot confirm, because per-path values are not stored. It is a precision figure, not a test.";
const NOTE_MODELS_HW_BGM =
  "Run A uses the Hull-White one-factor rate model (hull-white-1f) and run B the BGM rate model (bgm-lmm-2f), so every B - A carries the change of model as well as any other change between the runs.";
const NOTE_MODELS_BGM_HW =
  "Run A uses the BGM rate model (bgm-lmm-2f) and run B the Hull-White one-factor rate model (hull-white-1f), so every B - A carries the change of model as well as any other change between the runs.";

describe("a Hull-White and BGM pair", () => {
  const r = compareStochastic({ envelope: hw() }, { envelope: bgm() });

  it("same seed, same nPaths: different-models, never shared-seed-bound", () => {
    for (const d of [r.eveDistribution, r.nii12mDistribution]) {
      expect(d.meanDeltaStandardError.basis).toBe("different-models");
      expect(d.meanDeltaStandardError.basis).not.toBe("shared-seed-bound");
      expect(d.meanDeltaStandardError.text).toBe(TEXT_DIFFERENT_MODELS);
    }
    expect(r.eveDistribution.meanDeltaStandardError.value).toBe(5);
    expect(r.nii12mDistribution.meanDeltaStandardError.value).toBe(0);
  });

  it("different-models also on different seeds and different path counts", () => {
    const other = compareStochastic(
      { envelope: hw() },
      { envelope: bgm({ seed: "7", nPaths: 40, eveDistribution: { ...dist(104, 4), nPaths: 40 } }) },
    );
    expect(other.eveDistribution.meanDeltaStandardError.basis).toBe("different-models");
    expect(other.nii12mDistribution.meanDeltaStandardError.basis).toBe("different-models");
  });

  it("the notes gain one sentence naming the two models, in A then B order", () => {
    expect(r.notes).toHaveLength(4);
    expect(r.notes[3]).toBe(NOTE_MODELS_HW_BGM);
    const flipped = compareStochastic({ envelope: bgm() }, { envelope: hw() });
    expect(flipped.notes[3]).toBe(NOTE_MODELS_BGM_HW);
  });

  it("the context keeps 23 rows; a and sigma read null on the BGM side; the model row differs", () => {
    expect(r.context).toHaveLength(23);
    const row = (f: string) => r.context.find((c) => c.field === f);
    expect(row("model")).toEqual({ field: "model", a: "hull-white-1f", b: "bgm-lmm-2f", same: false });
    expect(row("calibration.a")).toEqual({ field: "calibration.a", a: 0.01, b: null, same: false });
    expect(row("calibration.sigma")).toEqual({ field: "calibration.sigma", a: 0.006, b: null, same: false });
    expect(row("calibration.source")).toEqual({
      field: "calibration.source",
      a: "cap-atm-calibration",
      b: "long-yield-atm-calibration",
      same: false,
    });
  });
});

describe("pairs of one model are unchanged", () => {
  it("an HW pair on one seed and one path count stays shared-seed-bound with three notes", () => {
    const r = compareStochastic({ envelope: hw() }, { envelope: hw({ runId: "run-hw-2" }) });
    expect(r.eveDistribution.meanDeltaStandardError.basis).toBe("shared-seed-bound");
    expect(r.notes).toHaveLength(3);
  });

  it("a BGM pair on one seed and one path count is shared-seed-bound, with no model note", () => {
    const r = compareStochastic({ envelope: bgm() }, { envelope: bgm({ runId: "run-bgm-2" }) });
    expect(r.eveDistribution.meanDeltaStandardError.basis).toBe("shared-seed-bound");
    expect(r.notes).toHaveLength(3);
  });

  it("the same run stays same-run", () => {
    const r = compareStochastic({ envelope: bgm() }, { envelope: bgm() });
    expect(r.eveDistribution.meanDeltaStandardError.basis).toBe("same-run");
  });
});
