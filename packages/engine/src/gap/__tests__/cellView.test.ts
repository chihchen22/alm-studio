/**
 * accumulateGapPosition writes through an INDEX and never
 * reads famIndex, so a cell-indexed pair of arrays is a legal target. The gap's
 * FamilySeries stays family-indexed; buildLadder and the COA roll-up are
 * untouched (plan deviation 2).
 */
import { describe, expect, it } from "vitest";
// ConstantRatePath is NOT a kernel export: it is the engine's own test stub at
// packages/engine/src/runtime/__tests__/stubRatePath.ts, and every existing
// consumer imports it from there by this relative path.
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { makeInstrument } from "../../runtime/instrumentFactory";
import { fixedPosition, twoSidedBook } from "../../run/__tests__/fixtures";
import { accumulateGapPosition, buildGapFromSeries, createFamilySeries, type BucketSeriesPair } from "../index";

const HORIZON = 60;
const path = new ConstantRatePath(0.04, HORIZON);

describe("accumulateGapPosition targets any indexed pair of series", () => {
  it("writes the same numbers into a bare pair as into a FamilySeries, at the same index", () => {
    const pos = fixedPosition("F1", { notional: 1_000_000, coupon: 0.05, maturityMonths: 24 });
    const inst = makeInstrument(pos.terms);
    const cfs = inst.generateCashflows(path);

    const fam = createFamilySeries(twoSidedBook(), HORIZON);
    accumulateGapPosition(fam, 0, inst, cfs, HORIZON, path);

    const bare: BucketSeriesPair = {
      repricing: [new Float64Array(HORIZON), new Float64Array(HORIZON)],
      principal: [new Float64Array(HORIZON), new Float64Array(HORIZON)],
    };
    accumulateGapPosition(bare, 0, inst, cfs, HORIZON, path);

    expect([...bare.principal[0]!]).toEqual([...fam.principal[0]!]);
    expect([...bare.repricing[0]!]).toEqual([...fam.repricing[0]!]);
    // Index 1 is untouched on both.
    expect([...bare.principal[1]!].every((v) => v === 0)).toBe(true);
  });
});

describe("piece 2c M5: a cell naming a family outside the chart of accounts", () => {
  it("is a throw naming the cell and the family, never booked into equity", () => {
    const book = twoSidedBook();
    const fam = createFamilySeries(book, HORIZON);
    fam.byCell = {
      cells: [{ id: "GHOST|side=asset", familyId: "GHOST", tags: { side: "asset" }, positionCount: 1 }],
      repricing: [new Float64Array(HORIZON)],
      principal: [new Float64Array(HORIZON)],
    };
    expect(() => buildGapFromSeries(book, "S0", fam, HORIZON)).toThrow(/GHOST\|side=asset/);
    expect(() => buildGapFromSeries(book, "S0", fam, HORIZON)).toThrow(/"GHOST"/);
  });
});
