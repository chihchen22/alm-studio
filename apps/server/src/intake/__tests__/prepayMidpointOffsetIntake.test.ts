// apps/server/src/intake/__tests__/prepayMidpointOffsetIntake.test.ts
/**
 * `prepayMidpointOffsetBp` is a mortgage terms field the engine reads (a four-factor prepay overlay adds it to the
 * midpoint it writes), so intake accepts a finite number on a mortgage without the "ignored by the engine"
 * warning, and refuses it, as a row error on its own column, when it is not a finite number or sits on another
 * terms type. Expected text restated.
 */
import { describe, expect, it } from "vitest";
import { parsePositionsJson } from "../positionsJson";
import type { RowError } from "../validationReport";
import { fixedLoanPosition, mortgagePosition, validSpec } from "./fixtures";

const NOT_FINITE = 'field "prepayMidpointOffsetBp" must be a finite number of basis points, got "11"';
const MORTGAGE_ONLY = 'field "prepayMidpointOffsetBp" applies to mortgage terms only: it moves the midpoint of a four-factor prepay overlay';

describe("prepayMidpointOffsetBp at intake", () => {
  it("a mortgage carrying a finite offset is accepted with no unrecognized-field warning", () => {
    const out = parsePositionsJson(validSpec([mortgagePosition("m1", { prepayMidpointOffsetBp: 11 })]));
    expect("portfolio" in out).toBe(true);
    if ("portfolio" in out) {
      expect(out.warnings.filter((w) => w.includes("prepayMidpointOffsetBp"))).toEqual([]);
      expect((out.portfolio.positions[0]!.terms as { prepayMidpointOffsetBp?: number }).prepayMidpointOffsetBp).toBe(11);
    }
  });
  it("a non-numeric offset is a row error on its column", () => {
    const out = parsePositionsJson(validSpec([mortgagePosition("m1", { prepayMidpointOffsetBp: "11" })]));
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors.map((e) => [e.row, e.positionId, e.column, e.message])).toEqual([[1, "m1", "prepayMidpointOffsetBp", NOT_FINITE]]);
  });
  it("accepts an offset of plus or minus 500bp and refuses one past it, naming the field", () => {
    for (const bp of [500, -500]) {
      expect("portfolio" in parsePositionsJson(validSpec([mortgagePosition("m1", { prepayMidpointOffsetBp: bp })])), String(bp)).toBe(true);
    }
    for (const bp of [501, -501, 1e6]) {
      const out = parsePositionsJson(validSpec([mortgagePosition("m1", { prepayMidpointOffsetBp: bp })]));
      const errors = (out as { errors: RowError[] }).errors;
      expect(errors.map((e) => [e.column, e.message]), String(bp)).toEqual([
        ["prepayMidpointOffsetBp", `field "prepayMidpointOffsetBp" must lie between -500 and 500 basis points, got ${bp}`],
      ]);
    }
  });
  it("any other terms type carrying the offset is refused", () => {
    const out = parsePositionsJson(validSpec([fixedLoanPosition("f1", { prepayMidpointOffsetBp: 11 })]));
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors.map((e) => [e.column, e.message])).toEqual([["prepayMidpointOffsetBp", MORTGAGE_ONLY]]);
  });
});
