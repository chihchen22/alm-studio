/**
 * The dimension contract: the three derived ids are fixed
 * and the shapes are what every other task types against.
 */
import { describe, expect, it } from "vitest";
import { DERIVED_DIMENSION_IDS, type DimensionBag, type DimensionTaxonomy } from "../dimensions";
import { PLAN_SCHEMA_VERSION, type LicensedBinding, type StageSelector } from "../plan";
import type { OverlayBinding } from "../assumptions";
import type { Position } from "../position";

describe("dimension contract", () => {
  it("reserves exactly productFamily, side and behavioralClasses as derived", () => {
    expect([...DERIVED_DIMENSION_IDS]).toEqual(["productFamily", "side", "behavioralClasses"]);
  });
  it("types a bag, a taxonomy, a selected binding and a stage predicate", () => {
    const tax: DimensionTaxonomy = {
      schemaVersion: "1.0.0", id: "T", label: "t",
      dimensions: [{ id: "segment", label: "Segment", values: ["a", "b"] }, { id: "behavioralClasses", label: "c", multiValued: true }],
    };
    const bag: DimensionBag = { segment: "a", behavioralClasses: ["decay"] };
    const binding: OverlayBinding = { familyId: "F", modelVersion: "v", overlay: { kind: "cd-rollover", renewalProbability: 1, offeredSpreadBp: 0, termMonths: 12 }, selector: { segment: ["a"] } };
    const sel: StageSelector = { behavioralClasses: "decay", dimensions: { segment: "a" } };
    const lic: LicensedBinding = { stageId: "s", assumptionSetId: "A", familyId: "F", kind: "cd-rollover", bindingIndex: 0 };
    const pos: Pick<Position, "dimensions"> = { dimensions: bag };
    expect(tax.dimensions.length + Object.keys(bag).length + (binding.selector ? 1 : 0) + (sel.dimensions ? 1 : 0) + lic.bindingIndex + (pos.dimensions ? 1 : 0)).toBe(7);
  });
  it("is plan schema 1.4.0", () => {
    expect(PLAN_SCHEMA_VERSION).toBe("1.4.0");
  });
});
