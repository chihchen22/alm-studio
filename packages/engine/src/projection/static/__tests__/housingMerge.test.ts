// packages/engine/src/projection/static/__tests__/housingMerge.test.ts (F7)
import { describe, expect, it } from "vitest";
import { MBS_DEFAULTS, MORTGAGE_DEFAULTS } from "@alm/kernel";
import { applyLicensedOverlays, mergeHousingTerms } from "../applyOverlays";
const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const ov = { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing: H } as never;
describe("mergeHousingTerms", () => {
  it("mapped: writes housing", () => { expect((mergeHousingTerms(MORTGAGE_DEFAULTS, ov, true) as { housing?: unknown }).housing).toEqual(H); });
  it("unmapped and no prior key: the same object", () => { expect(mergeHousingTerms(MORTGAGE_DEFAULTS, ov, false)).toBe(MORTGAGE_DEFAULTS); });
  it("unmapped with a prior key: the key is removed", () => {
    const t = mergeHousingTerms({ ...MORTGAGE_DEFAULTS, housing: H } as never, ov, false);
    expect(Object.prototype.hasOwnProperty.call(t, "housing")).toBe(false);
  });
});

describe("applyLicensedOverlays writes housing for mapped families only", () => {
  const book = {
    id: "pf", label: "pf", asOf: "2026-03-31",
    coa: {
      schemaVersion: "1.0.0",
      nodes: [
        { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
        { id: "n-mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "mortgages", order: 0 },
        { id: "n-mbs", label: "MBS", parentId: "assets", side: "asset", isLeaf: true, familyId: "mbs", order: 1 },
      ],
      families: [
        { id: "mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "n-mortgages" },
        { id: "mbs", label: "MBS", side: "asset", instrumentType: "mortgage", coaNodeId: "n-mbs" },
      ],
    },
    positions: [
      { id: "m1", familyId: "mortgages", coaNodeId: "n-mortgages", terms: { ...MORTGAGE_DEFAULTS, id: "m1" } },
      { id: "b1", familyId: "mbs", coaNodeId: "n-mbs", terms: { ...MORTGAGE_DEFAULTS, id: "b1" } },
    ],
  } as never;
  const binding = (familyId: string) => ({ familyId, modelVersion: "v", overlay: { kind: "prepay", model: "four-factor-cpr", params: MBS_DEFAULTS, housing: H } });
  const set = { schemaVersion: "1.0.0", id: "s", label: "s", bindings: [binding("mortgages"), binding("mbs")],
    macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }] } as never;
  const housingOf = (pf: { positions: Array<{ id: string; terms: object }> }, id: string) =>
    Object.prototype.hasOwnProperty.call(pf.positions.find((p) => p.id === id)!.terms, "housing");
  it("the set's own mapping: mbs carries housing, mortgages does not", () => {
    const out = applyLicensedOverlays(book, set, new Set([0, 1])) as never;
    expect([housingOf(out, "m1"), housingOf(out, "b1")]).toEqual([false, true]);
  });
  it("an empty resolved mapping: neither does", () => {
    const out = applyLicensedOverlays(book, set, new Set([0, 1]), undefined, []) as never;
    expect([housingOf(out, "m1"), housingOf(out, "b1")]).toEqual([false, false]);
  });
});
