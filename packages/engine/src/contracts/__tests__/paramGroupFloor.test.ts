// packages/engine/src/contracts/__tests__/paramGroupFloor.test.ts
/**
 * Piece 7b follow-up (mfu-1, Slice 2 M8): a turnover floor above 100 breaks its
 * own bound, so it raises that one issue and not also the floor rule at the
 * same path. A floor inside its bound and above minCpr still raises the rule.
 * Texts and labels restated by hand.
 */
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS } from "@alm/kernel";
import { checkOverlayParams } from "../paramSchema";

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const ff = (housing: unknown) => ({ kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing }) as never;

describe("turnover floor issues", () => {
  it("a floor above 100: one issue, the bound", () => {
    expect(checkOverlayParams(ff({ ...H, turnoverCprFloor: 150 }))).toEqual([
      { path: "housing.turnoverCprFloor", label: "Turnover CPR floor", message: "must be at most 100" },
    ]);
  });
  it("a floor inside its bound and above minCpr: one issue, the rule", () => {
    expect(MBS_DEFAULTS.minCpr).toBe(2); // restated: the kernel default min CPR in percent
    expect(checkOverlayParams(ff({ ...H, turnoverCprFloor: 50 }))).toEqual([
      { path: "housing.turnoverCprFloor", label: "Turnover CPR floor", message: "must be at most the minimum CPR" },
    ]);
  });
});
