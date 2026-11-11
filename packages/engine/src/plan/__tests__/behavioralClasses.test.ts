import { describe, expect, it } from "vitest";
import { NMD_TERMS_DEFAULTS } from "@alm/kernel";
import { baseAssumptions, makeCoa, nmdPosition } from "../../run/__tests__/fixtures";
import { classesOfPosition, derivedClassesByFamily, OVERLAY_KIND_TO_CLASS } from "../behavioralClasses";

describe("derivedClassesByFamily", () => {
  it("pins the overlay kind to class table", () => {
    expect(OVERLAY_KIND_TO_CLASS).toEqual({
      prepay: "prepayment",
      "nmd-decay": "decay",
      "deposit-beta": "deposit-beta",
      "cd-rollover": "early-withdrawal",
      "commitment-draw": "draw-utilization",
      "loan-client-rate": "client-rate-asset",
    });
  });
  it("derives one class per binding on the fixture set", () => {
    const m = derivedClassesByFamily([baseAssumptions()]);
    expect([...m.get("MORTGAGE")!]).toEqual(["prepayment"]);
    expect([...m.get("DDA")!]).toEqual(["decay"]);
    expect([...m.get("MMA")!]).toEqual(["deposit-beta"]);
    expect(m.has("FIXED")).toBe(false);
  });
  it("unions classes across sets for one family", () => {
    const a = baseAssumptions("A");
    const b = baseAssumptions("B");
    b.bindings = [{ familyId: "MMA", overlay: { kind: "nmd-decay", params: NMD_TERMS_DEFAULTS.nmdParams }, modelVersion: "x" }];
    const m = derivedClassesByFamily([a, b]);
    expect([...m.get("MMA")!]).toEqual(["deposit-beta", "decay"]);
  });
});

describe("classesOfPosition", () => {
  it("unions the family's declared classes, the binding-derived ones, and the position's own tag", () => {
    const family = { ...makeCoa().families[2]!, behavioralClasses: ["decay" as const] };
    const pos = { ...nmdPosition("D1"), dimensions: { behavioralClasses: ["deposit-beta"] } };
    expect([...classesOfPosition(pos, family, new Set(["early-withdrawal"]), undefined)].sort()).toEqual(["decay", "deposit-beta", "early-withdrawal"]);
    expect([...classesOfPosition(nmdPosition("D1"), makeCoa().families[2]!, undefined, undefined)]).toEqual([]);
  });
});
