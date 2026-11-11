/**
 * The chunk core keys on the CELL index, and the family
 * arrays are the ordered fold over each family's contiguous cell range. Under
 * the identity plan that range holds one cell and the fold aliases it, so the
 * family arrays are literally the pre-2b arrays.
 */
import { describe, expect, it } from "vitest";
// NOT a kernel export: the engine's own test stub (see the note).
import { ConstantRatePath } from "../../runtime/__tests__/stubRatePath";
import { buildCellPlan } from "../../portfolio/cells";
import { accumulateChunk, allocMasterSink, foldCellsToFamilies } from "../shard/chunk";
import { twoSidedBook, viewSegmentedBook, BY_SEGMENT_VIEW } from "./fixtures";

const HORIZON = 120;
const path = new ConstantRatePath(0.04, HORIZON);

function accumulate(book: ReturnType<typeof twoSidedBook>, views: Parameters<typeof buildCellPlan>[1]) {
  const plan = buildCellPlan(book, views);
  const sink = allocMasterSink(plan.cells.length, HORIZON);
  accumulateChunk(book.positions, 0, book.positions.length, plan.cellIndexByPosition, path, HORIZON, sink);
  return { plan, sink };
}

describe("the cell-grain sink", () => {
  it("under the identity plan the family fold ALIASES, so the arrays are the same objects", () => {
    const { plan, sink } = accumulate(twoSidedBook(), undefined);
    const fam = foldCellsToFamilies(sink, plan.familyCellRange, HORIZON);
    for (let i = 0; i < plan.familyCellRange.length; i++) {
      expect(fam.balance[i]).toBe(sink.balance[i]);
      expect(fam.principal[i]).toBe(sink.principal[i]);
      expect(fam.interest[i]).toBe(sink.interest[i]);
      expect(fam.repricing[i]).toBe(sink.repricing[i]);
      expect(fam.gapPrincipal[i]).toBe(sink.gapPrincipal[i]);
    }
  });

  it("a segmented family's cells sum bucket-wise to what the identity plan books for it", () => {
    const book = viewSegmentedBook();
    const plain = accumulate(book, undefined);
    const split = accumulate(book, [BY_SEGMENT_VIEW]);
    const familyIds = book.coa.families.map((f) => f.id);
    const ddaIdx = familyIds.indexOf("DDA");

    const folded = foldCellsToFamilies(split.sink, split.plan.familyCellRange, HORIZON);
    for (const metric of ["balance", "principal", "interest", "repricing", "gapPrincipal"] as const) {
      const got = folded[metric][ddaIdx]!;
      const want = plain.sink[metric][ddaIdx]!;
      for (let k = 0; k < HORIZON; k++) {
        expect(Math.abs(got[k]! - want[k]!)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want[k]!)));
      }
    }
  });

  it("a family holding one cell under a view is BITWISE equal to its identity-plan series", () => {
    const book = viewSegmentedBook();
    const plain = accumulate(book, undefined);
    const split = accumulate(book, [BY_SEGMENT_VIEW]);
    const familyIds = book.coa.families.map((f) => f.id);
    const folded = foldCellsToFamilies(split.sink, split.plan.familyCellRange, HORIZON);
    for (const id of ["FIXED", "MORTGAGE", "MMA"]) {
      const i = familyIds.indexOf(id);
      const range = split.plan.familyCellRange[i]!;
      expect(range.end - range.start).toBe(1);
      expect([...folded.principal[i]!]).toEqual([...plain.sink.principal[i]!]);
      expect([...folded.interest[i]!]).toEqual([...plain.sink.interest[i]!]);
    }
  });
});
