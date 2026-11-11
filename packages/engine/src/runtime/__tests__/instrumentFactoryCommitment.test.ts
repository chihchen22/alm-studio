import { describe, expect, it } from "vitest";
import { makeInstrument } from "../instrumentFactory";
import { EMPTY_DRAW_PATH, type CommitmentTerms } from "../../commitment";

const terms: CommitmentTerms = {
  id: "commit-1",
  type: "commitment",
  notional: 2_000_000,
  maturityMonths: 24,
  originationOffsetMonths: 0,
  amortType: "bullet",
  side: "asset",
  draw: EMPTY_DRAW_PATH,
};

describe("makeInstrument, commitment arm", () => {
  it("builds a commitment instrument from commitment terms", () => {
    const inst = makeInstrument(terms);
    expect(inst.repricingSchedule()).toEqual([]);
  });

  it("an unbound commitment projects an empty stream", () => {
    expect(makeInstrument(terms).generateCashflows({} as never)).toEqual([]);
  });

  it("a bound commitment projects its draws", () => {
    const bound = { ...terms, draw: { rampRates: [0.25], steadyRate: 0 } };
    const rows = makeInstrument(bound).generateCashflows({} as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.principalPaid).toBeCloseTo(-500_000, 6);
  });

  it("refuses invalid commitment terms rather than degrading", () => {
    expect(() => makeInstrument({ ...terms, originationOffsetMonths: -6 })).toThrow(
      /originationOffsetMonths/,
    );
  });
});
