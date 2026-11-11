/**
 * The cell plan: the identity plan is today's family index
 * renamed, and the general plan is family-major with a contiguous range per
 * family. Spec Sections 2.2, 3 and 4 (P4).
 */
import { describe, expect, it } from "vitest";
import {
  twoSidedBook,
  segmentedNmdBook,
  viewSegmentedBook,
  BY_SEGMENT_VIEW,
} from "../../run/__tests__/fixtures";
import { ExecutorError, ViewDefinitionError } from "../../run/executorErrors";
import { buildCellPlan, cellIdOf, toViewResults } from "../cells";

describe("cellIdOf", () => {
  it("is familyId + pipe for a cell with no tags", () => {
    expect(cellIdOf("DDA", {})).toBe("DDA|");
  });
  it("sorts keys ascending and JSON-quotes scalar values", () => {
    expect(cellIdOf("DDA", { vintage: "2021", segment: "rate-shopper" })).toBe(
      'DDA|{"segment":"rate-shopper","vintage":"2021"}',
    );
  });
});

describe("buildCellPlan, the identity plan", () => {
  const book = twoSidedBook();
  const families = book.coa.families.map((f) => f.id);

  it("gives one cell per DECLARED family, in declared order, with no tags", () => {
    const plan = buildCellPlan(book, undefined);
    expect(plan.cells.map((c) => c.familyId)).toEqual(families);
    expect(plan.cells.map((c) => c.id)).toEqual(families.map((f) => `${f}|`));
    expect(plan.cells.every((c) => Object.keys(c.tags).length === 0)).toBe(true);
  });
  it("makes familyCellRange[i] exactly {i, i+1} and groupingDimensions empty", () => {
    const plan = buildCellPlan(book, []);
    expect(plan.familyCellRange).toEqual(families.map((_, i) => ({ start: i, end: i + 1 })));
    expect(plan.groupingDimensions).toEqual([]);
    expect(plan.views).toEqual([]);
  });
  it("maps every position to its declared family index", () => {
    const plan = buildCellPlan(book, undefined);
    expect([...plan.cellIndexByPosition]).toEqual(
      book.positions.map((p) => families.indexOf(p.familyId)),
    );
  });
  it("P4: the cell position counts sum to the book's position count", () => {
    const plan = buildCellPlan(book, undefined);
    const total = plan.cells.reduce((a, c) => a + c.positionCount, 0);
    expect(total).toBe(book.positions.length);
  });
  it("refuses a position naming a family the chart of accounts does not declare", () => {
    const bad = { ...book, positions: [{ ...book.positions[0]!, familyId: "GHOST" }] };
    expect(() => buildCellPlan(bad, undefined)).toThrow(/buildCellPlan: position "F1" references unknown family "GHOST"/);
  });
});

describe("buildCellPlan, a view on segment", () => {
  const book = viewSegmentedBook();
  const plan = buildCellPlan(book, [BY_SEGMENT_VIEW]);
  const families = book.coa.families.map((f) => f.id);

  it("splits the deposit family into two cells, 2 rate shoppers and 1 relationship", () => {
    const dda = plan.cells.filter((c) => c.familyId === "DDA");
    expect(dda.map((c) => [c.id, c.positionCount])).toEqual([
      ['DDA|{"segment":"rate-shopper"}', 2],
      ['DDA|{"segment":"relationship"}', 1],
    ]);
  });
  it("orders cells family-major on declared COA order, then by id ascending", () => {
    const order = plan.cells.map((c) => c.familyId);
    const firstSeen: string[] = [];
    for (const f of order) if (firstSeen.at(-1) !== f) firstSeen.push(f);
    expect(firstSeen).toEqual(firstSeen.filter((f, i) => firstSeen.indexOf(f) === i));
    expect(firstSeen).toEqual(families.filter((f) => order.includes(f)));
    // The second half of the order contract: within a family, canonical id
    // ascending. Compare the array AS STORED against a sorted copy; comparing
    // two sorted copies would assert nothing.
    const dda = plan.cells.filter((c) => c.familyId === "DDA").map((c) => c.id);
    expect(dda).toEqual([...dda].sort());
  });
  it("gives each family a contiguous half-open cell range", () => {
    for (let i = 0; i < families.length; i++) {
      const r = plan.familyCellRange[i]!;
      for (let c = r.start; c < r.end; c++) expect(plan.cells[c]!.familyId).toBe(families[i]);
    }
    const spans = plan.familyCellRange.reduce((a, r) => a + (r.end - r.start), 0);
    expect(spans).toBe(plan.cells.length);
  });
  it("records the grouping dimensions as the sorted union of every view's groupBy", () => {
    expect(plan.groupingDimensions).toEqual(["segment"]);
  });
  it("P4: cell counts and every view's group counts each sum to the book", () => {
    expect(plan.cells.reduce((a, c) => a + c.positionCount, 0)).toBe(book.positions.length);
    for (const v of plan.views) {
      expect(v.groups.reduce((a, g) => a + g.positionCount, 0)).toBe(book.positions.length);
    }
  });
  it("puts each position in exactly one cell, and its cell is its family's", () => {
    expect(plan.cellIndexByPosition.length).toBe(book.positions.length);
    book.positions.forEach((pos, p) => {
      expect(plan.cells[plan.cellIndexByPosition[p]!]!.familyId).toBe(pos.familyId);
    });
  });
  it("resolves every position to its OWN cell by id, not merely to its family", () => {
    // The family assertion above cannot see a defect confined to the Pass 2 id
    // lookup: one that sent D3 to the rate-shopper cell would keep every family
    // right and every count right, because positionCount comes from the Pass 1
    // draft map and not from this array. Pin the whole mapping by cell id.
    const byPosition = Object.fromEntries(
      book.positions.map((pos, p) => [pos.id, plan.cells[plan.cellIndexByPosition[p]!]!.id]),
    );
    expect(byPosition).toEqual({
      F1: 'FIXED|{"segment":"whole-book"}',
      M1: 'MORTGAGE|{"segment":"whole-book"}',
      D1: 'DDA|{"segment":"rate-shopper"}',
      B1: 'MMA|{"segment":"whole-book"}',
      D2: 'DDA|{"segment":"rate-shopper"}',
      D3: 'DDA|{"segment":"relationship"}',
    });
    // P4 read off cellIndexByPosition rather than off the draft counts: the
    // positions resolving to a cell must number exactly that cell's
    // positionCount. The two sides have independent provenance, so a mis-assignment
    // in either one breaks the equality.
    const tally = new Map<string, number>();
    for (let p = 0; p < book.positions.length; p++) {
      const id = plan.cells[plan.cellIndexByPosition[p]!]!.id;
      tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    expect(plan.cells.map((c) => [c.id, tally.get(c.id) ?? 0])).toEqual(
      plan.cells.map((c) => [c.id, c.positionCount]),
    );
  });
  it("projects to a ViewResult with cell ids and no numbers beyond the counts", () => {
    const [view] = toViewResults(plan);
    expect(view!.viewId).toBe("by-segment");
    expect(view!.label).toBe("By segment");
    expect(view!.groupBy).toEqual(["segment"]);
    expect(view!.groups.map((g) => [g.key.segment, g.positionCount])).toEqual([
      ["rate-shopper", 2],
      ["relationship", 1],
      ["whole-book", 3],
    ]);
    expect(view!.groups[0]!.cellIds).toEqual(['DDA|{"segment":"rate-shopper"}']);
  });
});

/**
 * The three partition refusals. A view that
 * cannot slice the book without losing or double-counting a position is refused
 * by name, never repaired.
 */
describe("the partition check", () => {
  const book = viewSegmentedBook();
  const caught = (fn: () => unknown): ViewDefinitionError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ViewDefinitionError) return e;
      throw e;
    }
    throw new Error("expected a ViewDefinitionError and none was thrown");
  };

  it("P1: a view naming a tag the taxonomy does not declare is refused, naming both", () => {
    const err = caught(() => buildCellPlan(book, [{ id: "v1", label: "V1", groupBy: ["vintage"] }]));
    expect(err.rule).toBe("P1");
    expect(err.viewId).toBe("v1");
    expect(err.dimension).toBe("vintage");
    expect(err.message).toContain("v1");
    expect(err.message).toContain("vintage");
    // The 422 mapping is by family: a refusal that did not extend ExecutorError
    // would leave the server answering 500 for a plan the caller can fix.
    expect(err).toBeInstanceOf(ExecutorError);
  });
  it("P1: an empty groupBy and a repeated id are refused", () => {
    expect(caught(() => buildCellPlan(book, [{ id: "v2", label: "V2", groupBy: [] }])).rule).toBe("P1");
    const dup = caught(() => buildCellPlan(book, [{ id: "v3", label: "V3", groupBy: ["segment", "segment"] }]));
    expect(dup.rule).toBe("P1");
    expect(dup.dimension).toBe("segment");
  });
  it("P1: the derived ids productFamily and side are groupable", () => {
    const plan = buildCellPlan(book, [{ id: "v4", label: "V4", groupBy: ["side"] }]);
    expect(plan.groupingDimensions).toEqual(["side"]);
    expect(plan.cells.every((c) => c.tags.side === "asset" || c.tags.side === "liability")).toBe(true);
  });
  it("P2: grouping on behavioralClasses is refused as multi-valued", () => {
    const err = caught(() =>
      buildCellPlan(book, [{ id: "v5", label: "V5", groupBy: ["behavioralClasses"] }]),
    );
    expect(err.rule).toBe("P2");
    expect(err.dimension).toBe("behavioralClasses");
    expect(err.message).toContain("multi-valued");
  });
  it("P2: grouping on a taxonomy tag declared multiValued is refused", () => {
    const multi = {
      ...book,
      taxonomy: { ...book.taxonomy!, dimensions: [{ id: "tier", label: "Tier", multiValued: true }] },
    };
    expect(caught(() => buildCellPlan(multi, [{ id: "v6", label: "V6", groupBy: ["tier"] }])).rule).toBe("P2");
  });
  it("P3: a position with no value for a grouped tag is refused, naming the position", () => {
    const err = caught(() => buildCellPlan(segmentedNmdBook(), [BY_SEGMENT_VIEW]));
    expect(err.rule).toBe("P3");
    expect(err.viewId).toBe("by-segment");
    expect(err.dimension).toBe("segment");
    expect(err.positionId).toBe("F1");
    expect(err.message).toContain("F1");
  });
  it("P3: an empty list for a grouped tag is refused too, naming that position", () => {
    // The other shape of "carries no value". A bag holding [] would otherwise
    // reach the cell key as the first element of an empty array.
    const empty = {
      ...book,
      positions: book.positions.map((p) => (p.id === "D3" ? { ...p, dimensions: { segment: [] } } : p)),
    };
    const err = caught(() => buildCellPlan(empty, [BY_SEGMENT_VIEW]));
    expect(err.rule).toBe("P3");
    expect(err.positionId).toBe("D3");
    expect(err.dimension).toBe("segment");
  });
  it("no view, no check: the identity plan never raises", () => {
    expect(() => buildCellPlan(segmentedNmdBook(), undefined)).not.toThrow();
  });

  // --- Coverage the single-dimension fixtures never reach -------------------

  it("groups on two dimensions at once, pinning both on every cell", () => {
    const plan = buildCellPlan(book, [{ id: "v7", label: "V7", groupBy: ["segment", "side"] }]);
    expect(plan.groupingDimensions).toEqual(["segment", "side"]);
    const byPosition = Object.fromEntries(
      book.positions.map((pos, p) => [pos.id, plan.cells[plan.cellIndexByPosition[p]!]!.id]),
    );
    expect(byPosition).toEqual({
      F1: 'FIXED|{"segment":"whole-book","side":"asset"}',
      M1: 'MORTGAGE|{"segment":"whole-book","side":"asset"}',
      D1: 'DDA|{"segment":"rate-shopper","side":"liability"}',
      B1: 'MMA|{"segment":"whole-book","side":"liability"}',
      D2: 'DDA|{"segment":"rate-shopper","side":"liability"}',
      D3: 'DDA|{"segment":"relationship","side":"liability"}',
    });
    const [view] = toViewResults(plan);
    expect(view!.groups.map((g) => [g.key.segment, g.key.side, g.positionCount])).toEqual([
      ["rate-shopper", "liability", 2],
      ["relationship", "liability", 1],
      ["whole-book", "asset", 2],
      ["whole-book", "liability", 1],
    ]);
  });
  it("pins the first value where a bag carries a list on a single-valued grouped tag", () => {
    // Intake rule D4 is what refuses such a book, and buildCellPlan is not the
    // intake gate, so it pins the first value rather than inventing a fourth
    // rule. This is the one path that reaches the list branch of the bag reader.
    const listed = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === "D3" ? { ...p, dimensions: { segment: ["relationship", "rate-shopper"] } } : p,
      ),
    };
    const plan = buildCellPlan(listed, [BY_SEGMENT_VIEW]);
    const byPosition = Object.fromEntries(
      listed.positions.map((pos, p) => [pos.id, plan.cells[plan.cellIndexByPosition[p]!]!.id]),
    );
    expect(byPosition.D3).toBe('DDA|{"segment":"relationship"}');
  });

  // --- Fix round 1: a refusal names the thing to fix ------------------------

  it("P1: two views carrying one id are refused, naming the id", () => {
    // The pivot of tasks 10 and 11 resolves a view by id. A duplicate would make
    // that resolution ambiguous and the first one would silently win.
    const err = caught(() =>
      buildCellPlan(book, [BY_SEGMENT_VIEW, { ...BY_SEGMENT_VIEW, label: "By segment, again" }]),
    );
    expect(err.rule).toBe("P1");
    expect(err.viewId).toBe("by-segment");
    expect(err.message).toContain("by-segment");
    expect(err.message).toContain("twice");
    // Two DIFFERENT cuts under one id are the same refusal: the id is the handle.
    const other = caught(() =>
      buildCellPlan(book, [BY_SEGMENT_VIEW, { id: "by-segment", label: "By side", groupBy: ["side"] }]),
    );
    expect(other.rule).toBe("P1");
    expect(other.viewId).toBe("by-segment");
  });
  it("P1: the derived ids the message offers are exactly the ones a view may group on", () => {
    // A message that advertises a dimension P2 always refuses sends its reader
    // to a dead end. Take the ids the message offers and prove each one groups.
    const err = caught(() => buildCellPlan(book, [{ id: "v8", label: "V8", groupBy: ["vintage"] }]));
    const offered = /groupable derived ids \(([^)]*)\)/.exec(err.message)?.[1]?.split(", ") ?? [];
    expect(offered).toEqual(["productFamily", "side"]);
    for (const dim of offered) {
      expect(() => buildCellPlan(book, [{ id: "v8", label: "V8", groupBy: [dim] }])).not.toThrow();
    }
    expect(offered).not.toContain("behavioralClasses");
  });
  it("P3 says which of the two faults it found: absent, or present and unusable", () => {
    // pinned's test is wider than "is the tag there", so the message has to be
    // too. A numeric tag told it carried "no value" would misdescribe the fix.
    const absent = caught(() => buildCellPlan(segmentedNmdBook(), [BY_SEGMENT_VIEW]));
    expect(absent.message).toContain("carries no value for this tag");

    const numeric = {
      ...book,
      positions: book.positions.map((p) =>
        p.id === "D3" ? { ...p, dimensions: { segment: 7 as unknown as string } } : p,
      ),
    };
    const num = caught(() => buildCellPlan(numeric, [BY_SEGMENT_VIEW]));
    expect(num.rule).toBe("P3");
    expect(num.positionId).toBe("D3");
    expect(num.message).toContain("the number 7");
    expect(num.message).not.toContain("carries no value");

    const blank = {
      ...book,
      positions: book.positions.map((p) => (p.id === "D3" ? { ...p, dimensions: { segment: "" } } : p)),
    };
    const empty = caught(() => buildCellPlan(blank, [BY_SEGMENT_VIEW]));
    expect(empty.message).toContain("an empty string");
    expect(empty.message).not.toContain("carries no value");

    // The empty list keeps the absent wording: nothing is there to name.
    const listed = {
      ...book,
      positions: book.positions.map((p) => (p.id === "D3" ? { ...p, dimensions: { segment: [] } } : p)),
    };
    expect(caught(() => buildCellPlan(listed, [BY_SEGMENT_VIEW])).message).toContain("an empty list");
  });
});
