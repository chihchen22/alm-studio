// apps/server/src/intake/__tests__/housingIntake.test.ts
/**
 * A raw `housing` key on a position's terms is refused at intake with a row
 * error on column housing: the house-price response comes from the assumption
 * set and its macro mapping, never from position terms. Expected text restated.
 */
import { describe, expect, it } from "vitest";
import { parsePositionsJson } from "../positionsJson";
import type { RowError } from "../validationReport";
import { fixedLoanPosition, mortgagePosition, validSpec } from "./fixtures";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const TEXT = 'field "housing" is engine-only: a house-price response comes from the assumption set\'s four-factor prepay binding and its macro mapping, never from position terms';

describe("housing at intake", () => {
  it("a mortgage carrying housing is a row error on column housing", () => {
    const out = parsePositionsJson(validSpec([mortgagePosition("m1", { housing: H })]));
    expect("errors" in out).toBe(true);
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors.map((e) => [e.row, e.positionId, e.column, e.message])).toEqual([[1, "m1", "housing", TEXT]]);
  });
  it("any other terms type carrying housing is refused the same way", () => {
    const out = parsePositionsJson(validSpec([fixedLoanPosition("f1", { housing: H })]));
    const errors = (out as { errors: RowError[] }).errors;
    expect(errors.map((e) => [e.column, e.message])).toEqual([["housing", TEXT]]);
  });
  it("a mortgage without the key is accepted", () => {
    expect("portfolio" in parsePositionsJson(validSpec([mortgagePosition("m1")]))).toBe(true);
  });
});
