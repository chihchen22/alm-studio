import { describe, expect, it } from "vitest";
import type { EVEResult } from "@alm/engine";
import { eveHasDerivatives } from "../eveRows";

const row = (extra: Record<string, number> = {}) => ({
  scenarioId: "S0",
  pvAssets: 10,
  pvLiabilities: 8,
  eve: 2,
  deltaEveVsBase: 0,
  deltaEvePct: 0,
  byFamily: [],
  durationSanityPassed: true,
  ...extra,
});

describe("eveHasDerivatives", () => {
  it("is false when no scenario carries pvDerivatives", () => {
    expect(eveHasDerivatives({ discountBasis: "all-in", byScenario: [row()] } as EVEResult)).toBe(false);
  });
  it("is true when any scenario carries it, a 0 included", () => {
    expect(eveHasDerivatives({ discountBasis: "all-in", byScenario: [row(), row({ pvDerivatives: 0 })] } as EVEResult)).toBe(true);
  });
});
