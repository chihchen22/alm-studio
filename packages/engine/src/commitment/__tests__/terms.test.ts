import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAW_PATH,
  validateCommitmentTerms,
  type CommitmentTerms,
} from "../terms";

function base(over: Partial<CommitmentTerms> = {}): CommitmentTerms {
  return {
    id: "commit-1",
    type: "commitment",
    notional: 1_000_000,
    maturityMonths: 36,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    draw: EMPTY_DRAW_PATH,
    ...over,
  };
}

describe("validateCommitmentTerms", () => {
  it("accepts a well-formed undrawn line", () => {
    expect(() => validateCommitmentTerms(base())).not.toThrow();
  });

  it("accepts an authored ramp plus steady rate", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [0.35, 0.15], steadyRate: 0.02 } })),
    ).not.toThrow();
  });

  it("accepts an empty ramp", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [], steadyRate: 0.01 } })),
    ).not.toThrow();
  });

  it("refuses a nonzero originationOffsetMonths", () => {
    expect(() => validateCommitmentTerms(base({ originationOffsetMonths: -12 }))).toThrow(
      /originationOffsetMonths/,
    );
  });

  it("refuses a non-positive notional", () => {
    expect(() => validateCommitmentTerms(base({ notional: 0 }))).toThrow(/notional/);
  });

  it("refuses a non-positive maturityMonths", () => {
    expect(() => validateCommitmentTerms(base({ maturityMonths: 0 }))).toThrow(/maturityMonths/);
  });

  it("refuses a ramp rate above 1", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [1.5], steadyRate: 0 } })),
    ).toThrow(/rampRates\[0\]/);
  });

  it("refuses a negative ramp rate", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [-0.1], steadyRate: 0 } })),
    ).toThrow(/rampRates\[0\]/);
  });

  it("refuses a non-finite ramp rate", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [Number.NaN], steadyRate: 0 } })),
    ).toThrow(/rampRates\[0\]/);
  });

  it("refuses a steadyRate outside [0, 1]", () => {
    expect(() =>
      validateCommitmentTerms(base({ draw: { rampRates: [], steadyRate: 1.2 } })),
    ).toThrow(/steadyRate/);
  });

  it("EMPTY_DRAW_PATH draws nothing", () => {
    expect(EMPTY_DRAW_PATH.rampRates).toEqual([]);
    expect(EMPTY_DRAW_PATH.steadyRate).toBe(0);
  });
});
