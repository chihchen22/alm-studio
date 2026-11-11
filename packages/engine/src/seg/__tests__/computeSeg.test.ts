/**
 * Task 5 (spec E1 and E7): the shape and the aggregation
 * rules of the SEG block, on hand-checkable books over a flat 3% par curve.
 *
 * segBank follows the bank print: (NII_dn - NII_up)(i) x 12 / 0.002 with
 * index i = month i + 1. Month 1 is unshocked, so segBank[0] is 0 by
 * construction; the first month a shock can show is index 1 (month 2). For a
 * fixed asset plus a floating liability of 100M each, only the liability
 * reprices, so segBank[1] = +100M: liability-sensitive, positive.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { loadMarket } from "../../run/__tests__/fixtures";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { SEG_DEFAULTS } from "../computeSeg";
import { M, N, cdPosition, fixedLoan, floatingLoan, runSeg } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

function twoPosition() {
  return runSeg(market, [fixedLoan("fixed"), floatingLoan("funding", { side: "liability" })]);
}

describe("computeSegBlock: shape and headline fields", () => {
  it("writes the convention, the base scenario, the shock sizes and the horizons", () => {
    const { result } = twoPosition();
    expect(result.convention).toBe("constant-balance-sheet");
    expect(result.scenarioId).toBe("S0");
    expect(result.shockBp).toBe(10);
    expect(result.niiShockBp).toBe(200);
    expect(result.horizonMonths).toBe(60);
    expect(result.niiHorizonMonths).toBe(12);
    expect(SEG_DEFAULTS).toEqual({ horizonMonths: 60, niiHorizonMonths: 12, shockBp: 10, niiShockBp: 200 });
  });

  it("series lengths: outstanding and periodic 61, EBP and segBank 60, NII monthly 12", () => {
    const { result, perPosition } = twoPosition();
    for (const s of [result.book, result.byFamily.FIXED!, result.byFamily["FLOAT-L"]!]) {
      expect(s.segOutstanding).toHaveLength(61);
      expect(s.segPeriodic).toHaveLength(61);
      expect(s.ebpAssets).toHaveLength(60);
      expect(s.ebpLiabilities).toHaveLength(60);
      expect(s.nii.baseMonthly).toHaveLength(12);
    }
    expect(result.segBank).toHaveLength(60);
    expect(perPosition.get("fixed")!.ebp).toHaveLength(60);
    expect(perPosition.get("fixed")!.segOutstanding).toHaveLength(61);
  });

  it("segBank of a fixed asset plus a floating liability is positive (liability-sensitive) from the first shocked month", () => {
    const { result } = twoPosition();
    expect(result.segBank[0]).toBe(0);
    expect(result.segBank[1]!).toBeGreaterThan(0);
    expect(Math.abs(result.segBank[1]! - N)).toBeLessThan(1e-6);
    // The fixed asset reprices only at month 60 (index 59 reads month 60, before its vintage earns).
    expect(Math.abs(result.segBank[58]! - N)).toBeLessThan(1e-6);
  });

  it("the signed book series: asset +100M locked, liability floater 0 after t = 0", () => {
    const { result } = twoPosition();
    expect(result.book.segOutstanding[0]).toBe(0); // +100M asset, -100M liability
    expect(Math.abs(result.book.segOutstanding[1]! - N)).toBeLessThan(1e-6);
    // A plateau at +100M for t = 1..59 (the peak month on it is whichever last
    // bit is largest), and 0 at t = 60 once the fixed asset reprices.
    expect(result.book.segPeak.month).toBeGreaterThanOrEqual(1);
    expect(result.book.segPeak.month).toBeLessThanOrEqual(59);
    expect(Math.abs(result.book.segPeak.value - N)).toBeLessThan(1e-6);
    expect(Math.abs(result.book.segOutstanding[60]!)).toBeLessThan(1e-6);
    expect(result.byFamily["FLOAT-L"]!.segOutstanding[0]).toBe(-N);
  });

  it("EBP: unsigned opening balances by side, months 1..60", () => {
    const { result, perPosition } = twoPosition();
    for (let t = 0; t < 60; t++) {
      expect(result.book.ebpAssets[t]).toBeCloseTo(N, 6);
      expect(result.book.ebpLiabilities[t]).toBeCloseTo(N, 6);
    }
    expect(result.byFamily.FIXED!.ebpLiabilities.every((x) => x === 0)).toBe(true);
    expect(perPosition.get("funding")!.ebp[0]).toBeCloseTo(N, 6);
  });

  it("NII is signed by side: the liability's interest is negative", () => {
    const { result } = twoPosition();
    expect(result.byFamily["FLOAT-L"]!.nii.base12).toBeLessThan(0);
    expect(result.byFamily.FIXED!.nii.base12).toBeGreaterThan(0);
    expect(result.book.nii.base12).toBeCloseTo(
      result.byFamily.FIXED!.nii.base12 + result.byFamily["FLOAT-L"]!.nii.base12,
      6,
    );
  });

  it("nimPct = 100 x book base12 / total asset notional", () => {
    const { result } = twoPosition();
    expect(result.totalAssetNotional).toBe(N);
    expect(result.nimPct).toBe((100 * result.book.nii.base12) / N);
  });
});

describe("computeSegBlock: aggregation", () => {
  it("the book is the sum of its families, every series", () => {
    const { result } = runSeg(market, [
      fixedLoan("f1"),
      fixedLoan("f2", { amortType: "level-pay", notional: 40 * M }),
      floatingLoan("v1"),
      floatingLoan("l1", { side: "liability", notional: 120 * M }),
    ]);
    expect(Object.keys(result.byFamily)).toEqual(["FIXED", "FLOAT", "FLOAT-L"]);
    const fams = Object.values(result.byFamily);
    const sum = (pick: (s: (typeof fams)[number]) => number[], i: number) => fams.reduce((s, f) => s + pick(f)[i]!, 0);
    for (let t = 0; t <= 60; t++) {
      expect(result.book.segOutstanding[t]).toBeCloseTo(sum((f) => f.segOutstanding, t), 4);
      expect(result.book.segPeriodic[t]).toBeCloseTo(sum((f) => f.segPeriodic, t), 4);
    }
    for (let t = 0; t < 60; t++) {
      expect(result.book.ebpAssets[t]).toBeCloseTo(sum((f) => f.ebpAssets, t), 4);
      expect(result.book.ebpLiabilities[t]).toBeCloseTo(sum((f) => f.ebpLiabilities, t), 4);
    }
    for (let m = 0; m < 12; m++) {
      expect(result.book.nii.upMonthly[m]).toBeCloseTo(sum((f) => f.nii.upMonthly, m), 6);
    }
    expect(result.totalAssetNotional).toBe(240 * M);
  });

  it("byAttributionGroup is left out when no position carries the dimension", () => {
    const { result } = twoPosition();
    expect("byAttributionGroup" in result).toBe(false);
  });

  it("byAttributionGroup sums NII by the dimension; an untagged position lands under 'unassigned'", () => {
    const { result } = runSeg(market, [
      fixedLoan("f1", {}, { attributionGroup: "asset-spread" }),
      floatingLoan("v1", {}, { attributionGroup: "asset-spread" }),
      floatingLoan("l1", { side: "liability" }),
    ]);
    const groups = result.byAttributionGroup!;
    expect(Object.keys(groups)).toEqual(["asset-spread", "unassigned"]);
    const assets = result.byFamily.FIXED!.nii.base12 + result.byFamily.FLOAT!.nii.base12;
    expect(groups["asset-spread"]!.base12).toBeCloseTo(assets, 6);
    expect(groups.unassigned!.down12).toBeCloseTo(result.byFamily["FLOAT-L"]!.nii.down12, 6);
  });
});

describe("computeSegBlock: what it does not cover", () => {
  it("a cd position lands in uncovered with the kernel-rule reason and moves no total", () => {
    const withCd = runSeg(market, [fixedLoan("fixed"), cdPosition("cd-1")]);
    const without = runSeg(market, [fixedLoan("fixed")]);
    expect(withCd.result.uncovered).toEqual([
      { positionId: "cd-1", reason: "no replacement vintage for cd (kernel rule)" },
    ]);
    expect(withCd.perPosition.has("cd-1")).toBe(false);
    expect("CD" in withCd.result.byFamily).toBe(false);
    expect(JSON.stringify(withCd.result.book)).toBe(JSON.stringify(without.result.book));
    expect(JSON.stringify(withCd.result.segBank)).toBe(JSON.stringify(without.result.segBank));
  });

  it("a seasoned fixed loan lands in uncovered: the kernel rule anchors its cash flows at origination", () => {
    const { result, perPosition } = runSeg(market, [fixedLoan("seasoned", { originationOffsetMonths: -12 })]);
    expect(result.uncovered).toHaveLength(1);
    expect(result.uncovered[0]!.positionId).toBe("seasoned");
    expect(result.uncovered[0]!.reason).toMatch(/originationOffsetMonths -12/);
    expect(perPosition.size).toBe(0);
  });

  it("a position the factory cannot build lands in uncovered with its type named", () => {
    const { result } = runSeg(market, [fixedLoan("fixed"), floatingLoan("odd")], {
      makeInstrument: (p) => (p.id === "odd" ? null : makeInstrument(p.terms)),
    });
    expect(result.uncovered).toEqual([{ positionId: "odd", reason: "no kernel instrument for floating-loan" }]);
  });

  it("an empty uncovered list is still written (a required field), and the JSON carries no NaN", () => {
    const { result } = twoPosition();
    expect(result.uncovered).toEqual([]);
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/NaN|null/);
  });

  it("two runs serialize byte-identically", () => {
    expect(JSON.stringify(twoPosition().result)).toBe(JSON.stringify(twoPosition().result));
  });
});
