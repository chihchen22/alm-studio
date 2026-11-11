/**
 * Stochastic Compare: compareStochastic aligns two stored
 * StochasticRunResult envelopes. Every expected value below is a hand-checkable
 * literal restated here; nothing but the function and the error class is
 * imported from the module under test.
 */
import { describe, expect, it } from "vitest";
import type {
  StochasticDistribution,
  StochasticRunResult,
} from "../../contracts/stochastic";
import { compareStochastic, StochasticCompareError } from "../stochasticCompare";

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

/** Run A numbers of vector V1. */
function distA(nPaths = 20): StochasticDistribution {
  return dist(nPaths, 100, 3, 10, 70, 130, [80, 90, 100, 110, 120]);
}
/** Run B numbers of vector V1. */
function distB(nPaths = 20): StochasticDistribution {
  return dist(nPaths, 104, 4, 15, 60, 150, [78, 95, 101, 113, 127]);
}
function nii(nPaths = 20): StochasticDistribution {
  return dist(nPaths, 10, 0, 0, 10, 10, [10, 10, 10, 10, 10]);
}

function env(over: Partial<StochasticRunResult> = {}): StochasticRunResult {
  const nPaths = over.nPaths ?? 20;
  return {
    schemaVersion: "0.1.0",
    kind: "stochastic-distribution",
    model: "hull-white-1f",
    runId: "run-a",
    scenarioId: "base",
    assumptionSetId: "as-1",
    seed: "1",
    nPaths,
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
    eveDistribution: distA(nPaths),
    nii12mDistribution: nii(nPaths),
    notImplemented: [],
    ...over,
  };
}

const envA = (over: Partial<StochasticRunResult> = {}) =>
  env({ runId: "run-a", seed: "1", ...over });
const envB = (over: Partial<StochasticRunResult> = {}) =>
  env({
    runId: "run-b",
    seed: "2",
    eveDistribution: distB(over.nPaths ?? 20),
    ...over,
  });

const TEXT_INDEPENDENT =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. The runs use different seeds, so their path sets are treated as independent and the figure is the standard error of the difference. It is a precision figure, not a test.";
const TEXT_BOUND =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. Both runs use the same seed and the same path count, so their paths share random numbers. The figure is an upper bound on the standard error of the difference only if the two runs' path outcomes are non-negatively correlated; that is typical when paths share random numbers, but the stored statistics cannot confirm it, because per-path values are not stored. It is a precision figure, not a test.";
const TEXT_UNALIGNED =
  "Standard-error figure for the B - A of the means, derived: sqrt(SE A^2 + SE B^2), from the two runs' reported standard errors. Both runs use the same seed but different path counts. The simulation draws its random numbers step by step across all paths, so with different path counts the two path sets do not line up path by path. The figure is therefore neither the exact standard error of the difference nor a proven bound on it; it holds only under an independence assumption that the stored statistics cannot confirm, because per-path values are not stored. It is a precision figure, not a test.";
const TEXT_SAME_RUN =
  "Run A and run B are the same run, so every B - A is zero by construction and no standard-error figure applies.";

const NOTE_1 =
  "A distribution here is a statistic of the Monte Carlo path set, never an EVE or an NII. Every B - A is derived by the server from the two stored envelopes, displayed beside both originals.";
const NOTE_2 =
  "The B - A of a quantile is the difference of the two runs' quantiles. It is not a quantile of the path-by-path difference: per-path values are not stored, so no distribution of B - A exists and none is shown.";
const NOTE_3 =
  "The B - A of the standard deviation, the standard error, the minimum and the maximum is a difference of two estimates, each from its own path set; it carries sampling error of its own that the envelopes do not report.";
const NOTE_4 =
  "The two runs use different path counts, so each statistic is estimated at its own precision; the B - A of a quantile, and most of all of the minimum and the maximum, which widen with the path count, mixes the change between the runs with the change in sample size.";

describe("V1 delta vector", () => {
  const r = compareStochastic({ envelope: envA() }, { envelope: envB() });

  it("rows in fixed order with delta = b - a", () => {
    expect(r.eveDistribution.rows).toEqual([
      { stat: "mean", p: null, a: 100, b: 104, delta: 4 },
      { stat: "standardError", p: null, a: 3, b: 4, delta: 1 },
      { stat: "stdev", p: null, a: 10, b: 15, delta: 5 },
      { stat: "min", p: null, a: 70, b: 60, delta: -10 },
      { stat: "max", p: null, a: 130, b: 150, delta: 20 },
      { stat: "quantile", p: 0.05, a: 80, b: 78, delta: -2 },
      { stat: "quantile", p: 0.25, a: 90, b: 95, delta: 5 },
      { stat: "quantile", p: 0.5, a: 100, b: 101, delta: 1 },
      { stat: "quantile", p: 0.75, a: 110, b: 113, delta: 3 },
      { stat: "quantile", p: 0.95, a: 120, b: 127, delta: 7 },
    ]);
  });

  it("independent seeds figure", () => {
    expect(r.eveDistribution.meanDeltaStandardError).toEqual({
      value: 5,
      basis: "independent-seeds",
      text: TEXT_INDEPENDENT,
    });
    expect(r.sameRun).toBe(false);
    expect(r.kind).toBe("stochastic-compare");
    expect(r.runA).toBe("run-a");
    expect(r.runB).toBe("run-b");
  });

  it("NII distributions compare with zero deltas", () => {
    expect(r.nii12mDistribution.rows).toHaveLength(10);
    for (const row of r.nii12mDistribution.rows) expect(row.delta).toBe(0);
  });

  it("does not mutate its inputs", () => {
    const a = envA();
    const b = envB();
    const before = JSON.stringify([a, b]);
    compareStochastic({ envelope: a }, { envelope: b });
    expect(JSON.stringify([a, b])).toBe(before);
  });
});

describe("V2 shared seed, aligned paths", () => {
  it("is shared-seed-bound at equal nPaths", () => {
    const r = compareStochastic(
      { envelope: envA({ seed: "7" }) },
      { envelope: envB({ seed: "7" }) },
    );
    const f = r.eveDistribution.meanDeltaStandardError;
    expect(f.value).toBe(5);
    expect(f.basis).toBe("shared-seed-bound");
    expect(f.text).toBe(TEXT_BOUND);
    expect(f.text).toContain("the same seed and the same path count");
    expect(f.text).toContain("non-negatively correlated");
    expect(f.text).toContain("per-path values are not stored");
    expect(r.nii12mDistribution.meanDeltaStandardError.basis).toBe("shared-seed-bound");
  });
});

describe("V2b shared seed, unaligned paths", () => {
  const r = compareStochastic(
    {
      envelope: envA({
        seed: "7",
        nPaths: 64,
        eveDistribution: distA(64),
        nii12mDistribution: nii(64),
      }),
    },
    {
      envelope: envB({
        seed: "7",
        nPaths: 32,
        eveDistribution: distB(32),
        nii12mDistribution: nii(32),
      }),
    },
  );
  it("is shared-seed-unaligned-paths, with no exactness or sharing claim", () => {
    const f = r.eveDistribution.meanDeltaStandardError;
    expect(f.value).toBe(5);
    expect(f.basis).toBe("shared-seed-unaligned-paths");
    expect(f.text).toBe(TEXT_UNALIGNED);
    expect(f.text).toContain("do not line up path by path");
    expect(f.text).toContain(
      "neither the exact standard error of the difference nor a proven bound",
    );
    expect(f.text).not.toContain("share random numbers");
    expect(r.nii12mDistribution.meanDeltaStandardError.basis).toBe(
      "shared-seed-unaligned-paths",
    );
  });
});

describe("V3 standard-error figure", () => {
  function withSe(seA: number, seB: number) {
    const ea = envA();
    ea.eveDistribution = { ...ea.eveDistribution, standardError: seA };
    const eb = envB();
    eb.eveDistribution = { ...eb.eveDistribution, standardError: seB };
    return compareStochastic({ envelope: ea }, { envelope: eb }).eveDistribution
      .meanDeltaStandardError.value;
  }
  it("is sqrt(SE A^2 + SE B^2)", () => {
    expect(withSe(0.6, 0.8)).toBeCloseTo(1, 15);
    expect(withSe(0, 0)).toBe(0);
  });
});

describe("V4 same run", () => {
  const r = compareStochastic({ envelope: envA() }, { envelope: envA() });
  it("every delta is zero and the figure is null", () => {
    expect(r.sameRun).toBe(true);
    for (const d of [r.eveDistribution, r.nii12mDistribution]) {
      for (const row of d.rows) expect(row.delta).toBe(0);
      expect(d.meanDeltaStandardError).toEqual({
        value: null,
        basis: "same-run",
        text: TEXT_SAME_RUN,
      });
    }
  });
});

describe("V5 mismatches", () => {
  function thrown(a: StochasticRunResult, b: StochasticRunResult): StochasticCompareError {
    try {
      compareStochastic({ envelope: a }, { envelope: b });
    } catch (e) {
      expect(e).toBeInstanceOf(StochasticCompareError);
      return e as StochasticCompareError;
    }
    throw new Error("expected a throw");
  }

  it("horizonMonths", () => {
    const e = thrown(envA(), envB({ horizonMonths: 120 }));
    expect(e.name).toBe("StochasticCompareError");
    expect(e.field).toBe("horizonMonths");
    expect(e.a).toBe(360);
    expect(e.b).toBe(120);
    expect(e.message).toContain("differ in horizonMonths (360 and 120)");
    expect(e.message).toContain("no B - A is defined");
    expect(e.message).toBe(
      'stochastic compare: runs "run-a" and "run-b" differ in horizonMonths (360 and 120). The horizon bounds the cash flows each path\'s EVE discounts, so the two distributions measure different quantities and no B - A is defined; run both on one horizon.',
    );
  });

  it("discountBasis", () => {
    const e = thrown(envA(), envB({ discountBasis: "risk-free" }));
    expect(e.field).toBe("discountBasis");
    expect(e.a).toBe("all-in");
    expect(e.b).toBe("risk-free");
    expect(e.message).toBe(
      'stochastic compare: runs "run-a" and "run-b" differ in discountBasis ("all-in" and "risk-free"). The basis sets the discount curve of every path\'s EVE, so the two distributions measure different quantities and no B - A is defined; run both on one basis.',
    );
  });

  it("quantile sets", () => {
    const b = envB();
    b.eveDistribution = {
      ...b.eveDistribution,
      quantiles: [
        { p: 0.05, value: 78 },
        { p: 0.5, value: 101 },
        { p: 0.95, value: 127 },
      ],
    };
    const e = thrown(envA(), b);
    expect(e.field).toBe("quantiles");
    expect(e.message).toContain("report different quantile sets");
    expect(e.message).toContain("a quantile compares only with the quantile at the same p.");
  });

  it("kind", () => {
    const bad = { ...envB(), kind: "x" } as unknown as StochasticRunResult;
    const e = thrown(envA(), bad);
    expect(e.field).toBe("kind");
    expect(e.message).toBe(
      'stochastic compare: run "run-b" is not a stochastic distribution envelope (kind x)',
    );
  });
});

describe("V6 nPaths flag", () => {
  it("differing nPaths is shown and noted, not refused", () => {
    const r = compareStochastic(
      { envelope: envA({ nPaths: 64, eveDistribution: distA(64) }) },
      { envelope: envB({ nPaths: 32, eveDistribution: distB(32) }) },
    );
    const row = r.context.find((c) => c.field === "nPaths");
    expect(row).toEqual({ field: "nPaths", a: 64, b: 32, same: false });
    expect(r.notes).toHaveLength(4);
    expect(r.notes[3]).toBe(NOTE_4);
  });
  it("equal nPaths gives three notes", () => {
    const r = compareStochastic({ envelope: envA() }, { envelope: envB() });
    expect(r.notes).toHaveLength(3);
  });
});

describe("V7 context", () => {
  it("has 23 rows in the stated order", () => {
    const r = compareStochastic({ envelope: envA() }, { envelope: envB() });
    expect(r.context.map((c) => c.field)).toEqual([
      "runId",
      "portfolioId",
      "marketId",
      "schemaVersion",
      "model",
      "scenarioId",
      "assumptionSetId",
      "seed",
      "nPaths",
      "horizonMonths",
      "discountBasis",
      "calibration.source",
      "calibration.a",
      "calibration.sigma",
      "calibration.rmseBp",
      "calibration.rmseGateBp",
      "calibration.rmseGateBreached",
      "calibration.nQuotes",
      "calibration.reason",
      "martingale.correctedMaxAbsErrBp",
      "martingale.rawTerminalErrBp",
      "martingale.terminalDfStandardError",
      "martingale.terminalYears",
    ]);
    expect(r.context).toHaveLength(23);
  });

  it("calibrated arm against override arm", () => {
    const over = envB({
      calibration: { source: "override", a: 0.02, sigma: 0.007, reason: "stress lever" },
    });
    const r = compareStochastic({ envelope: envA() }, { envelope: over });
    const get = (f: string) => r.context.find((c) => c.field === f)!;
    expect(get("calibration.source")).toEqual({
      field: "calibration.source",
      a: "cap-atm-calibration",
      b: "override",
      same: false,
    });
    expect(get("calibration.rmseBp")).toEqual({
      field: "calibration.rmseBp",
      a: 7.5,
      b: null,
      same: false,
    });
    expect(get("calibration.rmseGateBp")).toEqual({
      field: "calibration.rmseGateBp",
      a: 5,
      b: null,
      same: false,
    });
    expect(get("calibration.rmseGateBreached")).toEqual({
      field: "calibration.rmseGateBreached",
      a: true,
      b: null,
      same: false,
    });
    expect(get("calibration.nQuotes")).toEqual({
      field: "calibration.nQuotes",
      a: 12,
      b: null,
      same: false,
    });
    expect(get("calibration.reason")).toEqual({
      field: "calibration.reason",
      a: null,
      b: "stress lever",
      same: false,
    });
    expect(get("calibration.a")).toEqual({
      field: "calibration.a",
      a: 0.01,
      b: 0.02,
      same: false,
    });
    expect(get("calibration.sigma").same).toBe(false);
  });

  it("portfolioId and marketId come through when supplied, null when absent", () => {
    const r1 = compareStochastic(
      { envelope: envA(), portfolioId: "pf-1", marketId: "m-a" },
      { envelope: envB(), portfolioId: "pf-1", marketId: "m-b" },
    );
    const get1 = (f: string) => r1.context.find((c) => c.field === f)!;
    expect(get1("portfolioId")).toEqual({
      field: "portfolioId",
      a: "pf-1",
      b: "pf-1",
      same: true,
    });
    expect(get1("marketId")).toEqual({ field: "marketId", a: "m-a", b: "m-b", same: false });
    const r2 = compareStochastic({ envelope: envA() }, { envelope: envB() });
    const get2 = (f: string) => r2.context.find((c) => c.field === f)!;
    expect(get2("portfolioId")).toEqual({ field: "portfolioId", a: null, b: null, same: true });
    expect(get2("marketId")).toEqual({ field: "marketId", a: null, b: null, same: true });
    expect(get2("seed")).toEqual({ field: "seed", a: "1", b: "2", same: false });
    expect(get2("nPaths")).toEqual({ field: "nPaths", a: 20, b: 20, same: true });
  });
});

describe("V8 notes", () => {
  const r = compareStochastic({ envelope: envA() }, { envelope: envB() });
  it("fixed notes in order", () => {
    expect(r.notes[0]).toBe(NOTE_1);
    expect(r.notes[1]).toBe(NOTE_2);
    expect(r.notes[2]).toBe(NOTE_3);
  });
  it("no verdict language anywhere in the reply", () => {
    const s = JSON.stringify(r);
    for (const w of ["significan", "p-value", "t-stat", "confidence"]) {
      expect(s).not.toContain(w);
    }
  });
});
