/**
 * Piece 2b acceptance (d), the plan-less half: buildCellPlan is the one refusal
 * both paths go through, so the rule and the position it names here are the
 * rule and the position a COMPILE refusal names. The compile half lives in
 * compile.test.ts, where the mount-and-dispose helpers already are.
 */
import { describe, expect, it } from "vitest";
import { ViewDefinitionError } from "../../run/executorErrors";
import { buildCellPlan } from "../../portfolio/cells";
import { BY_SEGMENT_VIEW, segmentedNmdBook, viewSegmentedBook } from "../../run/__tests__/fixtures";

describe("a plan's views", () => {
  it("refuses the same book, the same rule and the same position on both paths", () => {
    const book = segmentedNmdBook();
    let planLess: ViewDefinitionError | undefined;
    try {
      buildCellPlan(book, [BY_SEGMENT_VIEW]);
    } catch (e) {
      planLess = e as ViewDefinitionError;
    }
    expect(planLess?.rule).toBe("P3");
    expect(planLess?.positionId).toBe("F1");
  });

  it("accepts the book every position of which carries the grouped tag", () => {
    expect(() => buildCellPlan(viewSegmentedBook(), [BY_SEGMENT_VIEW])).not.toThrow();
  });
});
