/**
 * Byte guard for compareStochastic. The lengths and sha256
 * digests below were measured on unmodified source before the
 * shared stochastic field helpers were introduced. They prove the refactor
 * leaves the compare reply byte-identical. This file is never edited and the
 * pins are never re-measured.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  StochasticDistribution,
  StochasticRunResult,
} from "../../contracts/stochastic";
import { compareStochastic, type StochasticCompareSide } from "../stochasticCompare";

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

function bytes(x: StochasticCompareSide, y: StochasticCompareSide): { length: number; sha256: string } {
  const s = JSON.stringify(compareStochastic(x, y));
  return { length: s.length, sha256: createHash("sha256").update(s).digest("hex") };
}

describe("compareStochastic reply bytes (pinned on unmodified source)", () => {
  it("AB: independent seeds, two markets", () => {
    expect(bytes(A, B)).toEqual({
      length: 4008,
      sha256: "3b60163ea58d3961e166ee2b880dc697ebfd91a31fc5843ff63c25d8272d863c",
    });
  });

  it("AA: the same run on both sides", () => {
    expect(bytes(A, A)).toEqual({
      length: 3616,
      sha256: "c19753a7530688d84cf172a2d27ce78ea22d21195db17ad8730f4e576407d77f",
    });
  });

  it("AC: shared seed, different path counts, override calibration, no ids", () => {
    expect(bytes(A, C)).toEqual({
      length: 4910,
      sha256: "121b71682070fd9acc2c8f21be49ae6bca04fd76a27dc9694619dff6fb8a29d1",
    });
  });
});
