/**
 * The PLAN-LESS path reaches the view refusals.
 *
 * A compiled run is refused at compile, where compile.ts builds the cell plan
 * before the request is assembled. A plan-less run never touches the compiler:
 * the server composes a RunRequest straight from stored documents and calls
 * buildRunResult. So the buildCellPlan call inside buildRunResult is the ONLY
 * gate a plan-less run crosses, and these two tests pin it open: a view that
 * cannot partition the book is refused, and a view that can still runs.
 *
 * "side" is a DERIVED dimension, so the positive control needs no taxonomy on
 * the fixture book and the two cases differ in the view alone.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { ViewDef } from "../../contracts/views";
import { resolveDefaultContext } from "../engine";
import { ViewDefinitionError } from "../executorErrors";
import { buildRunResult } from "../orchestrate";
import { loadMarket, makeRunRequest, twoSidedBook } from "./fixtures";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

/** The fixture book declares no taxonomy, so "segment" is a dimension it has no value for. */
const UNDECLARED_VIEW: ViewDef = { id: "by-segment", label: "By segment", groupBy: ["segment"] };
/** Derived, single-valued, present on every position without a taxonomy. */
const BY_SIDE_VIEW: ViewDef = { id: "by-side", label: "By side", groupBy: ["side"] };

describe("a plan-less run reaches the view refusals", () => {
  it("refuses a view naming a dimension the book's taxonomy does not declare", () => {
    const book = twoSidedBook();
    const request = makeRunRequest(market, { portfolioId: book.id, views: [UNDECLARED_VIEW] });
    let caught: unknown;
    try {
      buildRunResult(request, book, resolveDefaultContext());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ViewDefinitionError);
    const err = caught as ViewDefinitionError;
    expect(err.rule).toBe("P1");
    expect(err.viewId).toBe("by-segment");
    expect(err.dimension).toBe("segment");
  });

  it("still runs a view that does partition the book", () => {
    const book = twoSidedBook();
    const request = makeRunRequest(market, { portfolioId: book.id, views: [BY_SIDE_VIEW] });
    const result = buildRunResult(request, book, resolveDefaultContext());
    expect(result.nii.byScenario.length).toBeGreaterThan(0);
  });
});
