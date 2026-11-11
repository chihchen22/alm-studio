// packages/engine/src/contracts/__tests__/paramGroups.test.ts
/**
 * The optional housing group of the four-factor schema (blocker 3): all or none, bounds, the floor rule, and the
 * refusal on constant CPR. Texts and labels are restated here by hand.
 */
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS } from "@alm/kernel";
import { checkOverlayParams, numberFieldsOf } from "../paramSchema";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const ff = (housing?: unknown) => ({ kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, ...(housing === undefined ? {} : { housing }) }) as never;

describe("optional housing group", () => {
  it("absent: zero issues and the ten fields only", () => {
    expect(checkOverlayParams(ff())).toEqual([]);
    expect(numberFieldsOf(ff()).length).toBe(10);
  });
  it("present and whole: zero issues and seventeen fields", () => {
    expect(checkOverlayParams(ff(H))).toEqual([]);
    expect(numberFieldsOf(ff(H)).map((f) => f.path).slice(10)).toEqual(["housing.asOfLtv", "housing.refiLtvMid", "housing.refiLtvSlope", "housing.turnoverLtvMid", "housing.turnoverLtvSlope", "housing.turnoverFloorShare", "housing.turnoverCprFloor"]);
  });
  it("partial: one issue listing the missing fields", () => {
    const { turnoverCprFloor: _a, refiLtvSlope: _b, ...part } = H;
    expect(checkOverlayParams(ff(part))).toEqual([{ path: "housing", label: "House-price response (illustrative)", message: "is partial: missing refiLtvSlope, turnoverCprFloor; give all seven or none" }]);
  });
  it("floor above minCpr is refused at the floor", () => {
    expect(MBS_DEFAULTS.minCpr).toBe(2); // restated: the kernel default min CPR in percent
    expect(checkOverlayParams(ff({ ...H, turnoverCprFloor: 2.5 }))).toEqual([{ path: "housing.turnoverCprFloor", label: "Turnover CPR floor", message: "must be at most the minimum CPR" }]);
  });
  it("bounds", () => {
    expect(checkOverlayParams(ff({ ...H, turnoverFloorShare: 1.2 }))).toEqual([{ path: "housing.turnoverFloorShare", label: "Turnover floor share", message: "must be at most 1" }]);
  });
  it("housing on constant CPR is refused", () => {
    expect(checkOverlayParams({ kind: "prepay", model: "constant-cpr", annualCpr: 0.06, housing: H } as never)).toEqual([{ path: "housing", label: "House-price response (illustrative)", message: "applies to the four-factor CPR only" }]);
  });
});
