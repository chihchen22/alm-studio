import { describe, expect, it } from "vitest";
import { medianOf, pairedRatios, splitStochasticTiming } from "../benchSplit";

describe("splitStochasticTiming", () => {
  it("splits a BGM run into fixed cost, the rest of the environment build, and projection", () => {
    const s = splitStochasticTiming({ wholeMs: 20_000, envReadyMs: 4_000, fixedCostMs: 3_200, nPaths: 256 });
    expect(s.wholeMs).toBe(20_000);
    expect(s.fixedCostMs).toBe(3_200);
    expect(s.envBuildMs).toBe(800);
    expect(s.projectionMs).toBe(16_000);
    expect(s.perPathMs).toBe(62.5);
  });

  it("treats a run with no fixed cost (Hull-White) as all environment build before the projection", () => {
    const s = splitStochasticTiming({ wholeMs: 19_000, envReadyMs: 1_000, nPaths: 256 });
    expect(s.fixedCostMs).toBe(0);
    expect(s.envBuildMs).toBe(1_000);
    expect(s.projectionMs).toBe(18_000);
    expect(s.perPathMs).toBeCloseTo(18_000 / 256, 12);
  });

  it("refuses timings that do not nest", () => {
    expect(() => splitStochasticTiming({ wholeMs: 10, envReadyMs: 11, nPaths: 2 })).toThrow(/nest/);
    expect(() => splitStochasticTiming({ wholeMs: 10, envReadyMs: 5, fixedCostMs: 6, nPaths: 2 })).toThrow(/nest/);
    expect(() => splitStochasticTiming({ wholeMs: 10, envReadyMs: 5, nPaths: 0 })).toThrow(/nPaths/);
  });
});

describe("pairedRatios and medianOf", () => {
  it("divides round by round", () => {
    expect(pairedRatios([2, 9, 4], [1, 3, 4])).toEqual([2, 3, 1]);
  });

  it("refuses unequal round counts", () => {
    expect(() => pairedRatios([1, 2], [1])).toThrow(/rounds/);
  });

  it("takes the upper middle as the script's median does", () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(3);
  });
});
