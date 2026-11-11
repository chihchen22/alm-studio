import { describe, expect, it } from "vitest";
import type { CurveSetupBlock, MarketWithCurveSetup } from "../curveSetup";

describe("curveSetup contract", () => {
  it("types a setup and allows the block to be absent on a market", () => {
    const block: CurveSetupBlock = {
      id: "cs-test",
      label: "SOFR OIS, log-linear",
      baseCurve: "SOFR",
      interpolation: "log-linear-df",
      dayCount: "ACT/360",
      compounding: "annual",
      inputs: [{ instrument: "cash", tenorMonths: 1, quoteType: "par-rate", value: 0.04 }],
    };
    const withBlock = { curveSetup: block } as Partial<MarketWithCurveSetup>;
    const without = {} as Partial<MarketWithCurveSetup>;
    expect(withBlock.curveSetup?.inputs).toHaveLength(1);
    expect("curveSetup" in without).toBe(false);
  });
});
