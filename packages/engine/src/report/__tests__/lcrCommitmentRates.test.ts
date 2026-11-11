import { describe, expect, it } from "vitest";
import {
  COMMITMENT_CATEGORY_DIMENSION,
  US_LCR_COMMITMENT_DEMO,
} from "../lcr";

describe("US LCR committed-facility rates, 12 CFR 249.32(e)(1)", () => {
  it("pins all six rates", () => {
    expect(US_LCR_COMMITMENT_DEMO).toEqual({
      "facility-retail": 0.05,
      "credit-nonfinancial": 0.1,
      "liquidity-nonfinancial": 0.3,
      "facility-depository": 0.5,
      "credit-financial": 0.4,
      "liquidity-financial": 1,
    });
  });

  it("has exactly six categories", () => {
    expect(Object.keys(US_LCR_COMMITMENT_DEMO)).toHaveLength(6);
  });

  // Title says STRICTLY because the assertions are `toBeGreaterThan`. The
  // earlier title said "at least as heavily", which a pair of equal rates would
  // satisfy and these assertions would not.
  it("rates a liquidity facility strictly more heavily than a credit facility to the same counterparty", () => {
    expect(US_LCR_COMMITMENT_DEMO["liquidity-nonfinancial"]!).toBeGreaterThan(
      US_LCR_COMMITMENT_DEMO["credit-nonfinancial"]!,
    );
    expect(US_LCR_COMMITMENT_DEMO["liquidity-financial"]!).toBeGreaterThan(
      US_LCR_COMMITMENT_DEMO["credit-financial"]!,
    );
  });

  it("names its own dimension, distinct from the liability category", () => {
    expect(COMMITMENT_CATEGORY_DIMENSION).toBe("commitment-category");
  });

  it("every rate is a fraction in [0, 1]", () => {
    for (const [k, v] of Object.entries(US_LCR_COMMITMENT_DEMO)) {
      expect(Number.isFinite(v), k).toBe(true);
      expect(v, k).toBeGreaterThanOrEqual(0);
      expect(v, k).toBeLessThanOrEqual(1);
    }
  });
});
