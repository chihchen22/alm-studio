/**
 * Two simple loans on a flat 3% par curve.
 * Expected values are restated by hand from the signed convention.
 *
 *   fixed 5.00% bullet: outstanding +100M for t = 0..59, 0 at t = 60
 *   floater 1M + 200bp: outstanding +100M at t = 0, 0 for t >= 1
 *   a fixed liability reads -100M at t = 0
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { loadMarket } from "../../run/__tests__/fixtures";
import { M, N, fixedLoan, floatingLoan, runSeg } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

describe("SEG on two simple loans (flat 3% curve)", () => {
  it("fixed 5.00% 60-month bullet: +100M at t = 0, 0 at month 60, periodic sums to 100M", () => {
    const { result, perPosition } = runSeg(market, [fixedLoan("fixed")]);
    const out = result.book.segOutstanding;
    expect(out).toHaveLength(61);
    expect(out[0]).toBe(N);
    for (let t = 1; t < 60; t++) expect(Math.abs(out[t]! - N)).toBeLessThan(1e-6);
    expect(Math.abs(out[60]!)).toBeLessThan(1e-6);
    const per = result.book.segPeriodic;
    expect(per).toHaveLength(61);
    expect(per[0]).toBe(0);
    expect(Math.abs(per.reduce((s, x) => s + x, 0) - N)).toBeLessThan(1e-6);
    expect(perPosition.get("fixed")!.segOutstanding).toEqual(out);
  });

  it("floater 1M + 200bp: +100M at t = 0 and 0 for every t >= 1", () => {
    const { result } = runSeg(market, [floatingLoan("floater")]);
    const out = result.book.segOutstanding;
    expect(out[0]).toBe(N);
    for (let t = 1; t <= 60; t++) expect(Math.abs(out[t]!)).toBeLessThan(1e-6);
  });

  it("a fixed-loan liability reads -100M at t = 0 and 0 at month 60", () => {
    const { result } = runSeg(market, [fixedLoan("fixed-l", { side: "liability" })]);
    expect(result.book.segOutstanding[0]).toBe(-N);
    expect(Math.abs(result.book.segOutstanding[30]! - -N)).toBeLessThan(1e-6);
    expect(Math.abs(result.book.segOutstanding[60]!)).toBeLessThan(1e-6);
  });

  it("shock invariance: the fixed loans' outstanding SEG at 5, 10 and 25bp agrees within 0.1%", () => {
    // The bullet is invariant by construction; the level-pay loan's vintages
    // amortise on a shocked coupon, so it is the case with bite.
    for (const amortType of ["bullet", "level-pay"] as const) {
      const at = (shockBp: number) =>
        runSeg(market, [fixedLoan("fixed", { amortType })], { shockBp }).result.book.segOutstanding;
      const ref = at(10);
      for (const bp of [5, 25]) {
        const other = at(bp);
        for (let t = 0; t <= 60; t++) expect(Math.abs(other[t]! - ref[t]!)).toBeLessThanOrEqual(0.001 * N);
      }
    }
  });

  it("constant-balance NII: a 100M 5% bullet earns 5M over 12 months, and up12 equals base12", () => {
    const { result, perPosition } = runSeg(market, [fixedLoan("fixed")]);
    const nii = result.book.nii;
    expect(Math.abs(nii.base12 - 5 * M)).toBeLessThan(1e-6);
    expect(Math.abs(nii.up12 - nii.base12)).toBeLessThan(1e-6);
    expect(Math.abs(nii.down12 - nii.base12)).toBeLessThan(1e-6);
    expect(nii.baseMonthly).toHaveLength(12);
    expect(nii.upMonthly).toHaveLength(12);
    expect(nii.downMonthly).toHaveLength(12);
    const row = perPosition.get("fixed")!;
    expect(row.niiBase12).toBe(nii.base12);
    expect(row.niiUp12).toBe(nii.up12);
    expect(row.niiDown12).toBe(nii.down12);
  });

  it("the floater's constant-balance NII moves by 200bp from month 2: 11 shocked months of 100M", () => {
    const { result } = runSeg(market, [floatingLoan("floater")]);
    const nii = result.book.nii;
    // Month 1 reads step 0, unshocked; months 2..12 read the shocked steps.
    expect(Math.abs(nii.upMonthly[0]! - nii.baseMonthly[0]!)).toBeLessThan(1e-9);
    expect(Math.abs(nii.up12 - nii.base12 - (11 * N * 0.02) / 12)).toBeLessThan(1e-6);
    expect(Math.abs(nii.base12 - nii.down12 - (11 * N * 0.02) / 12)).toBeLessThan(1e-6);
  });
});
