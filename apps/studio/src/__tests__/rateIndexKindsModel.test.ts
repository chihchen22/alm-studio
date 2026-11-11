import { describe, expect, it } from "vitest";
import { indexTenorText } from "../market/rateIndexModel";

describe("indexTenorText (Piece B, step B3a)", () => {
  it("keeps a compounded window's months and gives the settings of the two new kinds", () => {
    expect(indexTenorText({ id: "rfr-3m", label: "x", tenorMonths: 3, basis: 0 })).toBe("3 months");
    expect(indexTenorText({ id: "c", label: "x", kind: "constant-maturity-swap", tenorYears: 10, basis: 0 })).toBe("constant-maturity swap, 10 years");
    expect(indexTenorText({ id: "f", label: "x", kind: "formula", parent: "rfr-1m", coefficient: 1, basis: 0 })).toBe("formula on rfr-1m, coefficient (level) 1, lag none, floor none, cap none");
    // A beta index starts at start plus basis (F1): the settings text says so beside the start.
    expect(indexTenorText({ id: "b", label: "x", kind: "formula", parent: "rfr-1m", beta: 0.4, start: 0.0433, basis: 0.001 })).toBe(
      "formula on rfr-1m, beta (change) 0.4 from a start of 4.33 percent plus basis, lag none, floor none, cap none",
    );
  });
});
